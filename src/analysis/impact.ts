// 移植自 CodexPro（https://github.com/rebel0789/codexpro），MIT 授權，Copyright (c) 2026 CodexPro contributors。
// 原始檔：src/analysis/impact.ts。授權全文見專案根目錄的 THIRD_PARTY_NOTICES.md。
// 修改：改成不依賴 CodexPro 的 config／PathGuard；建議指令改用本專案的 detectCheckCommands（取代原本的 package／native 偵測）。
import path from "node:path";
import { detectCheckCommands } from "../project-checks.js";
import { detectRiskSignals } from "./classify.js";
import { inspectWorkspace } from "./index.js";
import type { AnalysisContext, AnalysisRiskSignal, ChangeAnalysis } from "./types.js";

const RISK_LABELS: Record<AnalysisRiskSignal["id"], string> = {
  "public-api": "Public API",
  authentication: "Authentication or sessions",
  storage: "Storage or persistence",
  migration: "Schema or migration",
  build: "Build or dependency configuration",
  configuration: "Runtime configuration"
};

function safeRelativePath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new Error("outside workspace");
  }
  return normalized;
}

export async function reviewWorkspaceChanges(
  ctx: AnalysisContext,
  options: { changedPaths: string[] }
): Promise<ChangeAnalysis> {
  const changedPaths: string[] = [];
  const pathWarnings: string[] = [];
  for (const candidate of options.changedPaths) {
    try {
      const relPath = safeRelativePath(candidate);
      if (!changedPaths.includes(relPath)) changedPaths.push(relPath);
    } catch {
      pathWarnings.push(`Skipped unsafe or unreadable changed path: ${candidate}`);
    }
  }
  const analysis = await inspectWorkspace(ctx);
  const affectedAreas = [...new Set(changedPaths.map((filePath) => filePath.includes("/") ? filePath.split("/")[0] : "."))].sort();
  const changed = new Set(changedPaths);
  const dependents = new Map<string, Set<string>>();
  const tests = new Map<string, Set<string>>();
  for (const relationship of analysis.relationships) {
    if (!changed.has(relationship.to)) continue;
    const target = relationship.kind === "tests" ? tests : dependents;
    const reasons = target.get(relationship.from) ?? new Set<string>();
    reasons.add(`${relationship.kind} ${relationship.to}`);
    target.set(relationship.from, reasons);
  }

  const directTestCandidates = analysis.files.filter((file) => file.role === "test" && changedPaths.some((changedPath) => {
    const base = path.basename(changedPath).replace(/\.[^.]+$/, "").toLowerCase();
    return base.length > 2 && file.path.toLowerCase().includes(base);
  }));
  for (const test of directTestCandidates) {
    const reasons = tests.get(test.path) ?? new Set<string>();
    reasons.add("test filename matches changed source");
    tests.set(test.path, reasons);
  }

  const risks = new Map<AnalysisRiskSignal["id"], Set<string>>();
  for (const changedPath of changedPaths) {
    for (const risk of detectRiskSignals(changedPath) as AnalysisRiskSignal["id"][]) {
      const paths = risks.get(risk) ?? new Set<string>();
      paths.add(changedPath);
      risks.set(risk, paths);
    }
  }
  const riskSignals: AnalysisRiskSignal[] = [...risks.entries()].map(([id, paths]) => ({
    id,
    label: RISK_LABELS[id],
    confidence: "inferred",
    paths: [...paths].sort(),
    reasons: [`path pattern matched ${id}`]
  }));
  const resultLimit = Math.max(1, ctx.maxSearchResults);
  const dependentFiles = [...dependents.entries()]
    .map(([filePath, reasons]) => ({ path: filePath, confidence: "strong" as const, reasons: [...reasons] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const relatedTests = [...tests.entries()]
    .map(([filePath, reasons]) => ({ path: filePath, confidence: "strong" as const, reasons: [...reasons] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const impactLimited = dependentFiles.length > resultLimit || relatedTests.length > resultLimit;

  return {
    schemaVersion: 1,
    changedPaths,
    affectedAreas,
    dependentFiles: dependentFiles.slice(0, resultLimit),
    relatedTests: relatedTests.slice(0, resultLimit),
    riskSignals,
    recommendedCommands: (await detectCheckCommands(ctx.root)).map((command) => ({
      command,
      source: "project files",
      reasons: ["detected from project configuration", "not verified"],
    })),
    coverage: analysis.coverage,
    warnings: [
      ...analysis.warnings,
      ...pathWarnings,
      ...(impactLimited ? [`Change-impact output was limited to ${resultLimit} dependent files and ${resultLimit} related tests.`] : [])
    ],
    cache: analysis.cache
  };
}
