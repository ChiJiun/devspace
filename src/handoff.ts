import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { git } from "./git.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

// 交接（handoff）：長對話會越來越慢，建議每個小任務開新對話。
// save_handoff 把「目標、已完成、決策、下一步」加上 Git 狀態存成一份 Markdown，
// 下次在同一個專案 open_workspace 時自動帶回最新一份，新對話不用重新說明。
// 檔案存在 DevSpace 的狀態目錄，不會寫進專案，也不會出現在 git status。
export const MAX_FIELD_CHARS = 4_000;
export const MAX_HANDOFFS_PER_PROJECT = 10;
export const MAX_LOADED_HANDOFF_CHARS = 6_000;

export interface HandoffInput {
  goal: string;
  done?: string;
  decisions?: string;
  next?: string;
  notes?: string;
}

export interface GitSnapshot {
  branch?: string;
  head?: string;
  status?: string[];
  recentCommits?: string[];
  diffStat?: string;
}

export interface LoadedHandoff {
  savedAt: string;
  markdown: string;
  truncated: boolean;
}

function clip(value: string | undefined, limit = MAX_FIELD_CHARS): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function handoffKey(projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  let normalized = resolve(projectRoot);
  if (platform === "win32") normalized = normalized.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function handoffDir(stateDir: string, projectRoot: string): string {
  return join(stateDir, "handoffs", handoffKey(projectRoot));
}

function timestampName(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.md`;
}

// 依「去掉 .md 的檔名」排序：同一時間點的 ...Z.md 排在 ...Z-2.md 之前（直接比含副檔名時 "-" 會排在 "." 前面）
function sortedHandoffFiles(files: string[]): string[] {
  const stem = (file: string) => file.replace(/\.md$/, "");
  return files
    .filter((file) => file.endsWith(".md"))
    .sort((a, b) => {
      const left = stem(a);
      const right = stem(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

function section(title: string, body: string | undefined): string[] {
  return body ? [`## ${title}`, body, ""] : [];
}

function bulletBlock(lines: string[] | undefined): string | undefined {
  return lines && lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : undefined;
}

export function renderHandoff(
  input: HandoffInput,
  gitSnapshot: GitSnapshot,
  meta: { projectRoot: string; workspaceId: string; savedAt: Date },
): string {
  const goal = clip(input.goal) ?? "(未填寫)";
  const gitLines = [
    gitSnapshot.branch ? `branch: ${gitSnapshot.branch}${gitSnapshot.head ? ` @ ${gitSnapshot.head}` : ""}` : undefined,
    gitSnapshot.diffStat ? `diff stat: ${gitSnapshot.diffStat}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return [
    `# Handoff — ${meta.savedAt.toISOString()}`,
    "",
    `Project: ${meta.projectRoot}`,
    `Workspace: ${meta.workspaceId}`,
    "",
    "## Goal",
    goal,
    "",
    ...section("Done", clip(input.done)),
    ...section("Decisions", clip(input.decisions)),
    ...section("Next steps", clip(input.next)),
    ...section("Notes", clip(input.notes)),
    ...section("Git", [bulletBlock(gitLines), bulletBlock(gitSnapshot.status?.map((line) => `\`${line}\``))
      ? `uncommitted:\n${bulletBlock(gitSnapshot.status?.map((line) => `\`${line}\``))}`
      : undefined,
    bulletBlock(gitSnapshot.recentCommits) ? `recent commits:\n${bulletBlock(gitSnapshot.recentCommits)}` : undefined,
    ].filter(Boolean).join("\n\n") || undefined),
  ].join("\n").trimEnd() + "\n";
}

async function gitText(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await git(cwd, args, { maxBuffer: 1024 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const [branch, head, status, commits, stat] = await Promise.all([
    gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitText(cwd, ["rev-parse", "--short", "HEAD"]),
    gitText(cwd, ["status", "--short"]),
    gitText(cwd, ["log", "-5", "--oneline"]),
    gitText(cwd, ["diff", "--shortstat", "HEAD"]),
  ]);
  const statusLines = status?.split(/\r?\n/).filter(Boolean) ?? [];
  return {
    branch,
    head,
    status: statusLines.length > 30
      ? [...statusLines.slice(0, 30), `…另外 ${statusLines.length - 30} 項`]
      : statusLines,
    recentCommits: commits?.split(/\r?\n/).filter(Boolean),
    diffStat: stat,
  };
}

export async function saveHandoff(options: {
  stateDir: string;
  projectRoot: string;
  workspaceId: string;
  input: HandoffInput;
  gitSnapshot: GitSnapshot;
  now?: Date;
}): Promise<{ path: string; name: string }> {
  const now = options.now ?? new Date();
  const dir = handoffDir(options.stateDir, options.projectRoot);
  await mkdir(dir, { recursive: true });

  let name = timestampName(now);
  const existing = new Set(await readdir(dir));
  // 同一毫秒內重複儲存時加序號，避免覆蓋
  for (let counter = 2; existing.has(name); counter += 1) {
    name = timestampName(now).replace(/\.md$/, `-${counter}.md`);
  }

  const markdown = renderHandoff(options.input, options.gitSnapshot, {
    projectRoot: options.projectRoot,
    workspaceId: options.workspaceId,
    savedAt: now,
  });
  const path = join(dir, name);
  await writeFile(path, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const files = sortedHandoffFiles(await readdir(dir));
  for (const stale of files.slice(0, Math.max(0, files.length - MAX_HANDOFFS_PER_PROJECT))) {
    await rm(join(dir, stale), { force: true });
  }
  return { path, name };
}

export async function loadLatestHandoff(
  stateDir: string,
  projectRoot: string,
  limit = MAX_LOADED_HANDOFF_CHARS,
): Promise<LoadedHandoff | undefined> {
  const dir = handoffDir(stateDir, projectRoot);
  let files: string[];
  try {
    files = sortedHandoffFiles(await readdir(dir));
  } catch {
    return undefined;
  }
  const latest = files.at(-1);
  if (!latest) return undefined;

  const raw = await readFile(join(dir, latest), "utf8");
  const truncated = raw.length > limit;
  const savedAt = /^# Handoff — (.+)$/m.exec(raw)?.[1] ?? latest.replace(/\.md$/, "");
  return { savedAt, markdown: truncated ? `${raw.slice(0, limit - 1)}…` : raw, truncated };
}

export function registerHandoffTool(
  server: McpServer,
  options: { config: ServerConfig; workspaces: WorkspaceRegistry },
): void {
  const { config, workspaces } = options;

  server.registerTool(
    "save_handoff",
    {
      title: "Save handoff",
      description:
        "Save a short handoff note for this project so a new conversation can continue where this one stopped. Call it when finishing a task or before the user switches to a new chat. Summarize the goal, what is done, key decisions, and next steps. Do not include secrets, tokens, or passwords. The note is stored outside the project and is returned automatically the next time open_workspace opens this project.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace to use. Reuse the current project's workspaceId."),
        goal: z.string().min(1).describe("What the user is trying to achieve."),
        done: z.string().optional().describe("What has been completed so far."),
        decisions: z.string().optional().describe("Important decisions and why they were made."),
        next: z.string().optional().describe("Concrete next steps."),
        notes: z.string().optional().describe("Anything else the next conversation should know."),
      },
      outputSchema: { result: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const projectRoot = workspace.sourceRoot ?? workspace.root;
      const saved = await saveHandoff({
        stateDir: config.stateDir,
        projectRoot,
        workspaceId: workspace.id,
        input,
        gitSnapshot: await collectGitSnapshot(workspace.root),
      });
      if (config.logging.toolCalls) {
        logEvent(config.logging, "info", "tool_call", {
          tool: "save_handoff",
          workspaceId: workspace.id,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      const text = `Handoff saved (${saved.name}). It will be returned the next time this project is opened with open_workspace.`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { result: text },
      };
    },
  );
}
