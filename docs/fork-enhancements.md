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

### 1. 交接 `save_handoff`

長對話會越來越慢，建議每個小任務開新對話。`save_handoff` 讓新對話接得上：

- 模型呼叫 `save_handoff`，填入目標、已完成、決策、下一步（可再加備註）；伺服器會自動附上 Git 狀態（branch、HEAD、未提交變更、最近 5 個 commit）。
- 內容存成 Markdown，放在 `<stateDir>/handoffs/<專案路徑雜湊>/`，**不寫進專案**，也不會出現在 `git status`。每個專案最多保留最近 10 份。
- 下次 `open_workspace` 開同一個專案（worktree 以來源專案為準）時，回應會附上最新一份（最多 6000 字元）；同一個對話重複開同一個 workspace 不會重複附上。
- `DEVSPACE_HANDOFF=0` 可關閉（連工具都不會註冊）。
- 請不要把密碼、token 放進交接內容。

### 2. 建議的檢查指令

`open_workspace` 會讀專案根目錄的設定檔，列出可能的驗證指令（不執行、不保證存在）：

- `package.json` 的 `test`、`typecheck`、`lint`、`check`、`build`（依 lockfile 判斷 npm／pnpm／yarn／bun；略過 npm 預設的假 `test`）
- `pytest`（有 pytest 設定時）、`ruff check .`、`cargo test`、`go test ./...`
- `Makefile` 的 `test`、`check`、`lint` target

### 3. 程式碼智慧（移植自 CodexPro）

三個唯讀工具，讓模型接手陌生專案時不用先跑一堆 `ls`、`grep`：

| 工具 | 用途 |
| --- | --- |
| `inspect_workspace` | 專案概覽：專案類型、語言、入口檔、重要檔案、頂層目錄；帶 `path` 時列出該目錄／檔案定義的函式、類別、型別。 |
| `search_code` | 搜尋文字或符號，結果分成「定義／引用／測試／設定／文件」並排序；`intent=references` 或 `impact` 會找出 import 了定義檔的檔案。 |
| `review_impact` | 給定改動的檔案（不給就用 `git status`），列出依賴它們的檔案、可能相關的測試、風險訊號（驗證、設定、資料庫等）與建議的驗證指令。 |

- 檔案清單在 Git 專案用 `git ls-files`（自動遵守 `.gitignore`），否則自己走訪並略過 `node_modules`、`dist` 等；單檔超過 2 MB 不分析。
- 符號與 import 是用正規表示式抽出來的（TS/JS、Python、Go、Rust、Swift、Java、C#、C/C++），**不是編譯器等級的索引**，只有相對路徑的 import 會建立關係。工具的說明文字也這樣告訴模型。
- 分析結果依檔案大小與修改時間做快取，檔案變動後自動失效。
- 搜尋結果會遮蔽常見的金鑰格式（`redact.ts`）。
- `DEVSPACE_ANALYSIS=0` 可關閉。

## 程式碼來源與授權

下列程式碼是**直接移植**後再修改的，都是 MIT 授權；每個檔案開頭註明來源與改了什麼，授權全文在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)：

- [CodexPro](https://github.com/rebel0789/codexpro)：`src/analysis/*`（types、classify、extract、graph、rank、cache 幾乎原樣；index、impact、inventory 為了脫離 CodexPro 的 config／PathGuard 而改寫）、`src/redact.ts`。`review_impact` 的建議指令改用本專案的 `project-checks.ts`，取代 CodexPro 原本的偵測。

## 想法的來源（自己重寫，沒有複製程式碼）

這些功能是讀過下列專案的 README／文件後，用自己的程式重新實作的（沒有複製它們的程式碼）：

- [CatDesk](https://github.com/Xeift/CatDesk)（Rust）：對話交接（handoff）的概念。
- [CodexPro](https://github.com/rebel0789/codexpro)：依專案偵測驗證指令的概念（`project-checks.ts` 為自行撰寫）。

## 沒做的事

- Desktop Commander 的工具（背景搜尋、`read_multiple_files`、PDF／Excel 讀寫等）：還沒評估哪些值得移植。
- 瀏覽器控制（CatDesk 的 chrome-devtools-mcp 整合）。
- 權限模式、指令白名單／黑名單：刻意不做。所有工具一律完整開放，要限制模型的行為就在對話的 prompt（或專案的 AGENTS.md）裡說明，由使用者自己決定。

## 更新到使用中的版本

這些改動不會自動影響正在跑的 DevSpace。要啟用時：

```bash
git checkout chijiun/enhancements
npm ci
npm run build
```

然後重啟 DevSpace（例如重新啟動 Windows 工作排程 `DevSpace MCP Server`，或重啟 systemd 服務）。
