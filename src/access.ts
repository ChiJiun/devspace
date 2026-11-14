// 存取模式：限制 MCP 用戶端能做的事。
//   full      預設，行為與原版相同（可讀、寫、執行指令）
//   no-shell  可讀寫專案檔案，但不提供任何 shell 工具（bash / exec_command / write_stdin）
//   readonly  只能讀；不註冊寫入、patch、shell 工具，也不允許建立 worktree
// 這是「少暴露工具」的做法，不是作業系統層級的沙箱。
export type AccessMode = "full" | "no-shell" | "readonly";

export const ACCESS_MODES: readonly AccessMode[] = ["full", "no-shell", "readonly"];

export function parseAccessMode(value: string | undefined): AccessMode {
  const mode = value?.trim().toLowerCase();
  if (!mode) return "full";
  if ((ACCESS_MODES as readonly string[]).includes(mode)) return mode as AccessMode;
  throw new Error(`Invalid DEVSPACE_ACCESS: ${value} (use full, no-shell, or readonly)`);
}

export function allowsWrites(mode: AccessMode): boolean {
  return mode !== "readonly";
}

export function allowsShell(mode: AccessMode): boolean {
  return mode === "full";
}

export function allowsWorktrees(mode: AccessMode): boolean {
  return mode !== "readonly";
}

export function describeAccessMode(mode: AccessMode): string | undefined {
  switch (mode) {
    case "readonly":
      return "This DevSpace server is read-only: it cannot modify files, run shell commands, or create worktrees. Inspect and explain; do not attempt changes.";
    case "no-shell":
      return "This DevSpace server has no shell access: use file tools only for reading and editing. Do not try to run tests, builds, or Git commands; tell the user which commands to run themselves.";
    default:
      return undefined;
  }
}
