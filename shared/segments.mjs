// shared/segments.mjs — 段（segments）与事件的共享读取层
//
// daemon.mjs（HTTP 展示）、summarize.mjs（摘要器）、mcp-entry.mjs（MCP 面）共用，
// 放在独立模块避免 daemon ↔ summarize 循环 import。全部只读，不碰隐私语义
// （闸门权威实现在 Swift 采集端，镜像在 shared/privacy.mjs）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

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

/** 段列表（读 <home>/segments/<name>/metadata.json；新→旧排序）。 */
export function listSegments(home = chronicleHome()) {
  const root = path.join(home, 'segments');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8')); } catch { meta = {}; }
    let eventCount = Number.isInteger(meta.eventCount) ? meta.eventCount : 0;
    let suppressedCount = null;
    if (!Number.isInteger(meta.eventCount)) {
      // metadata 缺失/损坏时兜底数行数
      try { eventCount = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { eventCount = 0; }
    }
    try { suppressedCount = readFileSync(path.join(dir, 'suppressed.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* 无抑制文件 */ }
    out.push({
      segment: name,
      path: dir,
      segmentStart: meta.segmentStart ?? null,
      segmentEnd: meta.segmentEnd ?? null,
      open: !meta.segmentEnd,
      eventCount,
      suppressedCount,
    });
  }
  return out.sort((a, b) => String(b.segment).localeCompare(String(a.segment)));
}

/** 读某段事件（JSONL → 数组；坏行跳过并计数）；段不存在返回 null。 */
export function readSegmentEvents(home = chronicleHome(), segment, { withSuppressed = false } = {}) {
  const dir = path.join(home, 'segments', String(segment));
  if (!existsSync(dir)) return null;
  const parseJsonl = (file) => {
    try {
      const lines = readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
      const events = [];
      let skipped = 0;
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch { skipped += 1; }
      }
      return { events, skipped };
    } catch { return { events: [], skipped: 0 }; }
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
 * @param {{q: string, limit?: number}} opts
 * @returns {{query: string, count: number, capped: boolean, events: Array}}
 */
export function searchEvents(home = chronicleHome(), { q, limit = 100 } = {}) {
  const query = String(q ?? '').trim();
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  if (!query) return { query, count: 0, capped: false, events: [] };
  const needle = query.toLowerCase();
  const out = [];
  let capped = false;
  for (const seg of listSegments(home)) {
    if (out.length >= cap) { capped = true; break; }
    const { events } = readSegmentEvents(home, seg.segment);
    for (let i = events.length - 1; i >= 0 && out.length < cap; i -= 1) {
      const e = events[i];
      if (eventMatches(e, needle)) {
        out.push({ segment: seg.segment, segmentStart: seg.segmentStart, ...e });
      }
    }
  }
  return { query, count: out.length, capped, events: out };
}
