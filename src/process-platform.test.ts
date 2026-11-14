import assert from "node:assert/strict";
import {
  parseWslWorkspacePath,
  resolveShellCommand,
  resolveWslShellCommand,
  terminateProcessTree,
} from "./process-platform.js";

assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-lc", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" }), {
  executable: "/bin/sh",
  args: ["-c", "echo ok"],
});

assert.deepEqual(
  parseWslWorkspacePath("\\\\wsl.localhost\\Ubuntu\\home\\user\\project", "win32"),
  { distro: "Ubuntu", linuxPath: "/home/user/project" },
);
assert.deepEqual(
  parseWslWorkspacePath("\\\\wsl$\\Ubuntu-24.04\\home\\user\\project", "win32"),
  { distro: "Ubuntu-24.04", linuxPath: "/home/user/project" },
);
assert.equal(
  parseWslWorkspacePath("\\\\server\\share\\project", "win32"),
  undefined,
);
assert.equal(
  parseWslWorkspacePath("\\\\wsl.localhost\\Ubuntu\\home\\user\\project", "linux"),
  undefined,
);
assert.deepEqual(
  resolveWslShellCommand(
    "npm test",
    "\\\\wsl.localhost\\Ubuntu\\home\\user\\project",
    "win32",
  ),
  {
    executable: "wsl.exe",
    args: [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/user/project",
      "--",
      "bash",
      "-lc",
      "npm test",
    ],
  },
);

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);
