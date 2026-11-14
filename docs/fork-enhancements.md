# ChiJiun fork：新增功能與差異

這個 fork 是從 [Waishnav/devspace](https://github.com/Waishnav/devspace) 分出來的個人版本。
上游持續更新中；這份文件只記錄 fork 與上游不同的地方。

## 分支說明

| 分支 | 內容 |
| --- | --- |
| `chijiun/current` | 我平常實際在用的版本：上游 + [PR #181](https://github.com/Waishnav/devspace/pull/181)（讓 bash 工具的說明允許 `git add/commit/fetch/pull/push`，仍禁止破壞性 Git 指令）+ WSL 工作區的 shell 支援（`\\wsl.localhost\...` 路徑改由 `wsl.exe` 在對應發行版執行指令）。 |
| `chijiun/enhancements` | 在 `chijiun/current` 之上加入下面三個功能。 |

> 注意：這兩個分支都是以較舊的上游為基礎（當時上游 `main` 比它多約 600 個提交）。
> 之後要追上游需要合併，`server.ts` 的 bash 說明可能會有衝突。

## 新功能

### 1. 存取模式 `DEVSPACE_ACCESS`

限制 MCP 用戶端能做的事，適合把 DevSpace 放在 VM 或共用環境。

| 值 | 效果 |
| --- | --- |
| `full`（預設） | 與原版相同。 |
| `no-shell` | 可讀寫專案檔案，但不註冊 `bash`、`exec_command`、`write_stdin`。 |
| `readonly` | 只能讀：不註冊 `write`、`edit`、`apply_patch` 與所有 shell 工具，也拒絕 `mode="worktree"`。 |

- 伺服器說明會依模式提醒模型「不能改檔／不能跑指令」，避免它一直嘗試呼叫不存在的工具。
- 填錯值會在啟動時直接失敗。
- **這只是少暴露工具，不是作業系統層級的沙箱。** `full` 與 `no-shell` 之外的邊界仍要靠使用者帳號權限、`allowedRoots` 與容器／VM 隔離。

### 2. 交接 `save_handoff`

長對話會越來越慢，建議每個小任務開新對話。`save_handoff` 讓新對話接得上：

- 模型呼叫 `save_handoff`，填入目標、已完成、決策、下一步（可再加備註）；伺服器會自動附上 Git 狀態（branch、HEAD、未提交變更、最近 5 個 commit）。
- 內容存成 Markdown，放在 `<stateDir>/handoffs/<專案路徑雜湊>/`，**不寫進專案**，也不會出現在 `git status`。每個專案最多保留最近 10 份。
- 下次 `open_workspace` 開同一個專案（worktree 以來源專案為準）時，回應會附上最新一份（最多 6000 字元）；同一個對話重複開同一個 workspace 不會重複附上。
- `DEVSPACE_HANDOFF=0` 可關閉（連工具都不會註冊）。`readonly` 模式下仍可儲存，因為它只寫狀態目錄。
- 請不要把密碼、token 放進交接內容。

### 3. 建議的檢查指令

`open_workspace` 會讀專案根目錄的設定檔，列出可能的驗證指令（不執行、不保證存在）：

- `package.json` 的 `test`、`typecheck`、`lint`、`check`、`build`（依 lockfile 判斷 npm／pnpm／yarn／bun；略過 npm 預設的假 `test`）
- `pytest`（有 pytest 設定時）、`ruff check .`、`cargo test`、`go test ./...`
- `Makefile` 的 `test`、`check`、`lint` target

## 想法的來源

這三個功能是讀過下列專案的 README／文件後，用自己的程式重新實作的（沒有複製它們的程式碼）：

- [CatDesk](https://github.com/Xeift/CatDesk)：對話交接（handoff）的概念。
- [CodexPro](https://github.com/rebel0789/codexpro)：只開放必要工具的模式、依專案偵測驗證指令。
- [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP)：明確區分「護欄」與「真正的隔離」。

## 沒做的事

- 程式碼智慧（符號／引用／影響範圍搜尋）：用 `bash` 搭配 `rg` 也能做，沒有專用工具。
- 瀏覽器控制（CatDesk 的 chrome-devtools-mcp 整合）。
- 指令白名單／黑名單：用字首比對很容易被 `;`、`&&`、子 shell 繞過，容易給人錯誤的安全感，所以選擇直接不提供 shell（`no-shell`、`readonly`）。

## 更新到使用中的版本

這些改動不會自動影響正在跑的 DevSpace。要啟用時：

```bash
git checkout chijiun/enhancements
npm ci
npm run build
```

然後重啟 DevSpace（例如重新啟動 Windows 工作排程 `DevSpace MCP Server`，或重啟 systemd 服務）。
在環境變數或服務的環境檔加上 `DEVSPACE_ACCESS=readonly` 之類的設定即可切換模式。
