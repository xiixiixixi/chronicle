#!/usr/bin/env node
// summarize.mjs — LLM 摘要生成器（批次 2）
//
// 读取 <home>/segments/*/events.jsonl，调用 LLM 压缩成人类可读的 Markdown 摘要，两级：
//   ① 10min 摘要：每个已关闭的段一份 → <home>/summaries/10min-<segment>.md
//   ② 6h  摘要：把同一 UTC 6 小时桶（00/06/12/18）内的 10min 摘要合并
//      → <home>/summaries/6h-<bucket>.md（桶结束且桶内有 10min 摘要才生成）
// 摘要文件自带 frontmatter（title / applications / segment / type），存在即视为已摘要
// （幂等；--segment / --all 可强制重生成）。
//
// LLM 配置读 <home>/config.json 的 "summarizer" 键——不硬编码任何 key 或 endpoint：
//   { "summarizer": { "enabled": true, "provider": "openai-compatible",
//       "baseUrl": "https://llm.example.com/v1", "model": "…",
//       "apiKeyEnv": "CHRONICLE_LLM_KEY" } }
// key 只从环境变量读（config 里存变量名）；provider "none" 或未配置 → 跳过摘要
// （只存原始 JSONL）。调用走 Node 18+ 原生 fetch，零新增依赖。
//
// CLI：node summarize.mjs [--segment <ts>] [--all] [--home DIR]
//   （默认）扫描已关闭且未摘要的段 + 待合并的 6h 桶
//   --segment <ts>  强制重生成指定段（无论是否已有摘要、是否已关闭）
//   --all           强制重生成全部已关闭段，并重建对应 6h 桶
//
// 提示词只要求事实性描述（什么时间在什么应用做了什么），并明确禁止复述敏感值；
// 但注意：启用 openai-compatible 摘要意味着把（已过隐私闸门的）事件内容发给你配置的
// LLM endpoint——这是用户在 config.json 里的显式选择。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chronicleHome, listSegments, readSegmentEvents, parseSegmentTs } from './shared/segments.mjs';

export const BUCKET_MS = 6 * 60 * 60 * 1000;
const LLM_SYSTEM_PROMPT = [
  '你是本地活动记录器的摘要器。你收到的是一段时间内电脑使用的结构化事件日志（应用切换/窗口标题/网址/焦点元素，均已过隐私过滤）。',
  '规则：只描述观察到的事实（什么时间用了什么应用/窗口/网址），不推测用户意图或情绪，不做评价；',
  '绝不复述可能是敏感值的内容（密码、令牌、验证码），即便输入中出现也不要照抄；时间一律用 HH:MM。',
  '只输出 JSON，不要输出 JSON 以外的任何内容。',
].join('');

export class SummarizeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------- 配置 ----------

/** 读 config.json 的 summarizer 段并归一化（缺省 = 关闭）。 */
export function loadSummarizerConfig(home = chronicleHome()) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { raw = {}; }
  const s = raw && typeof raw.summarizer === 'object' && raw.summarizer !== null ? raw.summarizer : {};
  return {
    enabled: s.enabled === true,
    provider: typeof s.provider === 'string' && s.provider.length ? s.provider : 'none',
    baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl.replace(/\/+$/, '') : '',
    model: typeof s.model === 'string' ? s.model : '',
    apiKeyEnv: typeof s.apiKeyEnv === 'string' ? s.apiKeyEnv : '',
    timeoutMs: Number.isInteger(s.timeoutMs) && s.timeoutMs > 0 ? s.timeoutMs : 60_000,
  };
}

/** 摘要器是否可用（配置完整且 provider 受支持；key 在调用时才检查）。 */
export function summarizerActive(cfg) {
  return Boolean(cfg && cfg.enabled === true && cfg.provider === 'openai-compatible' && cfg.baseUrl && cfg.model);
}

// ---------- 事件压缩与提示词 ----------

function pad2(n) { return String(n).padStart(2, '0'); }
function hhmm(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '??:??';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 事件流 → 提示词用的紧凑行（每事件一行，本地时间 HH:MM）。超长截断并注明。 */
export function compactEvents(events, { maxLines = 500 } = {}) {
  const lines = [];
  for (const e of events) {
    const t = hhmm(e?.ts);
    const d = e?.data ?? {};
    switch (e?.type) {
      case 'app-switch': lines.push(`${t} 切换应用 → ${d.appName ?? d.bundleId ?? '?'} (${d.bundleId ?? '?'})`); break;
      case 'window-change': lines.push(`${t} 窗口标题 → ${d.bundleId ?? '?'} "${d.windowTitle ?? ''}"`); break;
      case 'url-change': lines.push(`${t} 网址 → ${d.bundleId ?? '?'} ${d.url ?? ''}`); break;
      case 'focus-change': lines.push(`${t} 焦点元素 → ${d.bundleId ?? '?'} ${d.role ?? '?'}${d.title ? ` "${d.title}"` : ''}`); break;
      default: lines.push(`${t} ${e?.type ?? '?'} ${JSON.stringify(d)}`);
    }
  }
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `…（另有 ${lines.length - maxLines} 条事件已省略）`];
  return lines;
}

/** 事件里的去重 bundleId 列表（保持出现顺序）。 */
export function uniqueApplications(events) {
  const out = [];
  for (const e of events) {
    const b = e?.data?.bundleId;
    if (typeof b === 'string' && b.length && !out.includes(b)) out.push(b);
  }
  return out;
}

export function build10MinPrompt(lines) {
  return [
    '请为下面这个 10 分钟段落生成活动摘要。',
    '输出 JSON：{"title":"简短标题（30 字内，含时间范围，例如 \\"10:00-10:10 编码 + 查文档\\"）","body":"Markdown 正文，以 \\"## 活动摘要\\" 开头，逐条列出时间段与活动，不超过 500 词"}',
    '',
    '事件（本地时间 HH:MM）：',
    lines.join('\n'),
  ].join('\n');
}

export function build6hPrompt(blocks) {
  return [
    '请把下面同一 6 小时内的多个 10 分钟摘要合并成一份更粗粒度的总结。',
    '输出 JSON：{"title":"简短标题（30 字内，含时间范围）","body":"Markdown 正文，以 \\"## 活动摘要\\" 开头，归纳这段时间的主要活动与切换，不超过 300 词"}',
    '',
    '10 分钟摘要：',
    ...blocks.map((b) => `### ${b.title}\n${b.body}`.trim()),
  ].join('\n\n');
}

// ---------- LLM 调用（openai-compatible chat/completions；fetch 可注入便于测试） ----------

export async function callLLM({ cfg, apiKey, prompt, fetchImpl, timeoutMs }) {
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== 'function') throw new SummarizeError('本环境无 fetch（需要 Node 18+）', 'NO_FETCH');
  let res;
  try {
    res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 900,
      }),
      signal: AbortSignal.timeout(timeoutMs ?? cfg.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new SummarizeError(`LLM 请求失败: ${err.message}`, 'LLM_NETWORK');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new SummarizeError(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`, 'LLM_HTTP');
  }
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new SummarizeError('LLM 返回空内容', 'LLM_EMPTY');
  return content;
}

/** 解析 LLM 输出：优先 JSON {title, body}；解析失败降级为裸文本（title 空，调用方兜底）。 */
export function parseLLMOutput(raw) {
  const text = String(raw ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      const obj = JSON.parse(text.slice(s, e + 1));
      if (obj && typeof obj === 'object') {
        const title = typeof obj.title === 'string' ? obj.title : '';
        const body = typeof obj.body === 'string' ? obj.body : '';
        if (title || body) return { title, body };
      }
    } catch { /* 落到裸文本 */ }
  }
  return { title: '', body: text };
}

// ---------- 摘要文件（frontmatter 格式读写） ----------

const SAFE_SUMMARY_NAME = /^[\w][\w.-]*\.md$/;

export function buildFrontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---');
  return lines.join('\n');
}

/** 解析 frontmatter（title/applications/segment/type/segments + body）；无 frontmatter 时整体当 body。 */
export function parseSummaryFile(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text ?? ''));
  if (!m) return { body: String(text ?? '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (raw.startsWith('"') || raw.startsWith('[')) {
      try { meta[k] = JSON.parse(raw); } catch { meta[k] = raw; }
    } else meta[k] = raw;
  }
  return { ...meta, body: m[2].replace(/^\n+/, '') };
}

function summariesDir(home) { return path.join(home, 'summaries'); }

function writeSummaryFile(file, markdown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, markdown);
}

/** 摘要列表（新→旧；含解析后的 frontmatter 与正文）。 */
export function listSummaries(home = chronicleHome()) {
  const dir = summariesDir(home);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const p = parseSummaryFile(text);
    let mtimeMs = null;
    try { mtimeMs = statSync(file).mtimeMs; } catch { /* 忽略 */ }
    out.push({
      filename: name,
      type: p.type ?? null,
      segment: p.segment ?? null,
      title: p.title ?? '',
      applications: Array.isArray(p.applications) ? p.applications : [],
      segments: Array.isArray(p.segments) ? p.segments : [],
      body: p.body ?? '',
      mtimeMs,
    });
  }
  return out.sort((a, b) => String(b.segment ?? b.filename).localeCompare(String(a.segment ?? a.filename)));
}

/** 读单个摘要全文；文件名不合法或不存在返回 null。 */
export function readSummary(home = chronicleHome(), filename) {
  const name = String(filename ?? '');
  if (!SAFE_SUMMARY_NAME.test(name)) return null;
  const file = path.join(summariesDir(home), name);
  if (!existsSync(file)) return null;
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

// ---------- 两级摘要生成 ----------

/** Date → 所在 UTC 6h 桶（00/06/12/18 对齐）。 */
export function bucketInfo(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(Math.floor(d.getTime() / BUCKET_MS) * BUCKET_MS);
  return { start, end: new Date(start.getTime() + BUCKET_MS), key: start.toISOString().slice(0, 13) };
}

/** 段的起止时间：优先 metadata，兜底目录名 + 首末事件。 */
function segmentTimeRange(seg, events) {
  let start = seg.segmentStart ? new Date(seg.segmentStart) : parseSegmentTs(seg.segment);
  let end = seg.segmentEnd ? new Date(seg.segmentEnd) : null;
  if (!start || Number.isNaN(start.getTime())) start = events.length ? new Date(events[0].ts) : null;
  if ((!end || Number.isNaN(end.getTime())) && events.length) end = new Date(events[events.length - 1].ts);
  return { start, end };
}

function shortAppName(bundleId) {
  const parts = String(bundleId ?? '').split('.');
  return parts[parts.length - 1] || bundleId || '?';
}

function fallbackTitle(range, applications) {
  const apps = applications.slice(0, 2).map(shortAppName).join(' + ');
  return `${hhmm(range.start)}-${hhmm(range.end ?? range.start)} ${apps || '活动'}`;
}

async function runLLMShape({ cfg, env, fetchImpl, prompt, fallbackTitle: fb }) {
  const apiKey = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : '';
  if (cfg.apiKeyEnv && !apiKey) {
    throw new SummarizeError(`环境变量 ${cfg.apiKeyEnv} 未设置（config 只存变量名，key 从环境读）`, 'NO_API_KEY');
  }
  const raw = await callLLM({ cfg, apiKey, prompt, fetchImpl });
  const parsed = parseLLMOutput(raw);
  return { title: parsed.title || fb, body: parsed.body.trim() };
}

/**
 * 生成一个段的 10min 摘要。
 * @returns {Promise<{file?: string, skipped?: string, error?: string}>}
 */
export async function summarizeSegment(home, seg, { cfg, env = process.env, fetchImpl, force = false } = {}) {
  const file = path.join(summariesDir(home), `10min-${seg.segment}.md`);
  if (!force && existsSync(file)) return { skipped: 'already-summarized', file };
  const { events } = readSegmentEvents(home, seg.segment);
  if (!events.length) return { skipped: 'empty' };
  const applications = uniqueApplications(events);
  const range = segmentTimeRange(seg, events);
  let title = fallbackTitle(range, applications);
  let body;
  try {
    ({ title, body } = await runLLMShape({ cfg, env, fetchImpl, prompt: build10MinPrompt(compactEvents(events)), fallbackTitle: title }));
  } catch (err) {
    // 失败不写半成品：pending 模式记为跳过，CLI 强制模式向上抛
    return { skipped: err.code ?? 'llm-error', error: err.message };
  }
  const md = `${buildFrontmatter({ title, applications, segment: seg.segment, type: '10min' })}\n\n${body}\n`;
  writeSummaryFile(file, md);
  return { file, title };
}

/** 生成一个 6h 桶的合并摘要（输入 = 桶内全部 10min 摘要）。 */
export async function summarize6hBucket(home, bucketKey, { cfg, env = process.env, fetchImpl, force = false } = {}) {
  const file = path.join(summariesDir(home), `6h-${bucketKey}.md`);
  if (!force && existsSync(file)) return { skipped: 'already-summarized', file };
  const info = bucketInfo(new Date(`${bucketKey}:00:00.000Z`));
  if (!info) return { skipped: 'bad-bucket' };
  const blocks = [];
  const applications = [];
  const segNames = [];
  for (const s of listSummaries(home)) {
    if (s.type !== '10min' || !s.segment) continue;
    const d = parseSegmentTs(s.segment);
    const b = d && bucketInfo(d);
    if (!b || b.key !== bucketKey) continue;
    blocks.push({ title: s.title || s.segment, body: s.body });
    segNames.push(s.segment);
    for (const a of s.applications) if (!applications.includes(a)) applications.push(a);
  }
  segNames.reverse(); // 时间正序（listSummaries 是新→旧）
  blocks.reverse();
  if (!blocks.length) return { skipped: 'empty' };
  let title = `${hhmm(info.start)}-${hhmm(info.end)} 活动汇总`;
  let body;
  try {
    ({ title, body } = await runLLMShape({ cfg, env, fetchImpl, prompt: build6hPrompt(blocks), fallbackTitle: title }));
  } catch (err) {
    return { skipped: err.code ?? 'llm-error', error: err.message };
  }
  const md = `${buildFrontmatter({
    title, applications, segment: info.start.toISOString(), segments: segNames, type: '6h',
  })}\n\n${body}\n`;
  writeSummaryFile(file, md);
  return { file, title };
}

/**
 * 扫描待办并生成摘要（守护每 10 分钟调一次；也可手动跑）。
 * 摘要器未启用（none/未配置/缺 key 配置）时零副作用返回。
 * @returns {Promise<{checked: number, summarized10: number, summarized6h: number, skipped: string[]}>}
 */
export async function summarizePending(home = chronicleHome(), { env = process.env, fetchImpl, log = () => {}, now = () => new Date() } = {}) {
  const cfg = loadSummarizerConfig(home);
  const result = { checked: 0, summarized10: 0, summarized6h: 0, skipped: [] };
  if (!cfg.enabled || cfg.provider === 'none') return result;
  if (!summarizerActive(cfg)) {
    result.skipped.push(`unsupported-provider: ${cfg.provider}`);
    return result;
  }

  const segments = listSegments(home).filter((s) => !s.open && s.eventCount > 0);
  result.checked = segments.length;
  for (const seg of segments) {
    const r = await summarizeSegment(home, seg, { cfg, env, fetchImpl });
    if (r.file && !r.skipped) {
      result.summarized10 += 1;
      log(`10min 摘要完成: ${seg.segment}`);
    } else if (r.skipped && r.skipped !== 'already-summarized' && r.skipped !== 'empty') {
      result.skipped.push(`${seg.segment}: ${r.skipped}`);
      log(`10min 摘要跳过（${r.skipped}）: ${seg.segment}`);
    }
  }

  // 6h 合并：桶已结束 + 桶内有 10min 摘要 + 尚无 6h 文件
  const nowMs = now().getTime();
  const buckets = new Map();
  for (const s of listSummaries(home)) {
    if (s.type !== '10min' || !s.segment) continue;
    const b = parseSegmentTs(s.segment);
    const info = b && bucketInfo(b);
    if (info) buckets.set(info.key, true);
  }
  for (const key of buckets.keys()) {
    const info = bucketInfo(new Date(`${key}:00:00.000Z`));
    if (!info || nowMs < info.end.getTime()) continue; // 桶还没结束，等整点
    const r = await summarize6hBucket(home, key, { cfg, env, fetchImpl });
    if (r.file && !r.skipped) {
      result.summarized6h += 1;
      log(`6h 摘要完成: ${key}`);
    } else if (r.skipped && r.skipped !== 'already-summarized' && r.skipped !== 'empty') {
      result.skipped.push(`6h-${key}: ${r.skipped}`);
    }
  }
  return result;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { segment: null, all: false, home: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--segment') out.segment = next();
    else if (a === '--all') out.all = true;
    else if (a === '--home') out.home = path.resolve(next());
    else if (a === '--help' || a === '-h') {
      console.log('用法: node summarize.mjs [--segment <ts>] [--all] [--home DIR]');
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = args.home ?? chronicleHome();
  const cfg = loadSummarizerConfig(home);
  const log = (m) => console.log(`[summary] ${m}`);

  if (args.segment) {
    const seg = listSegments(home).find((s) => s.segment === args.segment);
    if (!seg) { console.error(`段不存在: ${args.segment}`); return 1; }
    if (!summarizerActive(cfg)) { console.error('摘要器未启用或配置不完整（config.json 的 summarizer 段）'); return 1; }
    const r = await summarizeSegment(home, seg, { cfg, force: true });
    if (r.file && !r.skipped) { log(`已写入 ${r.file}`); return 0; }
    console.error(`生成失败: ${r.skipped} ${r.error ?? ''}`.trim());
    return 1;
  }

  if (args.all) {
    if (!summarizerActive(cfg)) { console.error('摘要器未启用或配置不完整（config.json 的 summarizer 段）'); return 1; }
    const segments = listSegments(home).filter((s) => !s.open && s.eventCount > 0);
    for (const seg of segments) {
      const r = await summarizeSegment(home, seg, { cfg, force: true });
      if (r.file && !r.skipped) log(`已重写 ${r.file}`);
      else log(`跳过 ${seg.segment}: ${r.skipped ?? '?'}`);
    }
    // 重建已有 10min 摘要的 6h 桶
    const keys = new Set();
    for (const s of listSummaries(home)) {
      if (s.type !== '10min' || !s.segment) continue;
      const b = parseSegmentTs(s.segment);
      const info = b && bucketInfo(b);
      if (info && info.end.getTime() <= Date.now()) keys.add(info.key);
    }
    for (const key of keys) {
      const r = await summarize6hBucket(home, key, { cfg, force: true });
      if (r.file && !r.skipped) log(`已重写 ${r.file}`);
    }
    return 0;
  }

  const r = await summarizePending(home, { log });
  console.log(JSON.stringify(r));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[summarize] 失败: ${e.message}`); process.exit(1); });
}
