// 移植自 CodexPro（https://github.com/rebel0789/codexpro），MIT 授權，Copyright (c) 2026 CodexPro contributors。
// 原始檔：src/analysis/cache.ts。授權全文見專案根目錄的 THIRD_PARTY_NOTICES.md。
// 修改：改成不依賴 CodexPro 的 config／PathGuard，直接使用工作區根目錄。
import type { WorkspaceAnalysis } from "./types.js";

const MAX_CACHE_ENTRIES = 8;
const cache = new Map<string, WorkspaceAnalysis>();

export function getCachedWorkspaceAnalysis(key: string): WorkspaceAnalysis | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function setCachedWorkspaceAnalysis(key: string, value: WorkspaceAnalysis): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function invalidateWorkspaceAnalysis(workspaceId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
  }
}
