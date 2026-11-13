#!/usr/bin/env node
// scripts/bench.mjs — Chronicle 检索层基准（10 万事件 / 400 段级）
//
// 用法：
//   node scripts/bench.mjs [--events 100000] [--segments 400] [--days 14]
//                          [--seed 1337] [--keep] [--json] [--home DIR]
//
// 做什么：
//   ① 在临时 home（os.tmpdir/mkdtemp）生成与真实格式一致的 closed 段：
//      segments/<UTC 段名>/{events.jsonl, metadata.json, suppressed.jsonl}，
//      事件 type/data 形状与 Swift 采集端一致（app-switch/window-change/url-change/focus-change），
//      时间戳铺满最近 --days 天；另写少量 summaries/10min-*.md（不测摘要，只为数据真实）。
//      生成按「段」流式写盘（每次只持有一段的事件行），10 万级也不会把全部事件放内存。
//   ② 复用仓库现成 API 测量（不复制实现）：
//      - ensureIndex(home)                      首次建索引
//      - searchEventsPaged(home, {query,...})   20 个混合查询（命中/不命中/大小写/from-to）
//      - listSegmentsPaged(home, {limit,before}) 翻 10 页
//      - ensureIndex(home)                      二次增量索引
//      - process.memoryUsage().rss              进程 RSS 增量
//      - 若 shared/compression.mjs 已存在（批次 3 可选模块）：动态 import → 压缩全部段 →
//        删索引重建 → 5 个查询验证 gz 读取路径；不存在/接口不符则打印 skip（不影响退出码）
//   ③ 输出人可读表格，最后一行输出 JSON；--json 只输出 JSON 一行；--keep 保留临时 home。
//
// 退出码：0（基准不设阈值；阈值门禁在 test/perf.test.mjs）。异常时 1。
// 注意：本脚本只写临时 home，不碰 ~/.chronicle，不依赖网络。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  clearSegmentCache, closeIndex, ensureIndex, listSegmentsPaged, resetIndex,
  searchEventsPaged, sqliteAvailable,
} from '../shared/segments.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_EVENTS = 100_000;
export const DEFAULT_SEGMENTS = 400;
export const DEFAULT_DAYS = 14;
export const DEFAULT_SEED = 1337;
export const DEFAULT_MARKER = 'ZEBRA-MARKER-7731';
export const SEGMENT_DURATION_MS = 10 * 60 * 1000;

// ---------- 数据生成（确定性、可复用给 test/perf.test.mjs） ----------

const APP_POOL = [
  { bundleId: 'com.apple.Terminal', appName: 'Terminal' },
  { bundleId: 'com.apple.Safari', appName: 'Safari' },
  { bundleId: 'com.google.chrome', appName: 'Chrome' },
  { bundleId: 'com.microsoft.VSCode', appName: 'Code' },
  { bundleId: 'com.apple.finder', appName: 'Finder' },
  { bundleId: 'com.tinyspeck.slackmacgap', appName: 'Slack' },
  { bundleId: 'com.apple.Notes', appName: 'Notes' },
];
const TITLE_POOL = [
  'daemon.mjs — chronicle', 'GitHub — Pull requests', 'Inbox (12)', 'Untitled — Notes',
  'bash — 120×40', 'Search results for chronicle', 'package.json — chronicle', 'Settings',
];
const URL_POOL = [
  'https://github.com/weixili/chronicle', 'https://docs.example.com/chronicle/api',
  'https://mail.example.com/inbox', 'https://news.ycombinator.com/item', 'https://bank.example/login',
];
const FOCUS_POOL = [
  { role: 'AXTextArea', title: 'Editor' }, { role: 'AXTextField', title: '' },
  { role: 'AXButton', title: 'Save' }, { role: 'AXWebArea', title: '' },
  { role: 'AXList', title: 'Results' }, { role: 'AXWindow', title: '' },
];

/** mulberry32：确定性伪随机（同一 seed → 同一数据集，便于复现基准）。 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 段目录名：与 Swift segmentDirName 完全一致（UTC，yyyy-MM-dd'T'HH-mm-ss.SSS'Z'）。 */
export function segmentDirName(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`;
}

/** 单条事件（字段与 Swift 采集端落盘形状一致；url 已按 privacy.redactURLQuery 脱敏）。 */
function makeEvent(tsMs, type, app, titlePool, urlPool, rng, markerToken) {
  const data = { bundleId: app.bundleId };
  switch (type) {
    case 'app-switch':
      data.appName = app.appName;
      data.pid = 1000 + Math.floor(rng() * 9000);
      break;
    case 'window-change':
      data.windowTitle = titlePool();
      break;
    case 'url-change':
      data.url = urlPool();
      break;
    default: {
      const focus = pick(rng, FOCUS_POOL);
      data.role = focus.role;
      if (focus.title) data.title = focus.title;
      break;
    }
  }
  return { ts: new Date(tsMs).toISOString(), tsMs, type, data };
}

/**
 * 在 home 下生成 closed 段数据集（真实格式，流式按段写盘）。
 *
 * @param {string} home 数据根目录（会自动建 segments/、summaries/）
 * @param {{events?:number, segments?:number, days?:number, seed?:number,
 *          marker?:string, summaryCount?:number, suppressedEvery?:number}} [opts]
 * @returns {{home:string, eventsRequested:number, eventsGenerated:number, segmentCount:number,
 *            days:number, seed:number, startMs:number, endMs:number,
 *            marker:{token:string, tsMs:number, segment:string},
 *            segMetas:Array<{segment:string,startMs:number,endMs:number,eventCount:number,suppressedEventCount:number}>,
 *            summaryFiles:string[]}}
 */
export function generateDataset(home, opts = {}) {
  const eventsRequested = Math.max(1, Math.trunc(opts.events ?? DEFAULT_EVENTS));
  const days = Math.max(1, Math.trunc(opts.days ?? DEFAULT_DAYS));
  let segments = Math.max(1, Math.trunc(opts.segments ?? DEFAULT_SEGMENTS));
  if (segments > eventsRequested) segments = eventsRequested; // 每段至少 1 条事件
  const seed = opts.seed ?? DEFAULT_SEED;
  const markerToken = String(opts.marker ?? DEFAULT_MARKER);
  const summaryCount = Math.max(0, Math.trunc(opts.summaryCount ?? 20));
  const suppressedEvery = Math.max(1, Math.trunc(opts.suppressedEvery ?? 10));
  const rng = makeRng(seed);

  const segRoot = path.join(home, 'segments');
  const sumRoot = path.join(home, 'summaries');
  mkdirSync(segRoot, { recursive: true });
  mkdirSync(sumRoot, { recursive: true });

  // 最近 days 天（截止到 1 分钟前，避免边界与“现在”竞争）；400 段均匀分布。
  const endMs = Date.now() - 60_000;
  const windowMs = days * 24 * 60 * 60 * 1000;
  const startMs = endMs - windowMs;
  const spacingMs = Math.max(SEGMENT_DURATION_MS + 1, Math.floor((windowMs - SEGMENT_DURATION_MS) / segments));

  const basePerSeg = Math.floor(eventsRequested / segments);
  const extra = eventsRequested - basePerSeg * segments;
  const markerSegIdx = Math.floor(segments / 2);

  const segMetas = [];
  const summaryFiles = [];
  let eventsGenerated = 0;
  let marker = null;

  for (let i = 0; i < segments; i += 1) {
    const segStartMs = startMs + Math.round(i * spacingMs);
    const segEndMs = segStartMs + SEGMENT_DURATION_MS;
    const count = basePerSeg + (i >= segments - extra ? 1 : 0);
    const segment = segmentDirName(segStartMs);
    const dir = path.join(segRoot, segment);
    mkdirSync(dir, { recursive: true });

    // 每个 app 本段固定一次 appName/pid；url 只给浏览器，便于查询分布真实。
    const secApp = APP_POOL[i % APP_POOL.length];
    const urlApp = APP_POOL[1 + (i % 2)]; // Safari / Chrome
    const titlePool = () => pick(rng, TITLE_POOL);
    const urlPool = () => pick(rng, URL_POOL);

    const lines = [];
    for (let j = 0; j < count; j += 1) {
      const tsMs = segStartMs + Math.floor((j * (SEGMENT_DURATION_MS - 1)) / Math.max(1, count));
      let event;
      if (i === markerSegIdx && j === 1) {
        // 已知 token：供 test/perf.test.mjs 断言“可精确搜到”
        marker = { token: markerToken, tsMs, segment };
        event = {
          ts: new Date(tsMs).toISOString(),
          tsMs,
          type: 'window-change',
          data: { bundleId: secApp.bundleId, windowTitle: `${markerToken} — 压测标记页` },
        };
      } else if (j % 4 === 0) {
        event = makeEvent(tsMs, 'app-switch', secApp, titlePool, urlPool, rng, markerToken);
      } else if (j % 4 === 1) {
        event = makeEvent(tsMs, 'window-change', secApp, titlePool, urlPool, rng, markerToken);
      } else if (j % 4 === 2) {
        event = makeEvent(tsMs, 'url-change', urlApp, titlePool, urlPool, rng, markerToken);
      } else {
        event = makeEvent(tsMs, 'focus-change', secApp, titlePool, urlPool, rng, markerToken);
      }
      lines.push(JSON.stringify(event));
    }
    // 流式落盘：一次只持有一段事件（10min 段 ≈ 250 行 / ~45KB），不把全量事件留在内存。
    writeFileSync(path.join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);

    let suppressedEventCount = 0;
    if (i % suppressedEvery === 0) {
      const sup = [
        { ts: new Date(segStartMs + 1000).toISOString(), type: 'sample', scope: 'app', reason: 'app-blocklist' },
        { ts: new Date(segStartMs + 2000).toISOString(), type: 'url-change', scope: 'url', reason: 'incognito' },
      ];
      writeFileSync(path.join(dir, 'suppressed.jsonl'), `${sup.map((r) => JSON.stringify(r)).join('\n')}\n`);
      suppressedEventCount = sup.length;
    }
    // metadata：与 Swift 关闭段同形（含 ownerPid；closed 段无 segmentEnd 缺失）。
    writeFileSync(path.join(dir, 'metadata.json'), `${JSON.stringify({
      segmentStart: new Date(segStartMs).toISOString(),
      segmentEnd: new Date(segEndMs).toISOString(),
      eventCount: count,
      suppressedEventCount,
      ownerPid: 4242,
    }, null, 2)}\n`);

    segMetas.push({ segment, startMs: segStartMs, endMs: segEndMs, eventCount: count, suppressedEventCount });
    eventsGenerated += count;
  }

  // 少量 10min 摘要文件（摘要层不在本基准测量范围，只为数据集真实）。
  if (summaryCount > 0) {
    const step = Math.max(1, Math.floor(segments / summaryCount));
    for (let i = 0, n = 0; i < segments && n < summaryCount; i += step, n += 1) {
      const seg = segMetas[i];
      const name = `10min-${seg.segment}.md`;
      const body = `---\ntitle: "${new Date(seg.startMs).toISOString().slice(11, 16)} 基准段"\n`
        + `applications: ["${APP_POOL[i % APP_POOL.length].bundleId}"]\n`
        + `segment: "${seg.segment}"\ntype: "10min"\n---\n\n## 活动摘要\n- 基准数据（非真实摘要）：${seg.eventCount} 条事件\n`;
      writeFileSync(path.join(sumRoot, name), body);
      summaryFiles.push(name);
    }
  }

  clearSegmentCache(); // 生成了新目录/文件，清掉读取层缓存
  return {
    home, eventsRequested, eventsGenerated, segmentCount: segments, days, seed,
    startMs, endMs, marker, segMetas, summaryFiles,
  };
}

// ---------- 查询集与测量 ----------

/** 数值分位（P50/P95 等；用 ceil 取序位，样本少时 P95 会等于最大值，属预期）。 */
export function percentile(values, p) {
  const arr = [...values].sort((a, b) => a - b);
  if (!arr.length) return 0;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(p * arr.length) - 1));
  return arr[idx];
}

const round2 = (n) => Math.round(n * 100) / 100;

/** 20 个混合查询：命中/不命中/大小写/字段/from-to 范围。 */
export function makeQueries(dataset) {
  const day = 24 * 60 * 60 * 1000;
  const { startMs, endMs, marker } = dataset;
  return [
    { name: 'app:Terminal', query: 'Terminal' },
    { name: 'app:terminal(小写)', query: 'terminal' },
    { name: 'app:TERMINAL(大写)', query: 'TERMINAL' },
    { name: 'bundle:Safari', query: 'com.apple.Safari' },
    { name: 'bundle:Chrome', query: 'com.google.chrome' },
    { name: 'url:github', query: 'github' },
    { name: 'url:docs.example', query: 'docs.example.com' },
    { name: 'url:mail.example', query: 'mail.example.com' },
    { name: 'role:AXTextArea', query: 'AXTextArea' },
    { name: 'role:AXButton', query: 'AXButton' },
    { name: 'title:Inbox', query: 'Inbox' },
    { name: 'title:Notes', query: 'Notes' },
    { name: 'type:window-change', query: 'window-change' },
    { name: 'type:url-change', query: 'url-change' },
    { name: 'marker:稀有 token', query: marker.token },
    { name: 'miss:zzz', query: 'zzzz-no-such-token' },
    { name: 'miss:nonexistent', query: 'nonexistent-xyz-000' },
    { name: 'range:Terminal 最近3天', query: 'Terminal', from: endMs - 3 * day, to: endMs },
    { name: 'range:github 前7天', query: 'github', from: startMs, to: startMs + 7 * day },
    { name: 'range:空查询 最近1天', query: '', from: endMs - day, to: endMs },
  ];
}

/**
 * 测量 searchEventsPaged（含 ensureIndex 增量扫描的真实调用开销）。
 * @returns {{count:number, limit:number, samplesMs:number[], p50Ms:number, p95Ms:number, maxMs:number,
 *            results:Array<{name:string,ms:number,total:number,returned:number,indexed:boolean}>}}
 */
export function measureSearch(home, queries, { limit = 50, warmup = true } = {}) {
  if (warmup && queries.length) {
    const first = queries[0];
    searchEventsPaged(home, { query: first.query, limit, offset: 0, from: first.from, to: first.to });
  }
  const samples = [];
  const results = [];
  for (const spec of queries) {
    const t0 = performance.now();
    const r = searchEventsPaged(home, { query: spec.query, limit, offset: 0, from: spec.from, to: spec.to });
    const ms = performance.now() - t0;
    samples.push(ms);
    results.push({ name: spec.name, ms: round2(ms), total: r.total, returned: r.items.length, indexed: r.indexed });
  }
  return {
    count: samples.length,
    limit,
    samplesMs: samples.map(round2),
    p50Ms: round2(percentile(samples, 0.5)),
    p95Ms: round2(percentile(samples, 0.95)),
    maxMs: round2(Math.max(...samples)),
    results,
  };
}

/** 测量 listSegmentsPaged 翻页（默认 10 页 × 20 段/页）。 */
export function measurePagination(home, { limit = 20, pages = 10 } = {}) {
  const samples = [];
  const pageInfos = [];
  let before = null;
  for (let i = 0; i < pages; i += 1) {
    const t0 = performance.now();
    const page = listSegmentsPaged(home, { limit, before });
    const ms = performance.now() - t0;
    samples.push(ms);
    pageInfos.push({ page: i + 1, items: page.items.length, hasMore: page.hasMore, ms: round2(ms) });
    if (!page.hasMore) break;
    before = page.nextBefore;
  }
  return {
    pages: samples.length,
    limit,
    samplesMs: samples.map(round2),
    p50Ms: round2(percentile(samples, 0.5)),
    p95Ms: round2(percentile(samples, 0.95)),
    maxMs: round2(Math.max(...samples)),
    pageInfos,
  };
}

// ---------- 可选：压缩模块（shared/compression.mjs） ----------

function summarizeResult(result) {
  if (result === undefined) return null;
  if (result === null || typeof result !== 'object') return String(result);
  try {
    const keys = Object.keys(result).slice(0, 20);
    const out = {};
    for (const k of keys) {
      const v = result[k];
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
      else if (Array.isArray(v)) out[k] = `[array:${v.length}]`;
      else if (v && typeof v === 'object') out[k] = '{object}';
    }
    return out;
  } catch { return null; }
}

/**
 * 若 shared/compression.mjs 存在且导出 compress* 函数：压缩全部段 → 删索引重建 →
 * 测 5 个查询 + marker 命中，验证 gz 读取路径。接口不确定时按候选签名逐个尝试，
 * 全部失败/异常都只返回 skipped（不影响 benchmark 退出码）。
 */
async function maybeRunCompression(home, dataset, queries, baselineSearch) {
  const modPath = path.join(REPO_ROOT, 'shared', 'compression.mjs');
  if (!existsSync(modPath)) return { skipped: true, reason: 'shared/compression.mjs 不存在（本批未启用压缩模块）' };
  let mod;
  try {
    mod = await import(pathToFileURL(modPath).href);
  } catch (err) {
    return { skipped: true, reason: `import 失败: ${String(err.message).slice(0, 200)}` };
  }
  const fns = Object.entries(mod).filter(([name, fn]) => typeof fn === 'function' && /compress/i.test(name));
  if (!fns.length) return { skipped: true, reason: 'compression.mjs 未导出 compress* 函数' };

  const attempts = [];
  let used = null;
  for (const [name, fn] of fns) {
    for (const [label, args] of [
      ['home', [home]],
      ['home,segments', [home, dataset.segMetas]],
      ['home,{segments}', [home, { segments: dataset.segMetas }]],
    ]) {
      try {
        const t0 = performance.now();
        const result = await fn(...args);
        attempts.push({ fn: name, args: label, ok: true, ms: round2(performance.now() - t0) });
        used = { name, result };
        break;
      } catch (err) {
        attempts.push({ fn: name, args: label, ok: false, error: String(err.message).slice(0, 160) });
      }
    }
    if (used) break;
  }
  if (!used) return { skipped: true, reason: 'compress* 调用全部失败（接口不符？）', attempts };

  const rawResult = used.result;
  const numeric = (matcher) => {
    if (!rawResult || typeof rawResult !== 'object') return null;
    for (const [k, v] of Object.entries(rawResult)) {
      if (!matcher.test(k)) continue;
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return v.length;
    }
    return null;
  };
  const skippedSegments = rawResult && typeof rawResult === 'object'
    ? Object.entries(rawResult)
      .filter(([k, v]) => /^skipped/i.test(k) && typeof v === 'number')
      .reduce((acc, [, v]) => acc + v, 0)
    : null;
  const out = {
    skipped: false,
    compressFn: used.name,
    compressMs: attempts.find((a) => a.ok)?.ms ?? null,
    compressedSegments: numeric(/compressed/i),
    skippedSegments,
    bytesSaved: numeric(/bytest?Saved|savedBytes/i),
    compressResult: summarizeResult(rawResult),
    attempts,
  };
  try {
    // 强制重建：关索引句柄 + 删 index 目录（压缩后源文件已变，需要走 gz 读取路径重建）
    resetIndex(home);
    try { rmSync(path.join(home, 'index'), { recursive: true, force: true }); } catch { /* 无索引目录 */ }
    const t0 = performance.now();
    const stats = ensureIndex(home);
    out.rebuildMs = round2(performance.now() - t0);
    out.rebuildStats = stats ? { segments: stats.segments, events: stats.events, rebuilt: stats.rebuilt } : null;
    const five = measureSearch(home, queries.slice(0, 5), { warmup: false });
    out.queries5 = { p50Ms: five.p50Ms, p95Ms: five.p95Ms, maxMs: five.maxMs, results: five.results };
    const markerHits = searchEventsPaged(home, { query: dataset.marker.token, limit: 5 });
    out.markerHits = markerHits.total;
    out.gzReadPath = markerHits.total > 0 ? 'ok' : 'marker-not-found(gz 读取路径未生效?)';
    // 压缩只应改变存储形态，不应改变检索结果：5 个查询 total 应与压缩前一致
    if (baselineSearch && Array.isArray(baselineSearch.results)) {
      out.totalsMatch = five.results.every((r, i) => r.total === baselineSearch.results[i]?.total);
    }
  } catch (err) {
    out.error = String(err.message).slice(0, 300);
  }
  return out;
}

// ---------- 基准主流程 ----------

/**
 * 生成数据集并测量（不打印；CLI 与测试可复用）。
 * @param {{events?:number, segments?:number, days?:number, seed?:number, keep?:boolean, home?:string}} [opts]
 * @returns {Promise<object>} report（见 CLI 输出；ok=true 表示完整跑完）
 */
export async function runBench(opts = {}) {
  const events = Math.max(1, Math.trunc(opts.events ?? DEFAULT_EVENTS));
  const segments = Math.max(1, Math.trunc(opts.segments ?? DEFAULT_SEGMENTS));
  const days = Math.max(1, Math.trunc(opts.days ?? DEFAULT_DAYS));
  const seed = opts.seed ?? DEFAULT_SEED;
  const keep = opts.keep === true;
  const home = opts.home ?? mkdtempSync(path.join(os.tmpdir(), 'chronicle-bench-'));
  const report = {
    ok: false,
    home,
    keep,
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sqlite: sqliteAvailable(),
    },
    config: { events, segments, days, seed },
    data: null,
    index: null,
    timings: null,
    search: null,
    pagination: null,
    compression: null,
  };
  try {
    const tGen0 = performance.now();
    const dataset = generateDataset(home, { events, segments, days, seed });
    report.timings = { generateMs: round2(performance.now() - tGen0) };
    report.data = {
      events: dataset.eventsGenerated,
      segments: dataset.segmentCount,
      days: dataset.days,
      summaries: dataset.summaryFiles.length,
      markerToken: dataset.marker?.token ?? null,
      markerSegment: dataset.marker?.segment ?? null,
      range: { startMs: dataset.startMs, endMs: dataset.endMs },
    };

    clearSegmentCache();
    const rss0 = process.memoryUsage().rss;

    const tIdx0 = performance.now();
    const indexStats = ensureIndex(home);
    report.timings.ensureIndexMs = round2(performance.now() - tIdx0);
    report.index = indexStats
      ? { available: true, stats: { segments: indexStats.segments, events: indexStats.events, rebuilt: indexStats.rebuilt, removed: indexStats.removed, reused: indexStats.reused } }
      : { available: false, reason: 'node:sqlite 不可用，索引回退线性扫描' };

    const queries = makeQueries(dataset);
    report.search = measureSearch(home, queries);
    report.pagination = measurePagination(home, { limit: 20, pages: 10 });

    const tInc0 = performance.now();
    const incStats = ensureIndex(home);
    report.timings.incrementalMs = round2(performance.now() - tInc0);
    report.index.incremental = incStats
      ? { rebuilt: incStats.rebuilt, removed: incStats.removed, reused: incStats.reused, events: incStats.events }
      : null;

    report.compression = await maybeRunCompression(home, dataset, queries, report.search);

    const rss1 = process.memoryUsage().rss;
    report.timings.rssBeforeBytes = rss0;
    report.timings.rssAfterBytes = rss1;
    report.timings.rssDeltaBytes = rss1 - rss0;
    report.ok = true;
  } finally {
    if (!keep) {
      try { resetIndex(home); } catch { /* 无索引 */ }
      try { closeIndex(); } catch { /* 已关闭 */ }
      try { clearSegmentCache(); } catch { /* 无缓存 */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
  }
  return report;
}

// ---------- 输出 ----------

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** 人可读表格（不打印 JSON）。 */
export function formatHuman(report) {
  const lines = [];
  lines.push('Chronicle 检索层基准（临时 home：' + (report.keep ? report.home : '已清理，--keep 可保留') + '）');
  lines.push(`环境：node ${report.env.node} / ${report.env.platform} ${report.env.arch} / node:sqlite ${report.env.sqlite ? '✓' : '✗（线性回退）'}`);
  if (report.data) {
    lines.push(`数据：${report.data.events} 事件 / ${report.data.segments} 段 / ${report.data.days} 天 / ${report.data.summaries} 份摘要（生成 ${report.timings.generateMs} ms）`);
  }
  lines.push('');
  lines.push('指标                                      结果');
  lines.push('----------------------------------------  ----------------------------------------');
  if (report.index) {
    if (report.index.available) {
      const s = report.index.stats;
      lines.push(`① ensureIndex 首次构建                    ${report.timings.ensureIndexMs} ms（events=${s.events}, segments=${s.segments}, rebuilt=${s.rebuilt}）`);
    } else {
      lines.push(`① ensureIndex                             skip：${report.index.reason}`);
    }
  }
  if (report.search) {
    const r = report.search;
    lines.push(`② 搜索 ${r.count} 查询 P50 / P95 / 最慢        ${r.p50Ms} / ${r.p95Ms} / ${r.maxMs} ms（limit=${r.limit}, indexed=${r.results.some((x) => x.indexed)}）`);
    const slow = [...r.results].sort((a, b) => b.ms - a.ms).slice(0, 3);
    lines.push(`   最慢查询：${slow.map((x) => `${x.name}=${x.ms}ms(total ${x.total})`).join('；')}`);
  }
  if (report.pagination) {
    const p = report.pagination;
    lines.push(`③ 分页 ${p.pages} 页 P50 / P95                  ${p.p50Ms} / ${p.p95Ms} ms（limit=${p.limit}/页）`);
  }
  if (report.index?.available) {
    const inc = report.index.incremental;
    lines.push(`④ ensureIndex 二次增量                    ${report.timings.incrementalMs} ms（rebuilt=${inc?.rebuilt ?? '?'}, reused=${inc?.reused ?? '?'}）`);
  }
  lines.push(`⑤ 进程 RSS 增量                          +${mb(report.timings.rssDeltaBytes)}（${report.timings.rssBeforeBytes} → ${report.timings.rssAfterBytes}）`);
  if (report.compression) {
    const c = report.compression;
    if (c.skipped) lines.push(`⑥ 压缩后重建索引                         skip：${c.reason}`);
    else {
      const detail = [
        `compress=${c.compressMs}ms(${c.compressFn})`,
        c.compressedSegments !== null && c.compressedSegments !== undefined ? `压缩段=${c.compressedSegments}` : null,
        c.bytesSaved !== null && c.bytesSaved !== undefined ? `省=${mb(c.bytesSaved)}` : null,
        `rebuild=${c.rebuildMs ?? '?'}ms`,
        `5 查询 P95=${c.queries5?.p95Ms ?? '?'}ms`,
        `gz 读取=${c.gzReadPath ?? '?'}`,
        c.totalsMatch === false ? 'totals 不一致!' : null,
      ].filter(Boolean).join(', ');
      lines.push(`⑥ 压缩后重建索引                         ${detail}`);
      if (c.rebuildStats) lines.push(`   重建统计：events=${c.rebuildStats.events}, rebuilt=${c.rebuildStats.rebuilt}`);
    }
  }
  return lines.join('\n');
}

/** 完整 CLI 输出（人读表格 + 末尾一行 JSON；--json 时只输出 JSON 一行）。 */
export function formatOutput(report, { json = false, keep = false } = {}) {
  const payload = JSON.stringify(report);
  if (json) return payload;
  const human = formatHuman(report);
  const tail = keep ? `\n（临时 home 已保留：${report.home}）` : '';
  return `${human}${tail}\n\n${payload}`;
}

export function parseArgs(argv) {
  const out = {
    events: DEFAULT_EVENTS, segments: DEFAULT_SEGMENTS, days: DEFAULT_DAYS,
    seed: DEFAULT_SEED, keep: false, json: false, home: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const next = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`缺少参数值: ${key}`);
      return v;
    };
    const int = (name) => {
      const n = Number.parseInt(next(), 10);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 须为正整数`);
      return n;
    };
    if (key === '--events') out.events = int('--events');
    else if (key === '--segments') out.segments = int('--segments');
    else if (key === '--days') out.days = int('--days');
    else if (key === '--seed') out.seed = int('--seed');
    else if (key === '--home') out.home = path.resolve(next());
    else if (key === '--keep') out.keep = true;
    else if (key === '--json') out.json = true;
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

const HELP = `用法: node scripts/bench.mjs [--events 100000] [--segments 400] [--days 14] [--seed 1337] [--keep] [--json] [--home DIR]

  --events    事件总数（默认 ${DEFAULT_EVENTS}）
  --segments  段数（默认 ${DEFAULT_SEGMENTS}，每段 events/segments 条，铺满最近 --days 天）
  --days      时间跨度天数（默认 ${DEFAULT_DAYS}）
  --seed      伪随机种子（默认 ${DEFAULT_SEED}，同 seed 数据集可复现）
  --keep      保留临时 home（打印路径），否则结束清理
  --json      只输出 JSON（默认：人读表格 + 末尾一行 JSON）
  --home DIR  使用指定目录作为 home（默认 os.tmpdir 下 mkdtemp）
  -h, --help  显示帮助`;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  const report = await runBench(args);
  console.log(formatOutput(report, { json: args.json, keep: args.keep }));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[bench] 失败: ${err.message}`);
      process.exit(1);
    });
}
