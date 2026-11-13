// shared/segments.mjs — 段（segments）与事件的共享读取层
//
// daemon.mjs（HTTP 展示）、summarize.mjs（摘要器）、mcp-entry.mjs（MCP 面）共用，
// 放在独立模块避免 daemon ↔ summarize 循环 import。全部只读，不碰隐私语义
// （闸门权威实现在 Swift 采集端，镜像在 shared/privacy.mjs）。
//
// 批次 3 变更（向后兼容）：
//   ① 新增分页/范围查询：searchEventsPaged / listSegmentsPaged（有 SQLite 索引走索引，
//      没有则线性回退，**结果一致**；见 shared/index.mjs）。
//   ② 加缓存：segments 目录 listing 用「目录 mtime + 500ms TTL」缓存；每段的 metadata
//      解析结果按 metadata.json 的 (mtime,size) 缓存 —— 文件一改（关段/重写）立即失效，
//      所以调用方永远读到最新内容。
//   ③ suppressed.jsonl 不再每次 listSegments 全读：只有显式 withSuppressed:true 才统计。
//   ④ from/to 支持毫秒时间戳或 "YYYY-MM-DD"（本地时区）；搜索统一「最新在前」。
//
// 原有导出（chronicleHome / parseSegmentTs / listSegments / readSegmentEvents /
// searchEvents）签名与语义保持不变，旧调用方零改动。

import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  closeIndex, ensureIndex, indexStats, listSegmentsPaged, normalizeRange, resetIndex,
  searchEventsPaged, sqliteAvailable,
} from './index.mjs';
import { readSegmentDataText, stampSegmentDataFile } from './compression.mjs';

// 索引层的 paged 查询原样对外（daemon 路由与 MCP 均可直接用）。
export { closeIndex, ensureIndex, indexStats, listSegmentsPaged, searchEventsPaged, sqliteAvailable, resetIndex };

/** 分页/范围参数的本地时区归一化（毫秒时间戳或 YYYY-MM-DD → {fromMs,toMs}）。 */
export { normalizeRange };

/** segments 目录 listing 的缓存 TTL（毫秒）；目录 mtime 一变立即失效，与 TTL 取「与」。 */
export const SEGMENT_CACHE_TTL_MS = 500;

/** 数据根目录：CHRONICLE_HOME 环境变量 > 默认 ~/.chronicle（与 Swift 端一致）。 */
export function chronicleHome(env = process.env) {
  const h = env.CHRONICLE_HOME;
  return h && h.length ? path.resolve(h) : path.join(os.homedir(), '.chronicle');
}

/**
 * 段目录名（Swift 端格式 yyyy-MM-dd'T'HH-mm-ss.SSS'Z'，如 2026-10-19T02-00-00.000Z）
 * → Date；不匹配则按普通 ISO 解析，再不行返回 null。
 */
export function parseSegmentTs(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(String(name ?? ''));
  if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  const d = new Date(String(name ?? ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- 缓存 ----------

/** home → {rootMtimeMs, atMs, names:string[]}（只缓存目录 listing；内容永远现读现校验） */
const listingCache = new Map();
/** 段目录 → {metaStamp, meta, eventsStamp, countedEvents}（metadata/events 按文件 mtime+size 失效） */
const segmentCache = new Map();
/** 段目录 → {stamp, count}（仅 withSuppressed 时用） */
const suppressedCache = new Map();

/** 段名列表（目录 mtime + 500ms TTL 缓存；新增/删除段时目录 mtime 必变）。 */
function segmentNames(home) {
  const root = path.join(home, 'segments');
  let rootMtimeMs;
  try { rootMtimeMs = statSync(root).mtimeMs; } catch { return null; }
  const now = Date.now();
  const cached = listingCache.get(home);
  if (cached && cached.rootMtimeMs === rootMtimeMs && now - cached.atMs < SEGMENT_CACHE_TTL_MS) {
    return cached.names;
  }
  let names;
  try { names = readdirSync(root); } catch { return null; }
  listingCache.set(home, { rootMtimeMs, atMs: now, names });
  return names;
}

/** 单段元信息（metadata.json 按 (mtime,size) 缓存；缺失时按 events.jsonl 行数兜底）。 */
function segmentInfo(dir, name) {
  const metaStamp = stampSegmentDataFile(dir, 'metadata.json');
  let rec = segmentCache.get(dir);
  if (!rec || rec.metaStamp !== metaStamp) {
    let meta = {};
    const metaText = readSegmentDataText(dir, 'metadata.json');
    if (metaText !== null) { try { meta = JSON.parse(metaText); } catch { meta = {}; } }
    rec = { ...(rec ?? {}), metaStamp, meta };
    segmentCache.set(dir, rec);
  }
  const meta = rec.meta ?? {};
  let eventCount;
  if (Number.isInteger(meta.eventCount)) {
    eventCount = meta.eventCount;
  } else {
    // metadata 缺 eventCount：数 events.jsonl 行数（.gz 透明解压），按文件 (mtime,size) 缓存
    const eventsStamp = stampSegmentDataFile(dir, 'events.jsonl');
    if (rec.eventsStamp !== eventsStamp) {
      const text = readSegmentDataText(dir, 'events.jsonl');
      rec.countedEvents = text === null ? 0 : text.split('\n').filter(Boolean).length;
      rec.eventsStamp = eventsStamp;
    }
    eventCount = rec.countedEvents ?? 0;
  }
  return { meta, eventCount };
}

/** suppressed.jsonl 行数（仅显式需要时读；按 (mtime,size) 缓存）。 */
function suppressedCountOf(dir) {
  const stamp = stampSegmentDataFile(dir, 'suppressed.jsonl');
  if (stamp.endsWith(':-')) return null; // 不存在（含压缩后只有 .gz 之外的缺失）
  const cached = suppressedCache.get(dir);
  if (cached && cached.stamp === stamp) return cached.count;
  const text = readSegmentDataText(dir, 'suppressed.jsonl');
  const count = text === null ? 0 : text.split('\n').filter(Boolean).length;
  suppressedCache.set(dir, { stamp, count });
  return count;
}

/** 清空读取缓存（测试/清空历史后用；非必须）。 */
export function clearSegmentCache() {
  listingCache.clear();
  segmentCache.clear();
  suppressedCache.clear();
}

// ---------- 读取 ----------

/**
 * 段列表（读 <home>/segments/<name>/metadata.json；新→旧排序）。
 * @param {string} home
 * @param {{withSuppressed?: boolean}} [opts] withSuppressed=true 时才统计 suppressed.jsonl（默认不读）
 * @returns {Array<{segment:string,path:string,segmentStart:string|null,segmentEnd:string|null,open:boolean,eventCount:number,suppressedCount:number|null}>}
 */
export function listSegments(home = chronicleHome(), { withSuppressed = false } = {}) {
  const names = segmentNames(home);
  if (!names) return [];
  const root = path.join(home, 'segments');
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const { meta, eventCount } = segmentInfo(dir, name);
    out.push({
      segment: name,
      path: dir,
      segmentStart: meta.segmentStart ?? null,
      segmentEnd: meta.segmentEnd ?? null,
      open: !meta.segmentEnd,
      eventCount,
      suppressedCount: withSuppressed ? suppressedCountOf(dir) : null,
    });
  }
  return out.sort((a, b) => String(b.segment).localeCompare(String(a.segment)));
}

/** 读某段事件（JSONL → 数组；坏行跳过并计数）；段不存在返回 null。 */
export function readSegmentEvents(home = chronicleHome(), segment, { withSuppressed = false } = {}) {
  const dir = path.join(home, 'segments', String(segment));
  if (!existsSync(dir)) return null;
  const parseJsonl = (file) => {
    // 透明读：优先原文，其次 .gz（旧段压缩后对调用方完全无感）
    const text = readSegmentDataText(dir, file);
    if (text === null) return { events: [], skipped: 0 };
    const lines = text.split('\n').filter(Boolean);
    const events = [];
    let skipped = 0;
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { skipped += 1; }
    }
    return { events, skipped };
  };
  const { events, skipped } = parseJsonl('events.jsonl');
  const out = { segment: String(segment), events, skipped };
  if (withSuppressed) {
    out.suppressed = parseJsonl('suppressed.jsonl').events;
  }
  return out;
}

/** 事件是否命中搜索词（对整个事件 JSON 做不区分大小写子串匹配）。 */
function eventMatches(event, needle) {
  try { return JSON.stringify(event).toLowerCase().includes(needle); } catch { return false; }
}

/**
 * 跨所有段搜索事件（新→旧；段内也按新→旧）。
 * 兼容旧签名与返回形状 {query,count,capped,events}；内部走 searchEventsPaged
 * （有索引用索引，无索引线性回退，结果一致）。
 * @param {{q: string, limit?: number, from?: any, to?: any}} opts
 * @returns {{query: string, count: number, capped: boolean, events: Array}}
 */
export function searchEvents(home = chronicleHome(), { q, limit = 100, from, to } = {}) {
  const query = String(q ?? '').trim();
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  if (!query) return { query, count: 0, capped: false, events: [] };
  const page = searchEventsPaged(home, { query, limit: cap, offset: 0, from, to });
  return {
    query,
    count: page.items.length,
    capped: page.hasMore || page.total > page.items.length,
    events: page.items,
  };
}

/**
 * 单个段的事件（分页友好版；供 MCP/CLI 需要「按段时间范围」时使用）。
 * @returns {{segment:string, events:Array, total:number}}
 */
export function segmentEventsInRange(home = chronicleHome(), segment, { from, to } = {}) {
  const data = readSegmentEvents(home, segment);
  if (!data) return null;
  const { fromMs, toMs } = normalizeRange({ from, to });
  const events = data.events.filter((e) => {
    const t = Date.parse(e?.ts);
    if (Number.isNaN(t)) return fromMs === null && toMs === null;
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  });
  return { segment: data.segment, events, total: events.length };
}

/** 某本地日期 → [当天 00:00:00.000, 23:59:59.999]（毫秒）。 */
export function dayBoundsLocal(dateStr) {
  const s = String(dateStr ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const e = new Error(`日期格式须为 YYYY-MM-DD，收到: ${s}`);
    e.code = 'BAD_RANGE';
    throw e;
  }
  return normalizeRange({ from: s, to: s });
}

/** 人亲手操作才会产生的事件类型（时间线「亲手操作」与摘要「有没有人」共用）。 */
export const INPUT_EVENT_TYPES = new Set(['click', 'context-menu', 'drag', 'shortcut', 'text-input', 'submit', 'scroll', 'selection']);

/**
 * 这段是否没人在操作：采集器报告过不在场（presence idle/locked/sleep），
 * 且没有任何输入、真实换应用（非 reason=segment-start 的 app-switch）或回到在场（active/unlocked/wake）。
 * 没有 presence 记录的旧段一律按有人处理（宁可多摘要，不漏记）。
 */
export function segmentUnattended(events) {
  let absent = false;
  for (const ev of events) {
    const type = ev?.type;
    if (INPUT_EVENT_TYPES.has(type)) return false;
    if (type === 'app-switch' && ev.data?.reason !== 'segment-start') return false;
    if (type !== 'presence') continue;
    const state = ev.data?.state;
    if (state === 'active' || state === 'unlocked' || state === 'wake') return false;
    if (state === 'idle' || state === 'locked' || state === 'sleep') absent = true;
  }
  return absent;
}
