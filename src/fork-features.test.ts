import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

interface Fixture {
  client: Client;
  project: string;
}

async function fixture(
  t: TestContext,
  env: Record<string, string> = {},
  options: { git?: boolean } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-fork-test-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "vitest", lint: "eslint ." } }),
  );
  if (options.git) {
    await execFileAsync("git", ["init"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "devspace@example.com"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: project });
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: project });
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    ...env,
  });
  const store = new SqliteWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => buildLocalAgentProviderStatuses(config.subagents, []),
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-fork-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, project };
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

async function open(client: Client, path: string, scope: string, mode?: "worktree") {
  return client.callTool({
    name: "open_workspace",
    arguments: { path, ...(mode ? { mode } : {}) },
    _meta: { "openai/session": scope },
  } as Parameters<Client["callTool"]>[0]);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

test("DEVSPACE_ACCESS 控制暴露的工具", async (t) => {
  const full = await fixture(t);
  const fullTools = await toolNames(full.client);
  for (const name of ["open_workspace", "read", "write", "edit", "bash", "save_handoff"]) {
    assert.ok(fullTools.includes(name), `full 模式應有 ${name}`);
  }

  const noShell = await fixture(t, { DEVSPACE_ACCESS: "no-shell" });
  const noShellTools = await toolNames(noShell.client);
  assert.ok(noShellTools.includes("write") && noShellTools.includes("edit"));
  assert.ok(!noShellTools.includes("bash"));

  const readonly = await fixture(t, { DEVSPACE_ACCESS: "readonly" });
  const readonlyTools = await toolNames(readonly.client);
  for (const name of ["write", "edit", "bash", "apply_patch", "exec_command", "write_stdin"]) {
    assert.ok(!readonlyTools.includes(name), `readonly 不應有 ${name}`);
  }
  assert.ok(readonlyTools.includes("read") && readonlyTools.includes("open_workspace"));

  const readonlyCodex = await fixture(t, { DEVSPACE_ACCESS: "readonly", DEVSPACE_TOOL_MODE: "codex" });
  const codexTools = await toolNames(readonlyCodex.client);
  assert.ok(!codexTools.includes("apply_patch") && !codexTools.includes("exec_command"));

  const fullCodex = await fixture(t, { DEVSPACE_TOOL_MODE: "codex" });
  const fullCodexTools = await toolNames(fullCodex.client);
  assert.ok(fullCodexTools.includes("apply_patch") && fullCodexTools.includes("exec_command"));

  const noShellCodex = await fixture(t, { DEVSPACE_ACCESS: "no-shell", DEVSPACE_TOOL_MODE: "codex" });
  const noShellCodexTools = await toolNames(noShellCodex.client);
  assert.ok(noShellCodexTools.includes("apply_patch"));
  assert.ok(!noShellCodexTools.includes("exec_command") && !noShellCodexTools.includes("write_stdin"));
});

test("DEVSPACE_ACCESS 錯誤值在載入設定時就失敗", () => {
  assert.throws(
    () => loadConfig({ DEVSPACE_ACCESS: "root", DEVSPACE_OAUTH_OWNER_TOKEN: "x".repeat(20) }),
    /Invalid DEVSPACE_ACCESS/,
  );
});

test("readonly 模式拒絕 worktree，仍可正常開 checkout", async (t) => {
  const { client, project } = await fixture(t, { DEVSPACE_ACCESS: "readonly" }, { git: true });
  const opened = await open(client, project, "chat-1");
  assert.ok(!(opened as { isError?: boolean }).isError);
  const worktree = await open(client, project, "chat-2", "worktree").then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const failed = "error" in worktree || (worktree.result as { isError?: boolean }).isError === true;
  assert.ok(failed, "readonly 模式不該建立 worktree");
});

test("伺服器說明會依模式補充限制與交接提示", async (t) => {
  const readonly = await fixture(t, { DEVSPACE_ACCESS: "readonly" });
  const instructions = readonly.client.getInstructions() ?? "";
  assert.match(instructions, /read-only/);
  assert.match(instructions, /save_handoff/);

  const noHandoff = await fixture(t, { DEVSPACE_HANDOFF: "0" });
  assert.doesNotMatch(noHandoff.client.getInstructions() ?? "", /save_handoff/);
  assert.ok(!(await toolNames(noHandoff.client)).includes("save_handoff"));
});

test("open_workspace 附上建議的檢查指令", async (t) => {
  const { client, project } = await fixture(t);
  const opened = await open(client, project, "chat-1");
  assert.match(text(opened), /Suggested check commands .*npm test; npm run lint/);
  const structured = opened.structuredContent as { checkCommands?: string[] };
  assert.deepEqual(structured.checkCommands, ["npm test", "npm run lint"]);
});

test("save_handoff 存檔後，新對話開同一專案會帶回交接內容", async (t) => {
  const { client, project } = await fixture(t, {}, { git: true });
  const first = await open(client, project, "chat-1");
  assert.doesNotMatch(text(first), /Previous handoff/);
  const workspaceId = (first.structuredContent as { workspaceId: string }).workspaceId;

  const saved = await client.callTool({
    name: "save_handoff",
    arguments: {
      workspaceId,
      goal: "實作存取模式",
      done: "完成 config 與測試",
      next: "更新文件",
    },
  });
  assert.ok(!(saved as { isError?: boolean }).isError);
  assert.match(text(saved), /Handoff saved/);

  const second = await open(client, project, "chat-2");
  const message = text(second);
  assert.match(message, /Previous handoff/);
  assert.match(message, /實作存取模式/);
  assert.match(message, /更新文件/);
  assert.match(message, /branch: /);
  const structured = second.structuredContent as { handoff?: { markdown: string } };
  assert.match(structured.handoff?.markdown ?? "", /完成 config 與測試/);

  // 同一個對話再開一次（重用 workspace）不重複塞入交接內容
  const repeated = await open(client, project, "chat-2");
  assert.doesNotMatch(text(repeated), /Previous handoff/);
});

test("readonly 模式仍可儲存交接（只寫狀態目錄，不動專案）", async (t) => {
  const { client, project } = await fixture(t, { DEVSPACE_ACCESS: "readonly" });
  const first = await open(client, project, "chat-1");
  const workspaceId = (first.structuredContent as { workspaceId: string }).workspaceId;
  const saved = await client.callTool({ name: "save_handoff", arguments: { workspaceId, goal: "唯讀審查" } });
  assert.ok(!(saved as { isError?: boolean }).isError);
});
