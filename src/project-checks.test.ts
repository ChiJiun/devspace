import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCheckCommands,
  detectPackageManager,
  makeTargets,
  MAX_CHECK_COMMANDS,
  nodeScriptCommands,
} from "./project-checks.js";

// package.json scripts：依固定順序、跳過 npm 預設的假 test
assert.deepEqual(
  nodeScriptCommands({ scripts: { build: "x", lint: "x", test: "vitest", typecheck: "tsc", dev: "x" } }, "npm"),
  ["npm test", "npm run typecheck", "npm run lint", "npm run build"],
);
assert.deepEqual(
  nodeScriptCommands({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "x" } }, "pnpm"),
  ["pnpm run lint"],
);
assert.deepEqual(nodeScriptCommands({ scripts: { test: "x", check: "y" } }, "yarn"), ["yarn test", "yarn check"]);
assert.deepEqual(nodeScriptCommands({}, "npm"), []);
assert.deepEqual(nodeScriptCommands(null, "npm"), []);
assert.deepEqual(nodeScriptCommands({ scripts: "oops" }, "npm"), []);

// Makefile target
assert.deepEqual(makeTargets("build:\n\tgo build\ntest: build\n\tgo test\nVAR := 1\nlint:\n\tx\n"), ["make test", "make lint"]);
assert.deepEqual(makeTargets(".PHONY: test\nfoo:\n"), []);

const root = await mkdtemp(join(tmpdir(), "devspace-checks-"));
try {
  assert.deepEqual(await detectCheckCommands(root), []);
  assert.equal(await detectPackageManager(root), "npm");

  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }));
  await writeFile(join(root, "pnpm-lock.yaml"), "");
  assert.equal(await detectPackageManager(root), "pnpm");
  await writeFile(join(root, "Cargo.toml"), "[package]\n");
  await writeFile(join(root, "go.mod"), "module x\n");
  await writeFile(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n[tool.ruff]\n");
  await writeFile(join(root, "Makefile"), "check:\n\ttrue\n");
  assert.deepEqual(await detectCheckCommands(root), [
    "pnpm test",
    "pnpm run lint",
    "pytest",
    "ruff check .",
    "cargo test",
    "go test ./...",
    "make check",
  ]);

  // package.json 壞掉時不影響其他偵測
  await writeFile(join(root, "package.json"), "{ not json");
  assert.ok((await detectCheckCommands(root)).includes("cargo test"));

  assert.ok((await detectCheckCommands(root)).length <= MAX_CHECK_COMMANDS);
} finally {
  await rm(root, { recursive: true, force: true });
}
