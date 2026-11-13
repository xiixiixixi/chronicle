// test/index.test.mjs — 批次 3 SQLite 索引层测试
//
// 覆盖：
//   ① node:sqlite 可用性探测 + 不可用时优雅降级（indexed:false 线性回退）
//   ② 增量索引：新增段/变化段重建、未变段复用、消失段清理
//   ③ 损坏库自愈：写坏字节 → 改名 .corrupt 留档 → 同调用重建可用
//   ④ 索引路径 vs 线性回退路径：结果必须一致（items/total/hasMore）
//   ⑤ 分页（limit/offset/hasMore/total）与范围查询（ms / YYYY-MM-DD / ISO；非法 → BAD_RANGE）
//   ⑥ listSegmentsPaged（limit/before 名称或时间戳）+ indexStats + closeIndex/resetIndex
//   ⑦ shared/segments.mjs 的缓存与 suppressed 惰性读取（不破坏旧语义）
//
// 全部零网络、零第三方依赖（临时目录自造数据）。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeIndex, ensureIndex, indexStats, listSegmentsPaged, normalizeRange,
  resetIndex, searchEventsPaged, sqliteAvailable,
} from '../shared/index.mjs';
import {
  chronicleHome, clearSegmentCache, listSegments, searchEvents, dayBoundsLocal, searchEventsPaged as segSearchPaged,
} from '../shared/segments.mjs';

const HAS_SQLITE = sqliteAvailable();
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-idx-'));

/** 造一个段：<home>/segments/<name>/{events.jsonl,metadata.json}。 */
function mkSeg(home, name, events, { closed = true, eventCount = null } = {}) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.length ? `${events.map((e) => JSON.stringify(e)).join('\n')}\n` : '');
  const meta = { segmentStart: name.replace(/T(\d{2})-(\d{2})-(\d{2})\./, 'T$1:$2:$3.').replace(/-(\d{2})-(\d{2})-(\d{2})\./, '-$1-$2-$3.'), eventCount: eventCount ?? events.length };
  if (closed) meta.segmentEnd = meta.segmentStart;
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
  return dir;
}

const ev = (ts, type, data) => ({ ts, type, data });
const CHROME_SWITCH = ev('2026-10-19T02:01:00.000Z', 'app-switch', { bundleId: 'com.google.Chrome', appName: 'Chrome' });
const CHROME_URL = ev('2026-10-19T02:02:00.000Z', 'url-change', { bundleId: 'com.google.Chrome', url: 'https://github.com/chronicle' });
const TERM_WIN = ev('2026-10-18T20:11:00.000Z', 'window-change', { bundleId: 'com.apple.Terminal', windowTitle: 'GitHub work — zsh' });

/** 两个段、三条事件的固定样本（新→旧：02:00 段、20:10 段）。 */
function seedSample(home) {
  mkSeg(home, '2026-10-19T02-00-00.000Z', [CHROME_SWITCH, CHROME_URL]);
  mkSeg(home, '2026-10-18T20-10-00.000Z', [TERM_WIN]);
}

before(() => { closeIndex(); });
after(() => { closeIndex(); });

// ---------- ① 可用性与降级 ----------

describe('node:sqlite 可用性与降级', () => {
  test('sqliteAvailable() 反映当前 Node（Node 24 应为 true）', () => {
    assert.equal(typeof HAS_SQLITE, 'boolean');
    if (process.versions.node.split('.')[0] >= 24) assert.equal(HAS_SQLITE, true);
  });

  test('索引不可创建（<home>/index 是文件）→ 返回 null / indexed:false，但结果仍正确', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      // 用文件占住 index 目录 → mkdir 失败 → openIndex 返回 null
      writeFileSync(path.join(home, 'index'), 'not a directory');
      closeIndex();

      const stats = ensureIndex(home);
      assert.equal(stats, null);
      assert.equal(indexStats(home).indexed, false);

      const page = searchEventsPaged(home, { query: 'github' });
      assert.equal(page.indexed, false);       // 回退线性
      assert.equal(page.total, 2);
      assert.equal(page.items.length, 2);
      assert.equal(page.hasMore, false);
      // 顺序：最新在前
      assert.equal(page.items[0].data.url, 'https://github.com/chronicle');
      assert.equal(page.items[1].data.windowTitle, 'GitHub work — zsh');
      assert.ok(page.items.every((e) => typeof e.segment === 'string'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ② 增量索引 ----------

describe('增量索引（ensureIndex）', { skip: HAS_SQLITE ? false : 'node:sqlite 不可用' }, () => {
  test('首次全建 → 二次未变全复用 → 变化段重建 → 新增段追加 → 消失段清理', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      const s1 = ensureIndex(home);
      assert.equal(s1.indexed, true);
      assert.equal(s1.segments, 2);
      assert.equal(s1.events, 3);
      assert.equal(s1.rebuilt, 2);

      const s2 = ensureIndex(home);
      assert.equal(s2.rebuilt, 0);
      assert.equal(s2.reused, 2);
      assert.equal(s2.removed, 0);

      // 变化段：追加一条事件（events.jsonl 变化 → 指纹变化 → 重建该段且仅该段）
      const dir = path.join(home, 'segments', '2026-10-19T02-00-00.000Z');
      const extra = ev('2026-10-19T02:03:00.000Z', 'focus-change', { bundleId: 'com.google.Chrome', role: 'AXButton', title: 'OK' });
      writeFileSync(path.join(dir, 'events.jsonl'), `${readdirSync(dir).includes('events.jsonl') ? '' : ''}${[CHROME_SWITCH, CHROME_URL, extra].map((e) => JSON.stringify(e)).join('\n')}\n`);
      const s3 = ensureIndex(home);
      assert.equal(s3.rebuilt, 1, '只重建变化段');
      assert.equal(s3.reused, 1);
      assert.equal(s3.events, 4);
      assert.equal(searchEventsPaged(home, { query: 'AXButton' }).total, 1);

      // 新增段
      mkSeg(home, '2026-10-19T05-00-00.000Z', [ev('2026-10-19T05:01:00.000Z', 'app-switch', { bundleId: 'com.apple.finder', appName: 'Finder' })]);
      const s4 = ensureIndex(home);
      assert.equal(s4.segments, 3);
      assert.equal(s4.events, 5);
      assert.equal(s4.rebuilt, 1);

      // 消失段：删目录 → 索引行同步删除
      rmSync(path.join(home, 'segments', '2026-10-18T20-10-00.000Z'), { recursive: true, force: true });
      const s5 = ensureIndex(home);
      assert.equal(s5.removed, 1);
      assert.equal(s5.segments, 2);
      assert.equal(searchEventsPaged(home, { query: 'GitHub work' }).total, 0, '被删段的事件不得残留');
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });

  test('metadata 缺 eventCount 时用 events.jsonl 行数兜底（不报错）', () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T02-00-00.000Z', [CHROME_SWITCH, CHROME_URL], { eventCount: null });
      // 手工把 eventCount 去掉
      writeFileSync(path.join(home, 'segments', '2026-10-19T02-00-00.000Z', 'metadata.json'),
        JSON.stringify({ segmentStart: '2026-10-19T02:00:00.000Z', segmentEnd: '2026-10-19T02:10:00.000Z' }));
      clearSegmentCache();
      const segs = listSegments(home);
      assert.equal(segs[0].eventCount, 2);
      const stats = ensureIndex(home);
      assert.equal(stats.events, 2);
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ③ 损坏库自愈 ----------

describe('损坏库自愈', { skip: HAS_SQLITE ? false : 'node:sqlite 不可用' }, () => {
  test('写坏 events.db → 留档 .corrupt → 同调用重建并可用', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      assert.equal(ensureIndex(home).events, 3);
      const dbFile = path.join(home, 'index', 'events.db');
      assert.ok(statSync(dbFile).isFile());

      closeIndex(); // 释放句柄，模拟“下次启动遇到坏库”
      writeFileSync(dbFile, 'this is definitely not a sqlite database file');

      const stats = ensureIndex(home);
      assert.equal(stats.indexed, true, '坏库应被重建');
      assert.equal(stats.events, 3);
      const sidecars = readdirSync(path.join(home, 'index')).filter((n) => n.includes('.corrupt'));
      assert.ok(sidecars.length >= 1, `应留下坏库副本，实际：${sidecars.join(',')}`);
      assert.equal(searchEventsPaged(home, { query: 'github' }).total, 2);
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ④ 索引 vs 线性一致 ----------

describe('索引路径与线性回退结果一致', { skip: HAS_SQLITE ? false : 'node:sqlite 不可用' }, () => {
  test('同一批数据：indexed 与 fallback 的 items/total/hasMore 完全一致', () => {
    const indexedHome = tmpHome();
    const linearHome = tmpHome();
    try {
      seedSample(indexedHome);
      seedSample(linearHome);
      writeFileSync(path.join(linearHome, 'index'), 'blocks index dir');
      closeIndex();

      const cases = [
        { query: 'github' },
        { query: 'GITHUB' },                 // 大小写不敏感
        { query: 'chrome' },
        { query: '' },                        // 空查询 = 全量
        { query: 'com.apple.Terminal' },
        { query: 'nonsense-no-hit' },
        { query: 'github', limit: 1 },
        { query: '', limit: 1, offset: 1 },
      ];
      for (const opts of cases) {
        const a = searchEventsPaged(indexedHome, opts);
        const b = searchEventsPaged(linearHome, opts);
        assert.equal(a.indexed, true, `索引 home 应走索引: ${JSON.stringify(opts)}`);
        assert.equal(b.indexed, false, `受阻 home 应回退: ${JSON.stringify(opts)}`);
        assert.deepEqual(a.items, b.items, `items 不一致: ${JSON.stringify(opts)}`);
        assert.equal(a.total, b.total, `total 不一致: ${JSON.stringify(opts)}`);
        assert.equal(a.hasMore, b.hasMore, `hasMore 不一致: ${JSON.stringify(opts)}`);
      }
    } finally { closeIndex(); rmSync(indexedHome, { recursive: true, force: true }); rmSync(linearHome, { recursive: true, force: true }); }
  });

  test('同一毫秒的多条事件：索引与线性回退顺序一致（保持 file 顺序）', () => {
    const indexedHome = tmpHome();
    const linearHome = tmpHome();
    try {
      const sameTs = '2026-10-19T02:01:00.000Z';
      const events = [
        ev(sameTs, 'app-switch', { bundleId: 'com.a', appName: 'A' }),
        ev(sameTs, 'window-change', { bundleId: 'com.b', windowTitle: 'B' }),
        ev(sameTs, 'url-change', { bundleId: 'com.c', url: 'https://c.example/' }),
      ];
      for (const home of [indexedHome, linearHome]) mkSeg(home, '2026-10-19T02-00-00.000Z', events);
      writeFileSync(path.join(linearHome, 'index'), 'blocks index dir');
      closeIndex();
      const a = searchEventsPaged(indexedHome, { query: '' });
      const b = searchEventsPaged(linearHome, { query: '' });
      assert.equal(a.indexed, true);
      assert.equal(b.indexed, false);
      assert.deepEqual(a.items.map((e) => e.type), b.items.map((e) => e.type));
    } finally { closeIndex(); rmSync(indexedHome, { recursive: true, force: true }); rmSync(linearHome, { recursive: true, force: true }); }
  });
});

// ---------- ⑤ 分页与范围 ----------

describe('分页与范围查询', { skip: HAS_SQLITE ? false : 'node:sqlite 不可用' }, () => {
  test('limit/offset/hasMore/total 语义', () => {
    const home = tmpHome();
    try {
      const many = Array.from({ length: 7 }, (_, i) => ev(`2026-10-19T02:0${i}:00.000Z`, 'app-switch', { bundleId: `com.x${i}`, appName: `X${i}` }));
      mkSeg(home, '2026-10-19T02-00-00.000Z', many);

      const p1 = searchEventsPaged(home, { query: '', limit: 3, offset: 0 });
      assert.equal(p1.items.length, 3);
      assert.equal(p1.total, 7);
      assert.equal(p1.hasMore, true);
      const p2 = searchEventsPaged(home, { query: '', limit: 3, offset: 3 });
      assert.equal(p2.items.length, 3);
      assert.equal(p2.hasMore, true);
      const p3 = searchEventsPaged(home, { query: '', limit: 3, offset: 6 });
      assert.equal(p3.items.length, 1);
      assert.equal(p3.hasMore, false);
      // 最新在前（02:06 在最前）
      assert.equal(p1.items[0].data.appName, 'X6');
      // 越界 offset → 空页但不报错
      const p4 = searchEventsPaged(home, { query: '', limit: 3, offset: 99 });
      assert.deepEqual(p4.items, []);
      assert.equal(p4.hasMore, false);
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });

  test('from/to：毫秒时间戳 / YYYY-MM-DD（本地时区）/ ISO；空 query 只按范围过滤', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      // 毫秒时间戳精确范围
      const from = Date.parse('2026-10-19T00:00:00.000Z');
      const to = Date.parse('2026-10-19T03:00:00.000Z');
      const byMs = searchEventsPaged(home, { query: '', from, to });
      assert.equal(byMs.total, 2);
      // 本地日期范围：三条事件在 UTC 上跨两天，但 +08:00 本地都落在同一天
      const localDay = localKey('2026-10-19T02:01:00.000Z');
      assert.equal(localDay, localKey('2026-10-18T20:11:00.000Z'), '样本应同日（本地时区）');
      const byDay = searchEventsPaged(home, { query: '', from: localDay, to: localDay });
      assert.equal(byDay.total, 3);
      // 邻近的空白日 → 0 命中
      const emptyDay = searchEventsPaged(home, { query: '', from: '2026-10-20', to: '2026-10-20' });
      assert.equal(emptyDay.total, 0);
      // ISO 字符串边界
      const byIso = searchEventsPaged(home, { query: 'github', from: '2026-10-19T00:00:00.000Z', to: '2026-10-19T23:59:59.999Z' });
      assert.equal(byIso.total, 1);
      // 纯数字字符串按毫秒
      const byStr = searchEventsPaged(home, { query: 'github', from: String(from), to: String(to) });
      assert.equal(byStr.total, 1);
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });

  test('非法范围 → BAD_RANGE（daemon 映射 400）；from > to 也报错', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      assert.throws(() => searchEventsPaged(home, { query: 'x', from: 'not-a-date' }), (e) => e.code === 'BAD_RANGE');
      assert.throws(() => searchEventsPaged(home, { query: 'x', from: '2026-10-19', to: '2026-10-18' }), (e) => e.code === 'BAD_RANGE');
      assert.throws(() => dayBoundsLocal('2026/10/19'), (e) => e.code === 'BAD_RANGE');
      // normalizeRange 纯函数
      assert.deepEqual(normalizeRange({}), { fromMs: null, toMs: null });
      assert.equal(normalizeRange({ from: '2026-10-19' }).fromMs, new Date(2026, 9, 19, 0, 0, 0, 0).getTime());
      assert.equal(normalizeRange({ to: '2026-10-19' }).toMs, new Date(2026, 9, 19, 23, 59, 59, 999).getTime());
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });
});

/** ISO → 本地日期键（和 index/web 的口径一致）。 */
function localKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- ⑥ 段分页 / 统计 / 生命周期 ----------

describe('段分页与索引统计', { skip: HAS_SQLITE ? false : 'node:sqlite 不可用' }, () => {
  test('listSegmentsPaged：before 支持段名与时间戳；hasMore/nextBefore 正确', () => {
    const home = tmpHome();
    try {
      for (const name of ['2026-10-19T06-00-00.000Z', '2026-10-19T05-00-00.000Z', '2026-10-19T04-00-00.000Z']) {
        mkSeg(home, name, [ev(name.replace(/T(\d{2})-(\d{2})-(\d{2})\./, 'T$1:$2:$3.'), 'app-switch', { bundleId: 'a.b' })]);
      }
      const p1 = listSegmentsPaged(home, { limit: 2 });
      assert.equal(p1.items.length, 2);
      assert.equal(p1.hasMore, true);
      assert.equal(p1.nextBefore, '2026-10-19T05-00-00.000Z');

      const p2 = listSegmentsPaged(home, { limit: 2, before: p1.nextBefore });
      assert.equal(p2.items.length, 1);
      assert.equal(p2.hasMore, false);
      assert.equal(p2.nextBefore, null);

      // before 用时间戳（只返回更早的段）
      const p3 = listSegmentsPaged(home, { limit: 10, before: '2026-10-19T05:00:00.000Z' });
      assert.equal(p3.items.length, 1);
      assert.equal(p3.items[0].segment, '2026-10-19T04-00-00.000Z');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('indexStats 形状；closeIndex/resetIndex 后可重建', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      const st = indexStats(home);
      assert.equal(st.indexed, true);
      assert.equal(st.segments, 2);
      assert.equal(st.events, 3);
      assert.ok(st.bytes > 0);
      assert.ok(st.dbPath.endsWith(path.join('index', 'events.db')));

      closeIndex();
      assert.equal(searchEventsPaged(home, { query: 'github' }).total, 2, '重开后仍可用');

      resetIndex(home);
      assert.equal(indexStats(home).events, 3);
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ⑦ segments.mjs 缓存与惰性 suppressed ----------

describe('shared/segments.mjs 缓存与惰性读取', () => {
  test('listSegments 缓存不返回过期内容（metadata 原地更新立即可见）', () => {
    const home = tmpHome();
    try {
      const dir = mkSeg(home, '2026-10-19T02-00-00.000Z', [CHROME_SWITCH], { closed: false });
      clearSegmentCache();
      assert.equal(listSegments(home)[0].open, true);
      // 原地关闭段（重写 metadata.json）→ 紧接着再读必须看到 open=false
      writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
        segmentStart: '2026-10-19T02:00:00.000Z', segmentEnd: '2026-10-19T02:10:00.000Z', eventCount: 1,
      }));
      assert.equal(listSegments(home)[0].open, false);
      assert.ok(listSegments(home)[0].segmentEnd);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('suppressedCount 默认不读（null），显式 withSuppressed 才统计', () => {
    const home = tmpHome();
    try {
      const dir = mkSeg(home, '2026-10-19T02-00-00.000Z', [CHROME_SWITCH]);
      writeFileSync(path.join(dir, 'suppressed.jsonl'), `${JSON.stringify({ ts: '2026-10-19T02:05:00.000Z', type: 'sample', scope: 'app' })}\n`);
      clearSegmentCache();
      assert.equal(listSegments(home)[0].suppressedCount, null);
      const withSup = listSegments(home, { withSuppressed: true });
      assert.equal(withSup[0].suppressedCount, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('searchEvents 旧契约保持（query/count/capped/events）；searchEventsPaged 与 index 版一致', () => {
    const home = tmpHome();
    try {
      seedSample(home);
      closeIndex();
      const legacy = searchEvents(home, { q: 'github' });
      assert.equal(legacy.query, 'github');
      assert.equal(legacy.count, 2);
      assert.equal(legacy.capped, false);
      assert.equal(legacy.events.length, 2);
      const one = searchEvents(home, { q: 'github', limit: 1 });
      assert.equal(one.count, 1);
      assert.equal(one.capped, true);

      const paged = segSearchPaged(home, { query: 'github', limit: 1 });
      assert.equal(paged.items.length, 1);
      assert.equal(paged.hasMore, true);
      assert.equal(typeof paged.indexed, 'boolean');
    } finally { closeIndex(); rmSync(home, { recursive: true, force: true }); }
  });

  test('chronicleHome 尊重 CHRONICLE_HOME', () => {
    assert.equal(chronicleHome({ CHRONICLE_HOME: '/tmp/x-chronicle' }), path.resolve('/tmp/x-chronicle'));
    assert.ok(chronicleHome({}).endsWith('.chronicle'));
  });
});
