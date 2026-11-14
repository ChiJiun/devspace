// 概念與輸出格式取自 CodexPro（https://github.com/rebel0789/codexpro，MIT，Copyright (c) 2026 CodexPro contributors）的 src/analysis/inventory.ts。
// 授權全文見專案根目錄的 THIRD_PARTY_NOTICES.md。
// DevSpace 版改寫：在 Git 專案用 `git ls-files` 取得檔案清單（自動遵守 .gitignore），否則自己走訪目錄並略過常見的產物資料夾。
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { git } from "../git.js";
import { classifyFileRole, classifyLanguage, isEntrypoint, isGeneratedFile } from "./classify.js";
import type { AnalysisContext, InventoryFile, InventoryResult } from "./types.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
]);

// 單一檔案超過這個大小就不分析（多半是產物或資料檔）
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function listWithGit(root: string, limit: number): Promise<string[] | undefined> {
  try {
    const { stdout } = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = stdout.split("\0").filter(Boolean);
    return files.slice(0, limit + 1);
  } catch {
    return undefined;
  }
}

async function listWithWalk(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  async function walk(absDir: string, relDir: string): Promise<void> {
    if (files.length > limit) return;
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length > limit) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  await walk(root, "");
  return files;
}

export async function inventoryWorkspace(ctx: AnalysisContext): Promise<InventoryResult> {
  const maxFiles = ctx.limits.maxInventoryFiles;
  const candidates = (await listWithGit(ctx.root, maxFiles)) ?? (await listWithWalk(ctx.root, maxFiles));
  const truncated = candidates.length > maxFiles;
  const files: InventoryFile[] = [];

  for (const candidate of candidates.slice(0, maxFiles)) {
    const rel = candidate.replace(/\\/g, "/");
    if (rel.split("/").some((part) => SKIPPED_DIRECTORIES.has(part))) continue;
    try {
      const stat = await fsp.stat(path.join(ctx.root, rel));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const language = classifyLanguage(rel);
      files.push({
        path: rel,
        bytes: stat.size,
        modifiedMs: stat.mtimeMs,
        language,
        role: classifyFileRole(rel, language),
        generated: isGeneratedFile(rel),
        entrypoint: isEntrypoint(rel),
      });
    } catch {
      // 已刪除或讀不到的檔案直接略過
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.bytes}:${file.modifiedMs}`).join("\n"))
    .digest("hex");
  const warnings = truncated ? [`Inventory truncated at ${maxFiles} files.`] : [];
  return {
    files,
    fingerprint,
    coverage: {
      inventoryFiles: files.length,
      analyzedFiles: 0,
      scannedBytes: 0,
      symbolCount: 0,
      relationshipCount: 0,
      truncated,
      warnings,
    },
  };
}
