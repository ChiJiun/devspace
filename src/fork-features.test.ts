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

test("伺服器說明提到交接，且一律提供完整工具", async (t) => {
  const full = await fixture(t);
  assert.match(full.client.getInstructions() ?? "", /save_handoff/);
  const tools = await toolNames(full.client);
  for (const name of ["write", "edit", "bash"]) {
    assert.ok(tools.includes(name), `應有 ${name}`);
  }

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
