# Chronicle 安装与使用指南

> 面向非技术用户的完整说明。全程只需要复制粘贴命令，或直接双击安装器。
> Chronicle 是**本地**工具：不截屏、不录音、不读屏幕像素；数据只存在你自己的 Mac 上
> （`~/.chronicle/`），默认不联网、无遥测、无账号。

---

## 30 秒速查表

| 我想…… | 怎么做 |
| --- | --- |
| 安装 / 升级 | 双击 `install.command`，选 `1` |
| 打开时间线 | 先运行 `npm run daemon`，再打开 <http://127.0.0.1:3777/> |
| 查看是否在记录 | `node daemon.mjs --status` |
| 暂停 / 恢复记录 | 时间线页面顶栏的「⏸ 暂停 / ▶ 恢复」 |
| 改隐私规则（屏蔽某应用/网站） | 时间线页面右上角「⚙ 设置」 |
| 接入 AI 工具 | 菜单栏「AI 工具接入…」，或 `node mcp-install.mjs --target all --yes` |
| 检查 AI 接入状态 | `node mcp-install.mjs --list` |
| 开机自启（登录自动记录） | 安装时默认已注册；手动刷新：`npm run service:install` |
| 临时停止自启 | `npm run service:uninstall`（保留所有数据） |
| 手动整理旧数据 | 先预览 `npm run maintain:dry`，确认后 `npm run maintain` |
| 卸载但保留数据 | `node uninstall.mjs --keep-data` |
| 卸载并删除全部数据 | `node uninstall.mjs`（不可恢复） |

> 所有命令都在 Chronicle 项目文件夹（含 `package.json` 的目录）里执行。不确定时先
> `cd` 到该目录，例如 `cd ~/Downloads/chronicle`。

---

## 1. 系统要求

- macOS（采集依赖 Accessibility / AppleScript；仅支持 Mac）
- Node.js **18 或更高版本**（推荐用 [nodejs.org](https://nodejs.org/zh-cn) 安装包或 `brew install node`）
- Xcode 命令行工具（提供 `swiftc`，用于编译采集守护）：
  终端运行 `xcode-select --install`，按提示安装即可
- 磁盘空间：很小（纯文本数据；10 万事件约几十 MB，压缩后更小）

检查环境（在项目目录执行）：

```sh
node --version       # 需要 >= 18
npm --version
swiftc --version     # 没有就运行 xcode-select --install
```

---

## 2. 安装

### 方式 A：双击安装（推荐）

1. 在 Finder 里双击项目目录下的 **`install.command`**（macOS 会用「终端」打开它）。
2. 安装器会自动检查 Node.js / npm / swiftc；缺哪个会给出安装提示。
3. 在菜单里输入 `1` 回车 → 选择「安装 / 升级 Chronicle」。
4. 看到「安装 / 升级完成」即可。

> 首次双击如果被 macOS 拦截（提示"无法打开，因为来自身份不明的开发者"），
> 请右键点 `install.command` →「打开」→ 再点「打开」。
> 也可以在终端执行 `chmod +x install.command` 后再双击。

### 方式 B：终端命令

```sh
cd /path/to/chronicle     # 进入项目目录
npm install               # 安装 Node 依赖（首次需要）
npm run setup             # 编译采集守护 + 建数据目录 + 装权限主体 + 权限引导
```

`npm run setup` 会做这些事：

1. 用 `swiftc` 编译采集守护（`swift/chronicle-daemon.swift`）；
2. 创建数据目录 `~/.chronicle/`（隐私规则 `config.json` 首次会写入安全默认值）；
3. 安装 `~/.chronicle/Chronicle Helper.app`（系统权限挂在这个 app 上，之后授权一次长期有效）；
4. 弹出「辅助功能」授权引导卡片，并打开系统设置对应页面；
5. **默认注册开机自启**（launchd：登录自动启动、崩溃自动拉起）。

### 授权辅助功能（必做）

1. 安装时屏幕上会出现一张琥珀色引导卡片；
2. 按卡片提示：系统设置 →「隐私与安全性」→「辅助功能」；
3. 把卡片左侧的 **Chronicle Helper** 图标拖进列表（或点「+」选择 `~/.chronicle/Chronicle Helper.app`），并打开开关；
4. 授权生效后卡片会自动消失。

> 只有「辅助功能」一项是采集必需的。浏览器标签 URL 需要 **「自动化」** 权限：
> 首次读取浏览器标签时会弹一次系统确认，点「允许」即可。拒绝也不影响其他记录，
> 只是拿不到网址。

---

## 3. 启动并打开时间线

```sh
npm run daemon
```

看到「HTTP 127.0.0.1:3777」字样后，打开浏览器访问：

**<http://127.0.0.1:3777/>**

- 页面每 5 秒自动刷新；顶部状态行显示「采集中 / 已暂停」。
- 首次安装后等 10 分钟左右，AI 摘要（若已配置 LLM）与首段时间线就会出现。
- 想让它自己常驻：安装时已默认注册开机自启；也可以把 `npm run daemon` 放在一个不关的终端里。

---

## 4. 日常管理

### 暂停 / 恢复

- 时间线页面顶栏：`⏸ 暂停` / `▶ 恢复`（暂停时顶栏有琥珀色「已暂停」标记）。
- 暂停期间不采集任何事件；恢复后从当前状态继续。

### 隐私规则

时间线右上角「⚙ 设置」可编辑：

- **总开关**：关闭 = 完全停止记录；
- **blocklist（阻断名单）**：每行一条，如 `app:com.1password.*`、`url:*banking*`；
- **allowlist（白名单）**：留空 = 观察所有未被阻断的应用；填写后只观察名单内应用；
- **规则语义：block 永远赢**（同时命中白名单与黑名单时一律阻断，不会记录内容）；
- 保存后如果采集在运行，会自动重启观察让规则立即生效。

被规则抑制的采样只写一行**无内容**的审计记录（时间 + 原因，如 `app-blocklist`），
不写应用名、窗口标题或网址。

### 查看状态 / 停止

```sh
node daemon.mjs --status    # 是否运行、当前段、累计事件
node daemon.mjs --stop      # 停止记录器（数据保留，下次启动继续累积）
```

### 开机自启（launchd）

安装时默认已注册。手动管理：

```sh
npm run service:install     # 注册/刷新自启（登录自动运行、崩溃自动拉起）
npm run service:uninstall   # 移除自启（保留数据与程序）
```

自启日志在 `~/.chronicle/logs/`（URL 一律脱敏，不记录标题/网址内容）。

### 长期使用：保留与压缩（可选）

默认**不会自动删除任何数据**。如需自动清理旧数据，编辑 `~/.chronicle/config.json`：

```json
{
  "maintenance": {
    "retentionDays": 90,
    "compressAfterDays": 7
  }
}
```

- `retentionDays: 0`（默认）= 永不自动删除；
- `compressAfterDays: 7`（默认）= 把 7 天前已关闭的旧段透明压缩成 `.gz`（读取/搜索无感）；
- 手动维护：`npm run maintain:dry`（只预览，不删不改）→ `npm run maintain`。

---

## 5. 接入 AI 工具（让 AI 能问「我今天做了什么」）

Chronicle 通过 **MCP**（Model Context Protocol）把自己的历史记录提供给 AI 工具。
支持 5 种客户端：Claude Code、Claude Desktop、Cursor、Codex CLI、VS Code。

> 前提：Chronicle 正在运行（`npm run daemon`，或已装开机自启）；否则 AI 工具会连不上。

### 方式 1：菜单栏「AI 工具接入…」（最省事）

点击菜单栏的 Chronicle 图标 →「**AI 工具接入…**」→ 按提示复制/写入配置。
它内部调用 `node mcp-install.mjs --print`，生成标准配置片段：

```json
{"mcpServers":{"chronicle":{"command":"/usr/local/bin/node 或 which node 的绝对路径","args":["/绝对路径/mcp-entry.mjs"]}}}
```

> ⚠️ 手动写配置时注意：`command` 建议写 **node 的绝对路径**（终端里 `which node` 的输出）。
> Claude Desktop / Cursor / VS Code / Codex 这类图形客户端启动子进程时 PATH 通常不含
> Homebrew（`/opt/homebrew/bin`），只写 `node` 会找不到解释器。用 `mcp-install.mjs`
> 自动写入时会自动使用绝对路径。

### 方式 2：命令行（可选择性接入）

```sh
# 先预览（dry-run，默认不写任何文件）：
node mcp-install.mjs --target all

# 确认后真正写入（写前自动备份原配置；失败自动恢复）：
node mcp-install.mjs --target all --yes

# 只接入某一个：
node mcp-install.mjs --target cursor --yes
```

`--target` 可选：`claude-code`、`claude-desktop`、`cursor`、`codex`、`vscode`、`all`。

查看每个客户端当前是否已配置：

```sh
node mcp-install.mjs --list
```

写入前的备份在同目录，形如
`claude_desktop_config.json.chronicle-backup-20261110T073045123Z`；
出问题把这个备份文件改名回原文件名即可恢复。

### 各客户端分步说明

#### ① Claude Code（命令行）

```sh
node mcp-install.mjs --target claude-code --yes
# 或手动执行它打印的命令：
claude mcp add chronicle -- "$(which node)" /绝对路径/mcp-entry.mjs
```

完成后新开一个 Claude Code 会话，问「用 chronicle_status 看看记录器在不在跑」。

#### ② Claude Desktop（桌面 App）

```sh
node mcp-install.mjs --target claude-desktop --yes
```

写入 `~/Library/Application Support/Claude/claude_desktop_config.json` 的
`mcpServers.chronicle`。**完全退出并重启 Claude Desktop**，在
Settings → Developer 里能看到 `chronicle` 工具即成功。

#### ③ Cursor

```sh
node mcp-install.mjs --target cursor --yes
```

写入 `~/.cursor/mcp.json` 的 `mcpServers.chronicle`，重启 Cursor 后在
Settings → MCP 中确认。

#### ④ Codex CLI

```sh
node mcp-install.mjs --target codex --yes
```

会向 `~/.codex/config.toml` **追加**（不会重复写入）：

```toml
[mcp_servers.chronicle]
command = "/usr/local/bin/node 或 which node 的绝对路径"
args = ["/绝对路径/mcp-entry.mjs"]
```

重启 Codex 后生效。若已存在同名 section，脚本只提示、不改动。

#### ⑤ VS Code

```sh
node mcp-install.mjs --target vscode --yes
```

写入 `~/Library/Application Support/Code/User/mcp.json` 的 `servers.chronicle`
（VS Code 形态，含 `"type": "stdio"`），重启 VS Code 生效。

### 验证接入是否成功

```sh
node mcp-install.mjs --list      # 对应客户端 configured: true
```

然后在 AI 工具里直接问：

- 「用 chronicle_status 看下记录器状态」
- 「用 chronicle_today 总结我今天做了什么」
- 「用 chronicle_search 搜一下我上次访问 github 是什么时候」

### 注意

- MCP 配置里写的是 `mcp-entry.mjs` 的**绝对路径**；移动了项目目录需要重新执行一次接入。
- 所有客户端配置都只是读取 Chronicle 的本地数据，不会把数据上传；AI 能看到的范围由 Chronicle 的隐私规则决定。

---

## 6. 升级

```sh
cd /path/to/chronicle
git pull                  # 如果你用 git 管理
npm install               # 依赖有变化时
npm run setup             # 重新编译 + 刷新自启（会保留已有配置与数据）
node mcp-install.mjs --target all --yes   # 项目路径变了才需要
```

也可以直接双击 `install.command` 选 `1`。**升级不会删除已有活动记录或隐私配置。**

---

## 7. 卸载

```sh
# 只移除开机自启（保留程序与数据）
npm run service:uninstall

# 卸载程序，但保留活动记录与隐私配置
node uninstall.mjs --keep-data

# 完全卸载（删除程序、权限主体、自启项、全部活动记录；不可恢复）
node uninstall.mjs
```

卸载后如需彻底移除辅助功能授权，可到
系统设置 →「隐私与安全性」→「辅助功能」里手动删除 Chronicle Helper。

---

## 8. 常见问题（FAQ）

**Q1：浏览器打不开 <http://127.0.0.1:3777/>？**
记录器没在运行。先 `npm run daemon`；或检查 `node daemon.mjs --status`。
若提示端口被占用，换端口：`node daemon.mjs --port 3778`（时间线地址相应变成 3778）。

**Q2：状态是「采集中」，但时间线没有记录？**
① 先确认系统设置 → 隐私与安全性 → 辅助功能里 Chronicle Helper 已勾选；
② 观察几分钟：只有应用切换、窗口标题变化、网址变化、焦点变化才会产生事件；
③ 如果前台应用被隐私规则 block（例如 1Password），本来就不会记录内容。

**Q3：网址一直不显示？**
浏览器标签 URL 需要「自动化」权限：首次会弹系统确认，点允许。
另外 Firefox 不提供可靠的标签 URL 读取接口，Chronicle 会诚实跳过 URL（记录继续）。
Safari 的私密浏览检测是启发式的；如需彻底不记录 Safari 网址，可在
`~/.chronicle/config.json` 的 `privacy` 段设 `"excludeSafariURLs": true`。

**Q4：开机自启失效？**
`npm run service:install` 重新注册；查看 `~/Library/LaunchAgents/com.chronicle.daemon.plist`
是否存在、日志 `~/.chronicle/logs/` 有没有报错。

**Q5：接入了 AI 工具，但 AI 说没有 chronicle 工具？**
① 重启对应 AI 工具（有些客户端需要完全退出重开）；
② `node mcp-install.mjs --list` 确认 configured: true；
③ 检查配置里 `mcp-entry.mjs` 的绝对路径是否还存在（项目目录移动过就重新运行一次 `--target ... --yes`）。

**Q6：会不会偷偷截屏 / 录音 / 上传数据？**
不会。源码里写死了红线：不截屏、不录音、不读屏幕像素；只记录结构化的
应用/窗口标题/URL/焦点元素，且密码框与系统级安全输入（secure input）出现时
不读不写任何内容。默认不联网、无遥测；只有你主动配置 LLM 摘要后，才会把
已过隐私闸门的事件内容发给你自己填的 LLM 服务地址。

**Q7：数据存在哪里？怎么彻底删掉？**
`~/.chronicle/`（`config.json`、`segments/`、`summaries/`、`logs/`、`index/`）。
删除该目录即彻底清除；也可在时间线「⚙ 设置 → 清除全部历史」里清空活动记录（保留配置）。

**Q8：LLM 摘要没生成？**
摘要功能默认关闭。在 `~/.chronicle/config.json` 里配置 `summarizer`（provider、
baseUrl、model、apiKeyEnv）并 `export` 对应环境变量后，重启记录器；详见 README。
不配置也不影响原始记录与 AI 查询。

---

## 9. 隐私与数据位置

| 路径 | 内容 |
| --- | --- |
| `~/.chronicle/config.json` | 隐私规则（blocklist/allowlist）、采集开关、摘要与维护配置 |
| `~/.chronicle/segments/` | 活动事件（每 10 分钟一段，JSONL） |
| `~/.chronicle/summaries/` | AI 摘要（Markdown） |
| `~/.chronicle/index/` | 检索索引（SQLite，可删，会自动重建） |
| `~/.chronicle/logs/` | 运行日志（URL 脱敏，只记状态/计数/错误） |
| `~/.chronicle/Chronicle Helper.app` | 权限主体（辅助功能授权挂它身上） |

- 产品红线：**不截屏、不录音、不读屏幕像素**；只记录结构化事件。
- 被隐私规则抑制的采样只留无内容的审计行（时间 + 原因），不留标题/网址。
- 纯文件存储：备份 = 复制 `~/.chronicle/`；删除 = 删目录，没有云端副本。

---

## 10. 需要更多帮助

- 完整技术说明（架构、API、MCP 工具、性能、数据格式）：见仓库根目录 `README.md`
- 接入器细节与安全约束：`node mcp-install.mjs --help`
- 性能基准：`npm run bench`
