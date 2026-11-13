# Chronicle

macOS 后台活动记录器：观察你在用什么应用、什么窗口、什么网址、焦点在哪个元素，
10 分钟一段落成 JSONL，再由 LLM 摘要器压缩成人类可读的时间线。本地 HTTP 服务 +
时间线 Web UI + **菜单栏 App** + MCP 面（让任意 AI 工具回答「我今天在电脑上做了什么」）。

**默认红线：不截屏、不录音、不读屏幕像素。** 后台只记录结构化事件（应用 / 窗口标题 /
浏览器当前标签 URL / 焦点元素角色与标题 / 滚动 / 屏幕可见窗口清单）。
唯一例外是**按需 OCR**：只有你点击「读取当前窗口文字」时，才截当前单窗口、在内存里做
本地 Vision 识别；图片不落盘，识别出的文字作为 `visual-text` 事件写入本机时间线。
密码框与系统级安全输入（secure input）出现时不读也不写任何内容；无痕浏览无条件排除；
URL 入盘默认去掉 query/fragment；可见窗口清单跳过浏览器与阻断应用。
数据都是纯文件（JSONL + JSON + Markdown），删了就没了。

## 组成

```
swift/chronicle-daemon.swift   采集守护（单文件 Swift，行协议 JSON 服务）
swift/ChronicleMenuBar.swift   菜单栏 App（状态/暂停/恢复/接入 AI/复制配置/开机自启/退出）
daemon.mjs                     Node 守护管理 + 本地 HTTP 服务（127.0.0.1:3777）
summarize.mjs                  LLM 摘要器（10min/6h 两级，openai-compatible / none）
mcp-entry.mjs                  stdio MCP 服务器（8 个 chronicle_* 工具）
setup.mjs                      安装：编译 → 建 ~/.chronicle/ → 装 Helper.app → 权限引导
uninstall.mjs                  卸载（--keep-data 可保留数据）
shared/privacy.mjs             观察规则闸门（Node 侧镜像，权威实现在 Swift 端）
shared/segments.mjs            段/事件共享读取层（daemon/summarize/MCP 共用）
shared/index.mjs               SQLite 事件索引（node:sqlite；不可用时自动回退线性扫描）
shared/compression.mjs         旧段 gzip 透明压缩（校验后删原件，读者/索引自动兼容）
shared/retention.mjs           数据保留策略（默认关闭；按天删除旧段与对应摘要）
shared/maintenance.mjs         维护编排（保留 → 压缩 → 索引；启动 5s 后 + 每 6 小时）
shared/work-ledger.mjs         工作对象 / 洞察 / 闭环账本（上限、异常、复盘、Context Pack）
shared/coverage.mjs            采集覆盖账本（按应用统计 AX 快照/节点/盲区）
shared/team.mjs                团队/交接包导出与导入（不含原始事件）
shared/audit.mjs + agent-*.mjs 审计 / Agent 注册与权限 / 可回滚动作执行
web/index.html + app.js + style.css   时间线 UI（无框架单页应用）
mcp-install.mjs                一键把 MCP 配置写入 Claude Code / Claude Desktop / Cursor / Codex / VS Code
install.command                双击安装器（检查环境 → 安装/升级 → 可选接入 AI）
INSTALL.md                     面向非技术用户的安装/启动/管理/接入/卸载文档
scripts/bench.mjs              10 万事件级基准（索引构建/搜索/分页延迟与内存）
test/*.test.mjs                测试（真 Swift 对拍 + mock 守护 + mock LLM + InMemoryTransport MCP）
test/fixtures/mock-daemon.mjs  Swift 守护的 Node 桩
```

## 快速开始

**最省事**：在 Finder 里双击 `install.command`，按提示走完即可（安装/升级、接入 AI 工具都在菜单里）。

```sh
npm run setup          # 编译守护 + 菜单栏 App + 建数据目录 + 权限引导（默认注册开机自启）
npm run daemon         # 启动采集 + HTTP 服务（127.0.0.1:3777）
npm test               # 跑测试（无 swiftc 自动 SKIP 真编译自检）
npm run service:install    # 只注册/刷新 launchd 开机自启（不重编译）
npm run service:uninstall  # 只卸载 launchd 服务（保留数据）
npm run maintain           # 手动跑一次维护（清理+压缩+索引）；加 `-- --dry-run` 只看不删
npm run bench              # 10 万事件基准（索引/搜索/分页延迟）
npm run mcp:install -- --target all --yes   # 一键把 MCP 配置接入 5 种 AI 工具（默认 dry-run，先看再写）
```

- 状态：`node daemon.mjs --status`（含 restarts / lastExit）　停止：`node daemon.mjs --stop`
- 崩溃自动重启：看护进程按 1/2/4/8/16/30 秒退避重启采集子进程，并**自动恢复采集**
  （崩前若为暂停则保持暂停）；日志在 `~/.chronicle/logs/`
- 时间线 UI：`http://127.0.0.1:3777/`（一天讲成一句话 + 波形 + 章节与时刻 + 搜索；另有记忆、设置）
- 菜单栏：安装后右上角出现 Chronicle 图标（状态 · 权限提醒 · 打开时间线 · 暂停/恢复 · AI 接入 · 复制配置 · 退出）
- 手动摘要：`npm run summarize`（默认扫待办；`--segment <ts>` / `--all` 强制重生成）

## 菜单栏 App（`~/.chronicle/Chronicle.app`）

`npm run setup` 会编译并安装一个菜单栏常驻的 `Chronicle.app`（`LSUIElement`，不占 Dock），
并注册 `com.chronicle.menubar` 开机自启（崩溃才自动拉起，手动「退出」不会复活）。

菜单项：

| 菜单项 | 作用 |
| --- | --- |
| 状态行 | 运行中 · 今日 N 条事件 / 已暂停 / 未运行 |
| 需要辅助功能权限 · 点击授权 | 仅在未授权时出现；调 `POST /api/permissions/request`，弹出系统授权框 |
| 需要屏幕录制权限（按需 OCR） · 点击授权 | 仅在未授权时出现；调 `POST /api/permissions/screen`，打开屏幕录制授权入口 |
| 打开时间线 | 打开 `http://127.0.0.1:3777/` |
| 暂停 15 分钟 / 暂停 1 小时 / 暂停直到手动恢复 | 调 `POST /api/pause`（不记内容，立刻生效） |
| 恢复记录 | 调 `POST /api/resume` |
| AI 工具接入… | 打开 Web 面板 `/#ai`（5 种客户端配置片段与复制） |
| 复制 MCP 配置 | 把 `mcp-install.mjs --print` 的单行 JSON 放进剪贴板 |
| 打开数据文件夹 / 查看日志 | 打开 `~/.chronicle/` 与 `~/.chronicle/logs/` |
| 开机自启 | 勾选状态 = launchd 是否已注册；点击切换 |
| 退出 | 只退出菜单栏 App，采集继续 |

- 不装菜单栏：`npm run setup -- --skip-menubar`；只重装菜单栏：`npm run setup -- --skip-compile --skip-service`
- 程序位置：`~/.chronicle/Chronicle.app`（ad-hoc 签名；移动仓库目录后重跑 `npm run setup`）

## 数据形态

```
~/.chronicle/
  config.json                       隐私规则 + summarizer + maintenance 配置
  segments/<UTC时间戳>/
    events.jsonl                    事件流（append-only，一行一个 JSON）
    events.jsonl.gz                 旧段压缩后（默认 7 天前；metadata 永不压缩）
    suppressed.jsonl                被抑制的记录（{ts, type, scope, reason}，无内容）
    suppressed.jsonl.gz             同上（压缩后）
    metadata.json                   {segmentStart, segmentEnd?, eventCount, suppressedEventCount, closedBy?}
  summaries/
    10min-<段名>.md                 10 分钟摘要（frontmatter + Markdown 正文）
    6h-<桶名>.md                    6 小时合并摘要（UTC 00/06/12/18 对齐桶）
  index/events.db                   SQLite 事件索引（可删，自动重建）
  logs/daemon-YYYYMMDD.log          守护日志（URL 一律脱敏，只记状态/计数/错误）
  Chronicle Helper.app/             权限主体（辅助功能挂它身上）
  daemon.pid / daemon.lock          守护 pidfile 与单实例锁
```

事件：`{ts, tsMs, type, data:{...}}`。基础类型 `app-switch` / `window-change` / `url-change` /
`focus-change`；内容类型 `click` / `context-menu` / `drag` / `shortcut` / `text-input` / `submit` /
`selection` / `ax-snapshot` / `scroll` / `visible-windows` / `visual-text`（仅按需 OCR）。
`ax-snapshot` 对 `AXTextArea`/`AXWebArea` 的值预算提高到 4000 字（终端/编辑器），
`AXValueChanged` 触发即时 diff；`scroll` 按 2 秒或 0.9 秒空闲聚合；`visible-windows`
每 30 秒最多采样一次，只在窗口集合变化时写，跳过浏览器/阻断应用/浮层/小窗；
无屏幕录制权限时系统会抹掉窗口标题，此时只记应用与窗口尺寸（不需要额外授权）。
`presence`（与内容类型同一开关）：每段开头记一次在场状态，之后键鼠空闲满 5 分钟记 `idle`、回来记 `active`，
另记 `locked` / `unlocked` / `sleep` / `wake`；只带状态、空闲秒数与前台应用名。换段时给同一前台应用补记的
`app-switch` 带 `reason: "segment-start"`，不算人在切换。
`visual-text` 只由 `POST /api/ocr` 或今天页按钮触发：单窗口、像素只在内存、需要屏幕
录制权限；受 blocklist / secure input / 无痕闸门约束。故意不暴露为 MCP 工具，避免 agent
自主截屏；必须由人显式触发。
采样每 2 秒一次；连续采样无变化不产生事件；每 10 分钟自动轮转新段，空闲不产生空段目录
（段关闭时 0 事件且 0 抑制记录则删除目录）。守护启动时修复上次崩溃留下的半开段
（补 `segmentEnd`，标 `closedBy: "repair"`），暂停期间到期段照常关闭。

## 隐私规则（`~/.chronicle/config.json`）

```json
{
  "enabled": true,
  "allowlist": [],
  "blocklist": [
    {"scope": "app", "value": "com.1password.*"},
    {"scope": "app", "value": "com.apple.keychainaccess"},
    {"scope": "url", "value": "*banking*"}
  ],
  "includeURLs": true,
  "includeFocusedElement": true,
  "privacy": {
    "redactURLQuery": true,
    "safariPrivateDetection": "heuristic",
    "excludeSafariURLs": false
  },
  "summarizer": {"enabled": false, "provider": "none"}
}
```

- 规则按 glob 匹配（`*` 任意序列，不区分大小写）：`app` 匹配 bundleId，`url` 匹配完整网址或域名
- **block 永远赢**：同时命中 allow 与 block 一律阻断
- allowlist 非空时，白名单外一律不观察（app 命中，或 URL 明确放行）
- **决策在读取内容之前**：被拦截的采样不会读窗口标题/焦点内容，也不写任何内容事件
  （旧实现"先记标题再过 URL 闸门"的泄漏已修复）
- 被抑制的事件不进 events.jsonl，只在 suppressed.jsonl 记 `{ts, type, scope, reason}`，
  reason ∈ `app-blocklist` / `url-blocklist` / `incognito` / `secure-input` /
  `not-in-allowlist` / `safari-url-excluded`；metadata 里累计 `suppressedEventCount`
- 密码框（AXSecureTextField）焦点内容永远不记录；**系统级 secure input**（任何应用进入
  安全输入状态）期间整个采样被抑制
- 浏览器无痕无条件排除（Chrome 系读窗口 mode；Safari 用启发式识别，见下）
- **URL 脱敏**：入盘默认去掉 query 与 fragment（`redactURLQuery`），规则匹配始终用原始 URL
- `includeURLs` / `includeFocusedElement` 可整类关闭；`excludeSafariURLs: true` 可强制
  Safari 完全不记 URL（对无痕检测不放心的强保证）
- Safari 无痕检测局限：只能靠窗口名/AX 窗口 chrome 关键词启发式，漏检属于已知风险；
  误检方向是"多抑制"（安全侧）。要绝对保证请开 `excludeSafariURLs`

## 权限

采集只需要「辅助功能」一项（读窗口标题与焦点元素）。`npm run setup` 会安装
`~/.chronicle/Chronicle Helper.app` 并弹出琥珀引导卡片——把卡片左侧图标拖进
系统设置的辅助功能列表即完成授权（终端是谁无关，授权一次永久生效）。
浏览器 URL 读取需要首次时的「自动化」确认（Apple Events）。

## 守护协议（stdin/stdout 行协议）

一行 JSON 请求 `{id, cmd, ...}` → 一行 JSON 响应 `{id, ok, ...}`：
`start {configPath?}` / `stop` / `pause {durationSec?}` / `resume` / `status` / `probe`
/ `decide {sample}`（纯决策、无副作用：返回 observe / blockedScope / reason / redactedURL，
供测试与 JS 侧逐条对拍）。
stdin EOF、SIGTERM、SIGINT 均触发优雅退出（写完当前段 metadata 再走）。
数据根目录可用环境变量 `CHRONICLE_HOME` 覆盖（测试用）。

## 可靠性（`daemon.mjs`）

- 单实例：`~/.chronicle/daemon.lock`；重复启动直接退出并打印正在运行的 pid
- 看护重启：采集子进程意外退出按 1/2/4/8/16/30 秒退避重启，并重放 `start` 自动恢复采集
  （崩前为暂停则恢复为暂停）；正常停止不重启
- 日志：`~/.chronicle/logs/daemon-YYYYMMDD.log`，10MB 轮转保留 7 份；写日志前 URL 脱敏，
  只记 pid / 计数 / 状态 / 错误码，不记标题与网址内容
- 开机自启：`npm run setup` 默认注册 `~/Library/LaunchAgents/com.chronicle.daemon.plist`
  （RunAtLoad + KeepAlive + ThrottleInterval=10）；`npm run service:uninstall` 移除
- 数据自愈：启动修复半开段、删除空段；停止/卸载会先校验进程归属（防 pid 复用误杀），
  卸载等进程退出后才删数据
- 维护调度：启动 5 秒后跑一次，之后每 6 小时一次（保留 → 压缩 → 索引，后台且不阻塞采集）

## 长期使用：保留与压缩（`maintenance`）

配置在 `config.json` 的 `maintenance` 段（不写则用默认值）：

```json
{
  "maintenance": {
    "retentionDays": 0,
    "compressAfterDays": 7
  }
}
```

- **`retentionDays` 默认 0 = 保留策略关闭，不会自动删任何数据**（安全默认）。
  设成 `90` 表示维护时删除 90 天前**已关闭**的段及其 10 分钟摘要；
  6 小时摘要只有当整个桶结束早于截止时间才删。open 段/无法解析的段永不删，
  单条删除失败只记日志不中断。
- **`compressAfterDays` 默认 7**：把 7 天前已关闭段的 `events.jsonl` /
  `suppressed.jsonl` 透明压成 `.gz`（`metadata.json` 不压；压缩后不更小的极小文件
  保持原样，避免无收益写放大）。压缩前会解压回读并逐字节校验，
  一致才删原文件；读/搜/摘要对 `.gz` 完全透明，旧数据无需迁移。
- 手动维护：`npm run maintain`；只看不删：`npm run maintain -- --dry-run`；
  临时覆盖保留天数：`node daemon.mjs --maintain --retention-days 30 [--dry-run]`
- 维护日志只记段名（时间戳）与计数，不记标题/URL。

## 性能（`npm run bench`）

本机（Apple silicon / Node 24）实测 100,000 事件、400 段、14 天：

| 指标 | 结果 |
| --- | --- |
| 首次建索引（SQLite） | 1.97 s |
| 搜索延迟（20 查询，limit 50） | P50 33 ms / P95 56 ms |
| 段分页（20 段/页，10 页） | P50 5.6 ms / P95 8.1 ms |
| 增量重建索引（无变化） | 14 ms |
| 索引进程内存增量 | +70 MB |
| 旧段压缩后重建索引 | 2.0 s（读 `.gz`，压缩前后查询结果一致） |

`npm test` 里有一条 30k 事件的性能门禁（索引 < 15 s、搜索 P95 < 800 ms、
分页 P95 < 300 ms、RSS < 1.5 GB），防止后续改动把查询变慢。

## LLM 摘要（`summarize.mjs`）

两级摘要，定时自动生成（守护启动 5 秒后扫一遍，之后每 3 分钟检查待补队列；无待补时零模型调用）：

- **10min 摘要**：段关闭后，把该段事件写成一份给本人看的大白话工作笔记（总览 / 经过 / 还没做完 / 背景 / 依据，≤1200 字；原始证据只放「依据」），
  存 `summaries/10min-<段名>.md`。采集器报告这段没人（`presence` 为 idle/locked/sleep）且期间没有任何输入、
  真实换应用或回到在场时，不调模型，只写一句「没人在操作」（frontmatter `presence: "unattended"`）；
  没有 `presence` 记录的旧段照常摘要
- **6h 摘要**：UTC 00/06/12/18 对齐的桶结束后，把桶内多个 10min 摘要合并成
  更粗粒度的总结（≤300 词），存 `summaries/6h-<桶名>.md`

在 `config.json` 加 `summarizer` 段启用（**默认关闭，只存原始 JSONL**）：

```json
{
  "summarizer": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseUrl": "https://llm.example.com/v1",
    "model": "your-model",
    "apiKeyEnv": "CHRONICLE_LLM_KEY"
  }
}
```

- 不硬编码任何 key 或 endpoint：`baseUrl`/`model` 你自己填，key 只从环境变量读
  （`apiKeyEnv` 存的是变量名，不是值）——`export CHRONICLE_LLM_KEY=sk-…` 后再启动守护
- `provider: "none"`（或整段不写）= 不调用任何 LLM，只留原始事件
- 提示词只要求事实（什么时间在什么应用做了什么），不推测意图、不复述敏感值
- 注意：启用即代表你选择把（已过隐私闸门的）事件内容发给你配置的 LLM endpoint
- **工程化**：原子写（temp + rename）；失败按 5/30/120 秒退避重试 3 次并记死信
  `summaries/_deadletter.log`；6h 摘要的源 10min 文件变化会自动重算（`--all` 强制）；
  6h 输入超过 30k 字符分块（头 + 尾 + 省略标记）；事件文本用 `<events>` 定界，
  摘要提示词声明它是不可信观察内容（防提示注入）
- frontmatter 记录 `model` / `promptVersion` / `sourceDigest` / `segments` /
  `usage`（API 返回时）

摘要文件自带 frontmatter（title / applications / segment / type），时间线 UI 的
摘要卡片与 MCP 的 `chronicle_summary` 都直接读它。手动补跑：`npm run summarize`。

### 断网 / 离线后的分析补跑

LLM 调用失败（断网、超时）不会让分析永久缺失：

- 守护每 3 分钟盘点一次待补：缺 10min 摘要的段、缺/过期 6h 摘要的桶、
  未合并进长期记忆的摘要、排队中的洞察；没有待补时零模型调用。
- 断网时一轮只尝试到第一个网络错误就停，按 1 / 2 / 5 / 10 / 15 分钟退避；
  网络恢复后自动补齐，顺序是 **摘要 → 记忆 → 洞察**。
- 洞察生成遇到网络错误会排队（`analysis-state.json`），不会丢请求。
- 今天页会显示「分析待补 N 项」和「立即补跑」按钮；也可调
  `GET /api/analysis/status`、`POST /api/analysis/retry`。
- 状态在 `~/.chronicle/analysis-state.json`（0600），记录上次成功/失败、退避时间与队列。

## 工作账本（P1 v0：对象 / 洞察 / 闭环）

按 `docs/product-blueprint.md` 第 14 章落地的最小后端：把“正在做的事”从模糊的“线程”拆成有生命周期的
工作对象（Task/Project/Goal/Area/Commitment/Decision/Insight/Incident），每个对象必须有下一步/复盘日期或归档；
活跃 Project ≤7、Goal ≤3、Insight ≤20，防止无限堆积。

```bash
node scripts/work-ledger.mjs seed                 # 从最近 10min 摘要的 next_actions + 正文启发式（承诺/决策/异常候选）生成 inbox
node scripts/work-ledger.mjs list                 # 查看对象
node scripts/work-ledger.mjs exceptions           # 停滞/失约/到期/无下一步/洞察过期
node scripts/work-ledger.mjs review --cadence today
node scripts/work-ledger.mjs stats                  # 结果指标：闭环率/洞察验证应用率/Inbox/异常
node scripts/work-ledger.mjs pack --object <id>     # 生成 Context Pack（交接/新 agent 的上下文包）
node scripts/work-ledger.mjs add --type project --title "Hulala 归档" --next "核对图片清单"
node scripts/work-ledger.mjs update <id> --state doing --next "打开 PDF"
node scripts/work-ledger.mjs sweep                # 24h Action 过期、7 天无主归档、14 天项目标 blocked
node scripts/work-ledger.mjs insight generate --min 3      # 从重复任务生成候选洞察（仍需 validate）
node scripts/work-ledger.mjs insight add --claim "PDF 图片校验总被低估" --evidence 10min-a.md --confidence 0.7
node scripts/work-ledger.mjs insight validate <id>
node scripts/work-ledger.mjs insight apply <id> --to task:...
node scripts/work-ledger.mjs coverage --days 7        # 近 7 天应用级采集覆盖/零 AX 盲区
node scripts/work-ledger.mjs team export --project <id> --out handoff.json
node scripts/work-ledger.mjs team import handoff.json # 新机器/新同事接手；重复导入自动跳过
```

数据在 `~/.chronicle/work-ledger.json`（原子写 0600）；审计在 `~/.chronicle/audit/`。
MCP 新增 `chronicle_work`（`view=objects|review|exceptions|insights|stats`）。
写接口：`POST/PATCH/DELETE /api/work/objects`、`POST /api/work/insights/:id/{validate,refute,apply,retire}`。
Agent 动作执行走 `POST /api/agents/:id/act`（需 L2），回滚 `POST /api/audit/:id/undo`；
注册/授权/审计明细均落 `~/.chronicle/audit/`。

## Web UI（`http://127.0.0.1:3777/`）

无框架单页应用，只有三个地方：**时间线**、**记忆**、**设置**。跟随系统浅色/深色，窄屏可用，全部离线。

| 页面 | 内容 |
| --- | --- |
| 时间线（`/`、`/?date=YYYY-MM-DD`） | 一句话讲清这一天：亲手操作多久、主要在哪些应用（真实应用图标）；「屏幕在变但你没动手」单独说。一天的波形：5 分钟一格，高=亲手操作，矮=开着没动手，颜色取自当时在用应用的图标。「接下来」：记忆里每件在推进的事的下一步，只读、不用勾选，做没做完由 AI 整理记忆时自己判断。章节 = 6 小时回顾，里面是每 10 分钟的时刻，长章节先露出最近 6 个。点任意时刻从右侧滑出阅读页（经过、还没做完、AI 建议的下一步、原始记录），可上下翻 |
| 记忆（`/?view=memory`） | 你在推进的事（状态、最近进展、下一步；点开看任务组与相关时刻）、关于你、习惯、经验、回顾（可让 AI 写今天/这一周）、技能。状态全由 AI 根据之后的记录判断：做出来并转去做别的算做完，明确卡住算卡住，7 天没再出现就不再列出 |
| 设置（`/?view=settings#recording|privacy|model|ai|data`） | 记录开关/暂停/权限/读取窗口文字；隐私开关与「不记录的应用和网站」（可从最近用过的里选，带图标，可撤销）；AI 整理（服务商、模型、Key、测试连接）；接入 AI 工具（复制配置片段）；保留天数与清空 |

- 搜索：`⌘K` 或 `/`，同时搜 AI 摘要与原始记录；只因前台应用名命中的窗口清单不算结果。
- 应用图标来自 `GET /api/app-icon?bundleId=…`（本机渲染并缓存到 `~/.chronicle/cache/app-icons/`），拿不到时退成字母方块。
- 「亲手操作」= 最近一次点击/输入/滚动/快捷键/选中/真实切换应用之后 5 分钟内；换段时守护补的同应用 `app-switch` 不算。
- 今天的时间线每分钟静默刷新，保持滚动位置与焦点；记录状态每 15 秒刷新。

## HTTP API（127.0.0.1:3777，全部 JSON）

```
GET    /                            时间线 UI（静态文件白名单：index/app.js/style.css）
GET    /api/status                  守护状态（含 restarts / lastExit / managerPid）
GET    /api/overview?date=YYYY-MM-DD 某天的概览聚合（首末/时长/TOP 应用/24h 缎带；只读不建索引）
GET    /api/permissions             辅助功能/屏幕录制授权状态（{axGranted, screenGranted, secureInput}）
POST   /api/permissions/request     弹出辅助功能标准授权框（点「打开系统设置」→ 打开 Chronicle Helper）
POST   /api/permissions/screen      弹出屏幕录制授权入口（仅按需 OCR 需要）
POST   /api/ocr                     按需读取当前单窗口文字（本地 Vision OCR；像素不落盘，文字写 visual-text）
GET    /api/model/config            模型配置（密钥只回 hasKey/keySource，不回显）
PUT    /api/model/config            保存模型配置（可选 key → 写入 secrets.json 0600）
POST   /api/model/test              测试连接（GET /models + 固定 ping，不发送任何事件数据）
POST   /api/summarize/run           立即分析一次（{segment?}，默认扫待办段）
POST   /api/maintain                手动维护（{dryRun?:boolean} → 保留/压缩/索引报告）
GET    /api/integrations            AI 客户端接入信息（配置路径 + 片段，含绝对路径）
GET    /api/segments?limit=&before= 段列表（分页：{items, hasMore, nextBefore}，默认 20，上限 200）
GET    /api/segment/:ts/events      段事件（?withSuppressed=1 附带抑制记录）
GET    /api/summaries               摘要列表（含 frontmatter 元信息与正文）
GET    /api/summaries/:file         单个摘要全文（文件名白名单校验，拒绝穿越）
GET    /api/search?q=&limit=&offset=&from=&to=  跨段搜索（索引优先，回退线性扫描）
GET    /api/memory                  长期记忆聚合（memory_summary.md / MEMORY.md / 最近摘要）
GET    /api/analysis/status         分析待补队列（摘要/记忆/洞察；含离线与下次重试时间）
POST   /api/analysis/retry          立即补跑一轮分析（网络恢复后自动补齐）
GET    /api/work?cadence=&type=&state=&q=&status=  工作对象/异常/复盘/洞察只读聚合
GET    /api/work/pack?objectId=&projectId=  生成 Context Pack（对象/洞察/open loops/证据）
GET    /api/coverage?days=7         按应用统计 AX 覆盖/零 AX 盲区/前台时长
GET    /api/team/pack?projectId=&days=  导出团队/交接包（对象+洞察+handoff Markdown）
POST   /api/team/import             导入团队包（新 id、引用重映射、重复跳过）
GET    /api/audit?date=&limit=       工作对象/洞察/Agent 写操作的审计日志
GET    /api/agents                  Agent 注册表
POST   /api/agents                  注册 Agent（默认 L0）
POST   /api/agents/:id/grants       临时授权（L1–L3 + scope + 过期）
DELETE /api/agents/:id/grants/:gid  撤销授权
POST   /api/agents/:id/check        权限检查（level + scope）
POST   /api/agents/:id/outcome      记录 success/corrections/incidents
POST   /api/agents/:id/act          执行账本动作（需 L2；写审计，可撤销）
POST   /api/audit/:id/undo          撤销一次 Agent 动作（恢复 before 快照）
GET    /api/config                  读隐私配置
PUT    /api/config                  写隐私配置（形状校验；采集在跑则热重启生效）
DELETE /api/history                 清空全部段落与摘要（config/Helper.app 不动）
POST   /api/pause {durationSec?}    暂停
POST   /api/resume                  恢复
```

写接口（PUT / POST / DELETE）要求 Host 为 127.0.0.1/localhost、存在 Origin 时必须同源、
带 body 时 `Content-Type: application/json`（跨站页面无法静默改配置或暂停采集）；
段名与摘要文件名做严格正则 + realpath 包含检查，拒绝路径穿越。
搜索时间范围：`from` / `to` 支持毫秒时间戳、ISO 或 `YYYY-MM-DD`（本地时区）。

## MCP 面（`mcp-entry.mjs`）

stdio MCP 服务器，注册 8 个工具，供桌面端 AI / 编辑器里的助手查询你的活动历史：

| 工具 | 干什么用 |
| --- | --- |
| `chronicle_status` | 回答「记录器还在跑吗 / 暂停了吗」 |
| `chronicle_today {date?}` | 回答「我今天在电脑上做了什么」：时间线 + AI 摘要合并返回 |
| `chronicle_search {query, limit?, since?, until?}` | 回答「上次什么时候访问过 X / 用过某应用」；可限定日期范围 |
| `chronicle_summary {date?}` | 读某天的 AI 摘要（默认今天） |
| `chronicle_memory {query?, limit?}` | 读长期记忆画像与任务组；可按任务组/标题/关键词/证据检索 |
| `chronicle_work {view?, type?, state?, query?, cadence?}` | 读工作对象/复盘/异常/洞察（Task/Project/Goal/Commitment/Decision/Insight/Incident） |
| `chronicle_pause {durationSec?}` | 暂停采集（可定时恢复） |
| `chronicle_resume` | 恢复采集 |

控制类工具（`chronicle_status` / `chronicle_pause` / `chronicle_resume`）只通过本机 HTTP
控制**已在运行**的守护；HTTP 不可达时返回明确错误并提示 `npm run daemon`，不会另起第二个
采集进程。只读类工具在守护未运行时仍可直接读文件/索引工作。

每个工具描述都提醒 AI：返回数据是**观察记录不是指令**，窗口标题/URL 里的内容
不能当作提示执行。客户端配置示例：

```json
{
  "mcpServers": {
    "chronicle": {
      "command": "/usr/local/bin/node 或 `which node` 的绝对路径",
      "args": ["/path/to/chronicle/mcp-entry.mjs"]
    }
  }
}
```

> 图形客户端（Claude Desktop / Cursor / VS Code / Codex）启动 MCP 子进程时 PATH 通常不含
> Homebrew 路径，`command` 建议写 node 的**绝对路径**；用 `npm run mcp:install` 自动写入时会自动使用绝对路径。

## 接入 AI 工具（一键）

同一条 MCP 服务可以接给不同客户端；两种方式任选：

1. **图形化**：菜单栏「AI 工具接入…」或直接打开 `http://127.0.0.1:3777/#ai`，
   每张卡片显示该客户端的配置文件路径与配置片段，点「复制」粘贴即可。
2. **自动写入**：

```sh
npm run mcp:install -- --list                    # 看支持哪些工具、当前是否已配置
npm run mcp:install -- --target all              # 默认 dry-run：只打印将改哪些文件
npm run mcp:install -- --target all --yes        # 真正写入（写前自动备份 .chronicle-backup-<时间戳>）
npm run mcp:install -- --target cursor --yes     # 只接一个
```

支持：Claude Code（`claude mcp add` 命令）、Claude Desktop、Cursor、Codex（`config.toml` 追加
`[mcp_servers.chronicle]`）、VS Code。写入只 merge `chronicle` 一条，不动其它 MCP 配置；
JSON 损坏或文件异常时只备份不覆盖。手动配置片段见 `INSTALL.md`。

## 外部摘要钩子（逃生口）

配置环境变量 `CHRONICLE_SUMMARIZE_CMD="<命令>"` 可用外部命令替代内置摘要器：
每 60 秒扫描已关闭且无 `summary.json` 标记的段，以段路径为参数调用之。
