import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

// 偵測專案常用的驗證指令（測試、型別檢查、lint、build），讓模型開專案時不用先花幾次呼叫探索。
// 只讀專案根目錄的設定檔，不執行任何東西；結果僅是建議，不保證指令存在或能通過。
export const MAX_CHECK_COMMANDS = 8;

const NODE_SCRIPT_PRIORITY = ["test", "typecheck", "lint", "check", "build"] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function detectPackageManager(root: string): Promise<"pnpm" | "yarn" | "bun" | "npm"> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if ((await exists(join(root, "bun.lockb"))) || (await exists(join(root, "bun.lock")))) return "bun";
  return "npm";
}

function nodeRunCommand(manager: "pnpm" | "yarn" | "bun" | "npm", script: string): string {
  if (script === "test") return manager === "npm" ? "npm test" : `${manager} test`;
  return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
}

export function nodeScriptCommands(
  packageJson: unknown,
  manager: "pnpm" | "yarn" | "bun" | "npm",
): string[] {
  if (typeof packageJson !== "object" || packageJson === null) return [];
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];

  const names = new Set(Object.keys(scripts));
  const commands: string[] = [];
  for (const script of NODE_SCRIPT_PRIORITY) {
    if (!names.has(script)) continue;
    // npm 內建的佔位 test 指令不是真的測試
    const body = (scripts as Record<string, unknown>)[script];
    if (script === "test" && typeof body === "string" && /no test specified/i.test(body)) continue;
    commands.push(nodeRunCommand(manager, script));
  }
  return commands;
}

export function makeTargets(makefile: string): string[] {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:(?!=)/.exec(line);
    if (match) targets.add(match[1]);
  }
  return ["test", "check", "lint"].filter((target) => targets.has(target)).map((target) => `make ${target}`);
}

export async function detectCheckCommands(root: string): Promise<string[]> {
  const commands: string[] = [];

  const packageText = await readText(join(root, "package.json"));
  if (packageText !== undefined) {
    try {
      commands.push(...nodeScriptCommands(JSON.parse(packageText), await detectPackageManager(root)));
    } catch {
      // package.json 壞掉就略過，不影響其他偵測
    }
  }

  const pyproject = await readText(join(root, "pyproject.toml"));
  const hasPytestConfig =
    (pyproject !== undefined && /\[tool\.pytest/.test(pyproject)) ||
    (await exists(join(root, "pytest.ini"))) ||
    (await exists(join(root, "tox.ini")));
  if (hasPytestConfig) commands.push("pytest");
  if (pyproject !== undefined && /\[tool\.ruff/.test(pyproject)) commands.push("ruff check .");

  if (await exists(join(root, "Cargo.toml"))) commands.push("cargo test");
  if (await exists(join(root, "go.mod"))) commands.push("go test ./...");

  const makefile = await readText(join(root, "Makefile"));
  if (makefile !== undefined) commands.push(...makeTargets(makefile));

  return Array.from(new Set(commands)).slice(0, MAX_CHECK_COMMANDS);
}
