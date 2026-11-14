import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { inspectWorkspace, reviewWorkspaceChanges, searchWorkspaceStructured } from "./analysis/index.js";
import { DEFAULT_ANALYSIS_LIMITS, type AnalysisContext, type WorkspaceAnalysis } from "./analysis/types.js";
import type { ServerConfig } from "./config.js";
import { git } from "./git.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

// 程式碼智慧工具：repo 概覽、符號／引用搜尋、改動影響範圍。
// 分析邏輯移植自 CodexPro（MIT，見 THIRD_PARTY_NOTICES.md）；這裡是 DevSpace 的工具註冊與輸出格式。
const MAX_SEARCH_RESULTS = 50;
const MAX_LISTED_SYMBOLS = 200;
const MAX_LISTED_ITEMS = 20;

function contextFor(workspaceId: string, root: string): AnalysisContext {
  return { workspaceId, root, limits: DEFAULT_ANALYSIS_LIMITS, maxSearchResults: MAX_SEARCH_RESULTS };
}

function coverageLine(analysis: Pick<WorkspaceAnalysis, "coverage">): string {
  const { coverage } = analysis;
  return `Coverage: ${coverage.inventoryFiles} files indexed, ${coverage.analyzedFiles} source files analyzed, ${coverage.symbolCount} symbols${coverage.truncated ? " (truncated)" : ""}.`;
}

function warningLines(warnings: string[]): string[] {
  return warnings.length > 0 ? ["Warnings:", ...warnings.map((warning) => `- ${warning}`)] : [];
}

export function formatInspection(analysis: WorkspaceAnalysis, pathPrefix?: string): string {
  const lines = [
    `Project types: ${analysis.projectTypes.join(", ") || "unknown"}`,
    `Languages: ${analysis.languages.join(", ") || "none detected"}`,
    `Entrypoints: ${analysis.entrypoints.slice(0, MAX_LISTED_ITEMS).join(", ") || "none detected"}`,
    `Important files: ${analysis.importantFiles.slice(0, MAX_LISTED_ITEMS).join(", ") || "none detected"}`,
    "Top-level areas (path, role, files):",
    ...analysis.areas.slice(0, MAX_LISTED_ITEMS).map((area) => `- ${area.path} (${area.role}, ${area.files})`),
  ];
  if (pathPrefix) {
    const prefix = pathPrefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const symbols = analysis.symbols.filter((symbol) => symbol.path === prefix || symbol.path.startsWith(`${prefix}/`));
    lines.push(
      `Symbols under ${prefix} (${symbols.length}${symbols.length > MAX_LISTED_SYMBOLS ? `, showing ${MAX_LISTED_SYMBOLS}` : ""}):`,
      ...symbols
        .slice(0, MAX_LISTED_SYMBOLS)
        .map((symbol) => `- ${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}${symbol.exported ? " (exported)" : ""}`),
    );
  } else {
    lines.push("Pass `path` (a directory or file) to list the symbols defined under it.");
  }
  lines.push(coverageLine(analysis), ...warningLines(analysis.warnings));
  return lines.join("\n");
}

async function gitChangedPaths(root: string): Promise<string[]> {
  try {
    const { stdout } = await git(root, ["status", "--porcelain"], { maxBuffer: 4 * 1024 * 1024 });
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3))
      .map((entry) => (entry.includes(" -> ") ? entry.split(" -> ").at(-1)! : entry))
      .map((entry) => entry.replace(/^"|"$/g, ""));
  } catch {
    return [];
  }
}

export function registerAnalysisTools(
  server: McpServer,
  options: { config: ServerConfig; workspaces: WorkspaceRegistry },
): void {
  const { config, workspaces } = options;

  function log(tool: string, workspaceId: string, startedAt: number): void {
    if (!config.logging.toolCalls) return;
    logEvent(config.logging, "info", "tool_call", {
      tool,
      workspaceId,
      success: true,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }

  const textResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    structuredContent: { result: text },
  });

  server.registerTool(
    "inspect_workspace",
    {
      title: "Inspect workspace",
      description:
        "Get a quick map of a project: project types, languages, entrypoints, important files, top-level areas, and (with `path`) the functions, classes, and types defined under a directory or file. Use it before exploring an unfamiliar codebase instead of running many ls/grep calls. Results come from regex-based extraction, so treat them as strong hints rather than a compiler-accurate index.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace to inspect. Reuse the current project's workspaceId."),
        path: z.string().optional().describe("Directory or file (workspace-relative) whose symbols should be listed."),
      },
      outputSchema: { result: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, path }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const analysis = await inspectWorkspace(contextFor(workspace.id, workspace.root));
      log("inspect_workspace", workspace.id, startedAt);
      return textResult(formatInspection(analysis, path));
    },
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Search the project's text and symbols and get results grouped as definitions, references, tests, configuration, and documentation, ranked by relevance. Use intent=symbol to find where a name is defined, references or impact to find the files that import the file defining it. For regular expressions use grep instead.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace to search."),
        query: z.string().min(1).describe("Identifier or text to look for (case-insensitive, literal)."),
        intent: z
          .enum(["auto", "text", "symbol", "references", "impact"])
          .optional()
          .describe("Defaults to auto: a single identifier is treated as a symbol, anything else as text."),
        includeTests: z.boolean().optional().describe("Include test files in the results. Defaults to false."),
        path: z.string().optional().describe("Limit the search to this workspace-relative directory."),
        maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
      },
      outputSchema: { result: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, query, intent, includeTests, path, maxResults }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const result = await searchWorkspaceStructured(contextFor(workspace.id, workspace.root), {
        query,
        intent,
        includeTests,
        root: path,
        maxResults,
      });
      const lines = [`Search "${result.query}" (intent: ${result.intent}) — ${result.matches.length} result(s)`];
      for (const [group, matches] of Object.entries(result.groups)) {
        if (matches.length === 0) continue;
        lines.push(`\n## ${group}`);
        for (const match of matches) {
          lines.push(`${match.path}:${match.line}  ${match.text}  [${match.reasons.join(", ")}]`);
        }
      }
      lines.push("", coverageLine(result), ...warningLines(result.warnings));
      log("search_code", workspace.id, startedAt);
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "review_impact",
    {
      title: "Review change impact",
      description:
        "Given changed files (defaults to the files in `git status`), list the files that import them, the tests that likely cover them, risk signals such as authentication or build configuration, and suggested verification commands. Call it after editing and before running tests to decide what to verify.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace to review."),
        changedPaths: z
          .array(z.string())
          .max(200)
          .optional()
          .describe("Workspace-relative changed paths. Omit to use the current git status."),
      },
      outputSchema: { result: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, changedPaths }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const paths = changedPaths && changedPaths.length > 0 ? changedPaths : await gitChangedPaths(workspace.root);
      if (paths.length === 0) {
        return textResult("No changed paths were given and git status shows no changes.");
      }
      const review = await reviewWorkspaceChanges(contextFor(workspace.id, workspace.root), { changedPaths: paths });
      const section = (title: string, items: string[]) => (items.length > 0 ? [`${title}:`, ...items] : []);
      const lines = [
        `Changed (${review.changedPaths.length}): ${review.changedPaths.join(", ")}`,
        `Affected areas: ${review.affectedAreas.join(", ") || "none"}`,
        ...section("Files that depend on the changes", review.dependentFiles.map((file) => `- ${file.path} (${file.reasons.join("; ")})`)),
        ...section("Likely related tests", review.relatedTests.map((file) => `- ${file.path} (${file.reasons.join("; ")})`)),
        ...section("Risk signals", review.riskSignals.map((risk) => `- ${risk.label}: ${risk.paths.join(", ")}`)),
        ...section("Suggested commands (not verified)", review.recommendedCommands.map((item) => `- ${item.command}`)),
        coverageLine(review),
        ...warningLines(review.warnings),
      ];
      log("review_impact", workspace.id, startedAt);
      return textResult(lines.join("\n"));
    },
  );
}
