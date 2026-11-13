// shared/compression.mjs — 旧段透明压缩（gzip，任务 F）
//
// 目标：把「已关闭 + 足够旧」的段里的 JSONL 文件原地压成 `.jsonl.gz`，节省磁盘，
// 同时让所有读者（HTTP API / MCP / 摘要器 / SQLite 索引）**完全无感**。
//
// 安全红线（独立验收重点）：
//   ① 只压已关闭段（metadata 有 segmentEnd）；open 段/new 段永不触碰。
//   ② 先写 `<file>.gz.tmp` → 回读 gunzip + sha256 与原文件比对 → 一致才 rename 成
//      `<file>.gz` → 最后才删原文件。任一步失败：清 tmp、保留原文件、记 error。
//   ③ dryRun 只返回清单，不写任何文件（连 tmp 都不建）。
//   ④ 幂等：只有 .gz（无原文）→ 跳过；两文件并存 → 校验一致才删原件，不一致则
//      保留原件、删 .gz 并记 error（绝不因为「存在」就相信 .gz）。
//   ⑤ 日志只记段名（时间戳）/文件数/字节数，绝不记事件内容。
//
// 读者兼容（本模块同时导出读取助手，供 shared/segments.mjs、shared/index.mjs、
// summarize.mjs 复用；compression.mjs 只依赖 node 内建，不 import 内部模块，避免环）：
//   · resolveSegmentDataFile(dir, base)  优先原文，其次 .gz → {file, compressed}|null
//   · readSegmentDataText(dir, base)     透明读取（gz 自动解压）→ string|null
//   · stampSegmentDataFile(dir, base)    (mtime,size) stamp（.gz 用 .gz 的）
//
// 用法：compressOldSegments(home, { afterDays=7, now=Date.now(), dryRun=false, log })
//   返回 { dryRun, cutoffIso, compressedSegments:[{segment,files,bytesBefore,bytesAfter}],
//          skippedOpen, skippedTooNew, skippedAlreadyCompressed, skippedUnparsable,
//          errors:[{segment,file,code,message}], bytesSaved }

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gunzipSync, gzipSync } from 'node:zlib';

/** 可压缩的段内文件（metadata.json 永不压缩：它是段状态判定的依据）。 */
export const COMPRESSIBLE_FILES = ['events.jsonl', 'suppressed.jsonl'];
/** 压缩文件后缀与临时文件后缀。 */
export const GZ_SUFFIX = '.gz';
export const TMP_SUFFIX = '.gz.tmp';
/** 默认只压 7 天前的已关闭段（E 的 maintenance 会传参覆盖）。 */
export const DEFAULT_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function isRegularFile(file) {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

function safeUnlink(file) {
  try { unlinkSync(file); return true; } catch { return false; }
}

// ---------- 读者助手（透明读取；被 segments/index/summarize 复用） ----------

/**
 * 段内逻辑数据文件的实际读取路径：优先原文（真相），其次 `.gz`。
 * @param {string} dir 段目录
 * @param {string} base 逻辑文件名（如 "events.jsonl"）
 * @returns {{file:string, compressed:boolean}|null}
 */
export function resolveSegmentDataFile(dir, base) {
  const plain = path.join(dir, base);
  if (isRegularFile(plain)) return { file: plain, compressed: false };
  const gz = `${plain}${GZ_SUFFIX}`;
  if (isRegularFile(gz)) return { file: gz, compressed: true };
  return null;
}

/**
 * 透明读取段内文本文件（`.gz` 自动解压）。不存在/解压失败返回 null。
 * @param {string} dir
 * @param {string} base
 * @returns {string|null}
 */
export function readSegmentDataText(dir, base) {
  const resolved = resolveSegmentDataFile(dir, base);
  if (!resolved) return null;
  try {
    const buf = readFileSync(resolved.file);
    return (resolved.compressed ? gunzipSync(buf) : buf).toString('utf8');
  } catch { return null; }
}

/**
 * 段内文件的 (mtime,size) 指纹字符串；原文件不存在时用 `.gz` 的。
 * 返回 `<base>[:.gz]:<mtimeMicro>:<size>`；不存在 → `<base>:-`。
 * 注意：未压缩时输出与旧实现完全一致，避免无谓的指纹漂移。
 * @param {string} dir
 * @param {string} base
 * @returns {string}
 */
export function stampSegmentDataFile(dir, base) {
  const resolved = resolveSegmentDataFile(dir, base);
  if (!resolved) return `${base}:-`;
  try {
    const st = statSync(resolved.file);
    const name = resolved.compressed ? `${base}${GZ_SUFFIX}` : base;
    return `${name}:${Math.round(st.mtimeMs * 1000)}:${st.size}`;
  } catch { return `${base}:-`; }
}

/** 段是否已被压缩（events 或 suppressed 只剩 .gz）。 */
export function isSegmentCompressed(dir) {
  for (const base of COMPRESSIBLE_FILES) {
    const resolved = resolveSegmentDataFile(dir, base);
    if (resolved && resolved.compressed) return true;
  }
  return false;
}

// ---------- 段状态判定 ----------

/** 段名（Swift 的 HH-mm-ss 变体）→ 毫秒；失败 null（自实现，避免 import 循环）。 */
function segmentNameMs(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(String(name ?? ''));
  if (!m) {
    const t = Date.parse(String(name ?? ''));
    return Number.isNaN(t) ? null : t;
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
}

/** 读段 metadata（只读 metadata.json；坏 → null）。 */
function readSegmentMeta(dir) {
  const text = readSegmentDataText(dir, 'metadata.json');
  if (text === null) return null;
  try {
    const meta = JSON.parse(text);
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  } catch { return null; }
}

// ---------- 单文件压缩（幂等 + 校验） ----------

/**
 * 压缩段内单个数据文件（events.jsonl / suppressed.jsonl）。
 * @returns {{status:string, bytesBefore:number, bytesAfter:number, code?:string, message?:string}}
 *   status: absent | already-compressed | would-compress | would-dedupe | compressed | deduped | error
 */
function compressOneFile(dir, base, { dryRun }) {
  const plain = path.join(dir, base);
  const gz = `${plain}${GZ_SUFFIX}`;
  const tmp = `${plain}${TMP_SUFFIX}`;

  const plainExists = existsSync(plain);
  const gzExists = existsSync(gz);

  // 不存在 → 无事可做（注意：dryRun 也不清理任何东西）
  if (!plainExists && !gzExists) return { status: 'absent', bytesBefore: 0, bytesAfter: 0 };

  // 崩溃残留的 .gz.tmp 永远不是真相：非 dryRun 时先清掉再继续
  if (!dryRun && existsSync(tmp)) safeUnlink(tmp);

  // 只有 .gz：已压缩，幂等跳过（不重复解压校验，避免每次维护都全量解压）
  if (!plainExists && gzExists) return { status: 'already-compressed', bytesBefore: 0, bytesAfter: 0 };

  // 原文存在：必须是常规文件（拒绝符号链接/目录，避免越界写）
  if (!isRegularFile(plain)) {
    return { status: 'error', bytesBefore: 0, bytesAfter: 0, code: 'NOT_REGULAR_FILE', message: `${base} 不是常规文件（拒绝压缩）` };
  }
  let plainStat;
  let original;
  try {
    plainStat = statSync(plain);
    original = readFileSync(plain);
  } catch (err) {
    return { status: 'error', bytesBefore: 0, bytesAfter: 0, code: 'READ_FAILED', message: `读取 ${base} 失败: ${err.message}` };
  }
  const bytesBefore = original.length;

  // 两文件并存：幂等修复 —— 校验一致才删原件；不一致保留原件、删 .gz
  if (gzExists) {
    if (!isRegularFile(gz)) {
      return { status: 'error', bytesBefore, bytesAfter: 0, code: 'GZ_NOT_REGULAR_FILE', message: `${base}.gz 不是常规文件` };
    }
    let same = false;
    try {
      const restored = gunzipSync(readFileSync(gz));
      same = restored.length === bytesBefore && sha256(restored) === sha256(original) && restored.equals(original);
    } catch { same = false; }
    if (same) {
      if (dryRun) return { status: 'would-dedupe', bytesBefore, bytesAfter: 0 };
      const removed = safeUnlink(plain);
      return removed
        ? { status: 'deduped', bytesBefore, bytesAfter: 0 }
        : { status: 'error', bytesBefore, bytesAfter: 0, code: 'UNLINK_FAILED', message: `删除 ${base} 失败（保留 .gz）` };
    }
    // 内容不一致（或 .gz 损坏）：绝不删原件；删掉不可信的 .gz
    if (dryRun) return { status: 'error', bytesBefore, bytesAfter: 0, code: 'DUPLICATE_MISMATCH', message: `${base}.gz 与原文件不一致（dryRun 未改动）` };
    const gzRemoved = safeUnlink(gz);
    return {
      status: 'error', bytesBefore, bytesAfter: 0, code: 'DUPLICATE_MISMATCH',
      message: `${base}.gz 与原文件不一致，已保留原文件${gzRemoved ? '并删除 .gz' : '（.gz 清理失败）'}`,
    };
  }

  // 只有原文 → 真压缩
  let gzBuf;
  try { gzBuf = gzipSync(original); } catch (err) {
    return { status: 'error', bytesBefore, bytesAfter: 0, code: 'GZIP_FAILED', message: `gzip ${base} 失败: ${err.message}` };
  }
  const bytesAfter = gzBuf.length;
  if (bytesAfter >= bytesBefore) {
    // 压缩后不更小（空文件 / 已压缩内容）：不写、不删，避免无收益的写放大
    return { status: 'incompressible', bytesBefore, bytesAfter };
  }
  if (dryRun) return { status: 'would-compress', bytesBefore, bytesAfter };

  // ① 写 tmp（保留原文件权限位）
  const mode = plainStat.mode & 0o777;
  try {
    writeFileSync(tmp, gzBuf, { mode });
  } catch (err) {
    safeUnlink(tmp);
    return { status: 'error', bytesBefore, bytesAfter, code: 'WRITE_TMP_FAILED', message: `写 ${base}${TMP_SUFFIX} 失败: ${err.message}` };
  }

  // ② 回读校验：解压 tmp 与原文件比 sha256（并做逐字节比较）
  let verified = false;
  try {
    const restored = gunzipSync(readFileSync(tmp));
    verified = restored.length === bytesBefore && sha256(restored) === sha256(original) && restored.equals(original);
  } catch { verified = false; }
  if (!verified) {
    safeUnlink(tmp); // 清理临时文件，保留原文件
    return { status: 'error', bytesBefore, bytesAfter, code: 'VERIFY_FAILED', message: `${base} 压缩后回读校验失败（已保留原文件）` };
  }

  // ③ 校验通过才 rename 成 .gz
  try {
    renameSync(tmp, gz);
  } catch (err) {
    safeUnlink(tmp);
    return { status: 'error', bytesBefore, bytesAfter, code: 'RENAME_FAILED', message: `重命名 ${base}.gz 失败: ${err.message}` };
  }

  // ④ 最后删原文件；删不掉也安全（下次幂等路径会校验后重试）
  const removed = safeUnlink(plain);
  if (!removed) {
    return { status: 'error', bytesBefore, bytesAfter, code: 'UNLINK_FAILED', message: `${base} 已压缩但删除原文件失败（下次运行会校验并重试）` };
  }
  return { status: 'compressed', bytesBefore, bytesAfter };
}

// ---------- 对外主函数 ----------

/**
 * 压缩「已关闭且足够旧」的段。
 * @param {string} home 数据根目录（<home>/segments/<name>/…）
 * @param {{afterDays?:number, now?:number|Date, dryRun?:boolean, log?:(msg:string)=>void}} [opts]
 * @returns {{dryRun:boolean, cutoffIso:string, compressedSegments:Array, skippedOpen:number,
 *   skippedTooNew:number, skippedAlreadyCompressed:number, skippedUnparsable:number,
 *   errors:Array, bytesSaved:number}}
 */
export function compressOldSegments(home, { afterDays = DEFAULT_AFTER_DAYS, now = Date.now(), dryRun = false, log } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoffMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - Math.max(0, Number(afterDays) || 0) * DAY_MS;
  const result = {
    dryRun: Boolean(dryRun),
    cutoffIso: new Date(cutoffMs).toISOString(),
    compressedSegments: [],
    skippedOpen: 0,
    skippedTooNew: 0,
    skippedAlreadyCompressed: 0,
    skippedUnparsable: 0,
    errors: [],
    bytesSaved: 0,
  };
  const emit = (msg) => { if (typeof log === 'function') { try { log(msg); } catch { /* 日志失败不影响压缩 */ } } };
  const pushError = (segment, file, code, message) => {
    result.errors.push({ segment, file, code, message });
    emit(`压缩失败 ${segment ?? '(segment)'}${file ? ` ${file}` : ''}: ${code}`);
  };

  const root = path.join(home, 'segments');
  let names;
  try { names = readdirSync(root); } catch { return result; }
  names.sort(); // 稳定的处理顺序（段名=时间戳）

  for (const name of names) {
    const dir = path.join(root, name);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue; // 忽略散落文件（不计数：不是段）

    const meta = readSegmentMeta(dir);
    if (!meta) {
      // 没 metadata / 坏 metadata → 无法判定是否已关闭，保守跳过（绝不盲压）
      result.skippedUnparsable += 1;
      emit(`跳过（metadata 缺失/损坏）${name}`);
      continue;
    }
    if (!meta.segmentEnd) {
      // open 段（或 metadata 无 segmentEnd）→ 永不压缩
      result.skippedOpen += 1;
      continue;
    }
    const startMsRaw = Date.parse(String(meta.segmentStart ?? ''));
    const startMs = Number.isNaN(startMsRaw) ? segmentNameMs(name) : startMsRaw;
    if (startMs === null) {
      result.skippedUnparsable += 1;
      emit(`跳过（segmentStart 无法解析）${name}`);
      continue;
    }
    if (startMs >= cutoffMs) {
      result.skippedTooNew += 1;
      continue;
    }

    // 单段：逐个可压缩文件处理
    const entry = { segment: name, files: [], bytesBefore: 0, bytesAfter: 0 };
    let sawCompressedOnly = true; // 该段所有存在的可压缩文件都已是 .gz-only
    let sawAnyDataFile = false;
    let touched = false;
    for (const base of COMPRESSIBLE_FILES) {
      const r = compressOneFile(dir, base, { dryRun: Boolean(dryRun) });
      switch (r.status) {
        case 'absent':
          break;
        case 'already-compressed':
          sawAnyDataFile = true;
          break;
        case 'incompressible':
          sawAnyDataFile = true;
          sawCompressedOnly = false;
          break;
        case 'would-compress':
        case 'would-dedupe':
        case 'compressed':
        case 'deduped': {
          sawAnyDataFile = true;
          sawCompressedOnly = false;
          touched = true;
          entry.files.push(base);
          entry.bytesBefore += r.bytesBefore;
          entry.bytesAfter += r.status === 'deduped' || r.status === 'would-dedupe' ? 0 : r.bytesAfter;
          if (r.status === 'compressed' || r.status === 'deduped') {
            result.bytesSaved += r.status === 'deduped' ? r.bytesBefore : Math.max(0, r.bytesBefore - r.bytesAfter);
            emit(`${r.status === 'compressed' ? '已压缩' : '去重（校验一致）'} ${name} ${base} ${r.bytesBefore}→${r.bytesAfter} 字节`);
          } else {
            emit(`${r.status === 'would-compress' ? '待压缩' : '待去重'} ${name} ${base} ${r.bytesBefore}→${r.bytesAfter} 字节（dryRun）`);
          }
          break;
        }
        case 'error':
        default: {
          sawAnyDataFile = true;
          sawCompressedOnly = false;
          pushError(name, base, r.code ?? 'UNKNOWN', r.message ?? '未知错误');
          break;
        }
      }
    }
    if (touched) result.compressedSegments.push(entry);
    else if (sawCompressedOnly && sawAnyDataFile) {
      // 该段可压缩文件都已是 .gz-only → 幂等跳过（空段不计入，避免污染统计）
      result.skippedAlreadyCompressed += 1;
    }
  }

  if (!result.errors.length && !result.compressedSegments.length) emit('没有需要压缩的段');
  return result;
}
