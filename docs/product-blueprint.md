# Chronicle 产品蓝图 v1.0

- 状态：可作为实现基线（完整版）
- 日期：2026-11-12
- 关联文档：`docs/evidence/memory-parity-2026-11-11.md`、`docs/codex-comparison.md`、`docs/evidence/rea-skysight-keyboard-selection.md`
- 读者：产品、工程、设计、未来合作者

> 一句话：**Chronicle 是电脑的连续观察层 → 10 分钟摘要 → 6 小时摘要 → 长期记忆 → 线程 → agent 的家。**
>
> 它不追每个 agent 的私有日志；它观察用户可见、系统可访问的表面。它的终局不是“记录你做了什么”，而是“让你和任何 agent 共享同一份可信的工作记忆”。

**本版（v1.0）完成度**：

- 产品层：愿景、问题、定位、非目标、原则、用户、JTBD、一天/一周/一年场景。
- 系统层：架构图、时间尺度、进程/存储布局。
- 规格层：采集事件模型与字段、10 分钟/6 小时摘要输入/输出/质量、记忆 schema 与合并算法、线程数据模型/状态机/检测/API、Agent 权限阶梯/审计/回滚/Context Pack、安全威胁模型、按需 OCR、采集完备性账本。
- 执行层：现状盘点、P0–P4 路线图与验收、指标、商业模式、风险、开放决策。
- 附录：事件字段、摘要格式、记忆示例、线程示例、Agent 注册/权限/审计、Context Pack、HTTP/MCP API、fixture 矩阵、术语表。

---

## 目录

- Part I 产品
  - 1. 愿景
  - 2. 问题
  - 3. 定位与非目标
  - 4. 七条原则
  - 5. 用户与 JTBD
  - 6. 场景：一天 / 一周 / 一年
- Part II 系统
  - 7. 总览架构
  - 8. 时间尺度与数据流
  - 9. 进程与存储布局
- Part III 各层规格
  - 10. 采集层
  - 11. 10 分钟摘要层
  - 12. 6 小时摘要层
  - 13. 记忆层
  - 14. 工作对象、洞察与闭环
  - 15. Agent 层
  - 16. 信任、权限与审计
  - 17. 视觉与按需 OCR
  - 18. 采集完备性账本
- Part IV 执行
  - 19. 现状盘点
  - 20. 路线图与验收
  - 21. 指标
  - 22. 商业模式
  - 23. 风险
  - 24. 开放决策
- 附录
  - A. 事件类型与字段
  - B. 摘要文件格式
  - C. MEMORY.md 示例
  - D. 线程 JSON 示例
  - E. Agent 注册 / 权限 / 审计
  - F. Context Pack 格式
  - G. HTTP / MCP API 草案
  - H. 验收 fixture 矩阵
  - I. 术语表

---

# Part I 产品

## 1. 愿景

**让电脑拥有记忆，并让任何 agent 都能借用这份记忆。**

今天的电脑是“失忆”的：每个 app、每个 agent、每次对话都从零开始。人被迫成为所有工具之间的粘合剂：记住上次做到哪、文件在哪、答应过谁什么、为什么做了某个决定。

Chronicle 要成为这层缺失的基础设施：

- 对用户：一台**记得你经历过什么**的电脑。
- 对 agent：一个**懂你、可信、可审计**的家。
- 对团队：一份**不会因人离开而消失**的制度记忆。

### 1.1 结果定义（不是过程）

Chronicle 不按“记录了多少事件/建了多少对象”衡量成功，而按用户结果：

1. **60 秒内回答**：今天推进了什么、卡在哪、下一步是什么。
2. **承诺/任务闭环率提升**，返工与上下文恢复时间下降。
3. **洞察能改变至少一个行动/决策**，而不是生成更多笔记。
4. **交接/换 agent 不丢上下文**：新人/新 agent 几分钟进入状态。
5. **用户信任**：知道什么被记录、什么没被记录；可暂停、可删除、可导出。

不满足这些结果的功能，不继续扩张。

最终形态：`The operating system remembers.` 你的上下文属于你，agent 只是借用。

## 2. 问题

### 2.1 三个失忆

1. **应用失忆**：飞书不知道你在 WPS 做了什么，终端不知道你在浏览器查了什么。
2. **agent 失忆**：Codex 只记得 Codex 会话，Claude 只记得 Claude 会话；换一个 agent，上下文清零。
3. **人失忆**：一天结束，你记得“很忙”，但说不清推进了什么、卡在哪、答应过谁什么。

### 2.2 现有方案的缺口

| 方案 | 缺口 |
|---|---|
| 截图/录屏（Recall 类） | 隐私反噬；像素不可搜索；无法理解任务 |
| 各 agent 自带 memory | 单工具孤岛；换 agent 重置；用户不拥有 |
| 手动笔记/任务管理 | 需要人维护；记录的是“计划”，不是“实际发生” |
| 浏览器历史/应用日志 | 只有局部；没有任务、决策、承诺 |
| 通用 chatbot | 没有你的持续上下文；每次重新讲背景 |

### 2.3 Chronicle 的答案

- **连续观察**，不是一次性截图。
- **结构化压缩**，不是原始日志。
- **跨 app / 跨 agent / 跨年**，不是单工具记忆。
- **证据优先**，不是模型幻觉。
- **本地优先**，不是把生活交给云端。

## 3. 定位与非目标

### 3.1 定位

**Personal Agent Home：个人与 agent 共享的工作记忆层。**

- 对用户：今天的工作对象、历史的决策、长期画像、未闭环、可验证的洞察。
- 对 agent：对象/线程上下文、记忆检索、权限、审计、回滚。
- 对团队：共享对象/线程、交接、制度记忆。

### 3.2 非目标

- **不是默认录屏工具**：不默认截屏、不存像素、不录音。
- **不是 per-agent 日志聚合器**：不读 Codex/Claude/ChatGPT 的私有会话存储；只观察可见表面。
- **不是又一个 chatbot**：界面是对象/任务线/线程，不是聊天框。
- **不是生产力监控/绩效工具**：定位是用户的记忆，不是老板的监控。
- **不是全知全能**：采集不到的就写“未观察到”，并记录盲区。
- **不是无限扩张的建模工具**：不把所有事塞进同一种对象；每个对象必须有出口；功能不闭环就不做。

## 4. 七条原则

1. **可见表面优先**：只观察用户能看到、OS 能访问的内容；不读进程内部。
2. **连续观察**：单个视口会滚动；连续采样把视口变成时间流。
3. **证据优先**：每条结论可追溯到事件/摘要/文件/时间；没有证据就写负证据。
4. **隐私是生死线**：默认不采密码/secure input/无痕/黑名单；视觉按需、本地、可关。
5. **用户拥有上下文**：可导出、可删除、可迁移；agent 只是借用。
6. **agent 中立**：任何 agent 都能入住；Chronicle 不绑定任何模型/厂商。
7. **结果优先**：每个对象必须有下一步或归档；每个洞察必须能被验证、应用、退休；做不到闭环的功能不做，不无限扩张。

## 5. 用户与 JTBD

### 5.1 用户

| 用户 | 核心痛点 | Chronicle 提供 |
|---|---|---|
| 知识工作者 | 一天很忙但说不清推进了什么 | 任务线、open loops、周报证据 |
| 开发者/构建者 | 跨 Codex/Claude/终端/浏览器，上下文断 | 线程、决策链、上次失败怎么修 |
| 咨询/交付/客服 | 客户问进度，证据散落 | 交付证据包、承诺追踪、交接 |
| 团队负责人 | 人走记忆丢，新人上手慢 | 共享线程、制度记忆、入职包 |
| 隐私敏感者 | 不想被录屏/云端监控 | 本地优先、AX 文本、可暂停/删除 |

### 5.2 JTBD

- “我今天到底推进了什么？哪些没闭环？”
- “上次客户说的那个问题，我最后怎么处理的？”
- “这个项目从想法到上线，经历了什么？为什么改方案？”
- “我答应过谁什么？哪些没做到？”
- “如果明天我休假，谁能接手？先看什么？”
- “新 agent 怎么在五分钟内懂我？”

## 6. 场景：一天 / 一周 / 一年

### 6.1 一天

- 09:12 飞书客户说“图片又丢了”。
- 09:15 WPS 打开商品资料 PDF；09:25 Arc 核对商品页；09:40 终端让 agent 重跑。
- 10:05 微信回复“已修”；10:30 只验证到 91/1093 页。
- 18:00 你问“修没修？”Chronicle 给出：承诺 vs 证据缺口；线程 blocked；open loops：全量验证、图片清单、钉钉回执。
- 次日早上：Chronicle Agent brief 提醒这三个 open loops。

### 6.2 一周

- 周一需求 → 周二原型 → 周三测试失败 → 周四换方案 → 周五交付。
- 线程记录每次决策/返工/证据；周五生成交接包/证据包。
- 你问“为什么改了三次？” Chronicle 按时间线给出原因和证据。

### 6.3 一年

- 线程成为项目史；记忆成为个人画像/决策日志。
- 新 agent 入住，继承一年上下文；不用重新讲背景。
- 年度复盘：时间账本、反复返工、假设变化、技能沉淀。

---

# Part II 系统

## 7. 总览架构

```
┌──────────────────────────────────────────────────────────────┐
│ 采集层：屏幕 / 系统 / 输入 / 可见内容                         │
│ CGEventTap · AXObserver · NSWorkspace · AX snapshot           │
└───────────────────────────┬──────────────────────────────────┘
                            │ JSONL 段（10 分钟）
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 10 分钟摘要：任务片段、卡点、next_actions、suggestion          │
└───────────────────────────┬──────────────────────────────────┘
                            │ 6 个 10 分钟 + 事件概览
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 6 小时摘要：任务弧、决策、结果、返工、阻塞                     │
└───────────────────────────┬──────────────────────────────────┘
                            │ consolidation
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 记忆层：MEMORY.md 任务组 + memory_summary.md 画像 + 索引       │
└───────────────────────────┬──────────────────────────────────┘
                            │ 聚类 / 串联
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 对象/线程层：目标 + 状态 + 证据 + 未闭环 + 人 + 文件 + agent    │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
                ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Chronicle Agent（第一方）     │   │ Agent Home（任何 agent）      │
│ brief / open loops / resume   │   │ MCP / Object & Thread API     │
│ draft / act with permission   │   │ Pack / specialist agents      │
└───────────────┬──────────────┘   └───────────────┬──────────────┘
                │                                  │
                └──────────────┬───────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 信任层：权限阶梯、审计、证据收据、回滚、盲区账本              │
└──────────────────────────────────────────────────────────────┘
```

## 8. 时间尺度与数据流

| 尺度 | 输入 | 产物 | 回答 | 保留 |
|---|---|---|---|---|
| 事件 | 屏幕/系统/输入 | JSONL 事件 | 发生了什么 | 10 分钟段 |
| 10 分钟 | 事件 + 操作序列 + 记忆 | 10min 摘要 | 这一小段在做什么 | 长期 |
| 6 小时 | 6×10min + 事件概览 + 记忆 | 6h 摘要 | 这半天推进了什么 | 长期 |
| 记忆 | 10min/6h 摘要 | MEMORY.md / memory_summary | 跨天记住了什么 | 长期 |
| 对象/线程 | 摘要 + 记忆 + 事件 | Work Object / Thread View | 这件事走到哪、下一步是什么 | 长期 |
| Agent | 线程 + 记忆 + 权限 | brief/动作/证据 | 下一步做什么 | 审计 |

**压缩原则**：

- 事件 → 摘要：去掉动作流水，保留任务弧、结果、卡点、证据。
- 摘要 → 记忆：去掉窗口级细节，保留跨天有效的任务组、偏好、经验、失败。
- 记忆 → 线程：从“过去发生了什么”转为“现在要做什么”。
- 线程 → Agent：从“上下文”转为“可执行动作 + 权限”。

## 9. 进程与存储布局

### 9.1 进程

| 进程 | 职责 |
|---|---|
| `Chronicle Helper.app` | Swift 采集：CGEventTap、AXObserver、AX 快照、窗口/URL、隐私闸门 |
| `daemon.mjs` | 本地 HTTP API、段管理、摘要调度、记忆合并、维护、Web 静态服务 |
| `summarize.mjs` | 10min/6h 摘要、记忆合并、技能草稿、洞察 |
| `mcp-entry.mjs` | stdio MCP：today/search/summary/memory/pause/resume/status |
| Web | 今天/历史/记忆/洞察/技能/设置/蓝图 |
| Chronicle Agent（计划） | 第一方 agent：brief/open loops/resume/act |
| Agent Home（计划） | agent 注册、线程 API、权限、审计 |

### 9.2 存储（现状 + 计划）

```
~/.chronicle/
  segments/<UTC>/events.jsonl      # 事件流（现状）
  summaries/10min-*.md             # 10min 摘要（现状）
  summaries/6h-*.md                # 6h 摘要（现状）
  MEMORY.md                        # 任务组记忆（现状 v2）
  memory_summary.md                # 长期画像（现状）
  memory_pending.json              # 消费指纹（现状）
  skills/                          # 技能库（现状）
  insights/                        # 洞察（现状）
  backups/                         # 迁移备份（现状）
  threads/<id>.json                # 线程快照（计划；当前由 Context Pack 动态生成）
  agents/<id>.json                 # agent 注册/权限（现状：agents.json）
  audit/<date>.jsonl               # agent/工作对象审计（现状）
  coverage/                        # 采集覆盖（不落盘；由段文件实时计算）
```

**数据安全**：

- 所有文件本地；默认 0600；原子写；无云端同步。
- 摘要/记忆会进入用户配置的 LLM 服务商（默认 MiniMax）；事件原文不直接上传（只传压缩后的操作序列/摘要）。
- 视觉 OCR 本地处理；像素默认不落盘。

---

# Part III 各层规格

## 10. 采集层

### 10.1 采集范围

**采**：

- 前台 app、窗口、标题、文档路径、URL、标签页。
- 键盘/文本/IME/粘贴/快捷键/点击/右键/拖拽/滚动（计划）。
- 选区（文本/行/列/单元格）。
- AX 树 full/diff：角色、标题、值、控件。
- 菜单、弹窗、焦点变化。
- 可见窗口（计划，当前主要前台）。

**不采**：

- 屏幕像素（默认）；音频/麦克风。
- 密码框、secure input、无痕、黑名单 app/URL。
- 进程内部状态、网络流量、其他工具私有日志。

**按需**：

- 当前窗口截图 + 本地 OCR：用户触发或明确询问；像素不落盘；敏感场景跳过。

### 10.2 事件模型

所有事件：

```json
{
  "ts": "2026-11-12T02:15:06.715Z",
  "tsMs": 1762913706715,
  "type": "click",
  "data": { "...": "类型相关字段" }
}
```

事件类型与关键字段见附录 A。

### 10.3 采集机制

| 机制 | 用途 |
|---|---|
| CGEventTap（listen-only） | 键盘、文本、快捷键、点击、右键、拖拽、滚动（计划） |
| AXObserver | 焦点、选区、窗口标题、菜单、窗口变化 |
| NSWorkspace 通知 | app 激活/切换 |
| AX 快照 | 窗口内容 full/diff；节点/字符预算 |
| URL 读取 | 浏览器地址（Safari/Chrome/Arc 等） |
| 窗口列表 | 窗口号、可见窗口（计划） |
| 延迟补读 | 点击后 1s 读选区；Return 后 250ms 判定 submit |

### 10.4 采样与触发

- 常规采样：2s（可配置）。
- 快速路径：AX 标题/焦点窗口通知，非浏览器 app 立即记 window-change。
- 选区防抖：120ms；点击后 1s 补读。
- 文本 flush：窗口切换/空闲/Return 时落盘。
- 去重：窗口标题的“有意义部分”比较；选区 lastSelectionKey。

### 10.5 隐私闸门

| 闸门 | 行为 |
|---|---|
| secure input | 整机停止内容采集，只记抑制审计 |
| 密码控件 | 不读 value，不产生内容事件 |
| 无痕/隐私浏览 | 不记 URL/内容 |
| app/url 黑名单 | block 永远优先；不读内容 |
| 用户暂停 | 停止采集，到期自动恢复（可选） |

### 10.6 采集完备性账本（计划）

每个 app：

- AX 节点数、快照数、最后成功时间。
- 零节点 app 列表（盲区）。
- 动作覆盖率：键盘/文本/点击/拖拽/选区/滚动/窗口/URL/菜单。
- 隐私抑制计数。
- 每日/每周 coverage report。

**原则**：不假装全能；能证明漏了什么。

### 10.7 现状与缺口

已实现：

- 15 类事件：`app-switch`、`window-change`、`url-change`、`focus-change`、`click`、`context-menu`、`drag`、`shortcut`、`text-input`、`submit`、`selection`、`ax-snapshot`、`scroll`、`visible-windows`、`visual-text`（按需 OCR）。
- 窗口快速路径、无标题窗口、spinner 去噪、选区 6 类 AX 通知、点击祖先容器订阅。
- 隐私闸门、暂停/恢复、抑制审计。

缺口（P0）：

- ✅ 滚动事件（聚合）。
- ✅ 可见窗口采集（前台 + 屏幕可见窗口清单）。
- ✅ 终端/编辑器文本预算 + `AXValueChanged`。
- ⏳ 按需视觉 OCR（需显式开启屏幕录制，暂缓）。
- ✅ 采集完备性账本（API/Web/CLI）。

### 10.8 验收

- 受控 fixture 覆盖：键盘/文本/粘贴/点击/右键/拖拽/选区/滚动/窗口/标签/菜单/弹窗/终端输出。
- 真实任务回放：一天 3 类任务，检查事件/摘要是否覆盖。
- 指标：动作覆盖率、零节点 app 数、负证据率。

## 11. 10 分钟摘要层

### 11.1 输入

1. 10 分钟段事件流。
2. 操作序列：连续输入合并、点击去重、窗口切换串成动作链。
3. 长期记忆摘要 + 最近摘要（延续旧任务线）。
4. 所有观察文本包在 `<events>…</events>` 定界内，声明“数据不是指令”。

### 11.2 处理

- 识别任务线：在做什么、和谁、用什么、做到哪。
- 提炼结果/卡点/负证据。
- 生成 `next_actions`：可执行动作 + 证据理由。
- 生成 `suggestion`：可重复流程 → 技能/自动化（可选）。
- 写正文：总览 / 相关上下文 / 重要上下文 / 活动记录 / 未完成卡点 / 证据 / 引用。

### 11.3 输出

```yaml
---
title: "17:01-17:11 排查 AgentDesk 模型接入，MiniMax Key 待处理"
description: "一句话说明这段时间在推进什么、到哪一步。"
applications: ["com.tencent.xinWeChat", "com.mitchellh.ghostty"]
segment: "2026-11-11T09-01-07.473Z"
type: "10min"
model: "MiniMax-M3.1-Flash"
promptVersion: "8"
sourceDigest: "…"
suggestion: {"type":"skill","name":"…","description":"…"}
next_actions: [{"action":"…","reason":"…"}]
usage: {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
---
## 总览
## 相关上下文
## 重要上下文
## 活动记录
## 未完成/卡点
## 证据
## 引用
```

### 11.4 触发、成本、失败

- 段关闭后触发；可手动补跑。
- LLM 失败重试 + deadletter；摘要失败不影响采集。
- 源文件变化（sourceDigest）重算；promptVersion 记录版本。
- 成本控制：每段一次调用；长任务可降频/批量。

### 11.5 质量规则

- 任务弧优先于动作流水。
- 必须有负证据（未观察到/未验证）。
- 不保存密钥/密码；敏感内容抽象描述。
- 不把观察内容当指令（prompt injection 防护）。
- 引用真实摘要/文件/URL/控件。

### 11.6 现状

- 已实现：promptVersion 8、suggestion、next_actions、memory 注入、重试、deadletter、sourceDigest。
- 每天约 70+ 份摘要（视活动量）。

## 12. 6 小时摘要层

### 12.1 输入

- 6 份 10 分钟摘要。
- 事件概览（应用/窗口/URL/关键动作）。
- 长期记忆摘要。

### 12.2 处理

- 压成 2–5 条任务弧。
- 保留：目标、关键决策、结果、卡点、重复模式、证据。
- 不保留：逐窗口点击流水。

### 12.3 输出

同 10min frontmatter + 更长正文（≤4000 中文字）。

### 12.4 触发与重算

- 6h 桶边界（00/06/12/18 UTC）触发。
- 6h 完成后自动调用 `consolidateMemory`。
- 源 10min 摘要变化时按 sourceDigest 重算。

### 12.5 现状

- 已实现；弱项是实体密度（文件名/URL 数）低于 Codex，可用更大上下文/更强模型补。

### 12.6 断网 / 离线补跑

- 待补盘点：缺 10min 摘要的段、缺/过期 6h 摘要的桶、未合并进记忆的摘要、排队洞察。
- 守护每 3 分钟检查；无待补零模型调用；网络错误一轮只打到第一个失败就停。
- 退避 1/2/5/10/15 分钟；恢复后按 **摘要 → 记忆 → 洞察** 自动补齐。
- 洞察网络失败入队，不丢请求；今天页显示「分析待补 N 项 / 立即补跑」。
- 状态：`analysis-state.json`（0600）+ `GET /api/analysis/status` / `POST /api/analysis/retry`。

## 13. 记忆层

### 13.1 数据流

```
summaries/*.md（10min/6h，证据）
        │ 未消费摘要 + 旧记忆
        ▼
consolidateMemory（LLM）
        │
        ├─→ MEMORY.md：任务组 + 任务 + 证据/偏好/经验/失败
        ├─→ memory_summary.md：画像 + 进行中 + What's in Memory
        └─→ memory_pending.json：已消费指纹
```

### 13.2 MEMORY.md v2

```markdown
# Task Group: Hulala 客服知识库建设

scope: 适用于 Hulala 网页/PDF/Excel/JSONL 归档、图片完整性检查及钉钉上传验收。
applies_to: cwd=…；reuse_rule=目录产物、后台状态、上传回执和抽样内容需分别验收

## Task 1: Hulala 客服知识库归档、图片完整性与最终验收, partial

- date: 2026-11-11
- keywords: Hulala、PDF、图片清单.csv、PASS-final、245、钉钉上传
- evidence: 10min-…（钉钉“正在上传”，未见回执）；10min-…（README 声明 398 PDF…）
- references: 10min-…；10min-…
- preferences: 交付同时提供 PDF、Markdown、Excel、JSONL、索引；抽样核验…
- learnings: 目录存在不等于任务完成；合集 PDF 存在不等于 245 页全量覆盖…
- failures: 图片清单/终稿未独立核验；钉钉“正在上传”不等于成功，下次要回执
```

### 13.3 memory_summary.md

- `User Profile`：稳定画像。
- `User preferences`：反复出现的偏好。
- `Ongoing Tasks`：进行中任务与状态。
- `General Tips`：可复用经验。
- `What's in Memory`：任务组 → 最近任务/结果/关键词索引。

### 13.4 合并算法

1. 读取 pending，找未消费摘要（先按时间窗扫描再过滤，避免 limit 饥饿）。
2. 构造 prompt：旧 summary + 旧 MEMORY.md（截断）+ 任务组索引 + 最近摘要。
3. LLM 输出 `memory_summary_markdown` + `memory_sections`。
4. 解析/归一化：task_group/scope/applies_to/title/date/outcome/keywords/evidence/references/preferences/learnings/failures。
5. 合并：
   - 按 task_group 匹配；组名漂移但任务标题一致 → 归入旧组。
   - 同一任务线更新；组内单任务直接更新；多任务用标题相似度。
   - 数组去重（近义 ≥0.82）；上限：偏好 6 / 经验 6 / 失败 4 / 关键词 12 / 引用 8。
6. 生成 `What's in Memory` 索引，追加到 summary。
7. 原子写三件套；更新 pending 指纹；失败不改文件。
8. v1 文件迁移：扁平节按 task_group 归组；同组快照合并。

### 13.5 检索

- 摘要/洞察 prompt 自动注入。
- MCP `chronicle_memory`：按任务组/标题/关键词/证据检索。
- Web「记忆」：任务组卡片 + 证据/偏好/经验/失败。

### 13.6 现状

- v2 已实现；真实合并 49 份摘要 → 5 新增 / 17 更新 → 10 组、0 重复。
- 测试：memory 18 项；全量 512。

### 13.7 开放问题

- 矛盾信息如何裁决（保留冲突 + 时间戳 vs 覆盖）。
- 记忆衰减/归档策略。
- 实体图（人/项目/文件）何时引入。
- 是否支持用户手动 pin/编辑记忆（当前可直接编辑文件）。

## 14. 工作对象、洞察与闭环

> 你说得对：**线程不是本体，洞察不是事后总结，产品不能无限扩张。**
> 这一章把「工作对象 → 洞察 → 闭环 → 随用随取」拆开，先解决“它到底是什么”，再解决“它怎么被用起来、怎么退出”。

### 14.0 先纠正三个错误

1. **不是所有事都是“线程”**：临时任务、长线目标、持续责任、承诺、决策、异常、洞察，生命周期完全不同；用“线程”一把抓，最后一定堆成一个无法管理的池子。
2. **识别出来不等于要一直放着**：每个对象必须有类型、下一步/复盘日期，或者归档；没有“无主对象”。
3. **洞察不是“总结”**：洞察是**可复用、可验证、能改变未来行为**的结论；不能改变行为的，只是摘要，不是洞察。

### 14.1 工作对象：九种类型

| 类型 | 时间尺度 | 结果 | 生命周期 | 复盘节奏 | 例子 |
|---|---|---|---|---|---|
| Action 动作 | 秒–分 | 一次操作 | 捕获 → 附着/24h 过期 | 不单独复盘 | 发一条消息、点一个按钮 |
| Task 任务 | 小时–天 | 一个可完成的结果 | inbox → clarified → doing → done/dropped → archived | 每天 | 修一个 PDF 页数问题 |
| Project 项目 | 天–月 | 多步骤交付 | proposed → active → blocked → done/abandoned → archived | 每周 | Hulala 知识库归档 |
| Goal 目标 | 月–年 | 可衡量结果 | set → active → achieved/missed/revised → archived | 每月/每季 | 把交付返工率降 30% |
| Area 责任 | 长期 | 持续维持的标准 | active → reviewed → active（没有 done） | 每月 | 客服知识库维护 |
| Commitment 承诺 | 小时–周 | 对某人/某事的兑现 | made → due → followed_up → fulfilled/broken/renegotiated | 每天 | “周五前发你 PDF” |
| Decision 决策 | 天–年 | 一个选择及其后果 | proposed → decided → review_due → confirmed/revised | 到期复盘 | 选 A 方案还是 B 方案 |
| Insight 洞察 | 周–年 | 可复用的规律/教训 | candidate → validated/refuted → applied → retired | 每周/每月 | “PDF 图片校验总是被低估” |
| Incident 异常 | 分–天 | 恢复 + 防止再发 | detected → triaged → mitigating → resolved → prevented | 实时/每天 | 上传失败、agent 跑挂 |

**关键**：临时的事可以是 Task/Action，不强行升格为 Project；长期的事可以是 Goal/Area，不强行塞进“今天待办”。类型错了，后面全错。

### 14.2 线程是视图，不是本体

线程（Thread）只做一件事：**把围绕同一个目标/实体的对象串成一条叙事线**。

- 一个线程可以包含：Project + Tasks + Commitments + Decisions + Insights + Incidents。
- 临时 Task 可以不进线程；长线 Goal 可以有一个线程视图。
- 线程不是容器，不拥有对象；对象可以同时出现在多个视图里。
- 线程只在以下情况自动创建：≥2 个对象共享同一目标/实体，或用户手动 pin；否则对象独立存在。

线程视图 JSON：

```json
{
  "id": "view-hulala-image-fix",
  "title": "Hulala 图片修复",
  "kind": "thread_view",
  "goal": "客户反馈商品图片丢失，修复并验证全量商品页",
  "object_ids": ["proj-hulala-kb", "task-pdf-verify", "commit-customer-a", "insight-pdf-image"],
  "state": "blocked",
  "status_note": "已重跑，已回复客户，但只验证到 91/1093 页",
  "open_loop_ids": ["loop-verify-245", "loop-image-list", "loop-dingtalk-receipt"],
  "updated_at": "2026-11-11T10:30:00Z"
}
```

### 14.3 每个对象的状态机

| 类型 | 状态 | 进入条件 | 退出条件 | 超时/无人处理 |
|---|---|---|---|---|
| Task | inbox → clarified → doing → done/dropped | 用户确认/自动归类 | 有结果或明确放弃 | 7 天无动作 → 归档并记原因 |
| Project | proposed → active → blocked → done/abandoned | 有目标+范围 | 交付/放弃 | 14 天无进展 → 标 blocked，进周报 |
| Goal | set → active → achieved/missed/revised | 有指标+期限 | 到期/达成/重设 | 到期未复盘 → 月度提醒一次 |
| Area | active → reviewed → active | 长期责任 | 不再负责 | 每月未复盘 → 进月度清单 |
| Commitment | made → due → followed_up → fulfilled/broken/renegotiated | 检测到承诺 | 有兑现/改期/明确拒绝 | 到期无证据 → 每日 brief 提醒，3 次后标 broken |
| Decision | proposed → decided → review_due → confirmed/revised | 有选项/取舍 | 到期复盘 | 复盘到期 → 提醒一次；不重复骚扰 |
| Insight | candidate → validated/refuted → applied → retired | 有证据/反证 | 被验证/使用/过期 | 30 天未验证 → 降级/归档 |
| Incident | detected → triaged → mitigating → resolved → prevented | 异常规则 | 恢复+防再发 | 24h 未处理 → 升级/周报 |
| Action | captured → attached/expired | 事件发生 | 附着到对象或过期 | 24h 自动过期（不进入管理池） |

**“无人处理”是产品的一部分**：每个状态都有超时策略，避免“识别出来就一直放着”。

### 14.4 Triage / Clarify：防止无限堆积

每个新对象先进入 **Inbox**，只做三件事：

1. **这是什么？** 自动分类 + 用户确认（Task/Project/Goal/Commitment/Decision/Insight/Incident）。
2. **下一步是什么？** 一个动作，或一个复盘日期，或“归档”。
3. **它属于谁/哪条线？** 关联 Project/Goal/Area/人/文件；没有关联也可以，但必须有下一步。

规则：

- **无主对象不可存在**：7 天没有类型/下一步/关联 → 自动归档，并在周报说明原因。
- **上限**：活跃 Project ≤ 7，活跃 Goal ≤ 3，活跃 Insight ≤ 20，Inbox Task ≤ 30；超出必须合并/退休/排队。
- **一次只问一个问题**：不要用 20 个字段吓用户；先类型，再下一步，其余自动推断。
- **可撤回**：自动分类错了，一键改类型；不影响原始证据。

### 14.5 洞察引擎：从“发生过”到“下次怎么做”

#### 14.5.1 什么是洞察

> 洞察 = 可复用 + 有证据 + 能改变未来行为/决策的结论。

不是“今天做了 X”，不是“本周很忙”，而是：

- “每次 PDF 交付，图片校验时间都被低估 2 倍；下次先跑图片清单再估时。”
- “MCP 改完不重启，agent 一定失败；下次把重启写进流程。”
- “客户 A 的图片资源经常缺失；下次先要原始素材再开工。”
- “我在下午 3 点后做核对类工作，错误率明显更高；把核对放在上午。”

#### 14.5.2 洞察类型

| 类型 | 问题 | 例子 |
|---|---|---|
| Pattern 模式 | 什么反复发生？ | 每周五都在补 PDF 页数 |
| Bottleneck 瓶颈 | 哪一步卡住整个流程？ | 图片校验占总交付时间 40% |
| Root cause 根因 | 为什么反复失败？ | 失败不是模型，是没重启 MCP |
| Risk 风险 | 什么可能出事？ | 客户素材缺失导致返工 |
| Opportunity 机会 | 什么可以自动化/技能化？ | 重复的导出→核对→上传 |
| Preference 偏好 | 什么做法更适合我？ | 先写结论再补细节 |
| Exception rule 异常规则 | 什么情况下必须换做法？ | 超过 3 次返工就停手复盘 |

#### 14.5.3 洞察对象

```json
{
  "id": "insight-pdf-image-underestimated",
  "type": "bottleneck",
  "claim": "PDF 交付里图片校验时间被系统性低估，导致交付延期",
  "scope": {"user": "me", "project": "hulala-kb", "apps": ["wps", "finder"]},
  "evidence": ["10min-…", "task-…"],
  "counter_evidence": ["10min-…（某次校验很快）"],
  "confidence": 0.72,
  "sample_size": 6,
  "first_seen": "2026-10-20",
  "last_seen": "2026-11-11",
  "expiry": "2026-12-11",
  "status": "candidate",
  "actionability": "high",
  "suggested_action": "下次先跑图片清单，再估时",
  "related_objects": ["proj-hulala-kb", "task-pdf-verify"]
}
```

#### 14.5.4 生成管线

1. **信号**：频率、时长、切换、返工、失败、承诺、上下文切换、时间段、序列。
2. **基线**：按用户/项目/app/时间段建基线；偏离基线才是异常。
3. **候选**：统计 + 序列挖掘 + LLM 归纳；LLM 只提候选，不下结论。
4. **证据/反证**：至少 3 次或 2 周支持；主动找反例。
5. **置信/范围/过期**：低置信不进 brief；范围写清（项目/时间/app）。
6. **用户验证**：确认/反驳/改写；验证后才升级为“已验证洞察”。
7. **应用**：关联到决策/动作；记录是否真的改变了行为。
8. **退休**：过期/被推翻/不再相关 → retired，保留原因。

#### 14.5.5 管理理论映射

| 理论/学科 | 解决什么 | 产品落点 |
|---|---|---|
| GTD（Allen） | 捕获/澄清/组织/复盘/执行；六层视野 | Inbox/Triage、Work Object 类型、日/周复盘 |
| PDCA（Deming） | 计划-执行-检查-改进 | Project/Insight 闭环 |
| OODA（Boyd） | 观察-定向-决策-行动 | 异常处理、实时 brief |
| Cynefin（Snowden） | 简单/复杂/错综/混乱，不同问题不同方法 | 自动分类与“不要过度自动化”的边界 |
| Drucker | 目标管理、反馈分析、知识工作者有效性 | Goal/Area、决策复盘、时间账本 |
| Deming（变异） | 区分系统噪声与真实信号 | 洞察最低样本、基线、反证 |
| Argyris/Schön | 单环 vs 双环学习 | 洞察要挑战假设，不只改动作 |
| Klein（RPD/前 mortem） | 自然决策、事前验尸 | 决策记录、风险洞察 |
| Nonaka（SECI） | 隐性→显性→组合→内化 | 洞察外化、合并、技能化 |
| 约束理论（Goldratt） | 找瓶颈，不要优化非瓶颈 | 瓶颈类洞察、项目复盘 |
| Pareto | 80/20 | 洞察优先级、brief 只留 3 条 |
| AAR / 5 Whys | 事后复盘、根因 | Incident/Decision 复盘 |
| PARA / Zettelkasten | 组织与检索、原子笔记、链接 | 对象/洞察的原子化与双向链接 |

### 14.6 闭环：每个循环都要有“出口”

| 闭环 | 触发 | 输出 | 无人处理时 |
|---|---|---|---|
| Capture → Clarify → Organize → Reflect → Engage（GTD） | 新事件/摘要 | 类型、下一步、关联 | 7 天无主 → 归档 |
| Plan → Do → Check → Act（PDCA） | 项目/目标 | 计划、执行、检查、调整 | 14 天无进展 → blocked |
| Observe → Orient → Decide → Act（OODA） | 异常/机会 | 判断、动作、结果 | 24h 未处理 → 升级 |
| Commitment → Follow-up → Closure | 承诺 | 兑现/改期/拒绝 | 到期 3 次提醒 → broken |
| Decision → Outcome → Review | 决策 | 复盘、确认/修正 | 到期提醒一次 |
| Insight → Action → Outcome → Learning | 洞察 | 行动、结果、再学习 | 30 天未验证 → 降级 |
| Incident → Triage → Resolution → Prevention | 异常 | 恢复、防再发 | 24h 未处理 → 升级 |
| Capture → Compress → Retrieve → Apply → Feedback | 记忆 | 摘要、检索、应用、反馈 | 无反馈 → 降低权重 |

**出口规则**：每个循环必须能“完成/放弃/归档”；不能只有入口没有出口。

### 14.7 节奏：什么时候看什么

| 节奏 | 时间预算 | 输入 | 输出 | 硬上限 |
|---|---|---|---|---|
| 实时 | 秒 | 异常/高风险 | 提醒/暂停 agent | 只推 critical |
| 早上 | 5 分钟 | 今天对象、到期承诺、风险 | 3 个优先项 + 1 个洞察 | 3 条 |
| 晚上 | 5 分钟 | 今天完成/未完成 | 关掉/改期/明天 3 件 | 3 条 |
| 每周 | 30 分钟 | Projects/Goals/Commitments/Insights | 本周复盘 + 下周重点 | 7 个项目 |
| 每月 | 60 分钟 | Areas/Goals/趋势/洞察 | 目标调整、洞察退休、技能 | 3 个目标 |
| 每季/年 | 2 小时 | 全部 | 回顾、原则、身份、归档 | 1 页 |

**原则**：每个节奏都有“看什么、不看什么、最多几条”。没有上限的复盘会变成新的负担。

### 14.8 异常：只推“需要你注意的”

#### 14.8.1 检测规则

| 异常 | 规则 | 严重度 |
|---|---|---|
| Stuck 停滞 | 活跃 Project N 天无进展 | warn |
| Rework 返工 | 同一 Task 重复 ≥3 次 | warn |
| Broken promise | Commitment 到期无证据 | warn/critical |
| Bottleneck 瓶颈 | 某一步占总时长 >40% | info/warn |
| Context thrash | 1 小时内跨 ≥4 个项目 | info |
| Error spike | 失败/abort 连续 ≥3 次 | critical |
| Missing evidence | 声称完成但无验证 | warn |
| Time anomaly | 活动显著偏离个人基线 | info（不评判） |

#### 14.8.2 处理

- **分级**：info → 周报；warn → 日 brief；critical → 实时（仅限高风险/可回滚）。
- **动作**：解决 / 忽略 / 延后 / 转成 Task/Insight。
- **抑制**：用户可 mute 一类异常；基线自适应；避免重复打扰。
- **学习**：解决后写一条 Insight 或规则；下次同类异常优先匹配。

### 14.9 随用随取：Pull + Push

**Pull（用户主动要）**：

- 自然语言：“上次客户 A 的图片问题怎么处理的？”
- 语义检索：对象/洞察/记忆/证据。
- 过滤：类型/项目/人/时间/状态。
- MCP：`chronicle_context`、`chronicle_search`、`chronicle_thread`、`chronicle_insights`。

**Push（系统主动给）**：

- 打开某个项目/app 时，显示相关 open loops/insights/decisions。
- 早上 brief；会前上下文；交接包；agent brief。
- 规则：高置信 + 及时 + 可行动；最多 3 条；可 mute。
- 不做“信息流”；只做“决策流”。

### 14.10 防膨胀：结果优先，不是功能优先

**对象上限**：

- 活跃 Project ≤ 7；活跃 Goal ≤ 3；活跃 Insight ≤ 20；Inbox Task ≤ 30。
- 超出：合并、退休、排队；不无限新建。
- 每个对象必须有下一步/复盘日期/归档原因。

**洞察预算**：

- 同时“候选/已验证”洞察 ≤ 20；低置信不进 brief。
- 30 天未验证 → 降级；90 天未应用 → 退休。
- 洞察必须关联行动/决策；没有应用的洞察只是笔记。

**结果指标**（不是过程指标）：

- 承诺闭环率、任务完成率、项目按时率。
- 决策复盘率、洞察验证率/应用率。
- Time-to-context（恢复一个项目要多久）。
- 返工率、上下文切换成本、交接时间。
- 用户信任：隐私事件、越权、撤销。

**功能退出**：

- 任何一个功能，如果 4 周内没有产生“决策/行动/结果”，就不继续加码；先砍或重做。
- 不为“看起来完整”而堆功能；只保留能闭环的。

### 14.11 数据模型 / API

工作对象通用字段：

```json
{
  "id": "task-pdf-verify",
  "type": "task",
  "title": "核对 245 个商品页图片",
  "state": "doing",
  "owner": "me",
  "project_id": "proj-hulala-kb",
  "goal_id": null,
  "next_action": "打开图片清单.csv，按商品页抽样",
  "due_at": "2026-11-12T18:00:00Z",
  "review_at": null,
  "evidence": ["10min-…"],
  "created_at": "…",
  "updated_at": "…"
}
```

洞察字段见 14.5.3；线程视图见 14.2。

API 草案：

- `GET /api/objects?type=&state=&project=&limit=`
- `POST /api/objects`（创建/确认）
- `PATCH /api/objects/:id`（类型/状态/下一步/归档）
- `GET /api/inbox`
- `POST /api/inbox/:id/clarify`
- `GET /api/insights?status=&scope=`
- `POST /api/insights/:id/validate|apply|retire`
- `GET /api/reviews/today|week|month`
- `GET /api/context?project=&thread=&query=`（随用随取）
- `GET /api/exceptions?severity=`

### 14.12 验收

**7 天试点**：

- Inbox 清零：每个新对象有类型/下一步/归档。
- 活跃 Project ≤ 7；无 7 天无主对象。
- ≥3 条候选洞察被验证/反驳；≥1 条应用到行动。
- ≥1 个承诺闭环；≥1 个决策到期复盘。
- 早上 brief 不超过 3 条；用户不觉得被骚扰。

**指标阈值**：

- 对象无主率 <5%。
- 洞察验证率 ≥30%（候选→已验证）。
- 洞察应用率 ≥10%（已验证→实际改变行动）。
- 承诺闭环率 ≥80%。
- Time-to-context 比手工快 50%。

---

## 15. Agent 层

### 15.1 核心判断

> Personal agent 会变成商品；“懂你”和“你敢让它做”不会。

Chronicle 不做“又一个 agent”，做 agent 的家：

- 记忆：跨 app、跨年、带证据。
- 权限：分级授权、审计、回滚。
- 连续性：换 agent 不重置。
- 中立：任何 agent 都能入住。

### 15.2 Chronicle Agent（第一方）

- 早上 brief：3 个优先对象、到期承诺、异常、1 条洞察。
- 恢复上下文：按对象/线程视图打开相关文件/链接/会话。
- 起草/执行：按权限阶梯行动；对象类型决定权限范围。
- 证据回写：每个动作 before/after，关联到对象/洞察。
- 长期学习：偏好、标准、客户、失败教训；只把验证过的洞察用于建议。

### 15.3 Agent Home（任何 agent）

- MCP / Object & Thread API：读对象/线程上下文、读记忆/洞察、写回证据。
- Agent Registry：名称、能力、权限、信誉、历史。
- Context Pack：对象/线程/项目/时间段 → 可携带上下文包（含洞察与证据）。
- Specialist agents：垂直专家按线程入住，干完离开，记忆留下。

### 15.4 权限阶梯

| 级别 | 权限 | 例子 |
|---|---|---|
| L0 | 只看 | 读线程/记忆，不改任何东西 |
| L1 | 只建议 | 起草回复、准备文件、提出下一步 |
| L2 | 经批准执行 | 你点确认后发消息/改文件/跑命令 |
| L3 | 范围内自主 | 在划定范围内自主行动，全程留证、可回滚 |

- 信誉由成功率、用户修改次数、事故记录决定。
- 每个动作有审计日志、证据收据、回滚路径。
- 权限可按对象类型/项目/线程/app/动作/时间范围细化。

### 15.5 审计与回滚

审计事件：

```json
{
  "ts": "2026-11-12T03:10:00Z",
  "agent": "chronicle-agent",
  "thread": "thread-hulala-image-fix",
  "action": "send_message",
  "scope": "wechat:customer-a",
  "before": "…",
  "after": "…",
  "evidence": ["10min-…"],
  "approval": "user",
  "reversible": true,
  "undo": {"type": "delete_message", "id": "…"}
}
```

- 可回滚动作：发消息（撤回）、改文件（还原）、跑命令（反向/快照）。
- 不可回滚动作：必须 L2 批准 + 明确提示。
- Kill switch：一键暂停所有 agent 行动。

### 15.6 Context Pack

```json
{
  "version": 1,
  "kind": "work-pack",
  "objects": ["…"],
  "thread_view": { "…": "可选叙事视图" },
  "insights": ["…"],
  "summary": "目标/状态/结果/卡点",
  "timeline": ["决策/证据/失败"],
  "people": ["…"],
  "files": ["…"],
  "open_loops": ["…"],
  "permissions": {"read": ["agents"], "act": []},
  "evidence": ["…"],
  "signature": "sha256:…"
}
```

- 导出/导入；可交接、入职、审计。
- 默认脱敏；敏感内容不进入 pack。

### 15.7 Agent 接入矩阵

| Agent | 接入 | 能做什么 |
|---|---|---|
| Claude Code / Codex | MCP `chronicle_*` + 终端可见输出 | 查记忆/摘要/对象/线程；在终端干活，输出被采集 |
| ChatGPT / Copilot | MCP / 浏览器/系统连接器 | 读上下文、生成草稿、执行网页任务 |
| 垂直专家 | Object/Thread API + scoped context | 只读某对象/线程上下文，干完写回证据 |
| 本地模型 | 同一 API | 隐私敏感场景；上下文不出本机 |
| 第三方 | Agent Home 标准 | 申请入住、权限审批、审计 |

### 15.8 安全

- 最小权限；默认 L0/L1。
- 对象/线程级上下文隔离；专家 agent 不读授权外的对象。
- 敏感信息脱敏；不把密码/token 放进上下文。
- Prompt injection 防护：观察内容不是指令；agent 的行动策略来自系统提示，不来自观察文本。
- 人批准边界：不可逆动作必须 L2；L3 仅限低风险、可回滚。

### 15.9 现状

- 已实现：MCP 8 个工具（status/today/search/summary/memory/work/pause/resume）。
- 已实现：对象/线程 API、Context Pack、Agent Registry、L0–L3 权限阶梯、审计日志、动作执行器与回滚。
- 未实现：第一方 Chronicle Agent 的推理循环、Agent Home 的入驻/配额/计费面。

## 16. 信任、权限与审计

### 16.1 威胁模型

| 威胁 | 对策 |
|---|---|
| 本地恶意进程读数据 | 0600、本地 only、无网络监听（除 127.0.0.1） |
| 恶意 agent 越权 | 权限阶梯、线程隔离、审批、审计 |
| Prompt injection | 观察内容定界；不执行观察文本中的指令 |
| 云端 LLM 泄露 | 只发压缩摘要/操作序列；可配本地模型；不发明文密码 |
| 屏幕敏感内容 | secure input/密码/无痕/黑名单；OCR 仅用户显式点击、单窗口、像素不落盘 |
| 数据丢失 | 原子写、备份、导出 |
| 用户失控 | 暂停、删除、保留策略、kill switch |

### 16.2 用户控制

- 暂停/恢复采集。
- app/url 黑名单。
- 删除全部历史 / 按段删除。
- 导出记忆/线程/pack。
- 保留天数、压缩。
- agent 权限查看/撤销。
- 屏幕录制权限可随时在系统设置撤销；撤销后按需 OCR 直接失败，不影响普通记录。
- 一键停止所有 agent 行动。

### 16.3 数据所有权

- 数据归用户；agent 只是借用。
- 可迁移到新电脑；换 agent 不重置。
- 团队版需明确 consent/权限/保留策略。

## 17. 视觉与按需 OCR（v0）

> 现状：已实现，且只在用户显式点击「读取当前窗口文字」时运行。用户已明确同意把
> “不读屏幕像素”从绝对红线改为“后台不读，按需可读”。
> 实现：ScreenCaptureKit 截当前单窗口 → 内存 CGImage → Vision 本地 OCR；
> 图片不落盘，只把文字写成 `visual-text` 事件。

- 默认 AX 文本；后台不截屏。
- 按需：用户点今天页按钮或调用 `POST /api/ocr` 时，截当前单窗口做本地 Vision OCR。
- 像素不落盘；只存文字 + 时间 + 窗口 + 尺寸。
- 敏感场景（密码/安全输入/无痕/blocklist）跳过；不提供常开/定时 OCR。
- 不暴露为 MCP 工具：避免 agent 自主截屏，必须由人点击今天页按钮或显式调用本地 API。
- 用途：图片里的字、canvas、图表、设计稿、视频字幕。
- 验收：OCR 文本可检索；图片不产生文件；审计只记行数/字符数，不记原文。

## 18. 采集完备性账本（v0）

- ✅ 每 app：AX 节点数/快照数/最后成功时间/前台时长。
- ✅ 零节点 app（盲区）与 `visible-only` 应用。
- ✅ Web 设置页“采集覆盖”卡片；`GET /api/coverage`；CLI `work-ledger coverage`。
- ⏳ 动作覆盖率（按 click/shortcut/input 细分）、隐私抑制计数、每日/每周 report。
- ⏳ `chronicle_status` 暴露覆盖摘要（避免每次 status 都扫段，暂缓）。

---

# Part IV 执行

## 19. 现状盘点

| 层 | 状态 | 证据 |
|---|---|---|
| 采集 | ✅ 15 类事件、AX full/diff、选区/拖拽/右键、滚动聚合、可见窗口、终端 4000 字预算、窗口/值变化快速路径、隐私闸门 | Swift 实现 + 563 测试 + 受控回放 |
| 10min | ✅ promptVersion 8、suggestion、next_actions、memory 注入、重试/deadletter | `summaries/*.md` |
| 6h | ✅ 6h 摘要、重算、与记忆合并联动 | `6h-*.md` |
| 记忆 | ✅ MEMORY.md v2、memory_summary、索引、去重/迁移、MCP/Web | 49 摘要合并，10 组 0 重复 |
| 检索 | ✅ MCP 8 工具、Web 11 视图 | `mcp-entry.mjs`、`web/` |
| 技能 | ✅ suggestion → SKILL.md、技能库 | `~/.chronicle/skills` |
| 工作对象 / 洞察账本（v0） | ✅ 对象/洞察/异常/复盘/候选洞察/结果指标/Context Pack/审计日志、CLI、HTTP `/api/work`（读写）、MCP `chronicle_work`、Web「工作」Triage 页 | `shared/work-ledger.mjs` + 17 tests |
| 线程视图 | ✅ 项目 → 相关对象/洞察/open loops/证据（工作页「查看线程」） | Context Pack + Web |
| Chronicle Agent | ⏳ 未实现（执行器/权限/审计已具备） | `shared/agent-executor.mjs` |
| Agent 注册/权限/审计（后端 v0） | ✅ 注册、L0–L3、临时 grant、scope/过期、outcome、审计、动作执行/回滚 | `shared/agent-registry.mjs` + `shared/audit.mjs` + `shared/agent-executor.mjs` + 7 tests |
| Agent Home | ⏳ 未实现（Context Pack + Thread API 已有基础） | — |
| 分析补跑 | ✅ 断网/超时后盘点并自动补齐摘要→记忆→洞察；退避、队列、Web 提示 | `shared/analysis-catchup.mjs` + 3 tests |
| 视觉/OCR | ✅ v0：按需、单窗口、本地 Vision；像素不落盘；需要屏幕录制权限；API/Web/审计 | `ScreenOCR`（Swift）+ `POST /api/ocr` + 3 tests |
| 覆盖账本 | ✅ 按应用 good/thin/none、零 AX 盲区、前台时长；API + 设置页卡片 + CLI | `shared/coverage.mjs` + 3 tests |
| 团队/制度记忆 | ✅ v0：交接包导出/导入（对象+洞察+handoff；不含原始事件）、引用重映射、重复跳过；Web/CLI/API | `shared/team.mjs` + 3 tests |

### 19.1 技术债

- 6h 实体密度低于 Codex。
- 零 AX 应用可改用按需 OCR；但 OCR 只有用户显式触发才生效，不覆盖后台全量。
- 对象分类与洞察噪声尚未在真实使用中验证；需用户确认、证据门槛、上限与退休机制。
- 测试以单元/静态为主，缺端到端场景（对象闭环、洞察验证、异常处理）。
- 团队包是文件交换，不是实时协作/权限系统。

## 20. 路线图与验收

### P0：把采集做扎实（现在）

**目标**：可见表面覆盖可证明。

交付：

- ✅ 滚动事件（2s / 0.9s 空闲聚合）。
- ✅ 可见窗口采集（30s 节流，浏览器/阻断应用排除；无屏幕录制权限时只记应用/尺寸）。
- ✅ 终端/编辑器文本预算 + `AXValueChanged`。
- ✅ 按需视觉 OCR（ScreenCaptureKit + Vision；单窗口、像素不落盘、需屏幕录制权限）。
- ✅ 采集完备性账本（`/api/coverage` + 设置页卡片 + CLI）。
- ✅ 受控 fixture 矩阵（Swift 自检 + Node 回放）。

验收：

- 15 类事件 + 终端输出在 fixture 中全部 pass/partial 有解释。
- 零节点 app 列表可见；覆盖率报告生成。
- 真实一天 3 类任务回放，事件/摘要覆盖可核对。

### P1：工作对象、洞察与线程

**目标**：从记忆到“正在做的事 + 下次怎么做”，并且所有对象都有出口。

交付：

- 工作对象模型（Action/Task/Project/Goal/Area/Commitment/Decision/Insight/Incident）。
- Inbox / Triage：自动分类 + 用户确认 + 下一步/归档。
- 对象状态机与超时策略（无主对象 7 天归档）。
- 洞察引擎：候选生成、证据/反证、验证/退休、洞察预算。
- 复盘节奏：早上 3 条、晚上关环、每周 30 分钟、每月 60 分钟。
- 异常检测与分级（stuck/rework/broken promise/bottleneck/context thrash/error spike/missing evidence）。
- 线程视图（不是本体）：把同一目标/实体的对象串成叙事线。
- Thread Home、线程详情、时间线、Resume 恢复包。
- 随用随取：对象/洞察检索 + 上下文包 + MCP `chronicle_context`。

验收：

- 7 天试点：Inbox 清零；无 7 天无主对象；活跃 Project ≤7。
- ≥3 条候选洞察被验证/反驳；≥1 条应用到行动。
- ≥1 个承诺闭环；≥1 个决策到期复盘。
- 早上 brief ≤3 条；用户不觉得被骚扰。
- 线程视图只用于叙事；临时 Task 可独立存在。

### P2：Chronicle Agent（第一方）

**目标**：从“看”到“帮”。

交付：

- 早上 brief。
- Open loops 跟进。
- 起草/执行（L0–L2）。
- 审计/回滚。
- 权限阶梯 UI。

验收：

- 10 个真实任务；建议采纳率/纠正率可量化。
- 所有写动作有审计/回滚。
- 无越权。

### P3：Agent Home（平台）

**目标**：任何 agent 入住。

交付：

- Object / Thread API 与 MCP 写接口。
- Agent Registry。
- Context Pack。
- 专家 agent 入住/退出。
- 权限/审计标准化。

验收：

- ≥2 个第三方 agent 能读对象/线程、写证据。
- 线程隔离生效；越权被拒。
- Context Pack 可导出/导入。

### P4：团队/制度记忆

**目标**：人走记忆不丢。

交付：

- 共享对象/线程视图。
- 交接/入职包。
- 团队权限/保留/合规。
- 审计报表。

验收：

- 一个人离开，对象/线程可交接。
- 新人 1 天上手。
- 合规导出可用。

## 21. 指标

### 21.1 产品指标（结果，不是过程）

- 承诺闭环率；Open loop 关闭率。
- 对象无主率（7 天无类型/下一步/关联）。
- 洞察验证率（候选 → 已验证）；洞察应用率（已验证 → 改变行动）。
- 决策复盘率；项目按时率；返工率。
- Time-to-context（恢复一个项目/回答“上次…”要多久）。
- 交接时间（从几小时 → 几分钟）。
- 记忆命中率；Agent 建议采纳率/纠正率。

### 21.2 质量指标

- 采集覆盖率（动作/ app）。
- 摘要负证据率、实体密度、引用真实性。
- 记忆重复率、过期率、证据可追溯率。
- 对象分类准确率；线程视图聚类准确率；open loop 精确率/召回率。
- 洞察精确率/噪声率/过期率；复盘完成率。
- Agent 越权次数、回滚成功率。

### 21.3 信任指标

- 隐私抑制正确率。
- 用户暂停/删除/导出使用率。
- 零节点 app 可见率。
- 审计覆盖率。

## 22. 商业模式

| 版本 | 内容 | 付费点 |
|---|---|---|
| Free | 本地回忆、今日任务线、基础记忆 | 获客 |
| Pro | Context Pack、Proof/证据包、按需视觉、技能工厂、高级模型 | 个人订阅 |
| Team | 共享线程、交接/入职、团队记忆、权限/审计 | 按人/月 |
| Enterprise | 合规、保留、SSO、私有部署、Agent 可观测性 | 年费 |
| API/生态 | Object/Thread API、Context Pack 标准、agent 平台集成 | 用量/分成 |

**增长路径**：开发者/咨询/交付团队（痛点强、证据要求高）→ 知识团队 → 企业合规。

**护城河**：

- 连续跨 app 观察（不是 per-tool 集成）。
- 纵向任务/决策/证据图。
- 本地优先信任。
- agent 中立标准（MCP/Thread/Pack）。
- 数据复利 + 切换成本（但数据可迁移，信任是赚来的）。

## 23. 风险

1. **隐私反噬**：一次泄露/越权 = 信任崩塌。默认不截屏、最小权限、可删除。
2. **平台风险**：macOS 权限/AX 变化；Apple/Microsoft 做类似功能。差异化=中立/跨工具/用户拥有。
3. **准确性**：线程/记忆错误比没有更烦；证据链 + 用户确认。
4. **Agent 安全**：权限阶梯、审计、回滚、人批准。
5. **成本**：LLM/存储/视觉；分层降频、按需、本地模型。
6. **采用**：不能要求用户改变习惯；从“今天/历史/记忆”低摩擦入口开始。
7. **过度自动化**：agent 是扩展，不是替代；保留人的边界。
8. **团队隐私**：共享记忆需 consent/权限/保留策略。

## 24. 开放决策

| 决策 | 选项 | 建议 |
|---|---|---|
| 默认采集范围 | 前台 / 前台+可见窗口 | 先前台，P0 加可见窗口可选 |
| 视觉 OCR | 关闭 / 按需 / 常开 | 按需；常开不做默认 |
| 云边界 | 只发摘要 / 发操作序列 / 本地模型 | 只发摘要/操作序列；本地模型可选 |
| 工作对象类型 | 9 类 / 更少 / 更细 | 先 9 类，按用户反馈合并 |
| 对象自动化 | 全自动 / 用户确认 / 手动 | 先用户确认，再提高自动化 |
| 无主对象归档 | 3 / 7 / 14 天 | 7 天；归档可恢复 |
| 洞察预算 | 10 / 20 / 50 条 | 20 条；超出合并/退休 |
| 洞察验证阈值 | 2 次 / 3 次 / 2 周 | 3 次或 2 周；低置信不进 brief |
| 复盘节奏 | 日/周/月 / 仅周/月 | 先早上 3 条 + 周复盘，月复盘可选 |
| Agent 默认权限 | L0 / L1 / L2 | 新 agent L0；可信 agent L1；L2 需批准 |
| 团队记忆 | 默认共享 / 显式共享 | 显式共享 + 保留策略 |
| 记忆矛盾 | 覆盖 / 保留冲突 | 保留冲突 + 时间戳，LLM 标注 |
| 数据保留 | 永久 / 可配置 | 默认永久，用户可配/删除 |

---

# 附录

## A. 事件类型与字段

| 事件 | 关键字段 | 说明 |
|---|---|---|
| `app-switch` | bundleId, appName, pid, windowTitle?, url? | app 激活/切换 |
| `window-change` | bundleId, appName, pid, windowTitle, windowId?, documentPath?, url? | 窗口/标题变化 |
| `url-change` | bundleId, url | 浏览器 URL 变化 |
| `focus-change` | bundleId, role, title? | 焦点控件变化 |
| `click` | bundleId, appName, pid, x, y, button, target? | 左键/普通点击 |
| `context-menu` | 同上，button=right | 右键菜单 |
| `drag` | bundleId, origin, destination, from, to, button | 拖拽 |
| `shortcut` | bundleId, keyEquivalent, modifiers, target? | 非文本按键 |
| `text-input` | bundleId, text, target? | 输入/粘贴/IME 提交 |
| `submit` | bundleId, keyEquivalent, target? | Return/Enter 提交 |
| `selection` | bundleId, target, selectedText?, selectedRange?, selectedItems? | 选区 |
| `ax-snapshot` | bundleId, appName, windowTitle, mode, text, nodeCount, maxChars | 窗口内容 full/diff |
| `scroll` | bundleId, direction, deltaX, deltaY, ticks, durationMs | 滚动（聚合） |
| `visible-windows` | bundleId, appName, count, windows[{bundleId,appName,title?,width,height}] | 屏幕可见窗口清单（不含浏览器；无屏幕录制权限时无 title） |
| `visual-text` | bundleId, appName, pid, windowTitle, text, lineCount, width, height, source | 按需 OCR 的窗口文字（仅用户显式触发） |

## B. 摘要文件格式

见 11.3；6h 同结构，`type: "6h"`，正文 ≤4000 中文字。

## C. MEMORY.md 示例

见 13.2。

## D. 工作对象 / 线程 / 洞察示例

工作对象：见 14.11；线程视图：见 14.2；洞察：见 14.5.3。

## E. Agent 注册 / 权限 / 审计

Agent 注册：

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "kind": "coding-agent",
  "capabilities": ["read_object", "read_thread", "write_evidence", "run_command"],
  "default_level": "L1",
  "scopes": ["object:*", "thread:*"],
  "trust": {"success": 0, "corrections": 0, "incidents": 0},
  "created_at": "…"
}
```

权限：

```json
{
  "agent": "claude-code",
  "thread": "thread-hulala-image-fix",
  "level": "L2",
  "scopes": ["read:thread", "write:files", "run:command"],
  "expires_at": "…",
  "approved_by": "user"
}
```

审计：见 15.5。

## F. Context Pack 格式

见 15.6。

## G. HTTP / MCP API 草案

### 现有 HTTP（部分）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/status` | 守护状态 |
| GET | `/api/overview` | 今日概览 |
| GET | `/api/segments` | 段/事件 |
| GET | `/api/search` | 搜索事件 |
| GET | `/api/summaries` | 摘要列表 |
| GET | `/api/memory` | 记忆聚合 |
| GET | `/api/config` | 配置 |
| GET | `/api/model/config` | 模型配置 |
| POST | `/api/model/test` | 测试连接 |
| POST | `/api/summarize/run` | 立即分析 |
| GET | `/api/integrations` | AI 接入 |
| POST | `/api/permissions/request` | 请求权限 |
| DELETE | `/api/history` | 清空历史 |

### 计划 HTTP

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/threads` | 线程列表 |
| GET | `/api/threads/:id` | 线程详情 |
| POST | `/api/threads` | 创建/确认线程 |
| PATCH | `/api/threads/:id` | 更新/合并 |
| POST | `/api/threads/:id/resume` | 恢复包 |
| POST | `/api/threads/:id/pack` | 生成 Context Pack |
| GET | `/api/agents` | agent 注册 |
| POST | `/api/agents` | 注册 agent |
| GET | `/api/audit` | 审计日志 |
| POST | `/api/agents/:id/actions` | 执行动作（权限检查） |

### 现有 MCP

`chronicle_status` / `chronicle_today` / `chronicle_search` / `chronicle_summary` / `chronicle_memory` / `chronicle_pause` / `chronicle_resume`

### 计划 MCP

- `chronicle_threads {state?, limit?}`
- `chronicle_thread {id}`
- `chronicle_resume {id}`
- `chronicle_pack {id}`
- `chronicle_act {thread, action, params}`（权限检查）

## H. 验收 fixture 矩阵

| 动作 | fixture | 预期事件 | 状态 |
|---|---|---|---|
| 键盘输入 | 文本编辑器 | text-input | ✅ |
| 快捷键 | 文本编辑器 | shortcut | ✅ |
| 粘贴+Return | 微信/浏览器 | text-input + submit | ✅ |
| 点击 | 浏览器/原生 | click + target | ✅ |
| 右键 | Arc | context-menu | ✅ |
| 拖拽 | 浏览器/文件 | drag | ✅ |
| 选区（文本） | 文本编辑器 | selection + selectedText/range | ✅ |
| 选区（列表/表格） | 系统设置/表格 | selection + selectedItems | ✅ |
| 窗口切换 | 多窗口 | window-change | ✅ |
| 标签/URL | 浏览器 | url-change | ✅ |
| 菜单 | 原生 app | context-menu/AX menu | ✅ |
| 终端输出 | Ghostty | ax-snapshot 文本（4000 字 value 预算 + AXValueChanged） | ✅ |
| 滚动 | PDF/网页 | scroll | ✅ |
| 可见窗口 | 多应用 | visible-windows | ✅ |
| 图片文字 | 图片/PDF | visual-text（按需 OCR） | ✅ |
| 密码/无痕 | 密码框/无痕窗口 | 无内容事件 + 抑制审计 | ✅ |

## I. 术语表

| 术语 | 含义 |
|---|---|
| 事件 | 一次观察到的动作/变化 |
| 段 | 10 分钟 JSONL 文件 |
| 10min 摘要 | 窗口级任务片段 |
| 6h 摘要 | 任务弧 |
| 记忆 | 跨天任务组/画像 |
| 工作对象 | Task/Project/Goal/Commitment/Decision/Insight/Incident 等，生命周期不同 |
| 线程视图 | 把同一目标/实体的对象串成叙事线，不是容器 |
| Triage | 新对象先分类、定下一步或归档 |
| 洞察 | 可复用、有证据、能改变未来行为的结论 |
| 洞察预算 | 同时保留的候选/已验证洞察上限，防止无限堆积 |
| 复盘节奏 | 日/周/月/季的固定检查与出口 |
| Open Loop | 未闭环的承诺/问题/任务 |
| Context Pack | 可携带的对象/线程上下文包 |
| Agent Home | 任何 agent 入住的家 |
| Permission Ladder | L0–L3 权限阶梯 |
| Coverage Ledger | 采集完备性账本 |
