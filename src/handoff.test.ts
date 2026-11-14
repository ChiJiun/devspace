import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handoffDir,
  handoffKey,
  loadLatestHandoff,
  MAX_FIELD_CHARS,
  MAX_HANDOFFS_PER_PROJECT,
  renderHandoff,
  saveHandoff,
} from "./handoff.js";

// key：同一路徑穩定、不同路徑不同；Windows 不分大小寫
assert.equal(handoffKey("/work/a", "linux"), handoffKey("/work/a", "linux"));
assert.notEqual(handoffKey("/work/a", "linux"), handoffKey("/work/b", "linux"));
assert.equal(handoffKey("C:\Work\A", "win32"), handoffKey("c:\work\a", "win32"));
assert.match(handoffKey("/work/a"), /^[0-9a-f]{16}$/);

// 內容
const savedAt = new Date("2026-11-14T04:15:00.000Z");
const markdown = renderHandoff(
  { goal: "加存取模式", done: "完成 config", next: "寫測試" },
  { branch: "main", head: "abc123", status: [" M src/a.ts"], recentCommits: ["abc123 init"], diffStat: "1 file changed" },
  { projectRoot: "/work/a", workspaceId: "ws-1", savedAt },
);
assert.match(markdown, /^# Handoff — 2026-11-14T04:15:00.000Z/);
assert.match(markdown, /## Goal\n加存取模式/);
assert.match(markdown, /## Done\n完成 config/);
assert.match(markdown, /## Next steps\n寫測試/);
assert.doesNotMatch(markdown, /## Decisions/);
assert.match(markdown, /branch: main @ abc123/);
assert.match(markdown, /`\sM src\/a.ts`/.source ? / M src\/a\.ts/ : /x/);
assert.match(markdown, /recent commits:\n- abc123 init/);

// 過長欄位會被截斷
const long = renderHandoff(
  { goal: "g", notes: "x".repeat(MAX_FIELD_CHARS + 500) },
  {},
  { projectRoot: "/p", workspaceId: "w", savedAt },
);
assert.ok(long.includes("…"));
assert.ok(long.length < MAX_FIELD_CHARS + 600);

const stateDir = await mkdtemp(join(tmpdir(), "devspace-handoff-"));
try {
  const project = join(stateDir, "project");
  assert.equal(await loadLatestHandoff(stateDir, project), undefined);

  // 儲存多份：載入的是最新一份；超過上限會清掉最舊的
  for (let i = 0; i < MAX_HANDOFFS_PER_PROJECT + 3; i += 1) {
    await saveHandoff({
      stateDir,
      projectRoot: project,
      workspaceId: "ws",
      input: { goal: `goal ${i}` },
      gitSnapshot: {},
      now: new Date(Date.UTC(2026, 10, 14, 4, i, 0)),
    });
  }
  const files = await readdir(handoffDir(stateDir, project));
  assert.equal(files.length, MAX_HANDOFFS_PER_PROJECT);
  const latest = await loadLatestHandoff(stateDir, project);
  assert.match(latest?.markdown ?? "", new RegExp(`goal ${MAX_HANDOFFS_PER_PROJECT + 2}`));
  assert.equal(latest?.truncated, false);

  // 同一時間點重複儲存不會覆蓋
  const same = new Date(Date.UTC(2027, 0, 1));
  const first = await saveHandoff({ stateDir, projectRoot: project, workspaceId: "ws", input: { goal: "a" }, gitSnapshot: {}, now: same });
  const second = await saveHandoff({ stateDir, projectRoot: project, workspaceId: "ws", input: { goal: "b" }, gitSnapshot: {}, now: same });
  assert.notEqual(first.name, second.name);
  assert.match((await loadLatestHandoff(stateDir, project))?.markdown ?? "", /## Goal\nb/);

  // 載入時超過字數上限會標示 truncated
  const small = await loadLatestHandoff(stateDir, project, 20);
  assert.equal(small?.truncated, true);
  assert.ok((small?.markdown.length ?? 0) <= 20);

  // 不同專案互不影響
  assert.equal(await loadLatestHandoff(stateDir, join(stateDir, "other")), undefined);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
