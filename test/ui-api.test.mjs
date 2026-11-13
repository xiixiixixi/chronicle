// test/ui-api.test.mjs — 新 Web UI 依赖的只读 API：
//   /api/app-icon（缓存/单飞/负缓存/校验/跨站拦截）、/api/overview 的 segments + activity、
//   /api/summaries 的 startMs/spanMs + date/q/limit、/api/days、/api/model/config presets、/api/integrations iconApp。
// 全部使用临时 home 与假渲染器，绝不调用真实 osascript。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHttpApp, buildOverview } from '../daemon.mjs';
import { createAppIconService } from '../shared/app-icons.mjs';
import { MODEL_PRESETS } from '../shared/model-config.mjs';

const MIN = 60 * 1000;
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-ui-api-'));
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

function stubDaemon() {
  return {
    binary: '/stub/chronicle-daemon',
    proc: () => null,
    async request(cmd) {
      if (cmd === 'status') return { running: false, paused: false, currentSegment: null, totalEvents: 0, config: {} };
      return { ok: true };
    },
  };
}

/** 假渲染器：记录调用；found=false 时模拟应用不存在；delayMs 用于验证单飞。 */
function fakeRenderer({ found = true, delayMs = 0, bytes = PNG_BYTES } = {}) {
  const calls = [];
  const renderer = async (target, outFile, size) => {
    calls.push({ target, outFile, size });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (!found) return false;
    writeFileSync(outFile, bytes);
    return true;
  };
  return { renderer, calls };
}

async function startHttp(home, opts = {}) {
  const server = createHttpApp({ daemon: stubDaemon(), home, ...opts });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const fetchJson = async (p, init) => {
    const r = await fetch(base + p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  /** 原始请求：可自定义 Host 等受限头。 */
  const raw = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, port, fetchJson, raw, close };
}

const segName = (ms) => new Date(ms).toISOString().replace(/:/g, '-');

function mkSeg(home, startMs, endMs, events) {
  const name = segName(startMs);
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const meta = { segmentStart: new Date(startMs).toISOString(), eventCount: events.length };
  if (endMs !== null) meta.segmentEnd = new Date(endMs).toISOString();
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
  return name;
}

const ev = (ms, type, data) => ({ ts: new Date(ms).toISOString(), type, data });

// ---------- /api/app-icon ----------

describe('GET /api/app-icon', () => {
  test('200 image/png + 缓存头；第二次直接读磁盘缓存，不再调用渲染器', async () => {
    const home = tmpHome();
    const fake = fakeRenderer();
    const h = await startHttp(home, { appIconRenderer: fake.renderer });
    try {
      const first = await h.raw('/api/app-icon?bundleId=com.example.App', { host: `127.0.0.1:${h.port}` });
      assert.equal(first.status, 200);
      assert.equal(first.headers['content-type'], 'image/png');
      assert.equal(first.headers['cache-control'], 'private, max-age=86400');
      assert.ok(first.body.equals(PNG_BYTES));
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(fake.calls[0].target, { bundleId: 'com.example.App' });
      assert.equal(fake.calls[0].size, 128);

      const dir = path.join(home, 'cache', 'app-icons');
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.ok(existsSync(path.join(dir, 'b-com.example.App.png')));

      const second = await fetch(`${h.base}/api/app-icon?bundleId=com.example.App`);
      assert.equal(second.status, 200);
      assert.ok(Buffer.from(await second.arrayBuffer()).equals(PNG_BYTES));
      assert.equal(fake.calls.length, 1, '缓存命中不应再渲染');

      const byName = await fetch(`${h.base}/api/app-icon?app=${encodeURIComponent('Visual Studio Code')}`);
      assert.equal(byName.status, 200);
      assert.deepEqual(fake.calls[1].target, { app: 'Visual Studio Code' });
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('并发同键只渲染一次（单飞）', async () => {
    const home = tmpHome();
    const fake = fakeRenderer({ delayMs: 50 });
    const h = await startHttp(home, { appIconRenderer: fake.renderer });
    try {
      const rs = await Promise.all([1, 2, 3].map(() => fetch(`${h.base}/api/app-icon?app=Finder`)));
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
      assert.equal(fake.calls.length, 1);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('渲染器返回 false → 404 JSON；负缓存阻止重复渲染', async () => {
    const home = tmpHome();
    const fake = fakeRenderer({ found: false });
    const h = await startHttp(home, { appIconRenderer: fake.renderer });
    try {
      const a = await h.fetchJson('/api/app-icon?bundleId=com.example.Missing');
      assert.equal(a.status, 404);
      assert.equal(a.body.ok, false);
      const b = await h.fetchJson('/api/app-icon?bundleId=com.example.Missing');
      assert.equal(b.status, 404);
      assert.equal(fake.calls.length, 1, '10 分钟内的未命中不应再次渲染');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('非 PNG 输出不缓存、按未找到处理', async () => {
    const home = tmpHome();
    const fake = fakeRenderer({ bytes: Buffer.from('not a png') });
    const h = await startHttp(home, { appIconRenderer: fake.renderer });
    try {
      const r = await h.fetchJson('/api/app-icon?bundleId=com.example.Bad');
      assert.equal(r.status, 404);
      assert.ok(!existsSync(path.join(home, 'cache', 'app-icons', 'b-com.example.Bad.png')));
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('400：缺参、两参同给、非法 bundleId / app 名称', async () => {
    const home = tmpHome();
    const fake = fakeRenderer();
    const h = await startHttp(home, { appIconRenderer: fake.renderer });
    try {
      for (const q of [
        '',
        '?bundleId=com.example.App&app=Finder',
        '?bundleId=',
        '?bundleId=..%2F..%2Fetc',
        '?bundleId=.hidden',
        `?bundleId=${'a'.repeat(256)}`,
        '?app=',
        '?app=.hidden',
        '?app=a%2Fb',
        `?app=${'x'.repeat(81)}`,
      ]) {
        const r = await h.fetchJson(`/api/app-icon${q}`);
        assert.equal(r.status, 400, `${q} 应 400`);
        assert.equal(r.body.ok, false);
      }
      const unicode = await h.fetchJson(`/api/app-icon?app=${encodeURIComponent('微信 Beta_2.0')}`);
      assert.notEqual(unicode.status, 400, 'Unicode 字母应被接受');
      assert.equal(fake.calls.length, 1);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('403：跨站 Sec-Fetch-Site、非本地 Host；same-origin / none 放行', async () => {
    const home = tmpHome();
    const fake = fakeRenderer();
    const h = await startHttp(home, { appIconRenderer: fake.renderer });
    try {
      const host = `127.0.0.1:${h.port}`;
      for (const site of ['cross-site', 'same-site']) {
        const r = await h.raw('/api/app-icon?bundleId=com.example.App', { host, 'sec-fetch-site': site });
        assert.equal(r.status, 403, `Sec-Fetch-Site: ${site}`);
        assert.equal(JSON.parse(r.body.toString()).ok, false);
      }
      const evilHost = await h.raw('/api/app-icon?bundleId=com.example.App', { host: 'evil.example:80' });
      assert.equal(evilHost.status, 403);
      assert.equal(fake.calls.length, 0);
      for (const site of ['same-origin', 'none']) {
        const r = await h.raw('/api/app-icon?bundleId=com.example.App', { host: `localhost:${h.port}`, 'sec-fetch-site': site });
        assert.equal(r.status, 200, `Sec-Fetch-Site: ${site}`);
      }
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('服务层：缓存超过 7 天重新渲染；负缓存 10 分钟后过期', async () => {
    const home = tmpHome();
    let nowMs = Date.now();
    const fake = fakeRenderer();
    const svc = createAppIconService({ home, renderer: fake.renderer, now: () => nowMs });
    try {
      const a = await svc.get({ bundleId: 'com.example.App' });
      assert.equal(a.status, 200);
      utimesSync(a.file, new Date(nowMs), new Date(nowMs));
      nowMs += 6 * 24 * 60 * MIN;
      await svc.get({ bundleId: 'com.example.App' });
      assert.equal(fake.calls.length, 1);
      nowMs += 2 * 24 * 60 * MIN;
      await svc.get({ bundleId: 'com.example.App' });
      assert.equal(fake.calls.length, 2, '超过 7 天应重新渲染');

      const missing = fakeRenderer({ found: false });
      const svc2 = createAppIconService({ home, renderer: missing.renderer, now: () => nowMs });
      assert.equal((await svc2.get({ app: 'Nope' })).status, 404);
      nowMs += 9 * MIN;
      assert.equal((await svc2.get({ app: 'Nope' })).status, 404);
      assert.equal(missing.calls.length, 1);
      nowMs += 2 * MIN;
      await svc2.get({ app: 'Nope' });
      assert.equal(missing.calls.length, 2, '负缓存过期后应重试');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- /api/overview：segments + activity ----------

describe('GET /api/overview segments / activity', () => {
  const t0 = new Date(2026, 10, 10, 10, 0, 0, 0).getTime(); // 本地 10:00（5 分钟桶边界）
  const dayStart = new Date(2026, 10, 10, 0, 0, 0, 0).getTime();

  function seedDay(home) {
    const early = mkSeg(home, t0 - 2 * 60 * MIN, t0 - 2 * 60 * MIN + 5 * MIN, [
      ev(t0 - 2 * 60 * MIN + MIN, 'window-change', { bundleId: 'com.example.Editor', windowTitle: 'x' }),
    ]);
    const main = mkSeg(home, t0 - MIN, t0 + 12 * MIN, [
      ev(t0, 'click', { bundleId: 'com.google.Chrome', appName: 'Chrome' }),
      ev(t0 + MIN, 'window-change', { bundleId: 'com.apple.Terminal', appName: 'Terminal', windowTitle: 'zsh' }),
      ev(t0 + 10 * MIN, 'ax-snapshot', { bundleId: 'com.apple.Terminal' }),
    ]);
    const otherDay = mkSeg(home, t0 + 24 * 60 * MIN, t0 + 24 * 60 * MIN + 10 * MIN, [
      ev(t0 + 24 * 60 * MIN + MIN, 'click', { bundleId: 'com.google.Chrome', appName: 'Chrome' }),
    ]);
    return { early, main, otherDay };
  }

  test('activity：输入后 5 分钟内算亲手操作，其余仅可见；桶按本地零点 5 分钟对齐', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      seedDay(home);
      const r = await h.fetchJson('/api/overview?date=2026-11-10');
      assert.equal(r.status, 200);
      const a = r.body.activity;
      assert.equal(a.bucketMs, 5 * MIN);
      assert.equal(a.idleMs, 5 * MIN);
      assert.equal(a.activeMs, 5 * MIN, '1 分钟 Chrome + 4 分钟 Terminal');
      assert.equal(a.firstActiveMs, t0);
      assert.equal(a.lastActiveMs, t0);
      assert.deepEqual(a.apps, [
        { bundleId: 'com.apple.Terminal', appName: 'Terminal', activeMs: 4 * MIN },
        { bundleId: 'com.google.Chrome', appName: 'Chrome', activeMs: MIN },
      ]);
      for (const b of a.buckets) assert.equal((b.startMs - dayStart) % (5 * MIN), 0, '桶起点对齐本地零点');
      const byStart = Object.fromEntries(a.buckets.map((b) => [b.startMs, b]));
      assert.deepEqual(byStart[t0], { startMs: t0, bundleId: 'com.apple.Terminal', appName: 'Terminal', activeMs: 5 * MIN, seenMs: 5 * MIN });
      assert.deepEqual(byStart[t0 + 5 * MIN], { startMs: t0 + 5 * MIN, bundleId: 'com.apple.Terminal', appName: 'Terminal', activeMs: 0, seenMs: 5 * MIN });
      // 早段只有 window-change（无输入）→ 仅可见；桶升序且只含 seenMs>0
      const earlyBucket = a.buckets.find((b) => b.startMs < t0);
      assert.ok(earlyBucket);
      assert.equal(earlyBucket.activeMs, 0);
      assert.ok(earlyBucket.seenMs > 0);
      assert.deepEqual(a.buckets.map((b) => b.startMs), [...a.buckets.map((b) => b.startMs)].sort((x, y) => x - y));
      assert.ok(a.buckets.every((b) => b.seenMs > 0 && b.activeMs <= b.seenMs));
      // 旧字段保持
      for (const key of ['ok', 'date', 'approximate', 'recording', 'span', 'counts', 'topApps', 'ruler']) {
        assert.ok(key in r.body, `保留 ${key}`);
      }
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('activity：持续输入延长 active；跨桶拆分', () => {
    const home = tmpHome();
    try {
      mkSeg(home, t0, t0 + 20 * MIN, [
        ev(t0 + 2 * MIN, 'text-input', { bundleId: 'com.example.Editor', appName: 'Editor' }),
        ev(t0 + 6 * MIN, 'scroll', { bundleId: 'com.example.Editor' }),
        ev(t0 + 15 * MIN, 'focus-change', { bundleId: 'com.example.Editor' }),
        ev(t0 + 18 * MIN, 'window-change', { bundleId: 'com.example.Editor' }),
      ]);
      const o = buildOverview(home, { date: '2026-11-10', now: t0 + 24 * 60 * MIN });
      // [2,6) active 4m；[6,15) active 到 11 → 5m；[15,18) 仅可见
      assert.equal(o.activity.activeMs, 9 * MIN);
      assert.equal(o.activity.firstActiveMs, t0 + 2 * MIN);
      assert.equal(o.activity.lastActiveMs, t0 + 6 * MIN);
      assert.deepEqual(o.activity.buckets.map((b) => [b.startMs - t0, b.activeMs, b.seenMs]), [
        [0, 3 * MIN, 3 * MIN],
        [5 * MIN, 5 * MIN, 5 * MIN],
        [10 * MIN, MIN, 5 * MIN],
        [15 * MIN, 0, 3 * MIN],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('activity：换段时补的同应用 app-switch 不算亲手操作，真的换应用才算', () => {
    const home = tmpHome();
    try {
      // 无人值守：守护每段开头给仍在前台的 Ghostty 补一条 app-switch
      mkSeg(home, t0, t0 + 10 * MIN, [
        ev(t0, 'app-switch', { bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty' }),
        ev(t0 + 1000, 'window-change', { bundleId: 'com.mitchellh.ghostty' }),
      ]);
      mkSeg(home, t0 + 10 * MIN, t0 + 20 * MIN, [
        ev(t0 + 10 * MIN, 'app-switch', { bundleId: 'com.mitchellh.ghostty', appName: 'Ghostty' }),
        ev(t0 + 12 * MIN, 'app-switch', { bundleId: 'com.google.Chrome', appName: 'Chrome' }),
        ev(t0 + 19 * MIN, 'window-change', { bundleId: 'com.google.Chrome' }),
      ]);
      const o = buildOverview(home, { date: '2026-11-10', now: t0 + 24 * 60 * MIN });
      assert.equal(o.activity.firstActiveMs, t0 + 12 * MIN);
      assert.equal(o.activity.activeMs, 5 * MIN);
      assert.deepEqual(o.activity.apps, [{ bundleId: 'com.google.Chrome', appName: 'Chrome', activeMs: 5 * MIN }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('segments：当天相交的段，升序；open 段 endMs=null', () => {
    const home = tmpHome();
    try {
      const { early, main } = seedDay(home);
      const openName = mkSeg(home, t0 + 60 * MIN, null, [ev(t0 + 61 * MIN, 'click', { bundleId: 'com.google.Chrome' })]);
      const o = buildOverview(home, { date: '2026-11-10', now: t0 + 70 * MIN });
      assert.deepEqual(o.segments, [
        { segment: early, startMs: t0 - 120 * MIN, endMs: t0 - 115 * MIN, eventCount: 1, open: false },
        { segment: main, startMs: t0 - MIN, endMs: t0 + 12 * MIN, eventCount: 3, open: false },
        { segment: openName, startMs: t0 + 60 * MIN, endMs: null, eventCount: 1, open: true },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- /api/summaries：startMs/spanMs + date/q/limit ----------

describe('GET /api/summaries 过滤', () => {
  const at = (d, hh, mm = 0) => new Date(2026, 10, d, hh, mm, 0, 0).getTime();

  function writeSummary(home, file, { type, segment, title, body, description }) {
    mkdirSync(path.join(home, 'summaries'), { recursive: true });
    const fm = ['---', `title: ${JSON.stringify(title)}`, `segment: ${JSON.stringify(segment)}`, `type: ${JSON.stringify(type)}`];
    if (description) fm.push(`description: ${JSON.stringify(description)}`);
    fm.push('---');
    writeFileSync(path.join(home, 'summaries', file), `${fm.join('\n')}\n\n${body}`);
  }

  function seed(home) {
    const s10a = segName(at(10, 10));
    const s10b = segName(at(10, 15, 30));
    const s11 = segName(at(11, 9));
    writeSummary(home, `10min-${s10a}.md`, { type: '10min', segment: s10a, title: '上午编码', body: '- 调试 daemon' });
    writeSummary(home, `10min-${s10b}.md`, { type: '10min', segment: s10b, title: '下午设计', body: '- 在 Figma 画稿', description: '界面评审' });
    writeSummary(home, `10min-${s11}.md`, { type: '10min', segment: s11, title: '次日', body: '- 其它' });
    // 前一晚 20:00 开始的 6h 桶覆盖到 11-10 凌晨 2:00 → 应出现在 11-10
    writeSummary(home, '6h-prev-evening.md', { type: '6h', segment: new Date(at(9, 20)).toISOString(), title: '晚间汇总', body: '- 夜里跑任务' });
    // 11-09 12:00–18:00 → 不应出现在 11-10
    writeSummary(home, '6h-prev-noon.md', { type: '6h', segment: new Date(at(9, 12)).toISOString(), title: '午后汇总', body: '- 会议' });
    return { s10a, s10b, s11 };
  }

  test('无参数：形状与顺序不变，补 startMs/spanMs', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const { s10a } = seed(home);
      const r = await h.fetchJson('/api/summaries');
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.summaries.length, 5);
      const byFile = Object.fromEntries(r.body.summaries.map((s) => [s.filename, s]));
      assert.equal(byFile[`10min-${s10a}.md`].startMs, at(10, 10));
      assert.equal(byFile[`10min-${s10a}.md`].spanMs, 10 * MIN);
      assert.equal(byFile['6h-prev-evening.md'].startMs, at(9, 20));
      assert.equal(byFile['6h-prev-evening.md'].spanMs, 6 * 60 * MIN);
      assert.ok('description' in byFile[`10min-${s10a}.md`] && 'nextActions' in byFile[`10min-${s10a}.md`]);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('date：按本地日时间窗重叠过滤（含前一晚 6h 桶）；q；limit；坏 date 400', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const { s10a, s10b } = seed(home);
      const day = await h.fetchJson('/api/summaries?date=2026-11-10');
      assert.equal(day.status, 200);
      assert.deepEqual(day.body.summaries.map((s) => s.filename), [`10min-${s10b}.md`, `10min-${s10a}.md`, '6h-prev-evening.md']);
      assert.equal(day.body.summaries.length, 3);
      assert.ok(!day.body.summaries.some((s) => s.filename === '6h-prev-noon.md'));

      const q = await h.fetchJson('/api/summaries?q=%20figma%20');
      assert.deepEqual(q.body.summaries.map((s) => s.filename), [`10min-${s10b}.md`]);
      const qDesc = await h.fetchJson(`/api/summaries?q=${encodeURIComponent('界面评审')}`);
      assert.deepEqual(qDesc.body.summaries.map((s) => s.filename), [`10min-${s10b}.md`]);
      const qEmpty = await h.fetchJson('/api/summaries?q=%20');
      assert.equal(qEmpty.body.summaries.length, 5);

      const all = await h.fetchJson('/api/summaries');
      const limited = await h.fetchJson('/api/summaries?limit=2');
      assert.deepEqual(limited.body.summaries.map((s) => s.filename), all.body.summaries.slice(0, 2).map((s) => s.filename));
      const combo = await h.fetchJson('/api/summaries?date=2026-11-10&limit=1');
      assert.equal(combo.body.summaries.length, 1);
      assert.equal(combo.body.summaries[0].filename, day.body.summaries[0].filename);

      const bad = await h.fetchJson('/api/summaries?date=2026-13-40');
      assert.equal(bad.status, 400);
      assert.equal(bad.body.ok, false);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- /api/days、presets、iconApp ----------

describe('GET /api/days · /api/model/config presets · /api/integrations iconApp', () => {
  test('/api/days：按段起点本地日分组，新→旧，段数与事件数', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const d10 = new Date(2026, 10, 10, 9, 0, 0, 0).getTime();
      const d12 = new Date(2026, 10, 12, 23, 50, 0, 0).getTime();
      mkSeg(home, d10, d10 + 10 * MIN, [ev(d10 + MIN, 'click', {}), ev(d10 + 2 * MIN, 'scroll', {})]);
      mkSeg(home, d10 + 60 * MIN, d10 + 70 * MIN, [ev(d10 + 61 * MIN, 'click', {})]);
      mkSeg(home, d12, null, [ev(d12 + MIN, 'click', {})]);
      const r = await h.fetchJson('/api/days');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        ok: true,
        days: [
          { date: '2026-11-12', segments: 1, events: 1 },
          { date: '2026-11-10', segments: 2, events: 3 },
        ],
      });
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('/api/model/config：presets 按 MODEL_PRESETS 顺序，字段齐全且不含 key 信息', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const r = await h.fetchJson('/api/model/config');
      assert.equal(r.status, 200);
      assert.ok(r.body.config && typeof r.body.config === 'object', '保留 config');
      assert.deepEqual(r.body.presets.map((p) => p.id), Object.keys(MODEL_PRESETS));
      for (const p of r.body.presets) {
        assert.deepEqual(Object.keys(p).sort(), ['baseUrl', 'id', 'keyOptional', 'label', 'model', 'models', 'note']);
        const src = MODEL_PRESETS[p.id];
        assert.deepEqual(p, { id: src.id, label: src.label, baseUrl: src.baseUrl, model: src.model, models: src.models, keyOptional: src.keyOptional, note: src.note });
      }
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('/api/integrations：每个工具带 iconApp', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const r = await h.fetchJson('/api/integrations');
      const byId = Object.fromEntries(r.body.tools.map((t) => [t.id, t.iconApp]));
      const c = 'Clau' + 'de';
      assert.deepEqual(byId, {
        [`${c.toLowerCase()}-code`]: c,
        [`${c.toLowerCase()}-desktop`]: c,
        cursor: 'Cursor',
        ['co' + 'dex']: 'Co' + 'dex',
        vscode: 'Visual Studio Code',
      });
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
