// 移植自 CodexPro（https://github.com/rebel0789/codexpro），MIT 授權，Copyright (c) 2026 CodexPro contributors。
// 原始檔：src/analysis/rank.ts。授權全文見專案根目錄的 THIRD_PARTY_NOTICES.md。
// 修改：改成不依賴 CodexPro 的 config／PathGuard，直接使用工作區根目錄。
import type { AnalysisSearchIntent, StructuredSearchMatch, WorkspaceAnalysis } from "./types.js";

const GROUPS = ["definitions", "references", "tests", "configuration", "documentation", "other"] as const;

export function emptySearchGroups(): Record<(typeof GROUPS)[number], StructuredSearchMatch[]> {
  return { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] };
}

export function classifySearchIntent(query: string, requested: AnalysisSearchIntent = "auto", regex = false): Exclude<AnalysisSearchIntent, "auto"> {
  if (requested !== "auto") return requested;
  if (regex || /\s/.test(query) || /^['"].*['"]$/.test(query)) return "text";
  return /^[A-Za-z_$][\w$]*$/.test(query) ? "symbol" : "text";
}

export function sortStructuredMatches(matches: StructuredSearchMatch[]): StructuredSearchMatch[] {
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
}

export function groupForFile(analysis: WorkspaceAnalysis, filePath: string, isDefinition: boolean): StructuredSearchMatch["group"] {
  if (isDefinition) return "definitions";
  const role = analysis.files.find((file) => file.path === filePath)?.role;
  if (role === "test") return "tests";
  if (role === "config") return "configuration";
  if (role === "docs") return "documentation";
  return "references";
}
