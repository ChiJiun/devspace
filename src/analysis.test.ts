import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectWorkspace, reviewWorkspaceChanges, searchWorkspaceStructured } from "./analysis/index.js";
import { DEFAULT_ANALYSIS_LIMITS, type AnalysisContext } from "./analysis/types.js";
import { formatInspection } from "./analysis-tools.js";
import { redactSensitiveText } from "./redact.js";

async function project(files: Record<string, string>): Promise<{ ctx: AnalysisContext; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "devspace-analysis-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return {
    ctx: { workspaceId: `ws-${Math.random()}`, root, limits: DEFAULT_ANALYSIS_LIMITS, maxSearchResults: 50 },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const FILES = {
  "package.json": JSON.stringify({ name: "demo", scripts: { test: "vitest" } }),
  "src/index.ts": 'import { greet } from "./greet.js";\nexport function main() { return greet("x"); }\n',
  "src/greet.ts": "export function greet(name: string) { return `hi ${name}`; }\n",
  "src/greet.test.ts": 'import { greet } from "./greet.js";\ngreet("a");\n',
  "src/auth/login.ts": "export const token = 1;\n",
  "node_modules/dep/index.js": "export function greet() {}\n",
  "README.md": "greet docs\n",
};

test("inspectWorkspace 找出符號、入口與 import 關係，並略過 node_modules", async () => {
  const { ctx, cleanup } = await project(FILES);
  try {
    const analysis = await inspectWorkspace(ctx);
    assert.ok(analysis.projectTypes.includes("node"));
    assert.ok(analysis.entrypoints.includes("src/index.ts"));
    assert.ok(analysis.symbols.some((symbol) => symbol.name === "greet" && symbol.path === "src/greet.ts" && symbol.exported));
    assert.ok(!analysis.files.some((file) => file.path.startsWith("node_modules/")));
    assert.ok(analysis.relationships.some((rel) => rel.from === "src/index.ts" && rel.to === "src/greet.ts" && rel.kind === "imports"));
    assert.ok(analysis.relationships.some((rel) => rel.from === "src/greet.test.ts" && rel.to === "src/greet.ts" && rel.kind === "tests"));

    const second = await inspectWorkspace(ctx);
    assert.equal(second.cache.hit, true);

    const text = formatInspection(analysis, "src");
    assert.match(text, /src\/greet\.ts:1 function greet \(exported\)/);
  } finally {
    await cleanup();
  }
});

test("searchWorkspaceStructured 把定義排在引用前面，並依 includeTests 過濾", async () => {
  const { ctx, cleanup } = await project(FILES);
  try {
    const result = await searchWorkspaceStructured(ctx, { query: "greet", intent: "symbol" });
    assert.equal(result.groups.definitions[0]?.path, "src/greet.ts");
    assert.ok(result.groups.references.some((match) => match.path === "src/index.ts"));
    assert.equal(result.groups.tests.length, 0);

    const withTests = await searchWorkspaceStructured(ctx, { query: "greet", intent: "references", includeTests: true });
    assert.ok(withTests.groups.tests.some((match) => match.path === "src/greet.test.ts"));

    await assert.rejects(() => searchWorkspaceStructured(ctx, { query: "greet", root: "../outside" }), /inside the workspace/);
  } finally {
    await cleanup();
  }
});

test("reviewWorkspaceChanges 列出依賴者、相關測試、風險與建議指令", async () => {
  const { ctx, cleanup } = await project(FILES);
  try {
    const review = await reviewWorkspaceChanges(ctx, { changedPaths: ["src/greet.ts", "src/auth/login.ts", "../escape.ts"] });
    assert.deepEqual(review.changedPaths, ["src/greet.ts", "src/auth/login.ts"]);
    assert.ok(review.dependentFiles.some((file) => file.path === "src/index.ts"));
    assert.ok(review.relatedTests.some((file) => file.path === "src/greet.test.ts"));
    assert.ok(review.riskSignals.some((risk) => risk.id === "authentication"));
    assert.ok(review.recommendedCommands.some((item) => item.command === "npm test"));
    assert.ok(review.warnings.some((warning) => /Skipped unsafe/.test(warning)));
  } finally {
    await cleanup();
  }
});

test("redactSensitiveText 遮蔽常見的金鑰格式，但保留佔位字串", () => {
  assert.equal(redactSensitiveText("key sk-abcdefghijklmnop1234"), "key [REDACTED_SECRET]");
  assert.match(redactSensitiveText("Authorization: Bearer abcdefghijklmnopqrstuv"), /Bearer \[REDACTED_SECRET\]/);
  assert.match(redactSensitiveText("API_KEY=abcdefghijklmnopqrstuvwxyz123456"), /\[REDACTED_SECRET\]/);
  assert.equal(redactSensitiveText("const key = process.env.API_KEY;"), "const key = process.env.API_KEY;");
});
