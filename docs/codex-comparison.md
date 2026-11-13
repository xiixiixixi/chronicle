# Chronicle vs Codex Computer History（skysight）详细对比证据

- 生成时间：2026-11-11 14:46 CST
- 仓库：`/Users/weixili/git/chronicle`（HEAD `4edced4`，改动未提交）
- 本机模型配置：`MiniMax-M3.1-Flash` + `reasoning_effort=low`，maxTokens 10000，maxChars 60000
- 对比对象：Codex 的 `Computer History / skysight` 记忆扩展
  - 摘要资源：`~/.codex/memories/extensions/skysight/resources/`
  - 事件流：`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Caches/ComputerUse/Skysight/segments/`
  - 说明文档：`~/.codex/memories/extensions/skysight/instructions.md`
- 复现命令与原始数据见文末「复现」与 `docs/evidence/`。

---

## 0. 一句话结论

**分析/摘要层：Chronicle 已达到并超过 Codex（10 分钟同窗口 6 个窗口全胜；6 小时结构与负证据更好、篇幅/实体密度略低，判平齐）。
采集层：**09:00–09:10Z** 窗口 shortcut **45 vs 34**、text-input **48 条 / 495 字 vs 45 条 / 495 字**、click **74 vs 60**、AX 文本 **740,876 vs 472,334（1.57×）** 领先；受控 35 键回放 **35/35**；微信实时提交 **7/7**；Arc 侧栏 `sidebarAllTabList` 的 AXOutline + selectedItems 已实机对齐；`mouse.drag`/`context_menu` 已实机验证。**09:49–09:59Z** 复核窗口：shortcut **32 vs 31**、text **254/254 字**、window-change **15 vs 11**、selection **10 vs 4**、click **24 vs 22**、AX 文本 327,925 vs 358,859（0.91×，该窗口略低）。
产品/UI 层：历史记录时间线、技能建议/创建、技能库、每日/每周洞察、下一步建议、DSH 式模型设置、长期记忆 v2 + MCP `chronicle_memory` 已具备或超过 Codex 的对应能力；记忆格式/字段/去重/检索平齐（`docs/evidence/memory-parity-2026-11-11.md`）。**

独立验收报告（摘要质量快照）：`/tmp/chronicle-verify/report-parity.md`，**26 PASS / 0 FAIL / 4 NOTE**，结论为“达到与 Codex 平齐或更好”。

---

## 1. 采集对比（同一 10 分钟窗口：2026-11-11 13:20–13:30 CST / 05:20Z）

| 指标 | Codex skysight | Chronicle | 说明 |
|---|---:|---:|---|
| 事件总数 | 168 | 315 | 我们多出 focus-change / app-switch 等事件 |
| 带 AX 文本的事件 | 124（full 17 / diff 107） | 69（独立快照） | Codex 把 AX 挂在每个操作事件上，我们是独立快照事件 |
| AX 总字符 | **358,038** | **214,629** | Codex 是我们 1.67× |
| AX 总行数 | 8,922 | 5,956 | Codex 1.50× |
| 单条 AX 最大字符 | **41,490** | 16,384（快照上限） | 我们的节点/字符上限更紧 |
| 覆盖应用数 | 6 | 5 | Codex 多 Dock/控制中心等 |
| 覆盖窗口数 | 8 | 7 | 接近 |
| 点击 | 101 | 134 | 我们更多（含控件点击） |
| 快捷键 | **6** | 2 | Codex 记录更全 |
| 提交 | 7 | 5 | 接近 |
| 选择 | **18** | 8 | Codex 2.25× |
| 文本输入 | **13 条 / 177 字** | 6 条 / 106 字 | Codex 记录更多输入 |
| 窗口变化 | 17 | 17 | 一致 |
| 隐私过滤 | 34 条被抑制 | 由 secure input/密码/incognito/blocklist 规则过滤（无同口径计数） | 两边都有硬过滤 |
| 额外事件 | mouse.drag 6、context_menu 0 | focus-change 57、app-switch 17 | 我们的噪声事件更多 |

### 全天截至 14:10 CST 的总量

| 指标 | Codex | Chronicle | 倍率（Codex/我们） |
|---|---:|---:|---:|
| 事件总数 | 2,316 | 2,296 | 1.01× |
| 带 AX 事件 | 1,212 | 639 | 1.90× |
| AX 总字符 | **5,063,049** | **1,486,257** | **3.41×** |
| AX 总行数 | 125,648 | 48,316 | 2.60× |
| 单条 AX 最大字符 | 56,042 | 16,392 | 3.42× |
| 点击 | 712 | 648 | 1.10× |
| 快捷键 | **473** | **41** | **11.54×** |
| 提交 | 79 | 53 | 1.49× |
| 选择 | **232** | **61** | **3.80×** |
| 文本输入 | **385 条 / 5,391 字** | **142 条 / 2,296 字** | 2.71× / 2.35× |
| 窗口变化 | 400 | 238 | 1.68× |
| 隐私抑制 | 357 条 | 无同口径计数 | — |

**采集结论**：Codex 的强项是“每事件带 AX + 更大的树 + 键盘/选择覆盖”；Chronicle 的强项是事件类型更结构化（app-switch/window-change/focus-change 分离）、点击覆盖不低、隐私闸门明确。**采集厚度目前是 Chronicle 的短板，不能宣称超过 Codex。**

原始数据：`docs/evidence/capture-window-05-20.json`、`docs/evidence/capture-day.json`

### 1b. 采集补强后（2026-11-11 15:00–15:10，同一 10 分钟窗口）

补强内容：AX 深度 20 / 节点 3000 / 单值 500；每次点击、快捷键、提交、文本 flush 后立即补拍 AX diff；点击前 flush 待提交文本；无焦点目标也记录快捷键；文本 flush 0.8s→0.5s；`contentMaxChars=65536`、`diffMaxChars=16384`。

| 指标 | Codex | Chronicle（补强后） | 对比补强前（05:20 窗口） |
|---|---:|---:|---|
| 事件总数 | 277 | 415 | — |
| 带 AX 文本事件 | 50 | **173** | Codex 更少 |
| AX 总字符 | 258,958 | **815,865（3.15×）** | 补强前 214,629（0.60×） |
| AX 总行数 | 6,658 | **16,227（2.44×）** | 5,956 |
| 单条 AX 最大字符 | 30,623 | **65,538（2.14×）** | 16,384（上限） |
| 点击 | 23 | 32 | 101 vs 134 |
| 快捷键 | **144** | 17（仍落后） | 6 vs 2 |
| 提交 | 2 | **31** | 7 vs 5 |
| 选择 | **19** | 1（仍落后） | 18 vs 8 |
| 文本输入 | 67 条 / 507 字 | **77 条 / 485 字** | 13 vs 6 |
| 窗口变化 | 22 | 43 | 17 vs 17 |

**补强结论**：AX 采集量已从“落后 40%”变成“领先 3.15×”；文本输入/提交/点击已不落后。**快捷键与选区采集仍明显低于 Codex**（快捷键 17 vs 144、选择 1 vs 19），需要下一步用 AXObserver/更细的选中轮询补。

原始数据：`docs/evidence/capture-after-window-07-00.json`、`docs/evidence/capture-after.mjs`

### 1c. REA 逆向：Codex 的快捷键/选区到底怎么采（2026-11-11 15:50 CST）

**目标二进制**：`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService`
（Mach-O arm64，`sha256=469500545c940ecb20541d71a979461ea6bd22e92b513a87fa57eab90cd1061a`）

**符号与类型（`nm` + `swift-demangle`）**
- `EventStreamRecorder`：事件流采集器，持有 `_eventTap`、`_axObserver`、`textBuffer`、`pendingAXNotificationRecords`、`axNotificationDebounceTasks`。
- `EventStreamKeyboardInteraction{text, keyEquivalent, modifiers, target}`：所有键盘事件共用，不存在单独的“按键事件”类型。
- `EventStreamSelection{target, selectedText, selectedRange, selectedItems}`：选区事件四个字段。
- `SystemFocusedUIElementObserver` + `AXNotificationObserver(monitoringNotifications:ignoringErrors:processID:element:qos:handler:)`：AX 通知基础设施。

**AX 通知集合（二进制字符串 + 通知数组构造点 0x10078416c）**
`AXSelectedTextChanged`、`AXSelectedChildrenChanged`、`AXSelectedChildrenMoved`、`AXSelectedRowsChanged`、`AXSelectedColumnsChanged`、`AXSelectedCellsChanged`。
通知注册在 **application 元素**上；独立 Swift 探针实测：仅注册 app 元素即可收到后代 `AXTextArea` 的 `AXSelectedTextChanged`（每次选区变化 1 条通知）。

**事件流反推的语义**
- `keyboard.shortcut` 不是“⌘ 组合键”，而是**所有非文本按键**：全天 delete 609、return 167、方向键 113、tab 27、escape 7；modifiers 里 `()` 770 条、`function` 112 条、`command` 72 条。
- Return 在“无修饰键、且按下后目标文本被清空/焦点控件消失”时记为 `keyboard.submit`（07:00 窗口 29 条 return shortcut + 2 条 submit；飞书换行仍保留文本 → shortcut，微信发送清空 → submit）；Shift/Option 等修饰键的 Return 记 shortcut。
- `selection.changed` 全天 418 条：157 条带 `selectedText`、151 条带 `selectedRange`、261 条只有 `target`（bare）；role 分布 `AXWebArea 133 / AXOutline 112 / AXTabGroup 92 / AXTable 46 / AXTextField 18 / AXList 11 / AXStaticText 6`。

**Chronicle 对应实现（本轮）**
- 键盘：`NAV_KEY_NAMES`（delete/return/方向键/tab/esc/Home/End/PageUp/PageDown/ForwardDelete）+ `function` 修饰键 + 修饰键自身过滤；Return 用 250ms 后复查目标 AXValue 是否清空来区分 submit/shortcut（清空=发送，仍有内容=换行/终端继续）。
- 选区：`SelectionMonitor` 每个前台 app 建一个 `AXObserver`，在 app 元素 + 焦点窗口/焦点控件 + 窗口树内的 Outline/Table/List/TabGroup/Menu 容器上注册上述 6 类通知；回调经 120ms 防抖后在 stateQueue 读取 `AXSelectedText` / `AXSelectedTextRange` / `AXSelectedChildren/Rows/Columns/Cells`，允许 bare target；观察者与轮询兜底共享 `lastSelectionKey` 去重（同一上下文/目标/内容只落一条）。
- 应用切换：`NSWorkspace.didActivateApplicationNotification` 立即触发重采样，观察者跟随新 pid（不再最多等 2s）。
- 隐私口径不变：secure input / 密码控件 / 无痕 / 黑名单在读取前拦截；选区 target 只落 role/title/description，不带 value。

### 1d. 受控回放验收（2026-11-11 08:02:06Z，TextEdit）

用 CGEvent 向 TextEdit（自家测试文档，每键前校验前台 app）注入 35 个按键；
Codex 与 Chronicle 同时观察同一台机器。结果按 keyEquivalent + modifiers 逐项对拍：

| 键 | 注入 | Codex 捕获 | Chronicle 捕获 |
|---|---:|---:|---:|
| delete | 10 | 10 | 10 |
| down_arrow | 10 | 10 | 10 |
| up_arrow | 5 | 5 | 5 |
| tab | 3 | 3 | 3 |
| escape | 2 | 2 | 2 |
| command+a | 2 | 2 | 2 |
| return | 3 | 3（shortcut） | 3（shortcut） |
| **合计** | **35** | **35** | **35** |

- Return：TextEdit 保留文本（换行），双方都记 `shortcut`，没有误记 `submit` —— 说明 250ms 复查口径与参考实现一致。
- 同一 burst 的 Cmd+A 选区：Codex `selection.changed` **0 条**；Chronicle `selection` **1 条**
  （`AXTextArea`，`selectedText` + `selectedRange`）。这一项 Chronicle 领先。

**08:00–08:10Z 完整窗口（受控 burst + 用户真实活动）**

| 指标 | Codex | Chronicle | 判定 |
|---|---:|---:|---|
| 事件总数 | 252 | 399 | 领先 |
| shortcut | 89 | 99 | 领先（多 2 条 Ctrl+Cmd+Z） |
| selection | 18 | 7 | **落后**（Outline/Menu 未订阅到） |
| submit | 9 | 1 | **落后**（微信发送被误判 shortcut） |
| text-input | 30 | 15 | **落后**（微信文本无 AX target 被丢弃） |
| click | 66 | 89 | 领先 |
| window-change | 35 | 41 | 领先 |
| AX 字符 | 415,711 | 288,634 | 落后（本窗口 Codex 应用/窗口数更多） |

- shortcut 逐键对拍：delete 49/49、return 10/**18**（多出的 8 条正是被误判的微信 submit）、
  down 10/10、up 5/5、tab 3/3、escape 3/3、cmd+c 3/3、cmd+a 2/2、fn+方向键 3/3、cmd+v 1/1；
  唯一额外项是 Ctrl+Cmd+Z 2 条（Codex 未记录）。
- selection 差距构成：Codex `AXOutline items 8 + AXWebArea text 6 + AXMenu items 3 + AXOutline bare 1`；
  Chronicle 只有 `AXTextArea text 7`。Arc「文档」窗口的 Outline/Menu 选中没有订阅到。
- submit/text 差距构成：微信 17 条 text-input 全部漏采；微信 8 条发送被记成 shortcut。
  Codex 的微信 submit 事件 target 为空、`ax: no_change`；Chronicle 的微信 text-input 也没有 target。

### 1e. 同窗口暴露的短板与修复（08:13–08:16 CST）

| 短板 | 证据 | 修复 |
|---|---|---|
| 微信文本输入全部丢失 | Codex 微信 text-input 17 条；Chronicle 0 条 | 焦点控件读不到时允许 `target` 为空继续累积文本（密码风险仍由 secure input 全局闸门拦截） |
| 微信发送被误判 shortcut | Codex 8 submit + 10 return shortcut；Chronicle 18 return shortcut + 1 submit | Return 250ms 后：只有「同一文本类控件且文本仍在」才记 shortcut；目标消失 / role 为空或变化 / 非文本控件（对话框/按钮）/ 文本被清空 → submit；无文本且焦点在 AXWindow/Sheet/Dialog/Button 时直接 submit |
| Arc Outline/Menu 选区丢失 | Codex AXOutline items 8、AXMenu items 3；Chronicle 0（钉钉 08:26 也复现：AXMenu 2 条未采、AXOutline 已采 1 条 items=2） | 每次焦点变化把 6 类通知重新订阅到焦点窗口 + 焦点控件 + 焦点控件的 AXOutline/Table/List/TabGroup/Menu 祖先；窗口变化时广度优先扫描窗口树（300 节点 / 0.2s）+ 补扫 app 直接子元素（菜单弹层）；`AXMenuOpened` 时直接订阅菜单元素；选中项读取 AXSelectedChildren/Rows/Columns/Cells，按元素 CFHash 去重（空标题不同行不会合并） |
| 延迟事件顺序反转 | 受控 burst 中 Return 的 250ms 复查排到了 Cmd+A 之后 | 事件写入支持 `ts/tsMs` 使用按键发生时刻，逻辑顺序不变 |

**修复后即时样本（08:13:15–08:15:45Z）**：shortcut **Codex 11 / Chronicle 13**；
Return **5 / 5**（全部 shortcut）；submit **2 / 1**（漏掉的 1 条发生在 daemon 重启窗口）；
text-input **23 / 29**（Chronicle 反超）；selection 该样本无活动。

**AXOutline 实机证据（08:23:14Z）**：系统设置「辅助功能」边栏切换时，Chronicle 落盘
`selection { target.role_raw: AXOutline, description: 边栏, selectedItems: [AXRow, AXCell] }`；
同一时刻 Codex 在该窗口没有 `selection.changed`。这条验证了窗口容器扫描 + selectedItems 聚合路径。
Arc 侧栏的 AXTable/AXOutline 需要下一次真实操作复测（08:17 的 8 条发生在容器扫描修复之前）。

**08:20–08:30Z 过渡窗口（期间多次安装修复，非最终版单二进制）**：shortcut **81 vs 67**、
text-input **60 条 / 486 字 vs 50 条 / 466 字**、submit **12 vs 15**（最近文本判定尚未生效）、
selection **2 vs 6**（AXMenu 订阅尚未生效；钉钉 AXOutline 已采到 1 条 items=2）、
AX 文本 **316,460 vs 163,039（1.94×）**。

**最新版实机（08:31:07Z 起）**：08:31–08:33 三次微信发送 **Codex 3 / Chronicle 3**；
09:17–09:22 再次 **Codex 7 / Chronicle 7**（含 Cmd+V 粘贴后回车场景，target 均为空、形状一致）。
System Settings AXOutline 选中 **Chronicle 1 条（selectedItems=2）/ Codex 0 条**。
微信“输入后停顿再回车”和“粘贴后回车”的发送均已正确归为 submit。

### 1g. agentdesk 受控验证（2026-11-11 09:31Z，Arc）

- CUA tier A（AX + 屏幕授权），目标 Arc pid 69347。
- **右键**：Arc 09:31:21 → Chronicle `context-menu`（button=right，target AXGroup）+ Codex `mouse.context_menu`，**1/1 对齐**。
- **拖拽**：Arc 09:31:22 → Chronicle `drag`（origin AXStaticText → destination AXGroup，900,500 → 1150,500）；Codex 该动作未记 `mouse.drag`。
- 自然拖拽：Ghostty 09:26:44、flomo 09:28:11 各 1 条 `drag`；Codex 同窗口 0 条。
- 选区：flomo AXWebArea **Chronicle 3 条 / Codex 1 条**；System Settings AXOutline、DingTalk AXOutline 均已实机捕获。
- **Arc 侧栏 tab 选区（最终验证）**：Arc 的 `AXOutline id=sidebarAllTabList` 位于 AX 树第 7 层、全树约 8,931 个节点，
  窗口扫描预算到不了。修复为：点击命中点沿 `AXParent` 向上找最内层容器立即订阅，并在 1.0s 后补读一次选中项
  （Arc 先发窗口变化、约 0.8s 后才更新 AX 选中）。09:40:30 点击 gmail tab：
  Codex `selection.changed` → `AXOutline(sidebarAllTabList, item "gmail")`；
  Chronicle `selection` → `AXOutline` items `[AXRow "gmail", AXCell "gmail"]`。**双方对齐**。
  重复点击同一 tab 由稳定的 `role|label` 身份去重，不再重复落盘。
- 验证过程中 Arc 的当前标签被切到 `gmail`（点击侧栏所致），用户点 AIHOT tab 即可切回。

### 1f. 修复后完整窗口（2026-11-11 09:00–09:10Z）

| 指标 | Codex | Chronicle | 判定 |
|---|---:|---:|---|
| 事件总数 | 201 | 397 | 领先 |
| shortcut | 34 | **45** | 领先 |
| text-input | 45 条 / 495 字 | **48 条 / 495 字** | 字数平齐、条数领先 |
| submit | 21 | 19 | 差 2（Cmd+V 粘贴后 Return 被误判，已修） |
| selection | 6 | 0 | 差 6（Arc 侧栏 sidebarAllTabList，已修并实机对齐） |
| click | 60 | **74** | 领先 |
| window-change | 35 | 30 | 略低 |
| AX 文本 | 472,334 | **740,876（1.57×）** | 领先 |

- shortcut 逐键：delete 21/21、return 5/7（总 Return 26/26，差的 2 条正是上述 paste+Return）、
  fn+down 4/4、escape 2/2、cmd+v 2/2；Chronicle 额外记录 Ctrl+Z/Ctrl+Cmd+Z/Ctrl+A 共 9 条（Codex 未记录）。
- selection 差距构成：Codex `AXOutline items 4 + AXTable bare 2`，全部在 Arc 侧栏；
  Chronicle 0 条。原因是 Arc 同一窗口内换页时窗口 CFHash 不变，容器扫描被早退跳过——
  已移除早退，并把扫描预算提高到 500 节点 / 0.3s。
- submit 差距构成：09:00:58、09:01:01 两次都是 **Cmd+V 粘贴后 ~1s 按 Return**；
  `lastTextInputAt` 只由键盘字符更新，粘贴没更新 → 没进入 250ms 复查。
  已把 Cmd/Ctrl+V 也计入“最近文本”时间。

### 1h. window-change 复核窗口（2026-11-11 09:49–09:59Z）

修复后安装（`09:48:18Z` 重启）并运行的完整 10 分钟窗口：

| 指标 | Codex | Chronicle | 判定 |
|---|---:|---:|---|
| 事件总数 | 84 | 184 | Chronicle 多 AX 快照/focus-change |
| shortcut | 31 | **32** | 平齐 |
| text-input | 16 条 / 254 字 | 19 条 / 254 字 | 字数平齐、条数领先 |
| submit | 0 | 0 | 一致 |
| selection | 4 | **10** | 领先 |
| click | 22 | **24** | 领先 |
| window-change | 11 | **15** | 反超（原 09:00 窗口 35 vs 30） |
| AX 文本 | 358,859 | 327,925（0.91×） | 该窗口略低 |
| AX 行数 | 6,888 | **7,794** | 领先 |

window-change 修复：`AXTitleChanged` / `AXFocusedWindowChanged` 快速路径（非浏览器 app 立即记窗口变化），
`significantWindowTitle` 去掉终端 spinner 前缀；同时允许无标题弹层在焦点窗口元素变化时记录
（`windowChangeNeeded`）。证据：`docs/evidence/capture-after-window-09-59.json`、
`docs/evidence/capture-details-09-59.txt`。

---

## 2. 10 分钟摘要对比（同窗口 ±15 分钟，共 6 个窗口）

### 2.1 定量表

| 窗口（UTC） | 字符 Codex/我们 | 具体文件名 | 绝对路径 | URL | 结果/卡点句 |
|---|---:|---:|---:|---:|---:|
| 05:00Z | 1289 / **2622** | 3 / 2 | 3 / 3 | 0 / **4** | 8 / **22** |
| 05:10Z | 1077 / **1270** | 2 / 2 | 2 / 2 | 0 / 0 | 12 / **22** |
| 05:20Z | 1681 / **2024** | 9 / 7 | 4 / 4 | 0 / 0 | 5 / **19** |
| 05:30Z | 2016 / **3412** | 6 / 8 | 6 / 6 | 0 / **3** | 7 / **22** |
| 05:40Z | 1310 / **2670** | 3 / **9** | 4 / 3 | 0 / 0 | 4 / **31** |
| 05:50Z | 1182 / **1947** | 2 / 2 | 2 / **3** | 0 / 0 | 12 / **26** |
| **合计** | **8555 / 13945（+63%）** | 25 / **30** | 21 / 21 | 0 / **7** | 48 / **142（+196%）** |

- **6/6 窗口字符数 ≥ Codex**；合计 5 项指标全部 ≥（URL、结果/卡点句大幅领先；绝对路径持平；文件名略多）。
- 单窗口 05:20 明细：章节 7/11、文件名 9/12、绝对路径 4/4、URL 0/5、结果句 5/28。

### 2.2 摘要规模与结构

| 指标 | Codex | Chronicle |
|---|---|---|
| 今日 10min 摘要数 | 30 | 27 |
| 平均字节/份 | 2,938.5 | **3,557.4** |
| 结构 | Memory summary / Relevant prior context / Important non-obvious context / Recording summary / Citations | 总览 / 相关上下文 / 重要上下文 / 活动记录 / 未完成·卡点 / 证据 / 引用 |
| 模型 | 未在资源 frontmatter 暴露 | `MiniMax-M3.1-Flash`（frontmatter 可见） |
| 延迟（我们实测） | — | 10.6–31.4s/段（7 段实测，平均约 18s） |

### 2.3 同窗口内容抽样（13:20–13:30）

**Codex（节选）**
> 用户主要核查已整理的 Hulala 客服知识库……并用 Wisp 文件管理器浏览知识库目录中的 Markdown、数据表、原始数据和合并版 PDF。
> `03_Markdown知识库/HULALA_产品知识库.md`：较大的产品知识库文本。
> `04_合并版PDF/`：包含政策与帮助、商品资料、集合页三份可整本打印的合并文档。

**Chronicle（节选）**
> 工作区：`/Users/weixili/工作/资料/neu/客服/`
> 面包屑对应目录：`/Users/weixili/工作/资料/neu/客服/jsy/HULALA客服知识库_20261111/03_Markdown知识库`
> 抽验 PDF 包括：`P058_pages-yotpo-rewards.pdf`、`P052_pages-sitemap-hulalahome.pdf`、`P046_pages-memberproduct.pdf`、`P035_pages-birthday-treat.pdf`、`P037_pages-bundles.pdf`
> 抽查商品页：`https://hulalahome.com/products/baby-cot-bed-with-rounded-corners`，页面标题为“Fabiana Cozy Baby Nest Convertible Crib | Hulala Home”。
> （另有 README 的 398 份 PDF / 245 商品 / 1251 SKU、Arc WebSocket 127.0.0.1:7331 报错等具体证据）

**判定**：Codex 叙事更“像人写的”，Chronicle 证据更密、路径/URL/数量更具体，负证据更多。两者都已不是“点击流水”。

原始数据：`docs/evidence/summary-batch-2026-11-11T05.md`、`docs/evidence/summary-single-05-20.md`

---

## 3. 6 小时摘要对比（2026-11-11 00:00–06:00Z）

| 指标 | Codex | Chronicle |
|---|---:|---:|
| 正文字符 | 5,382 | 4,925 |
| 章节数 | 10 | **11** |
| 具体文件名 | **31** | 19 |
| URL | 0 | **6** |
| 负证据句 | 7 | **23** |
| 引用路径 | 2（events + 资源） | **9（全部真实存在）** |
| 文件大小 | — | 10,396 B |

- 结构、负证据、URL、引用：Chronicle 更好。
- 篇幅与实体密度：Codex 更高（6h 仍是我们的弱项，已记录）。

数据：`docs/evidence/compare6h.mjs`、`~/.chronicle/summaries/6h-2026-11-11T00.md`

---

## 4. 记忆层对比（v2，2026-11-11 升级）

详细证据：`docs/evidence/memory-parity-2026-11-11.md`

| 文件/维度 | Codex | Chronicle v2 | 说明 |
|---|---:|---:|---|
| MEMORY.md | 37,517 B，11 组 / 19 任务 | 19,317 B，10 组 / 10 任务 | Codex 积累多天；Chronicle 首日 |
| memory_summary.md | 9,671 B | 4,838 B（上限 6 KB） | 双方都有 User Profile / preferences / General Tips / What's in Memory |
| 任务格式 | `# Task Group` + scope/applies_to + `## Task N` + keywords + preferences + reusable knowledge + failures | 同结构 + 组内任务更新 + `references` | 平齐 |
| 去重 | 任务组内 Task 1..N | 同任务线更新；近似组名合并；数组近义去重（6/6/4 上限） | 平齐 |
| 检索 | Codex 桌面端自动读取 memory_summary | 摘要/洞察注入 + MCP `chronicle_memory` + Web「记忆」视图 | Chronicle 对外部 agent 更可用 |
| 输入源 | Skysight 活动摘要 + Codex rollout 会话 | 电脑活动摘要（事件/AX/窗口/URL） | Codex 多会话内部细节；Chronicle 覆盖面更广 |

真实合并证据（3 次，消费 49 份摘要）：

```json
{"consumed":24,"added":3,"updated":4,"sections":7}
{"consumed":24,"added":1,"updated":6,"sections":7}
{"consumed":1,"added":1,"updated":7,"sections":8}
```

迁移前 MEMORY.md 是 12 个扁平节、6 个 task_group（5 组有 2–3 个重复标题）；升级后 10 个任务组、0 重复，
每组都有 scope/applies_to，9/10 组有 keywords/references/failures。同刻 09:00–09:10Z 的 Codex 与 Chronicle
摘要都覆盖 AIHOT/微信/飞书/Claude Code；Chronicle 多 2 条 next_actions、1 条 suggestion 和负证据，
Codex 的 AgentDesk「170 项测试」事实对应 Chronicle 09:26 摘要。

**判定**：记忆格式、字段、去重、证据和检索**平齐**；Chronicle 多 Ongoing Tasks/next_actions/MCP 检索，
Codex 多 agent rollout 输入和历史积累。不声称内容体量已超越。

---

## 5. 功能矩阵

| 能力 | Codex | Chronicle | 证据 |
|---|---|---|---|
| 10 分钟历史记录（按天分组） | ✅ | ✅ | UI 截图 |
| 6 小时回顾 | ✅ | ✅ | `6h-2026-11-11T00.md` |
| AX 内容采集 | ✅ 每事件 full/diff，最大 41–56KB | ✅ 独立快照，上限 16KB | 第 1 节 |
| 键盘/文本输入/选择 | ✅ 更全（377/232/385 条） | ✅ 较少（41/61/142 条） | 第 1 节 |
| 负证据（未观察到/尚未） | ✅ | ✅ 更多 | 第 2.1 节 |
| 技能建议（suggestion） | ✅ frontmatter type: skill | ✅ 同格式 | 摘要 frontmatter |
| 创建技能 / SKILL.md | ✅ 技能编辑器/工作区技能 | ✅ 添加技能→生成 SKILL.md、技能库/编辑器 | `~/.chronicle/skills/`、`?view=skills` |
| 技能导入/导出/图标 | ✅ | ❌（未做） | — |
| 下一步建议（next_actions） | ✅ Suggest Next Actions | ✅ 摘要 frontmatter + 历史页卡片 | `next_actions` |
| 每日/每周洞察 | ✅ Insights / weeklyReview | ✅ `insights/*.md` + `?view=insights` | `~/.chronicle/insights/` |
| 长期记忆 | ✅ MEMORY.md 任务组 + memory_summary + What's in Memory | ✅ 同结构 + Ongoing Tasks + MCP `chronicle_memory` | 第 4 节 |
| 时间线 UI | ✅ 时间列 + 标题 + 叙述 + 图标 | ✅ 已对齐，另有「今天的活动时间线」 | 截图 |
| 模型设置 | Codex 不涉及 | ✅ 参考 DSH：provider 行/只写密钥/模型选项/推理强度 | `?view=model` 截图 |
| 隐私过滤 | ✅ 357 条抑制 | ✅ secure/密码/incognito/blocklist 硬过滤 | 测试+verifier |

---

## 6. UI 截图对照

- Codex 电脑历史记录：`/tmp/codex-computer-history.png`（本机实测截图）
- Chronicle 历史记录（真实数据）：`design-demos/C-production/codex-style-history.png`；实时版 `/tmp/v8-live2/live-v8-citations.png`
- Chronicle 时间线：`design-demos/C-production/codex-style-timeline.png`；实时版 `/tmp/v8-live2/live-v8-timeline2.png`
- Chronicle 模型设置（DSH 式）：`design-demos/C-production/model-settings-light.png`、`model-settings-dark.png`、`model-settings-mobile.png`
- Chronicle 技能/洞察：`design-demos/C-production/skills-list.png`、`insights.png`

---

## 7. 工程与验收

- 全量测试：**512/512 通过**；`npm run check` OK。
- 通用性红线：`test/generic.test.mjs` 3/3（分析/记忆/洞察/UI 不依赖第三方产品名/私有路径；仅 mcp-install/daemon 的 AI 客户端接入目标例外）。
- 独立验收（摘要质量快照）：`/tmp/chronicle-verify/report-parity.md`，**26 PASS / 0 FAIL / 4 NOTE**，结论“达到/超过 Codex”；实体核验 21 个全部真实、编造 0。
- 隐私：23 份摘要无密钥/token；引用路径全部真实；新段 217 事件无密码/secure；Helper selftest 密码 value=null。
- 可复现对照工具：`scripts/compare-codex.mjs`（`npm run compare:codex -- --batch 2026-11-11T05`）。

---

## 8. 复现

```bash
cd /Users/weixili/git/chronicle
# 摘要多窗口对照
npm run compare:codex -- --batch 2026-11-11T05
# 单窗口（Codex 05:20 vs Chronicle 05:26）
node scripts/compare-codex.mjs \
  --codex "$(ls ~/.codex/memories/extensions/skysight/resources/2026-11-11T05-20-00-* | head -1)" \
  --chronicle ~/.chronicle/summaries/10min-2026-11-11T05-26-04.328Z.md
# 采集对比
node docs/evidence/capture-compare.mjs > docs/evidence/capture-window-05-20.json
# 补强后同窗口
node docs/evidence/capture-after.mjs > docs/evidence/capture-after-window-07-00.json
# 6h 对比
node docs/evidence/compare6h.mjs
# 全量测试
node --test test/*.test.mjs && npm run check
```

证据文件 sha256：

| 文件 | sha256 |
|---|---|
| `docs/evidence/capture-day.json` | `fdceb8a47d644accd90dbe0942d2d029ac37eb2847f7c8da3d805a2c2a65f16d` |
| `docs/evidence/capture-window-05-20.json` | `6702168e049dd5315fad3f16ed2255110f4a09ca67c3d1b2070ffda1a932efeb` |
| `docs/evidence/summary-batch-2026-11-11T05.md` | `e1523cb9ed418fea5f5245e5e6676113e131775af02dfbdd79acf9b3f1e2c127` |
| `docs/evidence/summary-single-05-20.md` | `d5fbe5bccf65a98402baeedf4018e991dceda9a636762465f3633de5adbcf2e5` |
| `~/.chronicle/summaries/10min-2026-11-11T05-26-04.328Z.md` | `73f18ff1611225aced903223ed7c758bb9f9472abf86bfb94be177a3cafaecfd` |
| `~/.chronicle/summaries/6h-2026-11-11T00.md` | `d81f8d8d3e1f28aa7a5f8c4637e63f8cf88d5cd90fa3ee14000b3c00fcdf7266` |

---

## 9. 仍存的差距与下一步

1. **采集厚度（09:00 窗口大部分领先；Arc 侧栏与 paste+Return 已复测对齐）**：受控 35 键回放 35/35；09:00–09:10 窗口 shortcut 45 vs 34、text 495/495 字、AX 文本 1.57×、click 74 vs 60；submit 19 vs 21（Cmd+V 粘贴后 Return，已修，微信实时 7/7）；selection 0 vs 6（Arc 侧栏 `sidebarAllTabList`，已通过点击祖先订阅 + 1s 补读实机对齐）；mouse.drag/context_menu 已实机验证（右键 1/1、拖拽 Chronicle 领先）；window-change 09:49–09:59 窗口 **15 vs 11**（标题通知快速路径 + 无标题窗口规则，已反超）。
2. **6h 实体密度**：Codex 6h 31 个文件名 vs 我们 19；用 1M 上下文灌原始事件可补。
3. **记忆成熟度**：格式/字段/去重/检索已平齐（v2，证据见 `docs/evidence/memory-parity-2026-11-11.md`）；仅历史积累和 Codex rollout 会话输入仍差。
4. **技能导入/导出/图标/工作区技能**：Codex 有，我们暂未做（当前为本地 SKILL.md 列表+编辑器）。
5. **指标口径**：对照工具是文本启发式（字符/实体/关键词计数），不是语义质量评审；已配合人工抽样与独立 verifier，但样本仅一天 6 个窗口。
6. 工程收尾：512/512 测试绿，但改动未提交；Helper 已用稳定签名（Apple Development）重装并重启，TCC 授权保持有效（本轮实时事件为证）。

---

## 10. 结论

- **分析质量**：10 分钟同窗口 6/6 全胜（字符、文件名、URL、负证据、绝对路径合计全部 ≥）；6 小时结构/负证据更好、密度略低，判平齐。
- **采集**：09:00–09:10 完整窗口 shortcut 45 vs 34、text 495/495 字、AX 文本 1.57×、click 74 vs 60 均领先；受控 35/35；submit 19 vs 21（粘贴后 Return 已修，微信实时 7/7）；selection 0 vs 6（Arc 侧栏已实机对齐）；drag/context_menu 已实机验证。
- **产品能力**：历史记录、技能建议/创建/技能库、每日/每周洞察、下一步建议、DSH 式模型设置、长期记忆 v2 与 MCP 记忆检索均已落地；技能导入导出/图标与 6h 实体密度待补。
- **记忆**：MEMORY.md 任务组 / scope / applies_to / keywords / failures / references、memory_summary 索引与检索已与 Codex 平齐；Chronicle 多 Ongoing Tasks、next_actions、MCP `chronicle_memory`；Codex 多 agent rollout 输入与历史积累。
- 不宣称“全面超过”；按用户标准：**10min 分析已达到/超过，6h 平齐；09:00 窗口采集的 shortcut/text/click/AX 文本已领先，submit 差 2（已修，微信实时 7/7），selection 差 6（Arc 侧栏已实机对齐）；drag/context_menu 已实机验证；window-change 09:49–09:59 已 15 vs 11 反超；记忆格式/检索平齐。**
