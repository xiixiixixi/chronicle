// test/overview.test.mjs — W2：GET /api/overview 单日聚合
//
// 覆盖：
//   ① date 解析：缺省=今天（本地时区）、YYYY-MM-DD 校验、非法日期 400
//   ② 空天：全零结构、null span、空 topApps/ruler
//   ③ 多应用驻留时长 / 同应用合并 / share 归一（3 位小数）/ topApps 前 8
//   ④ 跨天边界与跨午夜段裁剪（只统计 [dayStart, dayEnd) 内事件；ruler 裁剪到当天）
//   ⑤ .gz 段透明读取（events.jsonl.gz 无原文）
//   ⑥ ruler：连续同 bundleId 合并、非连续不误合并、>500 条按 5 分钟桶聚合
//   ⑦ counts.suppressed 取 metadata.suppressedEventCount
//   ⑧ recording 三态（running/paused/stopped）+ 无实时状态时的近似标记 approximate
//   ⑨ HTTP 契约：字段类型、默认今天、非法日期 400、只读不建索引（请求前后文件树不变）
//   ⑩ 性能冒烟：几百段/数千事件仍远低于 300ms 量级（宽松断言）

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

import { buildOverview, createHttpApp, parseOverviewDate } from '../daemon.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-overview-'));
const localIso = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).toISOString();
const localMs = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

/** 造段：events 写 events.jsonl（或 .gz），metadata 写 segmentStart/End/eventCount/suppressedEventCount。 */
function writeSegment(home, name, { start, end, events = [], suppressedEventCount, gz = false } = {}) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  const meta = { segmentStart: start, eventCount: events.length };
  if (end !== undefined) meta.segmentEnd = end;
  if (Number.isInteger(suppressedEventCount)) meta.suppressedEventCount = suppressedEventCount;
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
  if (events.length) {
    const text = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    if (gz) writeFileSync(path.join(dir, 'events.jsonl.gz'), gzipSync(text));
    else writeFileSync(path.join(dir, 'events.jsonl'), text);
  }
  return dir;
}

const ev = (iso, bundleId, appName = '', extra = {}) => ({ ts: iso, type: 'app-switch', data: { bundleId, appName, ...extra } });

function writeConfig(home, cfg) {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
}

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

function stubDaemon({ status = null } = {}) {
  return {
    binary: '/stub/chronicle-daemon',
    proc: () => null, // 无实时子进程 → overview 走近似路径（不拉起守护）
    stats: () => ({ restarts: 0, lastExit: null }),
    async request(cmd) {
      if (cmd === 'status') return status ?? { running: false, paused: false, currentSegment: null, config: {} };
      return { ok: true };
    },
  };
}

async function startHttp(home, daemonOptions = {}) {
  const server = createHttpApp({ daemon: stubDaemon(daemonOptions), home });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: async (p) => {
      const r = await fetch(base + p);
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------- ① date 解析 ----------

describe('parseOverviewDate', () => {
  test('缺省 = 今天（本地时区）', () => {
    const now = localMs(2026, 11, 10, 23, 30);
    const r = parseOverviewDate(null, now);
    assert.equal(r.date, '2026-11-10');
    assert.equal(r.dayStartMs, localMs(2026, 11, 10, 0, 0));
    assert.equal(r.dayEndMs, localMs(2026, 11, 11, 0, 0));
  });

  test('合法日期→本地零点边界；非法格式/非法日历日期抛 BAD_DATE', () => {
    const ok = parseOverviewDate('2026-11-10', localMs(2026, 11, 10, 12));
    assert.equal(ok.date, '2026-11-10');
    assert.equal(ok.dayStartMs, localMs(2026, 11, 10));
    assert.equal(ok.dayEndMs, localMs(2026, 11, 11));

    for (const bad of ['2026/11/10', '20261110', '2026-2-3', '2026-13-01', '2026-02-30', 'not-a-date']) {
      assert.throws(() => parseOverviewDate(bad, Date.now()), (err) => err.code === 'BAD_DATE', `${bad} 应 400`);
    }
  });

  test('HTTP：非法日期 400，合法/缺省 200', async () => {
    const home = tmpHome();
    const httpApp = await startHttp(home);
    try {
      for (const bad of ['2026-13-01', 'not-a-date', '2026-02-30']) {
        const r = await httpApp.get(`/api/overview?date=${encodeURIComponent(bad)}`);
        assert.equal(r.status, 400, `${bad} 应 400`);
        assert.equal(r.body.ok, false);
        assert.match(r.body.error, /date/);
      }
      const ok = await httpApp.get('/api/overview?date=2026-11-10');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.date, '2026-11-10');
    } finally {
      await httpApp.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ② 空天 ----------

describe('buildOverview 空天', () => {
  test('没有任何段：零结构、null span、空 topApps/ruler', () => {
    const home = tmpHome();
    try {
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(r.ok, true);
      assert.equal(r.date, '2026-11-10');
      assert.deepEqual(r.counts, { events: 0, suppressed: 0, segments: 0 });
      assert.deepEqual(r.span, { firstTs: null, lastTs: null, spanMs: 0, segmentCount: 0 });
      assert.deepEqual(r.topApps, []);
      assert.deepEqual(r.ruler, []);
      assert.equal(r.recording.state, 'stopped');
      assert.equal(typeof r.approximate, 'boolean');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ③ 多应用时长 / 合并 / share ----------

describe('驻留时长与 topApps', () => {
  test('多应用时长、同应用合并、share 3 位小数、span/counts', () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0),
        end: localIso(2026, 11, 10, 10, 10),
        suppressedEventCount: 0,
        events: [
          ev(localIso(2026, 11, 10, 10, 0), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 10, 2), 'com.b', 'Beta'),
          ev(localIso(2026, 11, 10, 10, 5), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 10, 8), 'com.b', 'Beta'),
        ],
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      // 段已关闭：最后一条事件驻留 0；其余到下一条为止
      // A: 10:00→10:02 (2m) + 10:05→10:08 (3m) = 5m；B: 10:02→10:05 (3m) + 0 = 3m
      assert.equal(r.counts.events, 4);
      assert.equal(r.counts.segments, 1);
      assert.equal(r.span.spanMs, 8 * 60_000);
      assert.equal(r.span.firstTs, localIso(2026, 11, 10, 10, 0));
      assert.equal(r.span.lastTs, localIso(2026, 11, 10, 10, 8));
      assert.equal(r.topApps.length, 2);
      assert.deepEqual(r.topApps[0], { bundleId: 'com.a', appName: 'Alpha', ms: 5 * 60_000, share: 0.625, eventCount: 2 });
      assert.deepEqual(r.topApps[1], { bundleId: 'com.b', appName: 'Beta', ms: 3 * 60_000, share: 0.375, eventCount: 2 });
      const sum = r.topApps.reduce((s, a) => s + a.share, 0);
      assert.ok(sum <= 1.001, `share 总和不应超过 1：${sum}`);
      for (const app of r.topApps) assert.ok(app.share >= 0 && app.share <= 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('topApps 最多 8 项，按 ms 降序', () => {
    const home = tmpHome();
    try {
      const events = [];
      for (let i = 0; i < 10; i += 1) {
        events.push(ev(localIso(2026, 11, 10, 10, i), `com.app${i}`, `App${i}`));
      }
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0),
        end: localIso(2026, 11, 10, 11, 0),
        events,
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(r.topApps.length, 8);
      for (let i = 1; i < r.topApps.length; i += 1) assert.ok(r.topApps[i - 1].ms >= r.topApps[i].ms);
      assert.equal(r.topApps[0].bundleId, 'com.app0'); // 首个间隔最长
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ④ 跨午夜裁剪 ----------

describe('跨天边界与跨午夜段', () => {
  test('只统计当天 [dayStart, dayEnd) 事件；跨午夜段被裁剪', () => {
    const home = tmpHome();
    try {
      // 前一天 23:50 → 当天 00:20 的段：只保留 00:00 后的事件
      writeSegment(home, '2026-11-09T15-50-00.000Z', {
        start: localIso(2026, 11, 9, 23, 50),
        end: localIso(2026, 11, 10, 0, 20),
        events: [
          ev(localIso(2026, 11, 9, 23, 55), 'com.prev', 'Prev'),
          ev(localIso(2026, 11, 10, 0, 0, 1), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 0, 5), 'com.b', 'Beta'),
        ],
      });
      // 当天 23:50 → 次日 00:10 的段：只保留 24:00 前的事件
      writeSegment(home, '2026-11-10T15-50-00.000Z', {
        start: localIso(2026, 11, 10, 23, 50),
        end: localIso(2026, 11, 11, 0, 10),
        events: [
          ev(localIso(2026, 11, 10, 23, 59), 'com.c', 'Gamma'),
          ev(localIso(2026, 11, 11, 0, 5), 'com.next', 'Next'),
        ],
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 11, 12) });
      assert.equal(r.counts.events, 3, `应为 Alpha/Beta/Gamma 三条：${JSON.stringify(r.counts)}`);
      assert.equal(r.span.firstTs, localIso(2026, 11, 10, 0, 0, 1));
      assert.equal(r.span.lastTs, localIso(2026, 11, 10, 23, 59));
      assert.equal(r.counts.segments, 2);
      const dayStart = localMs(2026, 11, 10, 0, 0);
      const dayEnd = localMs(2026, 11, 11, 0, 0);
      for (const iv of r.ruler) {
        assert.ok(Number.isInteger(iv.startMs) && Number.isInteger(iv.endMs));
        assert.ok(iv.startMs >= dayStart && iv.endMs <= dayEnd && iv.startMs <= iv.endMs, `ruler 越界: ${JSON.stringify(iv)}`);
      }
      // 前一天/次日的事件不会进入 topApps
      assert.ok(!r.topApps.some((a) => a.bundleId === 'com.prev' || a.bundleId === 'com.next'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('段与当天相交但当天无事件：span 为 null、events 0、ruler 空', () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-09T15-50-00.000Z', {
        start: localIso(2026, 11, 9, 23, 50),
        end: localIso(2026, 11, 10, 0, 10),
        events: [ev(localIso(2026, 11, 9, 23, 55), 'com.prev', 'Prev')],
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(r.counts.events, 0);
      assert.equal(r.counts.segments, 1);
      assert.equal(r.span.firstTs, null);
      assert.equal(r.span.spanMs, 0);
      assert.deepEqual(r.ruler, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑤ gz 段 ----------

describe('gz 透明读取', () => {
  test('events.jsonl.gz 无原文时也能聚合', () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0),
        end: localIso(2026, 11, 10, 10, 10),
        gz: true,
        events: [
          ev(localIso(2026, 11, 10, 10, 0), 'com.gz1', 'GzOne'),
          ev(localIso(2026, 11, 10, 10, 5), 'com.gz2', 'GzTwo'),
        ],
      });
      assert.ok(!existsSync(path.join(home, 'segments', '2026-11-10T02-00-00.000Z', 'events.jsonl')));
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(r.counts.events, 2);
      assert.equal(r.topApps.length, 2);
      assert.equal(r.topApps[0].bundleId, 'com.gz1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑥ ruler 合并 / 上限 ----------

describe('ruler', () => {
  test('连续同 bundleId 区间合并；不同应用不误合并', () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0),
        end: localIso(2026, 11, 10, 10, 10),
        events: [
          ev(localIso(2026, 11, 10, 10, 0), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 10, 0, 1), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 10, 0, 2), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 10, 0, 5), 'com.b', 'Beta'),
          ev(localIso(2026, 11, 10, 10, 0, 6), 'com.a', 'Alpha'),
        ],
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      // 区间：A[0,1s] A[1,2s] A[2,5s] B[5,6s] A[6,6s](0 长度丢弃)
      // → A 合并为 10:00:00→10:00:05；B 为 10:00:05→10:00:06
      assert.equal(r.ruler.length, 2, JSON.stringify(r.ruler));
      assert.equal(r.ruler[0].bundleId, 'com.a');
      assert.equal(r.ruler[0].startMs, localMs(2026, 11, 10, 10, 0, 0));
      assert.equal(r.ruler[0].endMs, localMs(2026, 11, 10, 10, 0, 5));
      assert.equal(r.ruler[1].bundleId, 'com.b');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('超过 500 条：按 5 分钟桶聚合，长度 ≤ 500 且字段合法', () => {
    const home = tmpHome();
    try {
      const events = [];
      const base = localMs(2026, 11, 10, 10, 0);
      for (let i = 0; i < 700; i += 1) {
        events.push(ev(new Date(base + i * 1000).toISOString(), i % 2 === 0 ? 'com.a' : 'com.b', i % 2 === 0 ? 'Alpha' : 'Beta'));
      }
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0),
        end: localIso(2026, 11, 10, 10, 30),
        events,
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(r.counts.events, 700);
      assert.ok(r.ruler.length > 0 && r.ruler.length <= 500, `ruler 长度应 ≤500，实际 ${r.ruler.length}`);
      // 聚合后应是 5 分钟桶（≤ 2 个桶覆盖 10:00–10:11）
      assert.ok(r.ruler.length <= 10, `700s 活动应聚合成少量桶，实际 ${r.ruler.length}`);
      for (const iv of r.ruler) {
        assert.equal(typeof iv.bundleId, 'string');
        assert.equal(typeof iv.appName, 'string');
        assert.ok(Number.isInteger(iv.startMs) && Number.isInteger(iv.endMs));
        assert.ok(iv.startMs <= iv.endMs);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦ suppressed ----------

describe('counts.suppressed', () => {
  test('取 metadata.suppressedEventCount 之和（只统计与当天相交的段）', () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0), end: localIso(2026, 11, 10, 10, 10), suppressedEventCount: 3,
        events: [ev(localIso(2026, 11, 10, 10, 0), 'com.a', 'Alpha')],
      });
      writeSegment(home, '2026-11-10T03-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 20), end: localIso(2026, 11, 10, 10, 30), suppressedEventCount: 2,
        events: [ev(localIso(2026, 11, 10, 10, 20), 'com.b', 'Beta')],
      });
      writeSegment(home, '2026-11-09T02-00-00.000Z', {
        start: localIso(2026, 11, 9, 10, 0), end: localIso(2026, 11, 9, 10, 10), suppressedEventCount: 9,
      });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(r.counts.suppressed, 5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑧ recording ----------

describe('recording 三态与近似', () => {
  test('传入实时 status：running / paused / stopped + sinceMs/currentSegment', () => {
    const home = tmpHome();
    try {
      const startTs = localIso(2026, 11, 10, 10, 0);
      const running = buildOverview(home, {
        date: '2026-11-10', now: localMs(2026, 11, 10, 12),
        status: { running: true, paused: false, currentSegment: { startTs, eventCount: 7 } },
      });
      assert.equal(running.approximate, false);
      assert.equal(running.recording.state, 'running');
      assert.equal(running.recording.sinceMs, Date.parse(startTs));
      assert.deepEqual(running.recording.currentSegment, { startTs, eventCount: 7 });

      const paused = buildOverview(home, {
        date: '2026-11-10', now: localMs(2026, 11, 10, 12),
        status: { running: true, paused: true, currentSegment: { startTs, eventCount: 3 } },
      });
      assert.equal(paused.recording.state, 'paused');

      const stopped = buildOverview(home, {
        date: '2026-11-10', now: localMs(2026, 11, 10, 12),
        status: { running: false, paused: false, currentSegment: null },
      });
      assert.equal(stopped.recording.state, 'stopped');
      assert.equal(stopped.recording.currentSegment, null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('无实时 status：config.enabled + 最近 open 段近似，approximate=true', () => {
    const home = tmpHome();
    try {
      writeConfig(home, { enabled: true });
      const start = localIso(2026, 11, 10, 10, 0);
      const dir = path.join(home, 'segments', '2026-11-10T02-00-00.000Z');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ segmentStart: start, eventCount: 4 }));
      writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(ev(start, 'com.a', 'Alpha'))}\n`);

      const running = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(running.approximate, true);
      assert.equal(running.recording.state, 'running');
      assert.equal(running.recording.currentSegment.startTs, start);
      assert.equal(running.recording.currentSegment.eventCount, 4);

      writeConfig(home, { enabled: false });
      const stopped = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 12) });
      assert.equal(stopped.recording.state, 'stopped');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑨ HTTP 契约 / 只读不建索引 ----------

describe('HTTP /api/overview', () => {
  test('响应字段类型与 share 归一', async () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0), end: localIso(2026, 11, 10, 10, 10), suppressedEventCount: 1,
        events: [
          ev(localIso(2026, 11, 10, 10, 0), 'com.a', 'Alpha'),
          ev(localIso(2026, 11, 10, 10, 5), 'com.b', 'Beta'),
        ],
      });
      const httpApp = await startHttp(home);
      try {
        const r = await httpApp.get('/api/overview?date=2026-11-10');
        assert.equal(r.status, 200);
        const b = r.body;
        assert.equal(b.ok, true);
        assert.equal(b.date, '2026-11-10');
        assert.equal(typeof b.approximate, 'boolean');
        assert.ok(['running', 'paused', 'stopped'].includes(b.recording.state));
        assert.equal(typeof b.span.spanMs, 'number');
        assert.equal(typeof b.span.segmentCount, 'number');
        assert.equal(b.counts.events, 2);
        assert.equal(b.counts.suppressed, 1);
        assert.equal(typeof b.counts.segments, 'number');
        assert.ok(Array.isArray(b.topApps));
        assert.ok(Array.isArray(b.ruler));
        for (const app of b.topApps) {
          assert.equal(typeof app.bundleId, 'string');
          assert.equal(typeof app.appName, 'string');
          assert.equal(typeof app.ms, 'number');
          assert.equal(typeof app.share, 'number');
          assert.equal(typeof app.eventCount, 'number');
          assert.ok(app.share >= 0 && app.share <= 1);
          assert.ok(Math.abs(app.share * 1000 - Math.round(app.share * 1000)) < 1e-9, 'share 应保留 3 位小数');
        }
        const shareSum = b.topApps.reduce((s, a) => s + a.share, 0);
        assert.ok(shareSum <= 1.001, `share 总和 ${shareSum} 应 ≤ 1`);
        for (const iv of b.ruler) {
          assert.equal(typeof iv.bundleId, 'string');
          assert.equal(typeof iv.appName, 'string');
          assert.equal(typeof iv.startMs, 'number');
          assert.equal(typeof iv.endMs, 'number');
          assert.ok(iv.startMs <= iv.endMs);
        }
      } finally {
        await httpApp.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('缺省 date = 今天（本地时区）', async () => {
    const home = tmpHome();
    const httpApp = await startHttp(home);
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = await httpApp.get('/api/overview');
      assert.equal(r.status, 200);
      assert.equal(r.body.date, today);
    } finally {
      await httpApp.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('只读：请求前后文件树不变（不建索引、不写任何文件）', async () => {
    const home = tmpHome();
    try {
      writeSegment(home, '2026-11-10T02-00-00.000Z', {
        start: localIso(2026, 11, 10, 10, 0), end: localIso(2026, 11, 10, 10, 10),
        events: [ev(localIso(2026, 11, 10, 10, 0), 'com.a', 'Alpha')],
      });
      writeConfig(home, { enabled: true });
      const before = snapshot(home);
      const httpApp = await startHttp(home);
      try {
        const r = await httpApp.get('/api/overview?date=2026-11-10');
        assert.equal(r.status, 200);
        assert.equal(r.body.counts.events, 1);
      } finally {
        await httpApp.close();
      }
      const after = snapshot(home);
      assert.deepEqual(after, before, 'overview 不得写入文件（含索引）');
      assert.ok(!after.some((entry) => /(^|\/)index[^/]*\.(db|sqlite|sqlite3)(\||$)/i.test(entry)), '不应出现索引文件');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑩ 性能冒烟 ----------

describe('性能冒烟', () => {
  test('150 段 × 20 事件（3000 事件）聚合 < 1000ms', () => {
    const home = tmpHome();
    try {
      const dayBase = localMs(2026, 11, 10, 0, 0);
      for (let segIdx = 0; segIdx < 150; segIdx += 1) {
        const startMs = dayBase + segIdx * 5 * 60_000; // 每段 5 分钟，覆盖 12.5h
        const events = [];
        for (let i = 0; i < 20; i += 1) {
          events.push(ev(new Date(startMs + i * 10_000).toISOString(), `com.app${i % 5}`, `App${i % 5}`));
        }
        writeSegment(home, `seg-${String(segIdx).padStart(3, '0')}`, {
          start: new Date(startMs).toISOString(),
          end: new Date(startMs + 5 * 60_000 - 1).toISOString(),
          events,
        });
      }
      const t0 = performance.now();
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 23) });
      const elapsed = performance.now() - t0;
      assert.equal(r.counts.events, 3000);
      assert.ok(r.counts.segments >= 1);
      assert.ok(elapsed < 1000, `聚合耗时 ${elapsed.toFixed(1)}ms 应 <1000ms`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑪ appName 兜底：区间由非 app-switch 事件起始时也要显示应用名 ----------

describe('overview appName 兜底', () => {
  test('同 bundle 的 appName 只出现在后续 app-switch 时，topApps/ruler 也能补名', () => {
    const home = tmpHome();
    try {
      writeConfig(home, { enabled: true });
      const day = localMs(2026, 11, 10, 0);
      writeSegment(home, 'seg-name-fallback', {
        start: localIso(2026, 11, 10, 9, 0),
        end: localIso(2026, 11, 10, 9, 10),
        events: [
          // Terminal 的区间先从 window-change 开始（没有 appName）
          { ts: localIso(2026, 11, 10, 9, 0), type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: 'zsh' } },
          { ts: localIso(2026, 11, 10, 9, 2), type: 'url-change', data: { bundleId: 'com.apple.Terminal' } },
          // 之后才出现带 appName 的 app-switch（真实事件里只有 app-switch 带 appName）
          ev(localIso(2026, 11, 10, 9, 3), 'com.apple.Terminal', '终端'),
          ev(localIso(2026, 11, 10, 9, 5), 'com.example.unknown'),
        ],
      });
      const r = buildOverview(home, { date: '2026-11-10', now: day + 23 * 3600_000 });
      const terminal = r.topApps.find((a) => a.bundleId === 'com.apple.Terminal');
      assert.ok(terminal, 'Terminal 应在 topApps 中');
      assert.equal(terminal.appName, '终端', '即使区间由 window-change 起始，也应补上应用名');
      const unknown = r.topApps.find((a) => a.bundleId === 'com.example.unknown');
      if (unknown) assert.equal(unknown.appName, 'com.example.unknown', '完全无名字时回退 bundleId，不能是空串');
      const rulerTerminal = r.ruler.filter((x) => x.bundleId === 'com.apple.Terminal');
      assert.ok(rulerTerminal.length >= 1, 'Terminal 应出现在 ruler 中');
      for (const x of rulerTerminal) assert.equal(x.appName, '终端', 'ruler 里的 appName 也不能为空');
      for (const x of r.ruler) assert.ok(x.appName && x.appName.length > 0, 'ruler 不允许空 appName');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑫ 跨段空档不得计入应用时长（收盘/关机 gap） ----------

describe('overview 跨段空档', () => {
  test('已关闭段与段之间的空档不计入任何应用驻留时长', () => {
    const home = tmpHome();
    try {
      writeConfig(home, { enabled: true });
      const mkEvents = (h) => {
        const out = [];
        for (let i = 0; i < 10; i += 1) {
          out.push(ev(localIso(2026, 11, 10, h, i, 0), 'com.example.X', 'X'));
        }
        return out;
      };
      writeSegment(home, 'seg-gap-a', { start: localIso(2026, 11, 10, 9, 0), end: localIso(2026, 11, 10, 9, 10), events: mkEvents(9) });
      writeSegment(home, 'seg-gap-b', { start: localIso(2026, 11, 10, 10, 0), end: localIso(2026, 11, 10, 10, 10), events: mkEvents(10) });
      const r = buildOverview(home, { date: '2026-11-10', now: localMs(2026, 11, 10, 23) });
      const x = r.topApps.find((a) => a.bundleId === 'com.example.X');
      assert.ok(x, 'X 应在 topApps');
      // 每段：前 9 条各驻留 60s、最后一条关闭段记 0 → 540s；两段合计 18 分钟。
      // 绝不该把 09:10→10:00 的 50 分钟空档算进去（错误实现会得到 ~68 分钟）。
      assert.ok(x.ms >= 1_020_000, `应约 18 分钟，实际 ${x.ms}ms`);
      assert.ok(x.ms <= 1_200_000, `跨段空档不得计入，实际 ${x.ms}ms（应 ≤20 分钟）`);
      for (const a of r.topApps) assert.ok(a.ms < 25 * 60_000, `${a.bundleId} 时长 ${a.ms}ms 异常（可能算了段间空档）`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
