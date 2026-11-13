// shared/index.mjs — SQLite 检索索引（批次 3）
//
// 目标：把「跨段搜索」和「按时间范围查询」从线性扫描升级为索引查询，同时保持
// 与旧版线性实现**完全一致的语义**（大小写不敏感的子串匹配、最新在前）。
//
// 设计要点：
//   ① 依赖 Node 24 内建 `node:sqlite`（DatabaseSync），零第三方依赖；加载/打开/建表
//      任一步失败都返回 null，调用方（shared/segments.mjs）自动回退线性扫描。
//   ② 库文件 <home>/index/events.db，WAL 模式；坏库自动改名 <file>.corrupt[-ts] 后重建。
//   ③ 表 events 保存「一行一事件」的扁平列 + raw（原始事件 JSON）+ hay（raw 小写，
//      用于 LIKE 子串匹配 —— 与旧实现 JSON.stringify(event).toLowerCase().includes(q)
//      完全同语义）。
//   ④ 表 segments 是 meta：记录每段的内容指纹（mtime 指纹 + eventCount），据此做
//      增量重建：只重建变化段、删除已消失段、未变段复用。
//   ⑤ FTS5 只在可用时创建（仅作可选加速与元数据，不参与匹配判定，避免与子串语义分叉）。
//
// 导出：ensureIndex / searchEventsPaged / listSegmentsPaged / indexStats / closeIndex
//      + 内部用的 sqliteAvailable / searchIndexed
//
// 只读数据：本模块只读 <home>/segments/**，只写 <home>/index/**（不改动任何采集数据）。

import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { readSegmentDataText, stampSegmentDataFile } from './compression.mjs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ---------- node:sqlite 可选加载（失败即整体降级） ----------

let DatabaseSync = null;
let loadError = null;
try {
  // 顶层 await import：node:sqlite 在 Node 24 可用；老版本/被裁剪的构建抛错 → 降级。
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  DatabaseSync = null;
  loadError = err;
}

export const INDEX_SCHEMA_VERSION = '3';
const DEFAULT_LIMIT = 50;
const DEFAULT_SEGMENT_LIMIT = 20;

/** node:sqlite 是否可用（不可用时所有 paged 函数走 indexed:false 回退）。 */
export function sqliteAvailable() { return DatabaseSync !== null; }

/** 加载失败原因（诊断用；不可用时非 null）。 */
export function sqliteLoadError() { return loadError; }

// ---------- 基础工具 ----------

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区日期键 YYYY-MM-DD（与 web / mcp 的“按天”口径一致）。 */
export function localDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 默认数据根目录（与 shared/segments.mjs 的 chronicleHome 同规则）。 */
function defaultHome(env = process.env) {
  const h = env.CHRONICLE_HOME;
  return h && h.length ? path.resolve(h) : path.join(os.homedir(), '.chronicle');
}

/** 段名（Swift 的 HH-mm-ss 变体）或 ISO 串 → Date；失败 null。 */
function segNameToDate(name) {
  const s = String(name ?? '');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(s);
  if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 时间范围边界归一化。
 *   undefined/null → null
 *   number         → 毫秒时间戳
 *   "YYYY-MM-DD"   → 本地时区当天 00:00:00.000（from）/ 23:59:59.999（to）
 *   其他字符串      → Date.parse（ISO 等），失败抛 BAD_RANGE
 * @param {{from?: any, to?: any}} opts
 * @returns {{fromMs: number|null, toMs: number|null}}
 */
export function normalizeRange({ from, to } = {}) {
  const one = (v, isEnd) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw badRange(`非法时间边界: ${v}`);
      return Math.trunc(v);
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map((x) => Number.parseInt(x, 10));
      const local = isEnd
        ? new Date(y, m - 1, d, 23, 59, 59, 999)
        : new Date(y, m - 1, d, 0, 0, 0, 0);
      if (Number.isNaN(local.getTime())) throw badRange(`非法日期: ${s}`);
      return local.getTime();
    }
    if (/^\d+$/.test(s)) return Math.trunc(Number.parseInt(s, 10)); // 纯数字串按 ms
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw badRange(`无法解析的时间边界: ${s}`);
    return t;
  };
  const fromMs = one(from, false);
  const toMs = one(to, true);
  if (fromMs !== null && toMs !== null && fromMs > toMs) throw badRange('from 晚于 to');
  return { fromMs, toMs };
}

function badRange(message) {
  const e = new Error(message);
  e.code = 'BAD_RANGE';
  return e;
}

// ---------- 段目录扫描（本地实现，避免与 shared/segments.mjs 循环 import） ----------

/**
 * 扫描 <home>/segments/*，返回与 shared/segments.mjs listSegments 同形的数组（新→旧）。
 * @param {string} home
 * @returns {Array<{segment:string,path:string,segmentStart:string|null,segmentEnd:string|null,open:boolean,eventCount:number,suppressedCount:null}>}
 */
export function scanSegments(home = defaultHome()) {
  const root = path.join(home, 'segments');
  let names;
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let meta = {};
    const metaText = readSegmentDataText(dir, 'metadata.json');
    if (metaText !== null) { try { meta = JSON.parse(metaText); } catch { meta = {}; } }
    let eventCount = Number.isInteger(meta.eventCount) ? meta.eventCount : 0;
    if (!Number.isInteger(meta.eventCount)) {
      const text = readSegmentDataText(dir, 'events.jsonl'); // 兼容 .gz
      eventCount = text === null ? 0 : text.split('\n').filter(Boolean).length;
    }
    out.push({
      segment: name,
      path: dir,
      segmentStart: meta.segmentStart ?? null,
      segmentEnd: meta.segmentEnd ?? null,
      open: !meta.segmentEnd,
      eventCount,
      suppressedCount: null,
    });
  }
  return out.sort((a, b) => String(b.segment).localeCompare(String(a.segment)));
}

/**
 * 段内容指纹：目录内各数据文件的 (mtimeMs, size) 拼接。
 * 任一文件变化（追加、关闭段、写 metadata）都会改变指纹 → 触发该段重建。
 */
function segmentFingerprint(dir) {
  const parts = [];
  for (const file of ['metadata.json', 'events.jsonl', 'suppressed.jsonl']) {
    // .gz 存在时用 .gz 的 (mtime,size)；压缩导致的指纹变化会触发该段重建（允许）
    parts.push(stampSegmentDataFile(dir, file));
  }
  return parts.join('|');
}

/** 读段内事件（JSONL，坏行跳过）。 */
function readSegmentEventsRaw(dir) {
  const text = readSegmentDataText(dir, 'events.jsonl'); // 兼容 .gz
  if (text === null) return [];
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  return events;
}

/** 从事件对象取扁平列（缺失 → null）。 */
function columnsOf(event) {
  const d = event && typeof event === 'object' && event.data && typeof event.data === 'object' ? event.data : {};
  const str = (v) => (typeof v === 'string' && v.length ? v : null);
  const tsRaw = Date.parse(event?.ts);
  const ts = Number.isNaN(tsRaw) ? null : tsRaw;
  return {
    ts,
    date: ts === null ? '' : localDateKey(ts),
    type: str(event?.type),
    bundle: str(d.bundleId),
    app: str(d.appName),
    title: str(d.windowTitle),
    url: str(d.url),
    focus_role: str(d.role),
    focus_title: str(d.title),
  };
}

function isCorruptionError(err) {
  const msg = String(err?.message ?? err ?? '');
  const code = String(err?.code ?? '');
  return /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed|malformed/i.test(`${code} ${msg}`);
}

// ---------- 打开 / 建表 / 损坏自愈 ----------

const open = new Map(); // home(绝对路径) → {db, file}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY,
      segment TEXT NOT NULL,
      ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      type TEXT,
      bundle TEXT,
      app TEXT,
      title TEXT,
      url TEXT,
      focus_role TEXT,
      focus_title TEXT,
      raw TEXT NOT NULL,
      hay TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS ix_events_date ON events(date);
    CREATE INDEX IF NOT EXISTS ix_events_bundle ON events(bundle);
    CREATE INDEX IF NOT EXISTS ix_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS ix_events_segment ON events(segment);
    CREATE TABLE IF NOT EXISTS segments(
      segment TEXT PRIMARY KEY,
      mtime TEXT,
      eventCount INTEGER,
      indexedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS index_meta(k TEXT PRIMARY KEY, v TEXT);
  `);
  // FTS5 可选：创建失败不影响功能（匹配判定始终走 hay LIKE，保持与线性回退同语义）。
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(segment, app, bundle, title, url, focus_role, focus_title, content='')");
  } catch { /* 无 FTS5：忽略 */ }
  db.prepare('INSERT INTO index_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('schema_version', INDEX_SCHEMA_VERSION);
}

function quickCheckOk(db) {
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const v = row ? Object.values(row)[0] : null;
    return String(v ?? '').toLowerCase() === 'ok';
  } catch { return false; }
}

function moveAside(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const from = file + suffix;
      let to = `${file}.corrupt${suffix}`;
      let i = 1;
      // 已存在旧坏库副本 → 加序号，避免覆盖证据
      while (safeExists(to) && i < 1000) { to = `${file}.corrupt-${i}${suffix}`; i += 1; }
      renameSync(from, to);
    } catch { /* 文件不存在等：忽略 */ }
  }
}

function safeExists(p) {
  try { statSync(p); return true; } catch { return false; }
}

/**
 * 打开（或复用）某 home 的索引库；sqlite 不可用/无法创建 → null。
 * @returns {{db: object, file: string}|null}
 */
function openIndex(home) {
  if (!DatabaseSync) return null;
  const key = path.resolve(home);
  const cached = open.get(key);
  if (cached) return cached;
  const file = path.join(key, 'index', 'events.db');
  try { mkdirSync(path.dirname(file), { recursive: true }); } catch { return null; }

  const attempt = () => {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA busy_timeout = 2000');
    } catch { /* 某些构建不允许改 pragma：不影响读写 */ }
    return db;
  };

  let db = null;
  try {
    db = attempt();
    if (!quickCheckOk(db)) throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    ensureSchema(db);
  } catch (err) {
    try { db?.close(); } catch { /* 已关闭 */ }
    if (isCorruptionError(err) || /quick_check/i.test(String(err?.message ?? ''))) {
      moveAside(file); // 坏库留档后重建（不静默删证据）
      try {
        db = attempt();
        ensureSchema(db);
      } catch { return null; }
    } else {
      return null;
    }
  }
  const rec = { db, file };
  open.set(key, rec);
  return rec;
}

/**
 * 关闭全部索引句柄（测试/进程退出用）；之后再调用会自动重开。
 */
export function closeIndex() {
  for (const rec of open.values()) {
    try { rec.db.close(); } catch { /* 已关闭 */ }
  }
  open.clear();
}

/** 清空某 home 的索引缓存句柄（删除历史后调用，避免读到过期行）。 */
export function resetIndex(home) {
  const key = path.resolve(home ?? defaultHome());
  const rec = open.get(key);
  if (!rec) return;
  try { rec.db.close(); } catch { /* 已关闭 */ }
  open.delete(key);
}

// ---------- 增量索引 ----------

function tableCount(db, table) {
  try { return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0); } catch { return 0; }
}

/**
 * 增量建立/刷新索引：对比每段内容指纹，只重建变化段、删除消失段。
 * @param {string} home
 * @param {Array} [segments] 可选：调用方已有的段列表（省一次扫描）
 * @returns {null|{indexed:true,segments:number,events:number,rebuilt:number,removed:number,reused:number,dbPath:string}}
 */
export function ensureIndex(home = defaultHome(), segments = null) {
  const rec = openIndex(home);
  if (!rec) return null;
  const segs = Array.isArray(segments) ? segments : scanSegments(home);
  const db = rec.db;
  const stats = { indexed: true, segments: 0, events: 0, rebuilt: 0, removed: 0, reused: 0, dbPath: rec.file };

  let known;
  try { known = db.prepare('SELECT segment, mtime FROM segments').all(); } catch { return null; }
  const knownMap = new Map(known.map((r) => [r.segment, String(r.mtime ?? '')]));
  const seen = new Set();

  const delEvents = db.prepare('DELETE FROM events WHERE segment = ?');
  const delFts = db.prepare('DELETE FROM events_fts WHERE segment = ?');
  let ftsOk = true;
  const insert = db.prepare(`INSERT INTO events(segment, ts, date, type, bundle, app, title, url, focus_role, focus_title, raw, hay)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upsertMeta = db.prepare(`INSERT INTO segments(segment, mtime, eventCount, indexedAt) VALUES(?, ?, ?, ?)
    ON CONFLICT(segment) DO UPDATE SET mtime = excluded.mtime, eventCount = excluded.eventCount, indexedAt = excluded.indexedAt`);

  for (const seg of segs) {
    const name = String(seg.segment);
    seen.add(name);
    const fp = segmentFingerprint(seg.path);
    if (knownMap.get(name) === fp) { stats.reused += 1; continue; }

    const events = readSegmentEventsRaw(seg.path);
    const nowIso = new Date().toISOString();
    try {
      db.exec('BEGIN');
      delEvents.run(name);
      try { delFts.run(name); } catch { ftsOk = false; }
      let lastId = 0;
      for (const event of events) {
        const cols = columnsOf(event);
        const raw = JSON.stringify(event);
        const hay = raw.toLowerCase();
        const info = insert.run(
          name, cols.ts ?? 0, cols.date, cols.type, cols.bundle, cols.app,
          cols.title, cols.url, cols.focus_role, cols.focus_title, raw, hay,
        );
        lastId = Number(info.lastInsertRowid ?? 0);
        if (ftsOk) {
          try {
            db.prepare(`INSERT INTO events_fts(rowid, segment, app, bundle, title, url, focus_role, focus_title)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
              lastId, name, cols.app ?? '', cols.bundle ?? '', cols.title ?? '',
              cols.url ?? '', cols.focus_role ?? '', cols.focus_title ?? '',
            );
          } catch { ftsOk = false; /* FTS5 写入不支持 → 本次起停用 */ }
        }
      }
      upsertMeta.run(name, fp, events.length, nowIso);
      db.exec('COMMIT');
      stats.rebuilt += 1;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 无事务 */ }
      if (isCorruptionError(err)) { // 写到一半发现坏库：留档重建后交由下次调用补
        try { db.close(); } catch { /* 已关闭 */ }
        open.delete(path.resolve(home));
        moveAside(rec.file);
        return null;
      }
      // 单段失败不拖垮整次索引：保持旧数据，继续下一段
    }
  }

  // 已消失的段：清掉其事件与 meta
  const delMeta = db.prepare('DELETE FROM segments WHERE segment = ?');
  for (const name of knownMap.keys()) {
    if (seen.has(name)) continue;
    try {
      db.exec('BEGIN');
      delEvents.run(name);
      delMeta.run(name);
      db.exec('COMMIT');
      stats.removed += 1;
    } catch { try { db.exec('ROLLBACK'); } catch { /* 无事务 */ } }
  }

  stats.segments = tableCount(db, 'segments');
  stats.events = tableCount(db, 'events');
  return stats;
}

// ---------- 查询 ----------

function escapeLike(s) { return String(s).replace(/[\\%_]/g, (c) => `\\${c}`); }

function buildWhere({ query, fromMs, toMs }) {
  const clauses = [];
  const params = [];
  if (fromMs !== null && fromMs !== undefined) { clauses.push('ts >= ?'); params.push(fromMs); }
  if (toMs !== null && toMs !== undefined) { clauses.push('ts <= ?'); params.push(toMs); }
  const q = String(query ?? '').trim();
  if (q) { clauses.push("hay LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(q.toLowerCase())}%`); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** 索引行 → 事件对象（与原事件同形，附带 segment）。 */
function rowToEvent(row) {
  let event = {};
  try { event = JSON.parse(row.raw); } catch { event = { ts: row.ts ? new Date(row.ts).toISOString() : null, type: row.type ?? null, data: {} }; }
  return { segment: row.segment, ...event };
}

/**
 * 走索引的分页搜索（内部用；索引不可用返回 null）。
 * @returns {null|{items:Array,total:number,hasMore:boolean,indexed:true}}
 */
export function searchIndexed(home = defaultHome(), { query = '', limit = DEFAULT_LIMIT, offset = 0, from, to } = {}) {
  const stats = ensureIndex(home);
  if (!stats) return null;
  const rec = openIndex(home);
  if (!rec) return null;
  const db = rec.db;
  const range = normalizeRange({ from, to });
  const { sql, params } = buildWhere({ query, ...range });
  const lim = clampInt(limit, DEFAULT_LIMIT, 1, 500);
  const off = clampInt(offset, 0, 0, 1_000_000);
  let total = 0;
  let items = [];
  try {
    total = Number(db.prepare(`SELECT COUNT(*) AS c FROM events ${sql}`).get(...params)?.c ?? 0);
    const rows = db.prepare(`SELECT segment, raw FROM events ${sql} ORDER BY ts DESC, segment DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, lim, off);
    items = rows.map(rowToEvent);
  } catch (err) {
    if (isCorruptionError(err)) {
      try { db.close(); } catch { /* 已关闭 */ }
      open.delete(path.resolve(home));
      moveAside(rec.file);
      return null; // 交由调用方回退线性扫描
    }
    throw err;
  }
  return { items, total, hasMore: off + items.length < total, indexed: true };
}

function clampInt(v, dflt, min, max) {
  const n = typeof v === 'number' ? Math.trunc(v) : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * 跨段分页搜索（对外主入口）。索引可用走索引；否则线性回退（结果一致，indexed:false）。
 * @param {string} home
 * @param {{query?:string, limit?:number, offset?:number, from?:any, to?:any}} opts
 * @returns {{items:Array, total:number, hasMore:boolean, indexed:boolean}}
 */
export function searchEventsPaged(home = defaultHome(), { query = '', limit = DEFAULT_LIMIT, offset = 0, from, to } = {}) {
  const lim = clampInt(limit, DEFAULT_LIMIT, 1, 500);
  const off = clampInt(offset, 0, 0, 1_000_000);
  const range = normalizeRange({ from, to }); // 非法边界统一在此抛 BAD_RANGE
  try {
    const indexed = searchIndexed(home, { query, limit: lim, offset: off, from, to });
    if (indexed) return indexed;
  } catch (err) {
    if (err?.code === 'BAD_RANGE') throw err;
    // 索引层任意异常 → 静默回退（索引是加速项，不是正确性依赖）
  }
  return linearSearch(home, { query, limit: lim, offset: off, range });
}

/** 线性回退实现（语义与旧版 searchEvents 完全一致：不区分大小写子串、最新在前）。 */
function linearSearch(home, { query, limit, offset, range }) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = [];
  for (const seg of scanSegments(home)) {
    for (const event of readSegmentEventsRaw(seg.path)) {
      const cols = columnsOf(event);
      if (range.fromMs !== null && (cols.ts === null || cols.ts < range.fromMs)) continue;
      if (range.toMs !== null && (cols.ts === null || cols.ts > range.toMs)) continue;
      if (q) {
        let hay = '';
        try { hay = JSON.stringify(event).toLowerCase(); } catch { hay = ''; }
        if (!hay.includes(q)) continue;
      }
      all.push({ segment: seg.segment, ts: cols.ts, event });
    }
  }
  // 最新在前：ts 降序，同 ts 按段名/插入序倒序（与索引 ORDER BY 对齐）
  all.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || String(b.segment).localeCompare(String(a.segment)));
  const total = all.length;
  const items = all.slice(offset, offset + limit).map((r) => ({ segment: r.segment, ...r.event }));
  return { items, total, hasMore: offset + items.length < total, indexed: false };
}

/**
 * 段列表分页（新→旧）。
 * @param {string} home
 * @param {{limit?:number, before?:any}} opts before = 段名（不含）或时间戳（只返回更早的段）
 * @returns {{items:Array, hasMore:boolean, nextBefore:string|null}}
 */
export function listSegmentsPaged(home = defaultHome(), { limit = DEFAULT_SEGMENT_LIMIT, before = null } = {}, segments = null) {
  const lim = clampInt(limit, DEFAULT_SEGMENT_LIMIT, 1, 200);
  const all = Array.isArray(segments) ? segments : scanSegments(home);
  let start = 0;
  if (before !== null && before !== undefined && before !== '') {
    const byName = all.findIndex((s) => s.segment === String(before));
    if (byName >= 0) start = byName + 1;
    else {
      const t = typeof before === 'number' ? before : Date.parse(String(before));
      if (!Number.isNaN(t)) start = all.findIndex((s) => {
        const d = segNameToDate(s.segment) ?? (s.segmentStart ? new Date(s.segmentStart) : null);
        return d && d.getTime() < t;
      });
      if (start < 0) start = all.length;
    }
  }
  const items = all.slice(start, start + lim);
  const hasMore = start + items.length < all.length;
  return { items, hasMore, nextBefore: hasMore && items.length ? items[items.length - 1].segment : null };
}

/**
 * 索引统计信息（顺带做一次增量刷新）。
 * @returns {{indexed:boolean, dbPath?:string, segments?:number, events?:number, bytes?:number, schemaVersion?:string, reason?:string}}
 */
export function indexStats(home = defaultHome()) {
  const stats = ensureIndex(home);
  if (!stats) {
    return { indexed: false, reason: DatabaseSync ? 'index-unavailable' : 'node:sqlite-unavailable' };
  }
  let bytes = 0;
  try { bytes = statSync(stats.dbPath).size; } catch { bytes = 0; }
  return {
    indexed: true,
    dbPath: stats.dbPath,
    bytes,
    segments: stats.segments,
    events: stats.events,
    schemaVersion: INDEX_SCHEMA_VERSION,
  };
}
