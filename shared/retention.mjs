// shared/retention.mjs — 数据保留策略（默认关闭：retentionDays=0 绝不自动删数据）
//
// 设计红线：
//   ① 默认 no-op：`retentionDays = 0` 时本模块不删除、不写任何文件（安全默认）。
//   ② 只删「已关闭」段（metadata.json 有 segmentEnd）；open 段、metadata 缺失/损坏的段永不删。
//   ③ segmentStart 无法解析的段跳过并记 warning（宁可不删，不可错删）。
//   ④ dryRun 只算清单、绝不落盘（不删段、不删摘要、不刷索引）。
//   ⑤ 单条删除失败不中断整体：errors 计数 + warning，继续处理其它段。
//   ⑥ 日志只记计数与段名（段名=时间戳），绝不记标题/URL/事件内容。
//
// 摘要命名（与 summarize.mjs 保持一致，读该文件确认）：
//   10min：<home>/summaries/10min-<段目录名>.md
//   6h   ：<home>/summaries/6h-<bucketKey>.md，bucketKey = 桶起点 UTC ISO 的前 13 字符（如 2026-11-01T00）
// 6h 摘要只在「桶结束时间（桶起点 + 6h）早于 cutoff」时删除；否则保留（可能覆盖未过期数据）。

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const DAY_MS = 86_400_000;
/** 段目录名严格格式（与 shared/segments.mjs / Swift 端一致）。仅用于 metadata 缺 start 时兜底。 */
const STRICT_SEGMENT_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/;
/** 6h 桶宽度（与 summarize.mjs 的 BUCKET_MS 一致）。 */
export const BUCKET_MS = 6 * 60 * 60 * 1000;
/** 保留天数的硬上限（> 该值视为超范围并钳制，防误配置成天文数字以外的异常输入）。 */
export const MAX_MAINTENANCE_DAYS = 3650;
/** 维护配置默认值：retentionDays=0 表示「保留策略关闭」；compressAfterDays 默认 7 天。 */
export const DEFAULT_MAINTENANCE = Object.freeze({ retentionDays: 0, compressAfterDays: 7 });

const logName = (name) => String(name ?? '(unknown)');

// ---------- 配置归一化 ----------

/**
 * 把 config.json（或直接是 maintenance 段）归一化成维护配置。
 * 接受三种输入：
 *   · 完整配置对象且含 `maintenance` 段 → 用该段
 *   · 直接是 maintenance 段（含 retentionDays/compressAfterDays）→ 原样读取
 *   · 缺省/非对象 → 默认值 + warning
 * 非法值（非非负整数、负数、NaN、浮点、字符串等）回落默认并记 warning；
 * 超过 MAX_MAINTENANCE_DAYS 的值钳制到上限并记 warning。
 * @returns {{retentionDays:number, compressAfterDays:number, warnings:string[]}}
 */
export function normalizeMaintenanceConfig(cfg) {
  const warnings = [];
  const section = (() => {
    if (cfg === null || cfg === undefined) return {};
    if (typeof cfg !== 'object' || Array.isArray(cfg)) return null;
    if (cfg.maintenance !== undefined) {
      const m = cfg.maintenance;
      if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
      return m;
    }
    if ('retentionDays' in cfg || 'compressAfterDays' in cfg) return cfg;
    return {};
  })();
  if (section === null) {
    warnings.push('maintenance 配置须为对象；已回退默认值');
    return { ...DEFAULT_MAINTENANCE, warnings };
  }
  const coerce = (value, def, key) => {
    if (value === undefined || value === null) return def;
    if (!Number.isInteger(value) || value < 0) {
      warnings.push(`${key} 须为非负整数（收到 ${JSON.stringify(value)}）；已回退默认 ${def}`);
      return def;
    }
    if (value > MAX_MAINTENANCE_DAYS) {
      warnings.push(`${key}=${value} 超过上限 ${MAX_MAINTENANCE_DAYS}；已钳制`);
      return MAX_MAINTENANCE_DAYS;
    }
    return value;
  };
  return {
    retentionDays: coerce(section.retentionDays, DEFAULT_MAINTENANCE.retentionDays, 'retentionDays'),
    compressAfterDays: coerce(section.compressAfterDays, DEFAULT_MAINTENANCE.compressAfterDays, 'compressAfterDays'),
    warnings,
  };
}

// ---------- 内部工具 ----------

/** 目录总字节数（递归；读不到的子项按 0 计）。 */
function dirBytes(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let children = [];
      try { children = readdirSync(p); } catch { return; }
      for (const child of children) walk(path.join(p, child));
    } else {
      total += st.size;
    }
  };
  walk(dir);
  return total;
}

function fileBytes(file) {
  try { return statSync(file).size; } catch { return 0; }
}

/** 段起始时间：metadata.segmentStart 优先，回退「严格格式」目录名解析；不可解析返回 NaN。 */
function segmentStartMs(name, meta) {
  if (meta && typeof meta.segmentStart === 'string' && meta.segmentStart.length) {
    const t = Date.parse(meta.segmentStart);
    if (Number.isFinite(t)) return t;
  }
  // 注意：不能用宽松的 new Date(name)（"unparsable-01" 这类字符串会被 V8 误解析成合法日期，
  // 从而把「时间不可解析」的段误判为过期段）。只接受严格的段目录名格式。
  const m = STRICT_SEGMENT_NAME_RE.exec(String(name ?? ''));
  if (!m) return Number.NaN;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** 段桶 key（UTC 6h 对齐，取 ISO 前 13 字符；与 summarize.mjs 的 bucketInfo().key 同构）。 */
export function bucketKeyFor(ms) {
  const t = Math.floor(ms / BUCKET_MS) * BUCKET_MS;
  return new Date(t).toISOString().slice(0, 13);
}

// ---------- 保留策略主体 ----------

/**
 * 删除过期段及其摘要。
 * @param {string} home 数据根（<home>/segments、<home>/summaries）
 * @param {{retentionDays?:number, now?:number|Date, dryRun?:boolean, log?:Function}} opts
 * @returns {{
 *   dryRun:boolean, cutoffIso:string|null, removedSegments:string[], removedSummaries:string[],
 *   skippedOpen:number, skippedUnparsable:number, bytesFreed:number, failedSegments:string[],
 *   errors:number, warnings:string[], disabled:boolean
 * }}
 */
export function pruneOldSegments(home, { retentionDays = 0, now = Date.now(), dryRun = false, log = () => {} } = {}) {
  const report = {
    dryRun: Boolean(dryRun),
    cutoffIso: null,
    removedSegments: [],
    removedSummaries: [],
    skippedOpen: 0,
    skippedUnparsable: 0,
    bytesFreed: 0,
    failedSegments: [],
    errors: 0,
    warnings: [],
    disabled: false,
  };

  // 默认关闭（安全红线）：retentionDays=0/非法 → 不碰任何文件
  const days = Number.isInteger(retentionDays) && retentionDays > 0
    ? Math.min(retentionDays, MAX_MAINTENANCE_DAYS)
    : 0;
  if (days === 0) {
    report.disabled = true;
    log('[retention] 已关闭（retentionDays=0）：不删除任何数据');
    return report;
  }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoffMs = baseMs - days * DAY_MS;
  report.cutoffIso = new Date(cutoffMs).toISOString();

  const segmentsRoot = path.join(home, 'segments');
  const summariesRoot = path.join(home, 'summaries');

  // 扫描（只读 metadata.json；坏 metadata 视为 open，永不删）
  let names = [];
  try {
    names = readdirSync(segmentsRoot)
      .filter((n) => { try { return statSync(path.join(segmentsRoot, n)).isDirectory(); } catch { return false; } })
      .sort();
  } catch { /* 无 segments 目录 = 没有可删的段 */ }

  const removable = []; // {name, startMs}
  for (const name of names) {
    const dir = path.join(segmentsRoot, name);
    let meta = null;
    try { meta = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8')); } catch { meta = null; }
    // 只删已关闭段：没有 segmentEnd / metadata 缺失或损坏 → 视为 open，永不删
    if (!meta || typeof meta !== 'object' || !meta.segmentEnd) {
      report.skippedOpen += 1;
      continue;
    }
    const startMs = segmentStartMs(name, meta);
    if (!Number.isFinite(startMs)) {
      report.skippedUnparsable += 1;
      report.warnings.push(`segmentStart 无法解析，跳过不删: ${logName(name)}`);
      log(`[retention] 跳过无法解析 segmentStart 的段 ${logName(name)}（不删除）`);
      continue;
    }
    if (startMs >= cutoffMs) continue; // 未过期（严格早于 cutoff 才删）
    removable.push({ name, startMs });
  }

  // dryRun：只算清单，不写任何文件
  if (report.dryRun) {
    const bucketKeys = new Set(removable.map((r) => bucketKeyFor(r.startMs)));
    const summaryNames = new Set(removable.map((r) => `10min-${r.name}.md`));
    for (const key of bucketKeys) {
      const bucketStart = Date.parse(`${key}:00:00.000Z`);
      if (Number.isFinite(bucketStart) && bucketStart + BUCKET_MS < cutoffMs) summaryNames.add(`6h-${key}.md`);
    }
    report.removedSegments = removable.map((r) => r.name).sort();
    report.removedSummaries = [...summaryNames]
      .filter((f) => existsSync(path.join(summariesRoot, f)))
      .sort();
    for (const r of removable) report.bytesFreed += dirBytes(path.join(segmentsRoot, r.name));
    for (const f of report.removedSummaries) report.bytesFreed += fileBytes(path.join(summariesRoot, f));
    log(`[retention] dryRun：将删除 ${report.removedSegments.length} 段 / ${report.removedSummaries.length} 摘要（cutoff=${report.cutoffIso}）`);
    return report;
  }

  // 真正删除：先删段；单段失败只记 error，不中断
  const removedWithStart = [];
  for (const r of removable) {
    const dir = path.join(segmentsRoot, r.name);
    const size = dirBytes(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
      report.removedSegments.push(r.name);
      report.bytesFreed += size;
      removedWithStart.push(r);
    } catch (err) {
      report.errors += 1;
      report.failedSegments.push(r.name);
      report.warnings.push(`删除段失败 ${logName(r.name)}: ${err.message}`);
      log(`[retention] 删除段失败 ${logName(r.name)}: ${err.message}`);
    }
  }

  // 摘要：10min 只删「段确已删除」对应的；6h 只删桶结束早于 cutoff 的桶
  const summaryNames = new Set(removedWithStart.map((r) => `10min-${r.name}.md`));
  const bucketKeys = new Set(removedWithStart.map((r) => bucketKeyFor(r.startMs)));
  for (const key of bucketKeys) {
    const bucketStart = Date.parse(`${key}:00:00.000Z`);
    if (Number.isFinite(bucketStart) && bucketStart + BUCKET_MS < cutoffMs) summaryNames.add(`6h-${key}.md`);
  }
  for (const filename of [...summaryNames].sort()) {
    const file = path.join(summariesRoot, filename);
    if (!existsSync(file)) continue;
    const size = fileBytes(file);
    try {
      rmSync(file, { force: true });
      report.removedSummaries.push(filename);
      report.bytesFreed += size;
    } catch (err) {
      report.errors += 1;
      report.warnings.push(`删除摘要失败 ${logName(filename)}: ${err.message}`);
      log(`[retention] 删除摘要失败 ${logName(filename)}: ${err.message}`);
    }
  }

  report.removedSegments.sort();
  report.removedSummaries.sort();
  log(`[retention] 删除 ${report.removedSegments.length} 段 / ${report.removedSummaries.length} 摘要（cutoff=${report.cutoffIso}，释放 ${report.bytesFreed} 字节）`);
  return report;
}
