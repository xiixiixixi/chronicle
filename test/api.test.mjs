// test/api.test.mjs — 批次 2 新增 HTTP API 测试
//
// 覆盖（文件型端点直接造数据，不起采集守护；控制类透传用桩 daemon）：
//   ① /api/summaries 列表与 /api/summaries/:file 读取（含路径穿越拒绝）
//   ② /api/search 跨段搜索（大小写、limit 截断、缺参 400）
//   ③ /api/config GET / PUT（合法写入持久化 + 采集热重启；非法规则 400）
//   ④ DELETE /api/history（清空段落与摘要；采集在跑则 stop→clear→start）
//   ⑤ 静态资源 /app.js /style.css（白名单 + content-type）
//   ⑥ 品牌词零命中（被禁词表见下，拼串构造避免自命中——
//      唯一豁免："openai-compatible" 是规格点名的 provider 协议名）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpApp, clearHistory } from '../daemon.mjs';
import { defaultConfig } from '../shared/privacy.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-api-'));

/** 桩 daemon：记录调用；status 可配置，其余返回 ok。 */
function stubDaemon({ running = false } = {}) {
  const calls = [];
  return {
    calls,
    binary: '/stub/chronicle-daemon',
    proc: () => null,
    async request(cmd, params = {}) {
      calls.push({ cmd, params });
      if (cmd === 'status') return { running, paused: false, currentSegment: null, totalEvents: 0, config: {} };
      return { ok: true, pausedAt: '2026-10-19T00:00:00.000Z', resumedAt: '2026-10-19T00:00:00.000Z' };
    },
  };
}

async function startHttp(daemon, home) {
  const server = createHttpApp({ daemon, home });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchJson = async (p, init) => {
    const r = await fetch(base + p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const fetchText = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.text(), contentType: r.headers.get('content-type') };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, fetchJson, fetchText, close };
}

/** 造一个已关闭的段。 */
function mkSeg(home, name, events) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ segmentStart: '2026-10-19T02:00:00.000Z', segmentEnd: '2026-10-19T02:10:00.000Z', eventCount: events.length }));
}

/** 造样例数据：两段事件 + 两份摘要 + 默认 config。 */
function seed(home) {
  mkSeg(home, '2026-10-19T02-00-00.000Z', [
    { ts: '2026-10-19T02:01:00.000Z', type: 'app-switch', data: { bundleId: 'com.google.Chrome', appName: 'Chrome', pid: 2 } },
    { ts: '2026-10-19T02:02:00.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://github.com/chronicle' } },
  ]);
  mkSeg(home, '2026-10-18T20-10-00.000Z', [
    { ts: '2026-10-18T20:11:00.000Z', type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: 'GitHub work — zsh' } },
  ]);
  mkdirSync(path.join(home, 'summaries'), { recursive: true });
  writeFileSync(path.join(home, 'summaries', '10min-2026-10-19T02-00-00.000Z.md'),
    '---\ntitle: "10:00-10:10 编码"\napplications: ["com.google.Chrome"]\nsegment: "2026-10-19T02-00-00.000Z"\ntype: "10min"\n---\n\n## 活动摘要\n- 查仓库');
  writeFileSync(path.join(home, 'summaries', '6h-2026-10-19T00.md'),
    '---\ntitle: "08:00-14:00 汇总"\nsegment: "2026-10-19T00:00:00.000Z"\ntype: "6h"\n---\n\n## 活动摘要\n- 编码为主');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
}

// ---------- ① 摘要端点 ----------

describe('HTTP /api/summaries', () => {
  test('列表：解析 frontmatter，新→旧；单文件读取返回全文', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      const list = await http.fetchJson('/api/summaries');
      assert.equal(list.status, 200);
      assert.equal(list.body.summaries.length, 2);
      const first = list.body.summaries[0]; // segment 02:00 > 00:00
      assert.equal(first.filename, '10min-2026-10-19T02-00-00.000Z.md');
      assert.equal(first.type, '10min');
      assert.equal(first.title, '10:00-10:10 编码');
      assert.deepEqual(first.applications, ['com.google.Chrome']);
      assert.match(first.body, /查仓库/);
      assert.equal(list.body.summaries[1].type, '6h');

      const one = await http.fetchJson('/api/summaries/10min-2026-10-19T02-00-00.000Z.md');
      assert.equal(one.status, 200);
      assert.equal(one.body.filename, '10min-2026-10-19T02-00-00.000Z.md');
      assert.match(one.body.markdown, /^---\ntitle: "10:00-10:10 编码"/);

      const missing = await http.fetchJson('/api/summaries/no-such.md');
      assert.equal(missing.status, 404);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('路径穿越与非法文件名拒绝（%2f 编码、无扩展名）', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      for (const p of ['/api/summaries/x%2f..%2fconfig.json', '/api/summaries/..%2e%2econfig', '/api/summaries/README']) {
        const r = await http.fetchJson(p);
        assert.equal(r.status, 404, `${p} 应 404`);
      }
      assert.ok(existsSync(path.join(home, 'config.json'))); // config 未被读漏
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ② 搜索 ----------

describe('HTTP /api/search', () => {
  test('跨段命中（大小写不敏感），新→旧；limit 截断标 capped；缺 q 400', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      const r = await http.fetchJson('/api/search?q=github');
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 2);
      assert.equal(r.body.capped, false);
      // 新→旧：02:02 的 url-change 在 20:11 的 window-change 之前
      assert.equal(r.body.events[0].data.url, 'https://github.com/chronicle');
      assert.equal(r.body.events[1].data.windowTitle, 'GitHub work — zsh');

      const one = await http.fetchJson('/api/search?q=GITHUB&limit=1');
      assert.equal(one.body.count, 1);
      assert.equal(one.body.capped, true);

      const term = await http.fetchJson('/api/search?q=Terminal');
      assert.equal(term.body.count, 1);
      assert.equal(term.body.events[0].segment, '2026-10-18T20-10-00.000Z');

      assert.equal((await http.fetchJson('/api/search')).status, 400);
      assert.equal((await http.fetchJson('/api/search?q=')).status, 400);
      assert.equal((await http.fetchJson('/api/search?q=nonsense-no-hit')).body.count, 0);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ③ 配置 ----------

describe('HTTP /api/config', () => {
  test('GET 返回现有配置；PUT 合法 → 持久化并 merge 未知键', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      const before = await http.fetchJson('/api/config');
      assert.equal(before.status, 200);
      assert.deepEqual(before.body.config.blocklist, defaultConfig().blocklist);

      const put = await http.fetchJson('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ blocklist: [{ scope: 'url', value: '*secret.example*' }], includeURLs: false }),
      });
      assert.equal(put.status, 200);
      assert.equal(put.body.applied, false); // 桩 daemon 未在跑
      const onDisk = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.deepEqual(onDisk.blocklist, [{ scope: 'url', value: '*secret.example*' }]);
      assert.equal(onDisk.includeURLs, false);
      assert.deepEqual(onDisk.allowlist, []);       // 未传的键保留旧值
      assert.equal(onDisk.enabled, true);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('PUT 非法规则 → 400 + errors；合法但采集在跑 → stop/start 热重启', async () => {
    const home = tmpHome();
    const daemon = stubDaemon({ running: true });
    const http = await startHttp(daemon, home);
    try {
      seed(home);
      const bad = await http.fetchJson('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ blocklist: 'nope' }),
      });
      assert.equal(bad.status, 400);
      assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length > 0);
      assert.equal(daemon.calls.length, 0); // 校验失败不碰守护

      const badRule = await http.fetchJson('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ allowlist: [{ scope: 'weird', value: 'x' }] }),
      });
      assert.equal(badRule.status, 400);

      const good = await http.fetchJson('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ blocklist: [{ scope: 'app', value: 'com.x.*' }] }),
      });
      assert.equal(good.status, 200);
      assert.equal(good.body.applied, true);
      assert.deepEqual(daemon.calls.map((c) => c.cmd), ['status', 'stop', 'start']);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ④ 清历史 ----------

describe('HTTP /api/history（DELETE）', () => {
  test('清空段落与摘要（目录保留、config/Helper.app 不动）；采集在跑则 stop→clear→start', async () => {
    const home = tmpHome();
    const daemon = stubDaemon({ running: true });
    const http = await startHttp(daemon, home);
    try {
      seed(home);
      mkdirSync(path.join(home, 'Chronicle Helper.app', 'Contents', 'MacOS'), { recursive: true });

      const r = await http.fetchJson('/api/history', { method: 'DELETE' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.removedSegments, 2);
      assert.equal(r.body.removedSummaries, 2);
      assert.equal(r.body.restarted, true);
      assert.deepEqual(daemon.calls.map((c) => c.cmd), ['status', 'stop', 'start']);

      assert.deepEqual(readdirSync(path.join(home, 'segments')), []);   // 目录在、内容空
      assert.deepEqual(readdirSync(path.join(home, 'summaries')), []);
      assert.ok(existsSync(path.join(home, 'config.json')));
      assert.ok(existsSync(path.join(home, 'Chronicle Helper.app')));
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('clearHistory 纯函数：无 summaries 目录也能清', () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T02-00-00.000Z', []);
      const counts = clearHistory(home);
      assert.deepEqual(counts, { removedSegments: 1, removedSummaries: 0 });
      assert.deepEqual(readdirSync(path.join(home, 'summaries')), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑤ 静态资源 ----------

describe('静态资源', () => {
  test('/app.js /style.css 200 且 content-type 正确；白名单外 404', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      const js = await http.fetchText('/app.js');
      assert.equal(js.status, 200);
      assert.match(js.contentType, /text\/javascript/);
      assert.match(js.body, /Chronicle 时间线 UI/);

      const css = await http.fetchText('/style.css');
      assert.equal(css.status, 200);
      assert.match(css.contentType, /text\/css/);
      assert.match(css.body, /--amber:\s*#f59e0b/i);

      assert.equal((await http.fetchText('/../package.json')).status, 404); // URL 规范化到 /package.json → 白名单外
      assert.equal((await http.fetchText('/nope.js')).status, 404);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑥ 品牌词零命中 ----------

describe('品牌词零命中（红线）', () => {
  // 拼串构造被禁词，避免本测试文件自己成为命中点；唯一豁免："ope"+"nai-compatible"
  // 是批次 2 规格点名的 provider 协议名，文档示例一律用占位域名。
  const BANNED = [
    'c' + 'odex',
    'ope' + 'nai(?!-compatible)',
    'chat' + 'gpt',
    'anth' + 'ropic',
    'cla' + 'ude',
    '逆' + '向',
  ];
  const FILES = [
    'daemon.mjs', 'summarize.mjs', 'mcp-entry.mjs', 'setup.mjs', 'uninstall.mjs',
    'shared/privacy.mjs', 'shared/segments.mjs',
    'web/index.html', 'web/app.js', 'web/style.css',
    'swift/chronicle-daemon.swift', 'package.json',
    'test/daemon.test.mjs', 'test/summarize.test.mjs', 'test/api.test.mjs', 'test/mcp.test.mjs',
  ];

  test('源码与配置零命中', () => {
    for (const rel of FILES) {
      let text;
      try { text = readFileSync(path.resolve(rel), 'utf8'); } catch { continue; } // 文件可能不存在（如尚未写）
      for (const frag of BANNED) {
        const re = new RegExp(frag, 'i');
        assert.ok(!re.test(text), `${rel} 不得包含品牌词 /${frag}/i`);
      }
    }
  });
});
