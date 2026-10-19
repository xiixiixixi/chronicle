# Chronicle

macOS 后台活动记录器：观察你在用什么应用、什么窗口、什么网址、焦点在哪个元素，
10 分钟一段落成 JSONL，再由后续批次的摘要器压缩成时间线。本地 HTTP 服务 + 时间线 UI。

**产品红线：不截屏、不录音、不读屏幕像素。** 只记录结构化事件（应用 / 窗口标题 /
浏览器当前标签 URL / 焦点元素角色与标题）。密码框内容与无痕浏览无条件排除。
数据都是纯文件（JSONL + JSON），删了就没了。

## 组成（批次 1）

```
swift/chronicle-daemon.swift   采集守护（单文件 Swift，行协议 JSON 服务）
daemon.mjs                     Node 守护管理 + 本地 HTTP 服务（127.0.0.1:3777）
setup.mjs                      安装：编译 → 建 ~/.chronicle/ → 装 Helper.app → 权限引导
uninstall.mjs                  卸载（--keep-data 可保留数据）
shared/privacy.mjs             观察规则闸门（Node 侧镜像，权威实现在 Swift 端）
test/daemon.test.mjs           测试（mock 守护 + Swift 真编译自检）
test/fixtures/mock-daemon.mjs  Swift 守护的 Node 桩
web/index.html                 时间线 UI 骨架（暗色 + 琥珀品牌色）
```

## 快速开始

```sh
npm run setup          # 编译守护 + 建数据目录 + 装 Helper.app + 权限引导
npm run daemon         # 启动采集 + HTTP 服务（127.0.0.1:3777）
npm test               # 跑测试（无 swiftc 自动 SKIP 真编译自检）
```

- 状态：`node daemon.mjs --status`　停止：`node daemon.mjs --stop`
- 时间线 UI：`http://127.0.0.1:3777/`（骨架，后续批次上线）

## 数据形态

```
~/.chronicle/
  config.json                       隐私规则
  segments/<UTC时间戳>/
    events.jsonl                    事件流（append-only，一行一个 JSON）
    suppressed.jsonl                被规则抑制的记录（只有 type/ts/scope，无内容）
    metadata.json                   {segmentStart, segmentEnd?, eventCount}
  Chronicle Helper.app/             权限主体（辅助功能挂它身上）
  daemon.pid                        守护管理器 pidfile
```

事件：`{ts, tsMs, type:'app-switch'|'window-change'|'url-change'|'focus-change', data:{...}}`。
采样每 2 秒一次；连续采样无变化不产生事件；每 10 分钟自动轮转新段。

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
  "includeFocusedElement": true
}
```

- 规则按 glob 匹配（`*` 任意序列，不区分大小写）：`app` 匹配 bundleId，`url` 匹配完整网址或域名
- **block 永远赢**：同时命中 allow 与 block 一律阻断
- allowlist 非空时，白名单外一律不观察（app 命中，或 URL 明确放行）
- 被抑制的事件不进 events.jsonl，只在 suppressed.jsonl 记 `{ts, type, scope}`（不带任何内容）
- 密码框（AXSecureTextField）焦点内容永远不记录；浏览器无痕模式无条件排除 URL
- `includeURLs` / `includeFocusedElement` 可整类关闭

## 权限

采集只需要「辅助功能」一项（读窗口标题与焦点元素）。`npm run setup` 会安装
`~/.chronicle/Chronicle Helper.app` 并弹出琥珀引导卡片——把卡片左侧图标拖进
系统设置的辅助功能列表即完成授权（终端是谁无关，授权一次永久生效）。
浏览器 URL 读取需要首次时的「自动化」确认（Apple Events）。

## 守护协议（stdin/stdout 行协议）

一行 JSON 请求 `{id, cmd, ...}` → 一行 JSON 响应 `{id, ok, ...}`：
`start {configPath?}` / `stop` / `pause {durationSec?}` / `resume` / `status` / `probe`。
stdin EOF、SIGTERM、SIGINT 均触发优雅退出（写完当前段 metadata 再走）。
数据根目录可用环境变量 `CHRONICLE_HOME` 覆盖（测试用）。

## 摘要接口（预留）

`daemon.mjs` 每 60 秒扫描已关闭且无 `summary.json` 的段；配置环境变量
`CHRONICLE_SUMMARIZE_CMD="<命令>"` 即以段路径为参数调用之（批次 2 接入真正的摘要器）。
