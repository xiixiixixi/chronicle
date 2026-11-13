// shared/memory.mjs — Chronicle 长期记忆层（通用 phase-2 记忆合并：摘要→ durable 记忆）
//
// 背景：只有 10min/6h 摘要时，模型看到的是"窗口级动作流水"，写不出跨天延续的任务线。
// 本模块维护三个文件（都在 <home> 根目录，便于备份/迁移）：
//   · memory_summary.md   紧凑长期画像（≤4KB，摘要 prompt 直接加载）
//   · MEMORY.md           durable 任务组日志（任务线/结果/证据/偏好/经验，append-only 去重）
//   · memory_pending.json 已消费摘要指纹（防重复合并）+ 上次合并时间
//
// 数据流：
//   summaries/*.md（10min/6h，证据）
//     → buildConsolidationPrompt（旧 memory + 最近摘要）
//     → LLM（由 summarize.mjs 注入 callLLM，本模块不依赖配置/网络）
//     → parseConsolidationOutput
//     → 原子写 memory_summary.md + MEMORY.md，更新 pending
//
// 设计约束：
//   · 只写有证据的 durable 事实；一条任务弧优先于逐窗口动作；一次性访问不写成画像。
//   · 所有写操作原子（临时文件 + rename），失败不留半成品；pending 指纹防重复消费。
//   · 本模块不做网络调用：consolidateMemory 需要调用方注入 llm({system,prompt,maxTokens})。
//   · 纯读函数（listRecentSummaries / memoryContextForPrompt）可被摘要器直接调用。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chronicleHome } from './segments.mjs';
import { extractJson, stripReasoning } from './model-config.mjs';

/** memory_summary.md 的硬上限（字节）：超过就按行截断，避免 prompt 被画像撑爆。 */
export const MEMORY_SUMMARY_MAX_BYTES = 6144;
/** pending 里保留的指纹数量上限（只用于去重，超了丢最旧的）。 */
export const PENDING_FINGERPRINT_CAP = 2000;
/** 记忆协议版本（文件结构/字段语义变化时递增；v2：任务组 + scope/applies_to/keywords/failures）。 */
export const MEMORY_VERSION = 2;
/** 单次 consolidation 最多消费多少条摘要（控制 LLM 输入与成本）。 */
export const CONSOLIDATION_BATCH_LIMIT = 24;

const SUMMARY_FILES = Object.freeze({
  summary: 'memory_summary.md',
  memory: 'MEMORY.md',
  pending: 'memory_pending.json',
});

/** 记忆文件路径（都在 home 根目录）。 */
export function memoryPaths(home = chronicleHome()) {
  const root = home;
  return {
    root,
    summary: path.join(root, SUMMARY_FILES.summary),
    memory: path.join(root, SUMMARY_FILES.memory),
    pending: path.join(root, SUMMARY_FILES.pending),
  };
}

// ---------- 通用读写 ----------

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function atomicWriteText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function emptyPending() {
  return { version: MEMORY_VERSION, consumed: [], lastConsolidatedAt: null };
}

/** 容错归一化 pending：坏 JSON/坏字段一律回落到空队列，绝不因记忆文件损坏而中断摘要。 */
function normalizePending(raw) {
  const base = emptyPending();
  if (!raw || typeof raw !== 'object') return base;
  const consumed = Array.isArray(raw.consumed) ? raw.consumed.filter((x) => typeof x === 'string' && x) : [];
  return {
    version: Number.isInteger(raw.version) ? raw.version : MEMORY_VERSION,
    consumed: [...new Set(consumed)].slice(-PENDING_FINGERPRINT_CAP),
    lastConsolidatedAt: typeof raw.lastConsolidatedAt === 'string' ? raw.lastConsolidatedAt : null,
  };
}

/**
 * 读记忆三件套（缺文件/坏文件都不抛异常）。
 * @returns {{paths:object, summary:string, memoryMd:string, pending:object, hasSummary:boolean, hasMemory:boolean}}
 */
export function loadMemory(home = chronicleHome()) {
  const paths = memoryPaths(home);
  const summary = readText(paths.summary);
  const memoryMd = readText(paths.memory);
  let pending = emptyPending();
  const rawPending = readText(paths.pending);
  if (rawPending) {
    try { pending = normalizePending(JSON.parse(rawPending)); } catch { pending = emptyPending(); }
  }
  return { paths, summary, memoryMd, pending, hasSummary: summary.trim().length > 0, hasMemory: memoryMd.trim().length > 0 };
}

/** 保存记忆三件套中指定的部分（undefined 的字段不动；原子写）。 */
export function saveMemory(home = chronicleHome(), { summary, memoryMd, pending } = {}) {
  const paths = memoryPaths(home);
  const written = [];
  if (typeof summary === 'string') { atomicWriteText(paths.summary, summary); written.push(paths.summary); }
  if (typeof memoryMd === 'string') { atomicWriteText(paths.memory, memoryMd); written.push(paths.memory); }
  if (pending && typeof pending === 'object') {
    atomicWriteText(paths.pending, `${JSON.stringify(normalizePending(pending), null, 2)}\n`);
    written.push(paths.pending);
  }
  return { written };
}

// ---------- 摘要读取（证据层） ----------

/** 容错解析摘要 frontmatter（值可能是 JSON 字面量或裸字符串/数组）。 */
function parseSummaryDoc(text) {
  const str = String(text ?? '');
  const out = { frontmatter: {}, body: str };
  const parseFmLines = (lines) => {
    const fm = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const raw = line.slice(i + 1).trim();
      if (!key) continue;
      let value = raw;
      if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('"')) {
        try { value = JSON.parse(raw); } catch { value = raw; }
      }
      fm[key] = value;
    }
    return fm;
  };
  const closed = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(str);
  if (closed) {
    out.frontmatter = parseFmLines(closed[1].split(/\r?\n/));
    out.body = str.slice(closed[0].length);
    return out;
  }
  // 容错：缺少结束线时，把开头连续的 `key: value` 行当元数据，正文从第一行非元数据开始
  const lines = str.split(/\r?\n/);
  if (lines[0] && lines[0].trim() === '---') {
    const fmLines = [];
    let i = 1;
    for (; i < lines.length; i += 1) {
      if (/^[\w.-]+\s*:/.test(lines[i])) fmLines.push(lines[i]);
      else break;
    }
    out.frontmatter = parseFmLines(fmLines);
    out.body = lines.slice(i).join('\n');
  }
  return out;
}

function segmentDayKey(segment) {
  const str = String(segment ?? '');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(str);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 摘要正文里最有信息量的一行（跳过标题/列表符号），用于「最近摘要」提示。 */
export function summaryGist(item) {
  const body = String(item?.body ?? '');
  const desc = typeof item?.description === 'string' ? item.description.trim() : '';
  if (desc) return desc;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#*-]+/, '').replace(/\*\*/g, '').trim();
    if (!line || line.length < 4) continue;
    if (/^(活动摘要|做了什么|进展与结果|卡点或未完成|相关上下文|证据|其他|在做什么)/.test(line)) continue;
    return line;
  }
  return '';
}

/**
 * 最近的 10min/6h 摘要（按段/桶时间倒序，其次 mtime）。
 * @param {string} home
 * @param {{limit?:number, sinceHours?:number, now?:number|Date, kinds?:string[]}} opts
 */
export function listRecentSummaries(home = chronicleHome(), { limit = 12, sinceHours = 48, now = Date.now(), kinds = ['10min', '6h'] } = {}) {
  const dir = path.join(home, 'summaries');
  if (!existsSync(dir)) return [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const minMtime = sinceHours > 0 ? nowMs - sinceHours * 3600_000 : 0;
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.startsWith('_') || name.includes('.tmp-')) continue;
    const file = path.join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (sinceHours > 0 && st.mtimeMs < minMtime) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const doc = parseSummaryDoc(text);
    const type = typeof doc.frontmatter.type === 'string' ? doc.frontmatter.type : (name.startsWith('6h-') ? '6h' : '10min');
    if (!kinds.includes(type)) continue;
    const segment = typeof doc.frontmatter.segment === 'string' ? doc.frontmatter.segment : '';
    out.push({
      filename: name,
      filePath: file,
      title: typeof doc.frontmatter.title === 'string' && doc.frontmatter.title ? doc.frontmatter.title : segment || name,
      description: typeof doc.frontmatter.description === 'string' ? doc.frontmatter.description : '',
      type,
      segment,
      segmentTime: segmentDayKey(segment),
      promptVersion: doc.frontmatter.promptVersion !== undefined ? String(doc.frontmatter.promptVersion) : '',
      applications: Array.isArray(doc.frontmatter.applications) ? doc.frontmatter.applications : [],
      mtimeMs: st.mtimeMs,
      bytes: st.size,
      body: doc.body.trim(),
    });
  }
  out.sort((a, b) => {
    if (a.segmentTime && b.segmentTime && a.segmentTime !== b.segmentTime) return b.segmentTime.localeCompare(a.segmentTime);
    return b.mtimeMs - a.mtimeMs;
  });
  return out.slice(0, Math.max(1, limit));
}

/** 摘要消费指纹：文件名 + mtime + 字节数（内容被重写会变，可再次消费）。 */
export function summaryFingerprint(item) {
  const src = `${item?.filename ?? ''}|${Math.round(Number(item?.mtimeMs) || 0)}|${Number(item?.bytes) || String(item?.body ?? '').length}`;
  return createHash('sha256').update(src).digest('hex').slice(0, 20);
}

/** 尚未被 consolidation 消费的摘要（按倒序）。 */
export function findUnconsumedSummaries(home = chronicleHome(), opts = {}) {
  const { limit = CONSOLIDATION_BATCH_LIMIT, sinceHours = 48, now = Date.now(), kinds = ['10min', '6h'] } = opts;
  const mem = loadMemory(home);
  const consumed = new Set(mem.pending.consumed);
  // 先按时间窗扫一批再过滤：limit 若直接传给 listRecentSummaries，最新 N 条都消费过时会永远看不到更早的未消费摘要。
  const scanLimit = Math.max(limit * 8, 500);
  return listRecentSummaries(home, { limit: scanLimit, sinceHours, now, kinds })
    .filter((item) => !consumed.has(summaryFingerprint(item)))
    .slice(0, Math.max(1, limit));
}

/** 未被 consolidation 消费的摘要总数（断网补跑盘点用；不做批次截断）。 */
export function countUnconsumedSummaries(home = chronicleHome(), opts = {}) {
  const { sinceHours = 24 * 365, now = Date.now(), kinds = ['10min', '6h'] } = opts;
  const mem = loadMemory(home);
  const consumed = new Set(mem.pending.consumed);
  return listRecentSummaries(home, { limit: 100_000, sinceHours, now, kinds })
    .reduce((n, item) => n + (consumed.has(summaryFingerprint(item)) ? 0 : 1), 0);
}

// ---------- 提示词片段 ----------

function truncateAt(text, maxChars, marker = '…') {
  const str = String(text ?? '');
  const budget = Math.max(50, Number(maxChars) || 0);
  if (str.length <= budget) return str;
  return `${str.slice(0, budget)}${marker}`;
}

/** 最近摘要 → 提示词块（每条标题 + 要点，受字符预算约束）。 */
export function renderRecentSummaries(summaries, { maxChars = 2500, perSummaryChars = 420 } = {}) {
  const lines = [];
  let used = 0;
  for (const item of summaries || []) {
    const when = item.segmentTime ? item.segmentTime.slice(11, 16) : '';
    const gist = summaryGist(item);
    const line = `- [${when || '?'} ${item.type || '10min'}] ${item.title || item.filename}：${truncateAt(gist, perSummaryChars)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * 给摘要 prompt 的「相关记忆 + 最近摘要」上下文。
 * 没有任何记忆/摘要时返回明确的「无历史记忆」标记（不假装有记忆）。
 * @returns {string} 已按 maxChars 截断
 */
export function memoryContextForPrompt(home = chronicleHome(), { maxChars = 3000, recentLimit = 5, sinceHours = 72, now } = {}) {
  const mem = loadMemory(home);
  const recent = recentLimit > 0 ? listRecentSummaries(home, { limit: recentLimit, sinceHours, now }) : [];
  if (!mem.summary.trim() && !mem.memoryMd.trim() && !recent.length) {
    return '无历史记忆（这是本机第一次为这类活动建立记忆；不要编造历史任务）。';
  }
  const budget = Math.max(300, Number(maxChars) || 3000);
  const parts = [];
  if (mem.summary.trim()) {
    parts.push(`### 长期记忆摘要（memory_summary.md）\n${truncateAt(mem.summary.trim(), Math.floor(budget * 0.55))}`);
  } else if (mem.memoryMd.trim()) {
    parts.push(`### 记忆库节选（MEMORY.md）\n${truncateAt(mem.memoryMd.trim(), Math.floor(budget * 0.55))}`);
  }
  if (recent.length) {
    const recentText = renderRecentSummaries(recent, { maxChars: Math.max(200, Math.floor(budget * 0.4)) });
    if (recentText) parts.push(`### 最近摘要（证据，按时间倒序）\n${recentText}`);
  }
  return truncateAt(parts.join('\n\n'), budget);
}

// ---------- consolidation（记忆合并） ----------

const CONSOLIDATION_OUTPUT_SPEC = '{"memory_summary_markdown":"<=5000 字符的紧凑长期画像（含 User Profile / User preferences / Ongoing Tasks / General Tips 小节；Ongoing Tasks 每条一件事，格式「- **事情名（partial|blocked）**：最近进展一句。下一步：一句马上能做的事」，事情名用大白话（16 字内），不用窗口标题或英文代号；只列最近 7 天出现过、还没做完的事）","memory_sections":[{"task_group":"任务组（同一任务线复用同一名称；不同目标换组）","scope":"一句话：这组记忆何时适用","applies_to":"cwd=...；reuse_rule=...（可空）","title":"任务名称","date":"YYYY-MM-DD","outcome":"success|partial|blocked|unknown|mixed","keywords":["可检索关键词"],"evidence":"证据（摘要文件名/时间/关键控件/URL）","references":["摘要文件名"],"preferences":["可复用偏好"],"learnings":["可复用经验"],"failures":["失败/卡点及下次如何避免"]}]}';

/**
 * 构造 consolidation 提示词（system + user）。
 * 规则（通用）：摘要只作为证据，收敛成任务弧，不保留逐窗口动作。
 */
export function buildConsolidationPrompt({ memorySummary = '', memoryMd = '', summaries = [] } = {}) {
  const system = [
    '你是本机活动记录器（Chronicle）的「记忆合并器」。输入是：旧的长期记忆摘要、MEMORY.md 日志（都可能是空）、以及最近 24-48h 的 10 分钟/6 小时活动摘要（作为证据）。',
    '你的唯一任务：把近期活动收敛成 durable（可复用、跨天有效）的记忆，而不是活动流水。',
    '规则：',
    '1. 只写有证据的内容；一条任务弧（用户想完成什么 → 做到哪 → 结果/卡点）优先于逐窗口动作。不要保留"点击了/切换了某窗口"这类动作明细，除非它直接解释任务结果或卡点。',
    '2. 证据（evidence 字段）引用摘要文件名、时间段、窗口标题、控件名或 URL；无法确认的不写，禁止编造。references 只填真实存在的摘要文件名。',
    '3. 不把一次性访问、单次会议、临时物流步骤写成用户画像或长期偏好；只有反复出现、可复用的才进 User preferences。User Profile / User preferences 只写本人反复表现出来的做法，不要把本提示词里的要求（比如要有证据、回执、验收）当成本人的习惯；旧画像里「验收要有证据/回执/构建结果」这类写法是旧版整理规则留下的，不是本人习惯，这次直接删掉。',
    '4. 状态由你判断，本人不会手动确认，也不会补交验收材料：记录显示东西做出来了（文件写好或保存了、页面能打开、消息发出去了），之后转去做别的事，就算 success，不要再要求逐页检查、构建回执或验收记录；明确卡住（报错、等别人、做不下去）是 blocked；还在反复修改的是 partial。success 的事和 7 天没再出现的事不放进 Ongoing Tasks（MEMORY.md 里照常保留）。failures 写"发生了什么 + 下次如何避免"，没有就留空数组。',
    '5. 绝不复述敏感值（密码、令牌、验证码、API Key）；若证据里出现，只抽象描述，不照抄。',
    '6. 合并旧记忆：沿用旧 MEMORY.md 里已有的 task_group；同一任务线的进展复用原任务标题并更新状态，不要新建近似标题。只有目标确实不同才新增任务。',
    '7. task_group 是检索/分组主键；scope 和 applies_to 帮助未来判断这条记忆是否适用于当前任务（例如 cwd、项目、时间边界）。keywords 用 3-8 个可检索的词/路径/文件名。',
    '8. preferences/learnings/failures 各最多 3 条，合并同义表述；优先保留最新、可执行、可验证的结论，不要堆叠历史措辞。',
    '9. 写给本人看：title、preferences、learnings、failures 和 memory_summary_markdown 用大白话，像同事帮你记的笔记——新任务的 title 用「动词 + 对象」说清是哪件事（例如"重做 Chronicle 时间线页面"），省略主语、不写"用户"，不用"任务线、任务弧、未观察到、partial、闭环、落地、落盘"这类词；evidence 给 AI 回溯用，可以保留原始字符串。',
    `10. 只输出 JSON：${CONSOLIDATION_OUTPUT_SPEC}`,
  ].join('\n');

  const parts = [];
  parts.push('## 旧 memory_summary.md');
  parts.push(memorySummary.trim() ? memorySummary.trim() : '（空）');
  parts.push('## 旧 MEMORY.md（可能被截断）');
  parts.push(memoryMd.trim() ? truncateAt(memoryMd.trim(), 6000) : '（空）');
  parts.push('## 现有任务组索引（合并时优先复用这些 task_group 与任务标题，不要新建近似组）');
  parts.push(memoryMd.trim() ? (renderMemoryIndex(memoryMd, { maxGroups: 30, maxKeywords: 0 }) || '（无）') : '（无）');
  parts.push('## 最近摘要（证据；frontmatter 是展示元数据，正文才是证据）');
  if (!summaries.length) {
    parts.push('（无）');
  } else {
    for (const item of summaries) {
      const head = `### ${item.filename}（type=${item.type || '?'}${item.segment ? `, segment=${item.segment}` : ''}${item.promptVersion ? `, promptVersion=${item.promptVersion}` : ''}）`;
      parts.push(head);
      parts.push(truncateAt((item.body || item.description || '').trim(), 1600) || '（空正文）');
    }
  }
  parts.push('## 输出');
  parts.push(`只输出 JSON，字段：${CONSOLIDATION_OUTPUT_SPEC}；memory_sections 最多 8 条，优先记录进行中/最近失败或阻塞的任务。`);
  return { system, user: parts.join('\n\n') };
}

/** 解析 consolidation 输出（容忍 <think>、```json 围栏、前后解释文字）。 */
export function parseConsolidationOutput(raw) {
  const cleaned = stripReasoning(String(raw ?? '')).trim();
  const obj = extractJson(cleaned);
  if (!obj || typeof obj !== 'object') {
    throw new Error('记忆合并输出不是可解析的 JSON');
  }
  const summaryMd = typeof obj.memory_summary_markdown === 'string' ? obj.memory_summary_markdown.trim() : '';
  const rawSections = Array.isArray(obj.memory_sections) ? obj.memory_sections : [];
  const sections = [];
  for (const s of rawSections) {
    if (!s || typeof s !== 'object') continue;
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) continue;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
    const taskGroup = typeof s.task_group === 'string' ? s.task_group.trim() : '';
    sections.push({
      title,
      task_group: taskGroup || title,
      scope: typeof s.scope === 'string' ? s.scope.trim() : '',
      applies_to: typeof s.applies_to === 'string' ? s.applies_to.trim() : '',
      date: typeof s.date === 'string' ? s.date.trim() : '',
      outcome: ['success', 'partial', 'blocked', 'unknown', 'mixed'].includes(s.outcome) ? s.outcome : 'unknown',
      keywords: list(s.keywords),
      evidence: typeof s.evidence === 'string' ? s.evidence.trim() : '',
      references: list(s.references),
      preferences: list(s.preferences),
      learnings: list(s.learnings),
      failures: list(s.failures),
    });
  }
  if (!summaryMd && !sections.length) throw new Error('记忆合并输出缺少 memory_summary_markdown 与 memory_sections');
  return { summaryMarkdown: summaryMd, sections: sections.slice(0, 8) };
}

// ---------- MEMORY.md：任务组解析 / 渲染 / 合并 ----------

const MEMORY_OUTCOMES = new Set(['success', 'partial', 'blocked', 'unknown', 'mixed']);

/** 标题归一化：去空白/标点、小写，用于 task_group 与任务标题匹配。 */
function normKey(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '')
    .replace(/[，。、；：""''（）()/·,.:;!?\-—_]+/g, '');
}

function titleBigrams(value) {
  const key = normKey(value);
  if (key.length < 2) return new Set(key ? [key] : []);
  const set = new Set();
  for (let i = 0; i < key.length - 1; i += 1) set.add(key.slice(i, i + 2));
  return set;
}

/** 中文标题相似度（字符 bigram Jaccard）：用于同一任务组的任务线更新匹配。 */
export function titleSimilarity(a, b) {
  const A = titleBigrams(a);
  const B = titleBigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function splitListValue(value, sep) {
  const parts = String(value ?? '').split(sep).map((x) => x.trim()).filter(Boolean);
  return [...new Set(parts)];
}

function splitSemi(value) { return splitListValue(value, /[；;]/); }
function splitKeywords(value) { return splitListValue(value, /[、,，;；]/); }

function uniqueList(list, cap = 12) {
  return [...new Set((list || []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))].slice(-cap);
}

/** 偏好/经验/失败：去掉措辞几乎相同的重复项（相似度 >= 0.82）。 */
function uniqueTextList(list, cap = 8) {
  const out = [];
  for (const raw of list || []) {
    const item = typeof raw === 'string' ? raw.trim() : '';
    if (!item) continue;
    const key = normKey(item);
    if (!key) continue;
    if (out.some((prev) => normKey(prev) === key || titleSimilarity(prev, item) >= 0.82)) continue;
    out.push(item);
  }
  return out.slice(-cap);
}

function normalizeOutcome(value) {
  const s = String(value ?? '').toLowerCase().trim();
  if (!s) return '';
  if (MEMORY_OUTCOMES.has(s)) return s;
  if (s.includes('success')) return 'success';
  if (s.includes('partial') || s.includes('mixed')) return s.includes('mixed') ? 'mixed' : 'partial';
  if (s.includes('block')) return 'blocked';
  return s;
}

function splitTaskHeading(heading) {
  const s = String(heading ?? '').trim().replace(/^Task\s+\d+\s*[:：]\s*/i, '');
  const m = /^(.*?)[,，]\s*(success|partial|blocked|unknown|mixed)\s*$/i.exec(s);
  if (m) return { title: m[1].trim(), outcome: normalizeOutcome(m[2]) };
  return { title: s, outcome: '' };
}

function emptyTask() {
  return {
    title: '', outcome: '', date: '', evidence: '', task_group: '',
    keywords: [], references: [], preferences: [], learnings: [], failures: [], lines: [],
  };
}

function emptyGroup(title = '') {
  return { title, scope: '', appliesTo: '', fields: [], tasks: [] };
}

function normalizeSectionTask(section) {
  return {
    title: String(section?.title ?? '').trim(),
    outcome: normalizeOutcome(section?.outcome),
    date: String(section?.date ?? '').trim(),
    evidence: String(section?.evidence ?? '').trim(),
    task_group: String(section?.task_group ?? '').trim(),
    keywords: uniqueList(section?.keywords, 12),
    references: uniqueList(section?.references, 8),
    preferences: uniqueTextList(section?.preferences, 6),
    learnings: uniqueTextList(section?.learnings, 6),
    failures: uniqueTextList(section?.failures, 4),
    lines: [],
  };
}

/** 旧版（v1，无 # Task Group）按 - task_group 归组：同一组视为同一任务线的连续快照。 */
function regroupLegacy(groups) {
  const out = [];
  const byKey = new Map();
  for (const g of groups) {
    for (const t of g.tasks) {
      const name = String(t.task_group || t.title || '').trim();
      if (!name) continue;
      const key = normKey(name);
      let target = byKey.get(key);
      if (!target) {
        target = emptyGroup(name);
        byKey.set(key, target);
        out.push(target);
      }
      if (!target.tasks.length) { target.tasks.push(t); continue; }
      const into = target.tasks[0];
      if (t.date && (!into.date || t.date >= into.date)) {
        into.title = t.title || into.title;
        into.date = t.date;
        if (t.outcome) into.outcome = t.outcome;
      }
      if (t.evidence) into.evidence = t.evidence;
      into.references = uniqueList([...into.references, ...t.references], 8);
      into.keywords = uniqueList([...into.keywords, ...t.keywords], 12);
      into.preferences = uniqueTextList([...into.preferences, ...t.preferences], 6);
      into.learnings = uniqueTextList([...into.learnings, ...t.learnings], 6);
      into.failures = uniqueTextList([...into.failures, ...t.failures], 4);
    }
  }
  return out;
}

/**
 * 解析 MEMORY.md（兼容 v1 扁平节与 v2 任务组格式）。
 * v2：`# Task Group: X` → `## Task N: 标题, outcome` → `- field: value`。
 * v1：`## 标题` → `- task_group: X` → `- date/outcome/evidence/preferences/learnings`。
 */
export function parseMemoryDocument(markdown = '') {
  const groups = [];
  let group = null;
  let task = null;
  let sawGroupHeading = false;
  const pushGroup = (title) => {
    group = emptyGroup(String(title ?? '').trim());
    groups.push(group);
    task = null;
  };
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    const groupHead = /^#\s+Task Group:\s*(.+)$/i.exec(trimmed);
    if (groupHead) {
      sawGroupHeading = true;
      pushGroup(groupHead[1]);
      continue;
    }
    const taskHead = /^##\s+(.+)$/.exec(trimmed);
    if (taskHead) {
      if (!group) pushGroup('');
      const parsed = splitTaskHeading(taskHead[1]);
      task = emptyTask();
      task.title = parsed.title;
      task.outcome = parsed.outcome;
      group.tasks.push(task);
      continue;
    }
    if (!group) continue;
    const plainField = /^(scope|applies_to|appliesTo)\s*[:：]\s*(.*)$/i.exec(trimmed);
    if (plainField) {
      if (task) { task.lines.push(trimmed); continue; }
      const key = plainField[1].toLowerCase();
      if (key === 'scope') group.scope = plainField[2].trim();
      else group.appliesTo = plainField[2].trim();
      continue;
    }
    const field = /^[-*+]\s+([A-Za-z_][\w-]*)\s*[:：]\s*(.*)$/.exec(trimmed);
    if (field) {
      const key = field[1].toLowerCase();
      const value = field[2].trim();
      if (!task) { group.fields.push({ key, value }); continue; }
      switch (key) {
        case 'task_group': task.task_group = value; break;
        case 'outcome': if (!task.outcome) task.outcome = normalizeOutcome(value); break;
        case 'date': task.date = value; break;
        case 'evidence': task.evidence = value; break;
        case 'references': task.references = splitSemi(value); break;
        case 'keywords': task.keywords = splitKeywords(value); break;
        case 'preferences': task.preferences = splitSemi(value); break;
        case 'learnings': task.learnings = splitSemi(value); break;
        case 'failures': task.failures = splitSemi(value); break;
        default: task.lines.push(`${key}: ${value}`);
      }
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
    task.lines.push(bullet ? bullet[1] : trimmed);
  }
  return sawGroupHeading ? groups.filter((g) => g.title || g.tasks.length) : regroupLegacy(groups);
}

/** 渲染 MEMORY.md v2：任务组 + 组内 Task N。 */
export function renderMemoryDocument(groups) {
  const blocks = [];
  for (const group of groups || []) {
    if (!group || (!group.title && !group.tasks?.length)) continue;
    const lines = [`# Task Group: ${group.title || '未命名任务组'}`, ''];
    if (group.scope) lines.push(`scope: ${group.scope}`);
    if (group.appliesTo) lines.push(`applies_to: ${group.appliesTo}`);
    for (const f of group.fields || []) lines.push(`- ${f.key}: ${f.value}`);
    if (group.scope || group.appliesTo || group.fields?.length) lines.push('');
    let n = 0;
    for (const task of group.tasks || []) {
      n += 1;
      const outcome = task.outcome && task.outcome !== 'unknown' ? `, ${task.outcome}` : '';
      lines.push(`## Task ${n}: ${task.title}${outcome}`, '');
      if (task.date) lines.push(`- date: ${task.date}`);
      if (task.keywords?.length) lines.push(`- keywords: ${task.keywords.join('、')}`);
      if (task.evidence) lines.push(`- evidence: ${task.evidence}`);
      if (task.references?.length) lines.push(`- references: ${task.references.join('；')}`);
      if (task.preferences?.length) lines.push(`- preferences: ${task.preferences.join('；')}`);
      if (task.learnings?.length) lines.push(`- learnings: ${task.learnings.join('；')}`);
      if (task.failures?.length) lines.push(`- failures: ${task.failures.join('；')}`);
      for (const line of task.lines || []) lines.push(`- ${line}`);
      lines.push('');
    }
    blocks.push(lines.join('\n').trim());
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/** 把一条 memory_section 渲染成 MEMORY.md 里的任务组节。 */
export function renderMemorySection(section) {
  const task = normalizeSectionTask(section);
  const group = {
    title: String(section?.task_group || section?.title || '').trim(),
    scope: String(section?.scope ?? '').trim(),
    appliesTo: String(section?.applies_to ?? '').trim(),
    fields: [], tasks: [task],
  };
  return renderMemoryDocument([group]).trim();
}

function mergeAppliesTo(oldValue, newValue) {
  const parts = [...splitSemi(oldValue), ...splitSemi(newValue)];
  return [...new Set(parts)].join('；');
}

function findTaskForSection(group, section) {
  const tasks = group?.tasks || [];
  if (!tasks.length) return null;
  const key = normKey(section.title);
  const exact = tasks.find((t) => normKey(t.title) === key);
  if (exact) return exact;
  // 单任务组：常态是同一任务线的更新；两边都 success 时更像新任务，追加而不是覆盖。
  if (tasks.length === 1) {
    const only = tasks[0];
    if (only.outcome !== 'success' || section.outcome !== 'success') return only;
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const t of tasks) {
    const score = titleSimilarity(section.title, t.title);
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

function updateTaskFromSection(task, section) {
  if (section.title) task.title = section.title;
  if (section.date) task.date = section.date;
  if (section.outcome) task.outcome = section.outcome;
  if (section.evidence) task.evidence = section.evidence;
  task.references = uniqueList([...task.references, ...section.references], 8);
  task.keywords = uniqueList([...task.keywords, ...section.keywords], 12);
  task.preferences = uniqueTextList([...task.preferences, ...section.preferences], 6);
  task.learnings = uniqueTextList([...task.learnings, ...section.learnings], 6);
  task.failures = uniqueTextList([...task.failures, ...section.failures], 4);
}

/**
 * 清理近似重复的任务组：组名相似（>=0.6）且存在同标题/近似标题任务时合并为一组。
 * 只用于写路径（合并/迁移），读路径保持原始结构。
 */
export function mergeDuplicateGroups(groups) {
  const out = [];
  for (const group of groups || []) {
    let target = out.find((g) => normKey(g.title) === normKey(group.title));
    if (!target) {
      target = out.find((g) => titleSimilarity(g.title, group.title) >= 0.6
        && (group.tasks || []).some((t) => (g.tasks || []).some((u) =>
          normKey(u.title) === normKey(t.title) || titleSimilarity(u.title, t.title) >= 0.5)));
    }
    if (!target) { out.push(group); continue; }
    if (!target.scope && group.scope) target.scope = group.scope;
    if (group.appliesTo) target.appliesTo = mergeAppliesTo(target.appliesTo, group.appliesTo);
    for (const task of group.tasks || []) {
      const existing = (target.tasks || []).find((u) =>
        normKey(u.title) === normKey(task.title) || titleSimilarity(u.title, task.title) >= 0.5);
      if (existing) updateTaskFromSection(existing, task);
      else target.tasks.push(task);
    }
  }
  return out;
}

/** 写回前统一收敛数组上限（偏好 6 / 经验 6 / 失败 4 / 关键词 12 / 引用 8）。 */
function normalizeGroups(groups) {
  for (const group of groups || []) {
    for (const task of group.tasks || []) {
      task.keywords = uniqueList(task.keywords, 12);
      task.references = uniqueList(task.references, 8);
      task.preferences = uniqueTextList(task.preferences, 6);
      task.learnings = uniqueTextList(task.learnings, 6);
      task.failures = uniqueTextList(task.failures, 4);
    }
  }
  return groups;
}

/** 解析 → 合并近似重复组 → 收敛数组上限 → 渲染（用于迁移/清理）。 */
export function normalizeMemoryDocument(markdown) {
  return renderMemoryDocument(normalizeGroups(mergeDuplicateGroups(parseMemoryDocument(markdown))));
}

/**
 * 把新节并入旧 MEMORY.md：按 task_group 分组，同一任务线更新而不是追加近似标题。
 * 旧 v1 文件会在这里迁移为 v2（组内历史快照合并为一条任务）。
 * @returns {{memoryMd:string, added:number, updated:number, skipped:number}}
 */
export function mergeMemorySections(existingMd, sections) {
  const list = Array.isArray(sections) ? sections : [];
  const old = String(existingMd ?? '');
  if (!list.length) return { memoryMd: old, added: 0, updated: 0, skipped: 0 };
  const groups = mergeDuplicateGroups(parseMemoryDocument(old));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const section of list) {
    if (!section || typeof section !== 'object') { skipped += 1; continue; }
    const name = String(section.task_group || section.title || '').trim();
    const title = String(section.title || '').trim();
    if (!name || !title) { skipped += 1; continue; }
    let group = groups.find((g) => normKey(g.title) === normKey(name));
    if (!group) {
      // 组名略有漂移但任务标题对得上 → 归入旧组，不再新建近似任务组。
      group = groups.find((g) => titleSimilarity(g.title, name) >= 0.6
        && (g.tasks || []).some((t) => normKey(t.title) === normKey(title) || titleSimilarity(t.title, title) >= 0.5));
    }
    if (!group) {
      group = emptyGroup(name);
      groups.push(group);
    }
    if (section.scope) group.scope = String(section.scope).trim();
    if (section.applies_to) group.appliesTo = mergeAppliesTo(group.appliesTo, String(section.applies_to).trim());
    const task = findTaskForSection(group, section);
    const normalized = normalizeSectionTask(section);
    if (task) {
      updateTaskFromSection(task, normalized);
      updated += 1;
    } else {
      group.tasks.push(normalized);
      added += 1;
    }
  }
  return { memoryMd: renderMemoryDocument(normalizeGroups(groups)), added, updated, skipped };
}

/** 紧凑检索索引（对应参考实现的 What's in Memory）：任务组 → 最近任务/结果/关键词。 */
export function renderMemoryIndex(markdown, { maxGroups = 10, maxKeywords = 4 } = {}) {
  const groups = parseMemoryDocument(markdown);
  const lines = [];
  for (const group of groups) {
    const task = group.tasks?.[group.tasks.length - 1];
    if (!task) continue;
    const kw = (task.keywords || []).slice(0, maxKeywords).join('、');
    const outcome = task.outcome && task.outcome !== 'unknown' ? `（${task.outcome}）` : '';
    lines.push(`- ${group.title}：${task.title}${outcome}${kw ? ` [${kw}]` : ''}`);
  }
  return lines.slice(0, maxGroups).join('\n');
}

/** 把检索索引并入 memory_summary.md（替换旧索引，避免重复）。 */
export function attachMemoryIndex(summaryMarkdown, memoryMd, opts = {}) {
  const index = renderMemoryIndex(memoryMd, opts);
  if (!index) return String(summaryMarkdown ?? '');
  const stripped = String(summaryMarkdown ?? '')
    .replace(/\n##\s+(?:What'?s in Memory|记忆索引)[\s\S]*?(?=\n##\s+|$)/gi, '')
    .trimEnd();
  return `${stripped}\n\n## What's in Memory\n${index}\n`;
}

/** 按关键词检索 MEMORY.md（group/task 任一字段命中即返回；空 query 返回全部组）。 */
export function searchMemoryGroups(markdown, query, { limit = 8 } = {}) {
  const groups = parseMemoryDocument(markdown);
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return groups.slice(0, Math.max(1, limit));
  const hits = [];
  for (const group of groups) {
    for (const task of group.tasks || []) {
      const hay = [
        group.title, group.scope, group.appliesTo,
        task.title, task.outcome, task.date, task.evidence,
        ...task.keywords, ...task.references, ...task.preferences, ...task.learnings, ...task.failures,
      ].join('\n').toLowerCase();
      if (!hay.includes(q)) continue;
      hits.push({ group, task });
      if (hits.length >= Math.max(1, limit)) return hits;
    }
  }
  return hits;
}

/** memory_summary.md 按字节上限截断（按行边界，避免切坏 markdown/UTF-8 语义）。 */
export function clampMemorySummary(markdown, maxBytes = MEMORY_SUMMARY_MAX_BYTES) {
  const text = String(markdown ?? '').trim();
  if (!text) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return `${text}\n`;
  const marker = '\n\n…（memory_summary 超长已截断；完整任务日志见 MEMORY.md）\n';
  const budget = Math.max(200, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const lines = text.split(/\r?\n/);
  let out = '';
  for (const line of lines) {
    if (Buffer.byteLength(`${out}${line}\n`, 'utf8') > budget) break;
    out += `${line}\n`;
  }
  return `${out.trimEnd()}${marker}`;
}

function mergeConsumed(oldList, newItems) {
  const merged = [...new Set([...(oldList || []), ...newItems])];
  return merged.slice(-PENDING_FINGERPRINT_CAP);
}

/**
 * 记忆合并主流程：取未消费摘要 → LLM → 原子写 memory_summary.md / MEMORY.md → 更新 pending。
 * @param {string} home
 * @param {{llm?:Function, now?:Date|number, dryRun?:boolean, limit?:number, sinceHours?:number, log?:Function}} opts
 *   llm({system,prompt,maxTokens}) → Promise<{content,usage}>（由 summarize.mjs 注入 callLLM，本模块不做网络）
 * @returns {Promise<{ok:boolean, consumed:number, added?:number, skipped?:string, error?:string, sections?:number, memorySummaryBytes?:number, usage?:object|null}>}
 */
export async function consolidateMemory(home = chronicleHome(), { llm, now = new Date(), dryRun = false, limit = CONSOLIDATION_BATCH_LIMIT, sinceHours = 48, log = () => {} } = {}) {
  const mem = loadMemory(home);
  const nowDate = now instanceof Date ? now : new Date(now);
  const candidates = findUnconsumedSummaries(home, { limit, sinceHours, now: nowDate.getTime() });
  if (!candidates.length) {
    return { ok: true, consumed: 0, skipped: 'no-new-summaries', sections: 0, memorySummaryBytes: Buffer.byteLength(mem.summary, 'utf8') };
  }
  if (typeof llm !== 'function') {
    return { ok: false, consumed: 0, skipped: 'llm-missing', error: 'consolidateMemory 需要注入 llm({system,prompt,maxTokens}) 回调' };
  }
  const { system, user } = buildConsolidationPrompt({ memorySummary: mem.summary, memoryMd: mem.memoryMd, summaries: candidates });
  let content = '';
  let usage = null;
  let parsed = null;
  let lastError = '';
  // 输出是 JSON；被 maxTokens 截断或夹带说明时重试一次（只在解析失败时发生）。
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    try {
      const res = await llm({ system, prompt: user, maxTokens: 6000 });
      content = typeof res?.content === 'string' ? res.content : '';
      usage = res?.usage ?? usage;
    } catch (err) {
      return { ok: false, consumed: 0, skipped: 'llm-error', error: String(err?.message ?? err), code: err?.code ?? 'LLM_ERROR' };
    }
    try {
      parsed = parseConsolidationOutput(content);
    } catch (err) {
      lastError = String(err?.message ?? err);
    }
  }
  if (!parsed) {
    return { ok: false, consumed: 0, skipped: 'bad-output', error: `${lastError}（模型输出 ${content.length} 字符）` };
  }
  const merged = mergeMemorySections(mem.memoryMd, parsed.sections);
  const nextSummary = clampMemorySummary(attachMemoryIndex(parsed.summaryMarkdown || mem.summary, merged.memoryMd));
  const fingerprints = candidates.map(summaryFingerprint);
  if (dryRun) {
    return {
      ok: true, dryRun: true, consumed: candidates.length, sections: parsed.sections.length,
      memorySummaryBytes: Buffer.byteLength(nextSummary, 'utf8'),
      wouldAdd: merged.added, wouldUpdate: merged.updated, usage,
    };
  }
  atomicWriteText(mem.paths.summary, nextSummary);
  atomicWriteText(mem.paths.memory, merged.memoryMd);
  const pending = {
    version: MEMORY_VERSION,
    consumed: mergeConsumed(mem.pending.consumed, fingerprints),
    lastConsolidatedAt: nowDate.toISOString(),
  };
  atomicWriteText(mem.paths.pending, `${JSON.stringify(pending, null, 2)}\n`);
  log(`记忆合并完成：消费 ${candidates.length} 条摘要，新增 ${merged.added} 条任务、更新 ${merged.updated} 条，memory_summary ${Buffer.byteLength(nextSummary, 'utf8')} 字节`);
  return {
    ok: true, consumed: candidates.length, added: merged.added, updated: merged.updated, skipped: merged.skipped,
    sections: parsed.sections.length, memorySummaryBytes: Buffer.byteLength(nextSummary, 'utf8'), usage,
  };
}
