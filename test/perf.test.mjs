// test/perf.test.mjs — 30k 事件 / 120 段性能门禁（回归级，避免拖慢全量测试）
//
// 目标：给检索层（shared/index.mjs + shared/segments.mjs）一个 CI 级性能回归门禁：
//   ① 正确性：已知 token 可精确搜到；from/to 范围过滤精确；分页无重无漏
//   ② 性能阈值（宽松防抖动）：
//        ensureIndex 首次 < 15000ms
//        搜索 P95 < 800ms（若有 node:sqlite 索引）；无 sqlite 线性回退时放宽为 < 3000ms
//        分页单页 P95 < 300ms
//        RSS 增量 < 1.5GB
//        二次增量索引 < 3000ms（仅索引路径；无变化时应全部复用）
//   ③ 单文件总耗时 < 90s（本机实测应远低于此）
//
// 数据生成复用 scripts/bench.mjs 的 generateDataset（真实事件格式），测量复用同文件的
// percentile/measureSearch/measurePagination，不在本文件复制实现。
// 不依赖网络；结束清理临时目录。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateDataset, makeQueries, measureSearch, measurePagination,
} from '../scripts/bench.mjs';
import {
  clearSegmentCache, closeIndex, ensureIndex, listSegmentsPaged, resetIndex,
  searchEventsPaged, sqliteAvailable,
} from '../shared/segments.mjs';

const FILE_START = Date.now();
const EVENTS = 30_000;
const SEGMENTS = 120;

const THRESHOLDS = {
  ensureIndexMs: 15_000,
  searchP95IndexedMs: 800,
  searchP95LinearMs: 3_000,
  paginationP95Ms: 300,
  rssDeltaBytes: 1.5 * 1024 * 1024 * 1024,
  incrementalMs: 3_000,
  fileTotalMs: 90_000,
};

describe('30k 事件性能门禁（120 段 / 14 天）', () => {
  let home;
  let dataset;
  let metrics;

  before(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'chronicle-perf-'));
    const tGen0 = performance.now();
    dataset = generateDataset(home, { events: EVENTS, segments: SEGMENTS });
    const generateMs = performance.now() - tGen0;
    clearSegmentCache();

    const rss0 = process.memoryUsage().rss;
    let t0 = performance.now();
    const indexStats = ensureIndex(home);
    const ensureIndexMs = performance.now() - t0;

    const queries = makeQueries(dataset);
    const search = measureSearch(home, queries);
    const pagination = measurePagination(home, { limit: 20, pages: 10 });

    t0 = performance.now();
    const incrementalStats = ensureIndex(home);
    const incrementalMs = performance.now() - t0;

    const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rss0);
    metrics = { generateMs, indexStats, ensureIndexMs, search, pagination, incrementalStats, incrementalMs, rssDeltaBytes };
  });

  after(() => {
    try { resetIndex(home); } catch { /* 无索引 */ }
    try { closeIndex(); } catch { /* 已关闭 */ }
    try { clearSegmentCache(); } catch { /* 无缓存 */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  });

  test('结果正确性 + 性能阈值 + 单文件 <90s', { timeout: THRESHOLDS.fileTotalMs }, () => {
    const indexed = sqliteAvailable();

    // ---------- ① 数据与索引结果正确 ----------
    assert.equal(dataset.eventsGenerated, EVENTS, '生成事件总数应精确等于请求数');
    assert.equal(dataset.segmentCount, SEGMENTS, '生成段数应精确等于请求数');
    assert.ok(dataset.marker && dataset.marker.token, '数据集应带已知 marker token');
    if (indexed) {
      assert.ok(metrics.indexStats, 'node:sqlite 可用时 ensureIndex 不应返回 null');
      assert.equal(metrics.indexStats.events, EVENTS, '索引事件数应等于生成事件数');
      assert.equal(metrics.indexStats.segments, SEGMENTS, '索引段数应等于生成段数');
    }

    // 已知 token 可精确搜到
    const markerHit = searchEventsPaged(home, { query: dataset.marker.token, limit: 5 });
    assert.ok(markerHit.total >= 1, `marker token 应可搜到: ${dataset.marker.token}`);
    assert.ok(JSON.stringify(markerHit.items[0]).includes(dataset.marker.token), 'marker 命中项应包含 token');

    // from/to 范围过滤：单段窗口内的事件数应精确匹配该段 eventCount
    const midSeg = dataset.segMetas[Math.floor(dataset.segMetas.length / 2)];
    const ranged = searchEventsPaged(home, {
      query: '', from: midSeg.startMs, to: midSeg.endMs - 1, limit: 500,
    });
    assert.equal(ranged.total, midSeg.eventCount, 'from/to 范围过滤应精确匹配单段事件数');
    for (const item of ranged.items) {
      const t = Date.parse(item.ts);
      assert.ok(Number.isInteger(t), `事件 ts 应可解析: ${item.ts}`);
      assert.ok(t >= midSeg.startMs && t <= midSeg.endMs - 1, '范围外事件不应返回');
    }

    // 分页无重无漏（头两页，段列表与搜索结果各测一次）
    const page1 = searchEventsPaged(home, { query: 'window-change', limit: 50, offset: 0 });
    const page2 = searchEventsPaged(home, { query: 'window-change', limit: 50, offset: 50 });
    assert.equal(page1.items.length, 50, '搜索第一页应满 50 条');
    assert.equal(page2.items.length, 50, '搜索第二页应满 50 条');
    assert.equal(page1.total, page2.total, '同一查询两次分页 total 应一致');
    const keyOf = (e) => `${e.segment}|${e.ts}|${e.type}|${JSON.stringify(e.data)}`;
    const seen = new Set(page1.items.map(keyOf));
    for (const e of page2.items) assert.ok(!seen.has(keyOf(e)), '搜索分页两页之间不应重复');
    assert.ok(dataset.segMetas.length >= 40, '段数应足以翻两页');
    const segPage1 = listSegmentsPaged(home, { limit: 20 });
    const segPage2 = listSegmentsPaged(home, { limit: 20, before: segPage1.nextBefore });
    assert.equal(segPage1.items.length, 20);
    assert.equal(segPage2.items.length, 20);
    const segNames = new Set(segPage1.items.map((s) => s.segment));
    for (const s of segPage2.items) assert.ok(!segNames.has(s.segment), '段分页两页之间不应重复');
    assert.ok(String(segPage1.items[19].segment).localeCompare(String(segPage2.items[0].segment)) > 0, '第二页应更旧');

    // ---------- ② 性能阈值 ----------
    assert.ok(
      metrics.ensureIndexMs < THRESHOLDS.ensureIndexMs,
      `ensureIndex 首次构建耗时 ${metrics.ensureIndexMs.toFixed(1)}ms 超过阈值 ${THRESHOLDS.ensureIndexMs}ms`,
    );

    const searchP95 = metrics.search.p95Ms;
    if (indexed) {
      assert.ok(
        searchP95 < THRESHOLDS.searchP95IndexedMs,
        `搜索 P95 ${searchP95}ms 超过阈值 ${THRESHOLDS.searchP95IndexedMs}ms（indexed）`,
      );
    } else {
      // 环境无 node:sqlite：线性回退，只能放宽阈值，不 fail 环境
      assert.ok(
        searchP95 < THRESHOLDS.searchP95LinearMs,
        `搜索 P95 ${searchP95}ms 超过线性回退阈值 ${THRESHOLDS.searchP95LinearMs}ms`,
      );
    }
    assert.ok(
      metrics.pagination.p95Ms < THRESHOLDS.paginationP95Ms,
      `分页单页 P95 ${metrics.pagination.p95Ms}ms 超过阈值 ${THRESHOLDS.paginationP95Ms}ms`,
    );
    assert.ok(
      metrics.rssDeltaBytes < THRESHOLDS.rssDeltaBytes,
      `RSS 增量 ${(metrics.rssDeltaBytes / 1024 / 1024).toFixed(1)}MB 超过阈值 1.5GB`,
    );
    if (indexed) {
      assert.ok(
        metrics.incrementalMs < THRESHOLDS.incrementalMs,
        `二次增量索引 ${metrics.incrementalMs.toFixed(1)}ms 超过阈值 ${THRESHOLDS.incrementalMs}ms`,
      );
      assert.equal(metrics.incrementalStats.rebuilt, 0, '无文件变化时增量索引应全部复用（rebuilt=0）');
      assert.equal(metrics.incrementalStats.reused, SEGMENTS, '增量索引应复用全部段');
    }

    // ---------- ③ 单文件 < 90s ----------
    const totalMs = Date.now() - FILE_START;
    assert.ok(totalMs < THRESHOLDS.fileTotalMs, `test/perf.test.mjs 总耗时 ${totalMs}ms 超过 90s`);

    // 便于本地排查：把关键数字打出来（node --test 默认捕获到诊断输出）
    console.log(`[perf] indexed=${indexed} generate=${metrics.generateMs.toFixed(0)}ms `
      + `ensureIndex=${metrics.ensureIndexMs.toFixed(0)}ms searchP95=${searchP95.toFixed(1)}ms `
      + `paginationP95=${metrics.pagination.p95Ms.toFixed(1)}ms `
      + `rssDelta=${(metrics.rssDeltaBytes / 1024 / 1024).toFixed(1)}MB `
      + `incremental=${metrics.incrementalMs.toFixed(1)}ms total=${totalMs}ms`);
  });
});
