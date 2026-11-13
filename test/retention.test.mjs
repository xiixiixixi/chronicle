// test/retention.test.mjs — 任务 E：数据保留策略 + 维护编排
//
// 覆盖：
//   ① normalizeMaintenanceConfig：默认值/非法值回落/超上限钳制/warnings
//   ② pruneOldSegments：默认关闭 no-op；dryRun 零写入；只删已关闭且过期的段；
//      open/metadata 缺失/segmentStart 无法解析的段永不删；10min/6h 摘要联动删除规则
//   ③ runMaintenance：retention→compression(动态, F 未就绪则跳过)→index 编排；错误不抛
//   ④ 索引：维护后被删段不再出现在 searchEventsPaged 结果里
//   ⑤ 删除失败不中断（只读目录注入 EACCES）
//   ⑥ daemon 接线：scheduleMaintenance 首跑/周期/CHRONICLE_MAINTENANCE_MS/异常吞掉
//   ⑦ CLI：node daemon.mjs --maintain [--dry-run] [--retention-days N] 输出纯 JSON、不启动 HTTP
//
// 所有数据都在系统临时目录的 CHRONICLE_HOME 下，不触碰 ~/.chronicle 真实数据。

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAINTENANCE,
  MAX_MAINTENANCE_DAYS,
  bucketKeyFor,
  normalizeMaintenanceConfig,
  pruneOldSegments,
} from '../shared/retention.mjs';
import { runMaintenance, summarizeMaintenanceReport } from '../shared/maintenance.mjs';
import { bucketInfo } from '../summarize.mjs';
import { scheduleMaintenance, maintenanceIntervalFromEnv, createHttpApp } from '../daemon.mjs';
import { searchEventsPaged } from '../shared/segments.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = path.join(REPO_ROOT, 'daemon.mjs');
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z'); // 固定“现在”，cutoff(2天)=2026-11-08T12:00:00Z
const CUTOFF_2D = new Date(NOW - 2 * DAY).toISOString();

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-retention-'));
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return Boolean(fn());
}

/** 造段：start/end 为毫秒时间戳；end=undefined 表示 open 段。 */
function makeSegment(home, name, { start, end, events = [], suppressed = null, metaOverride = null, payloadBytes = 64 } = {}) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  if (metaOverride === null) {
    const meta = { eventCount: events.length };
    if (start !== undefined) meta.segmentStart = typeof start === 'number' ? iso(start) : start;
    if (end !== undefined) meta.segmentEnd = iso(end);
    writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
  } else if (metaOverride !== false) {
    writeFileSync(path.join(dir, 'metadata.json'), metaOverride);
  }
  if (events.length) writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (suppressed) writeFileSync(path.join(dir, 'suppressed.jsonl'), suppressed.map((s) => JSON.stringify(s)).join('\n') + '\n');
  if (payloadBytes > 0) writeFileSync(path.join(dir, 'payload.bin'), 'x'.repeat(payloadBytes));
  return dir;
}

function makeSummary(home, filename) {
  mkdirSync(path.join(home, 'summaries'), { recursive: true });
  writeFileSync(path.join(home, 'summaries', filename), `---\ntitle: "test"\n---\n\n- placeholder\n`);
}

function writeConfig(home, cfg) {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
}

/** home 下全部文件的相对路径+大小（用于断言 dryRun/默认配置零写入）。 */
function snapshot(home) {
  const out = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, r);
      else out.push(`${r}|${st.size}`);
    }
  };
  walk(home, '');
  return out;
}

const bucketKey = (ms) => bucketInfo(new Date(ms)).key; // 与 summarize.mjs 的 6h 命名严格对齐

/**
 * 标准 fixture：
 *   old-01 / old-02（同一旧桶）、old-suppressed（只有 suppressed）、near-01（早于 cutoff 但桶未结束）、
 *   boundary-01（start == cutoff，不删）、recent-01（未过期）、open-01（open 段）、
 *   no-meta（无 metadata）、unparsable-01（segmentStart 无法解析但已关闭）
 */
function buildFixture(home) {
  const oldStart = Date.parse('2026-11-01T00:00:00.000Z');
  makeSegment(home, 'old-01', { start: oldStart, end: oldStart + 600_000, events: [{ ts: iso(oldStart + 1000), type: 'url-change', data: { bundleId: 'com.example.app', url: 'https://old.example.com/a' } }] });
  makeSegment(home, 'old-02', { start: oldStart + 300_000, end: oldStart + 900_000 });
  makeSegment(home, 'old-suppressed', { start: Date.parse('2026-11-02T03:00:00.000Z'), end: Date.parse('2026-11-02T03:10:00.000Z'), suppressed: [{ ts: '2026-11-02T03:01:00.000Z', type: 'sample', scope: 'app', reason: 'app-blocklist' }] });
  makeSegment(home, 'near-01', { start: Date.parse('2026-11-08T11:59:00.000Z'), end: Date.parse('2026-11-08T12:09:00.000Z') });
  makeSegment(home, 'boundary-01', { start: Date.parse(CUTOFF_2D), end: Date.parse(CUTOFF_2D) + 600_000 });
  makeSegment(home, 'recent-01', { start: Date.parse('2026-11-09T00:00:00.000Z'), end: Date.parse('2026-11-09T00:10:00.000Z'), events: [{ ts: '2026-11-09T00:01:00.000Z', type: 'app-switch', data: { bundleId: 'com.example.recent' } }] });
  makeSegment(home, 'open-01', { start: Date.parse('2026-10-01T00:00:00.000Z') }); // 无 segmentEnd
  makeSegment(home, 'no-meta', { metaOverride: false, payloadBytes: 8 });            // 无 metadata.json
  makeSegment(home, 'unparsable-01', { start: 'not-a-date', end: Date.parse('2026-11-03T00:10:00.000Z') });

  // 摘要：被删段各一份 10min；6h 桶覆盖“桶已结束”和“桶未结束”两种
  for (const name of ['old-01', 'old-02', 'old-suppressed', 'near-01', 'boundary-01', 'recent-01', 'open-01']) {
    makeSummary(home, `10min-${name}.md`);
  }
  makeSummary(home, `6h-${bucketKey(oldStart)}.md`);                            // 桶 06:00 < cutoff → 删
  makeSummary(home, `6h-${bucketKey(Date.parse('2026-11-02T03:00:00.000Z'))}.md`); // 同上 → 删
  makeSummary(home, `6h-${bucketKey(Date.parse('2026-11-08T11:59:00.000Z'))}.md`); // 桶 06:00~12:00 == cutoff → 保留
  makeSummary(home, `6h-${bucketKey(Date.parse('2026-11-09T00:00:00.000Z'))}.md`); // 无被删段 → 不动
  return {
    oldStart,
    removedSegments: ['near-01', 'old-01', 'old-02', 'old-suppressed'],
    keptSegments: ['boundary-01', 'open-01', 'no-meta', 'recent-01', 'unparsable-01'],
    removed10min: ['10min-near-01.md', '10min-old-01.md', '10min-old-02.md', '10min-old-suppressed.md'],
  };
}

// ---------- ① 配置归一化 ----------

describe('normalizeMaintenanceConfig', () => {
  test('默认值：retentionDays=0（安全关闭）、compressAfterDays=7', () => {
    assert.deepEqual(DEFAULT_MAINTENANCE, { retentionDays: 0, compressAfterDays: 7 });
    for (const input of [undefined, null, {}, { enabled: true }]) {
      const n = normalizeMaintenanceConfig(input);
      assert.equal(n.retentionDays, 0);
      assert.equal(n.compressAfterDays, 7);
      assert.deepEqual(n.warnings, []);
    }
  });

  test('支持完整配置（maintenance 段）与直接传段两种形式', () => {
    const a = normalizeMaintenanceConfig({ enabled: true, maintenance: { retentionDays: 3, compressAfterDays: 2 } });
    assert.equal(a.retentionDays, 3);
    assert.equal(a.compressAfterDays, 2);
    assert.deepEqual(a.warnings, []);

    const b = normalizeMaintenanceConfig({ retentionDays: 4 });
    assert.equal(b.retentionDays, 4);
    assert.equal(b.compressAfterDays, 7);
    assert.deepEqual(b.warnings, []);

    const c = normalizeMaintenanceConfig({ maintenance: { retentionDays: 0 } });
    assert.equal(c.retentionDays, 0);
  });

  test('非法值回落默认并返回 warnings', () => {
    for (const bad of [-1, 1.5, '3', true, [], {}]) {
      const n = normalizeMaintenanceConfig({ maintenance: { retentionDays: bad } });
      assert.equal(n.retentionDays, 0, `retentionDays=${JSON.stringify(bad)} 应回落 0`);
      assert.equal(n.warnings.length, 1);
    }
    const m = normalizeMaintenanceConfig({ maintenance: { retentionDays: 2, compressAfterDays: -5 } });
    assert.equal(m.retentionDays, 2);
    assert.equal(m.compressAfterDays, 7);
    assert.equal(m.warnings.length, 1);
  });

  test('超过上限钳制到 MAX_MAINTENANCE_DAYS 并记 warning', () => {
    const n = normalizeMaintenanceConfig({ maintenance: { retentionDays: MAX_MAINTENANCE_DAYS + 10 } });
    assert.equal(n.retentionDays, MAX_MAINTENANCE_DAYS);
    assert.match(n.warnings.join('\n'), /钳制/);
  });

  test('maintenance 段类型非法 → 默认值 + warning', () => {
    for (const bad of ['x', 42, [], null]) {
      const n = normalizeMaintenanceConfig({ maintenance: bad });
      assert.equal(n.retentionDays, 0);
      assert.equal(n.compressAfterDays, 7);
      assert.ok(n.warnings.length >= 1);
    }
  });
});

// ---------- ② pruneOldSegments ----------

describe('pruneOldSegments', () => {
  const homes = [];
  const cleanup = () => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); };
  after(cleanup);

  const newHome = () => { const h = tmpHome(); homes.push(h); buildFixture(h); return h; };

  test('默认 retentionDays=0：no-op，不删任何文件', () => {
    const home = newHome();
    const before = snapshot(home);
    const report = pruneOldSegments(home, { retentionDays: 0, now: NOW });
    assert.equal(report.disabled, true);
    assert.equal(report.dryRun, false);
    assert.equal(report.cutoffIso, null);
    assert.deepEqual(report.removedSegments, []);
    assert.deepEqual(report.removedSummaries, []);
    assert.equal(report.bytesFreed, 0);
    assert.deepEqual(snapshot(home), before);
  });

  test('dryRun：只返回将删清单，绝不写/删任何文件', () => {
    const home = newHome();
    const before = snapshot(home);
    const report = pruneOldSegments(home, { retentionDays: 2, now: NOW, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.cutoffIso, CUTOFF_2D);
    assert.deepEqual(report.removedSegments, ['near-01', 'old-01', 'old-02', 'old-suppressed']);
    assert.deepEqual(report.removedSummaries, [
      '10min-near-01.md', '10min-old-01.md', '10min-old-02.md', '10min-old-suppressed.md',
      `6h-${bucketKey(Date.parse('2026-11-01T00:00:00.000Z'))}.md`,
      `6h-${bucketKey(Date.parse('2026-11-02T03:00:00.000Z'))}.md`,
    ].sort());
    assert.ok(report.bytesFreed > 0);
    assert.equal(report.skippedOpen, 2);        // open-01 + no-meta
    assert.equal(report.skippedUnparsable, 1);  // unparsable-01
    assert.deepEqual(report.warnings.length, 1);
    assert.deepEqual(snapshot(home), before);   // 关键：dryRun 零写入
  });

  test('retentionDays=2：只删过期已关闭段；open/无 metadata/时间不可解析/边界段保留', () => {
    const home = newHome();
    const report = pruneOldSegments(home, { retentionDays: 2, now: NOW });
    assert.equal(report.disabled, false);
    assert.deepEqual(report.removedSegments, ['near-01', 'old-01', 'old-02', 'old-suppressed']);
    assert.deepEqual(report.failedSegments, []);
    assert.equal(report.errors, 0);
    assert.ok(report.bytesFreed > 0);
    assert.equal(report.skippedOpen, 2);
    assert.equal(report.skippedUnparsable, 1);

    // 段目录：该删的删了，该留的都在
    for (const name of ['near-01', 'old-01', 'old-02', 'old-suppressed']) {
      assert.ok(!existsSync(path.join(home, 'segments', name)), `${name} 应被删除`);
    }
    for (const name of ['boundary-01', 'open-01', 'no-meta', 'recent-01', 'unparsable-01']) {
      assert.ok(existsSync(path.join(home, 'segments', name)), `${name} 必须保留`);
    }

    // 10min：被删段对应摘要删除，保留段的摘要不动
    for (const name of ['near-01', 'old-01', 'old-02', 'old-suppressed']) {
      assert.ok(!existsSync(path.join(home, 'summaries', `10min-${name}.md`)));
    }
    for (const name of ['boundary-01', 'recent-01', 'open-01']) {
      assert.ok(existsSync(path.join(home, 'summaries', `10min-${name}.md`)), `10min-${name}.md 必须保留`);
    }

    // 6h：桶结束早于 cutoff 的删；near-01 的桶（06:00~12:00 == cutoff）保留
    assert.ok(!existsSync(path.join(home, 'summaries', `6h-${bucketKey(Date.parse('2026-11-01T00:00:00.000Z'))}.md`)));
    assert.ok(!existsSync(path.join(home, 'summaries', `6h-${bucketKey(Date.parse('2026-11-02T03:00:00.000Z'))}.md`)));
    assert.ok(existsSync(path.join(home, 'summaries', `6h-${bucketKey(Date.parse('2026-11-08T11:59:00.000Z'))}.md`)), '桶未结束的 6h 摘要不得删除');
    assert.ok(existsSync(path.join(home, 'summaries', `6h-${bucketKey(Date.parse('2026-11-09T00:00:00.000Z'))}.md`)), '无被删段的 6h 摘要不得删除');
  });

  test('删除失败不中断：只读目录注入 EACCES，errors 计数且不抛', () => {
    const home = newHome();
    const segmentsRoot = path.join(home, 'segments');
    chmodSync(segmentsRoot, 0o500); // 只读：无法 unlink 子项
    try {
      const report = pruneOldSegments(home, { retentionDays: 2, now: NOW });
      assert.ok(report.errors > 0, `应有删除失败计数，errors=${report.errors}`);
      assert.deepEqual(report.removedSegments, []);
      assert.deepEqual(report.failedSegments, ['near-01', 'old-01', 'old-02', 'old-suppressed']);
      assert.ok(report.warnings.length >= 1);
      // 失败段的段目录仍在（没有误删）
      for (const name of report.failedSegments) assert.ok(existsSync(path.join(home, 'segments', name)));
    } finally {
      chmodSync(segmentsRoot, 0o755);
    }
  });

  test('bucketKeyFor 与 summarize.mjs 的 6h 桶命名一致', () => {
    for (const ms of [Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-01T05:59:59Z'), Date.parse('2026-11-01T06:00:00Z')]) {
      assert.equal(bucketKeyFor(ms), bucketInfo(new Date(ms)).key);
    }
  });
});

// ---------- ③ 维护编排 ----------

describe('runMaintenance', () => {
  const homes = [];
  const cleanup = () => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); };
  after(cleanup);

  const newHome = () => { const h = tmpHome(); homes.push(h); buildFixture(h); return h; };

  test('默认配置：retention 跳过、不删数据（dryRun 下零写入）', async () => {
    const home = newHome();
    const before = snapshot(home);
    const report = await runMaintenance(home, {}, { now: NOW, dryRun: true });
    assert.equal(report.retentionSkipped, true);
    assert.equal(report.retention, null);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.index.skipped, true);
    assert.deepEqual(snapshot(home), before);
    assert.match(summarizeMaintenanceReport(report), /retentionDays=0/);
  });

  test('retentionDays=2：先保留、再压缩(未就绪则跳过)、最后刷新索引；返回合并报告', async () => {
    const home = newHome();
    const report = await runMaintenance(home, { maintenance: { retentionDays: 2, compressAfterDays: 7 } }, { now: NOW });
    assert.equal(report.retentionSkipped, false);
    assert.equal(report.retention.cutoffIso, CUTOFF_2D);
    assert.deepEqual(report.retention.removedSegments, ['near-01', 'old-01', 'old-02', 'old-suppressed']);
    // F 的 compression.mjs 可能尚未实现：此时必须跳过而不是抛错
    assert.equal(typeof report.compressionSkipped, 'boolean');
    if (report.compressionSkipped) assert.ok(report.compressionSkipReason);
    assert.ok(report.index && typeof report.index === 'object');
    assert.ok(Array.isArray(report.errors));
    // retention 本身不应有错；compression 来自 F 的写域，未就绪/失败都只应记录不应抛
    assert.ok(report.errors.every((e) => !e.startsWith('retention:')), `retention 不应报错: ${JSON.stringify(report.errors)}`);
    assert.match(report.summary, /removedSegments=4/);
    assert.ok(existsSync(path.join(home, 'segments', 'recent-01')));
  });

  test('任一步失败不抛给调用方（非法 home 也不炸）', async () => {
    const base = tmpHome();
    homes.push(base);
    const report = await runMaintenance(path.join(base, 'does-not-exist'), { maintenance: { retentionDays: 2, compressAfterDays: 0 } }, { now: NOW });
    assert.ok(report && typeof report === 'object');
    assert.ok(Array.isArray(report.errors));
    // 目录不存在时 retention 正常返回空清单；index 可能 ok/skipped，但绝不抛
    assert.deepEqual(report.retention.removedSegments, []);
  });
});

// ---------- ④ 索引联动：维护后被删段不再出现在搜索结果 ----------

describe('索引联动（维护 → ensureIndex → searchEventsPaged）', () => {
  test('被删段的事件不再被搜索返回', async () => {
    const home = tmpHome();
    try {
      const oldStart = Date.parse('2026-11-01T00:00:00.000Z');
      makeSegment(home, '2026-11-01T00-00-00.000Z', {
        start: oldStart,
        end: oldStart + 600_000,
        events: [{ ts: iso(oldStart + 1000), type: 'url-change', data: { bundleId: 'com.example.old', url: 'https://old.example.com/remove-me' } }],
      });
      makeSegment(home, '2026-11-09T00-00-00.000Z', {
        start: Date.parse('2026-11-09T00:00:00.000Z'),
        end: Date.parse('2026-11-09T00:10:00.000Z'),
        events: [{ ts: '2026-11-09T00:01:00.000Z', type: 'url-change', data: { bundleId: 'com.example.new', url: 'https://new.example.com/keep-me' } }],
      });
      const before = searchEventsPaged(home, { query: 'example.com', limit: 10, offset: 0 });
      assert.ok(before.items.length >= 2, `维护前应有两条命中，got ${before.items.length}`);
      assert.ok(before.items.some((e) => e.segment === '2026-11-01T00-00-00.000Z'));

      const report = await runMaintenance(home, { maintenance: { retentionDays: 2, compressAfterDays: 0 } }, { now: NOW });
      assert.equal(report.errors.length, 0);
      assert.ok(!existsSync(path.join(home, 'segments', '2026-11-01T00-00-00.000Z')));

      const after = searchEventsPaged(home, { query: 'example.com', limit: 10, offset: 0 });
      assert.ok(after.items.length >= 1);
      assert.ok(after.items.every((e) => e.segment !== '2026-11-01T00-00-00.000Z'), '被删段不得再被索引返回');
      assert.ok(after.items.some((e) => e.segment === '2026-11-09T00-00-00.000Z'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑤ daemon 接线：scheduleMaintenance ----------

describe('daemon 维护调度（scheduleMaintenance）', () => {
  test('启动 5s 语义（测试注入短延迟）+ 按 config.json 执行 retention', async () => {
    const home = tmpHome();
    try {
      buildFixture(home);
      writeConfig(home, { enabled: true, maintenance: { retentionDays: 2 } });
      const logs = [];
      const sched = scheduleMaintenance({ home, log: (m) => logs.push(m), firstDelayMs: 10, intervalMs: 60_000, now: NOW });
      try {
        assert.equal(await waitUntil(() => logs.some((l) => l.startsWith('[maintenance]')), { timeoutMs: 3000 }), true, `应产生维护日志: ${JSON.stringify(logs)}`);
        assert.ok(!existsSync(path.join(home, 'segments', 'old-01')), '过期段应被删除');
        assert.ok(existsSync(path.join(home, 'segments', 'recent-01')), '新段应保留');
        const report = sched.last();
        assert.equal(report.retention.removedSegments.length, 4);
        assert.equal(sched.invocations()[0].reason, 'startup');
      } finally {
        sched.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('CHRONICLE_MAINTENANCE_MS 测试钩子覆盖周期；run 注入可数调用', async () => {
    const home = tmpHome();
    const prev = process.env.CHRONICLE_MAINTENANCE_MS;
    try {
      process.env.CHRONICLE_MAINTENANCE_MS = '50';
      assert.equal(maintenanceIntervalFromEnv(), 50);
      let count = 0;
      const sched = scheduleMaintenance({
        home,
        log: () => {},
        firstDelay: false,
        intervalMs: maintenanceIntervalFromEnv(),
        run: async () => { count += 1; return {}; },
      });
      try {
        assert.equal(sched.intervalMs, 50);
        assert.equal(await waitUntil(() => count >= 2, { timeoutMs: 2000 }), true, `周期任务应至少跑 2 次，实际 ${count}`);
      } finally {
        sched.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.CHRONICLE_MAINTENANCE_MS;
      else process.env.CHRONICLE_MAINTENANCE_MS = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('维护异常被吞掉（不抛、记日志）', async () => {
    const home = tmpHome();
    try {
      const logs = [];
      const sched = scheduleMaintenance({ home, log: (m) => logs.push(m), firstDelay: false, run: async () => { throw new Error('boom'); } });
      try {
        const report = await sched.runOnce();
        assert.equal(report, null);
        assert.ok(logs.some((l) => l.includes('运行失败')), `应记录失败日志: ${JSON.stringify(logs)}`);
      } finally {
        sched.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑥ HTTP /api/config：maintenance 段可通过校验并归一化 ----------

describe('HTTP /api/config 的 maintenance 段', () => {
  function stubDaemon() {
    return {
      binary: '/stub/chronicle-daemon',
      proc: () => null,
      stats: () => ({ restarts: 0, lastExit: null }),
      async request(cmd) {
        if (cmd === 'status') return { running: false, paused: false, currentSegment: null, totalEvents: 0, config: {} };
        return { ok: true };
      },
    };
  }

  async function withServer(home, fn) {
    const server = createHttpApp({ daemon: stubDaemon(), home });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { return await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
  }

  test('PUT 合法 maintenance：200、落盘保留段、无 maintenanceWarnings', async () => {
    const home = tmpHome();
    try {
      writeConfig(home, { enabled: true, allowlist: [], blocklist: [] });
      const status = await withServer(home, async (base) => {
        const r = await fetch(`${base}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maintenance: { retentionDays: 3, compressAfterDays: 5 } }),
        });
        return { status: r.status, body: await r.json() };
      });
      assert.equal(status.status, 200);
      assert.equal(status.body.ok, true);
      assert.deepEqual(status.body.config.maintenance, { retentionDays: 3, compressAfterDays: 5 });
      assert.equal(status.body.maintenanceWarnings, undefined);
      const onDisk = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.deepEqual(onDisk.maintenance, { retentionDays: 3, compressAfterDays: 5 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('PUT 非法 maintenance 天数：200（不因维护配置拒绝隐私保存）+ maintenanceWarnings + 归一化落盘', async () => {
    const home = tmpHome();
    try {
      writeConfig(home, { enabled: true, allowlist: [], blocklist: [] });
      const status = await withServer(home, async (base) => {
        const r = await fetch(`${base}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maintenance: { retentionDays: -3 } }),
        });
        return { status: r.status, body: await r.json() };
      });
      assert.equal(status.status, 200);
      assert.ok(Array.isArray(status.body.maintenanceWarnings));
      assert.match(status.body.maintenanceWarnings.join('\n'), /retentionDays/);
      assert.equal(status.body.config.maintenance.retentionDays, 0);
      assert.equal(status.body.config.maintenance.compressAfterDays, 7);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦ CLI：--maintain / --dry-run / --retention-days ----------
// CLI 用真实时钟（Date.now()），所以 fixture 用「相对当前时间」的段，避免固定 NOW 造成时区/时钟漂移。

function buildCliFixture(home, nowMs = Date.now()) {
  makeSegment(home, 'old-5d', { start: nowMs - 5 * DAY, end: nowMs - 5 * DAY + 600_000 });
  makeSegment(home, 'old-4d', { start: nowMs - 4 * DAY, end: nowMs - 4 * DAY + 600_000 });
  makeSegment(home, 'recent-6h', { start: nowMs - 6 * 3600_000, end: nowMs - 5 * 3600_000 });
  makeSummary(home, '10min-old-5d.md');
  makeSummary(home, '10min-old-4d.md');
  makeSummary(home, '10min-recent-6h.md');
  return { removed: ['old-4d', 'old-5d'], kept: ['recent-6h'] };
}

describe('CLI --maintain', () => {
  test('--maintain --dry-run：输出纯 JSON、不删文件、不启动 HTTP/不建 lock', () => {
    const home = tmpHome();
    try {
      const fx = buildCliFixture(home);
      writeConfig(home, { enabled: true, maintenance: { retentionDays: 2 } });
      const before = snapshot(home);
      const r = spawnSync(process.execPath, [DAEMON, '--maintain', '--dry-run', '--home', home], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      const report = JSON.parse(r.stdout); // stdout 必须是纯 JSON（日志走 stderr）
      assert.equal(report.dryRun, true);
      assert.deepEqual(report.retention.removedSegments, fx.removed);
      assert.deepEqual(report.retention.removedSummaries, ['10min-old-4d.md', '10min-old-5d.md']);
      assert.deepEqual(snapshot(home), before); // dryRun 零写入
      assert.ok(!existsSync(path.join(home, 'daemon.lock'))); // 不启动 HTTP/守护
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--maintain --retention-days 2：真正删除并打印 JSON 报告', () => {
    const home = tmpHome();
    try {
      const fx = buildCliFixture(home);
      writeConfig(home, { enabled: true });
      const r = spawnSync(process.execPath, [DAEMON, '--maintain', '--retention-days', '2', '--home', home], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `stderr=${r.stderr}`);
      const report = JSON.parse(r.stdout);
      assert.equal(report.retentionDays, 2);
      assert.deepEqual(report.retention.removedSegments, fx.removed);
      for (const name of fx.removed) assert.ok(!existsSync(path.join(home, 'segments', name)), `${name} 应被删除`);
      assert.ok(existsSync(path.join(home, 'segments', 'recent-6h')));
      assert.ok(!existsSync(path.join(home, 'summaries', '10min-old-5d.md')));
      assert.ok(existsSync(path.join(home, 'summaries', '10min-recent-6h.md')));
      assert.ok(!existsSync(path.join(home, 'daemon.lock')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
