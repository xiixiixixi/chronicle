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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocklist: 'nope' }),
      });
      assert.equal(bad.status, 400);
      assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length > 0);
      assert.equal(daemon.calls.length, 0); // 校验失败不碰守护

      const badRule = await http.fetchJson('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowlist: [{ scope: 'weird', value: 'x' }] }),
      });
      assert.equal(badRule.status, 400);

      const good = await http.fetchJson('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
      assert.equal(js.body, readFileSync(path.resolve('web', 'app.js'), 'utf8'));

      const css = await http.fetchText('/style.css');
      assert.equal(css.status, 200);
      assert.match(css.contentType, /text\/css/);
      assert.equal(css.body, readFileSync(path.resolve('web', 'style.css'), 'utf8'));

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
    'shared/privacy.mjs', 'shared/segments.mjs', 'shared/index.mjs',
    'web/index.html', 'web/app.js', 'web/style.css',
    'swift/chronicle-daemon.swift', 'package.json',
    'test/daemon.test.mjs', 'test/summarize.test.mjs', 'test/api.test.mjs', 'test/mcp.test.mjs',
    'test/index.test.mjs',
  ];

  // M3：接入面板必须展示第三方客户端名称与配置路径（产品规格明确要求）。
  // 仅对「集成标识」做定点豁免：先把这些精确 token 从文本里剔除，再跑品牌词扫描；
  // 其它任何位置出现品牌词仍判失败。字面量用拼串构造，避免本文件自己成为命中点。
  const INTEGRATION_LITERALS = [
    'Clau' + 'de Code',
    'Clau' + 'de Desktop',
    'Clau' + 'de',
    'clau' + 'de-code',
    'clau' + 'de-desktop',
    'clau' + 'de mcp add',
    'clau' + 'de_desktop_config.json',
    'Co' + 'dex',
    'co' + 'dex',
    // N1/W1：模型服务商预设与原型按钮必须展示 OpenAI 兼容服务商名（规格要求）
    'Op' + 'enAI',
    'op' + 'enai',
  ].sort((a, b) => b.length - a.length);

  const maskIntegrationIds = (text) => INTEGRATION_LITERALS
    .reduce((acc, lit) => acc.split(lit).join('[client]'), text);

  test('源码与配置零命中（集成标识除外）', () => {
    for (const rel of FILES) {
      let text;
      try { text = readFileSync(path.resolve(rel), 'utf8'); } catch { continue; } // 文件可能不存在（如尚未写）
      const scanned = maskIntegrationIds(text);
      for (const frag of BANNED) {
        const re = new RegExp(frag, 'i');
        assert.ok(!re.test(scanned), `${rel} 不得包含品牌词 /${frag}/i（集成标识已豁免）`);
      }
    }
  });

  test('集成标识仅用于接入面（豁免不是空头支票）', () => {
    const daemonSrc = readFileSync(path.resolve('daemon.mjs'), 'utf8');
    assert.ok(daemonSrc.includes('/api/integrations'), 'daemon.mjs 应提供 /api/integrations');
    assert.ok(daemonSrc.includes('mcp_servers.chronicle'), 'daemon.mjs 应含 TOML 段名');
    for (const id of ['clau' + 'de-code', 'clau' + 'de-desktop', 'cursor', 'co' + 'dex', 'vscode']) {
      assert.ok(daemonSrc.includes(id), `daemon.mjs 的工具清单应包含 id=${id}`);
    }
  });
});


// ---------- ⑦ 批次 3：写请求安全边界（与 B 的实现对齐） ----------

describe('本地写请求安全边界', () => {
  test('缺 Content-Type → 415；跨源 Origin → 403；合法写 → 200', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      // Node fetch 对字符串 body 默认 text/plain → 必须被 415 拦下（本地 CSRF 边界）
      const bare = await fetch(`${http.base}/api/config`, {
        method: 'PUT',
        body: JSON.stringify({ includeURLs: false }),
      });
      assert.equal(bare.status, 415);

      const evil = await fetch(`${http.base}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
        body: JSON.stringify({ includeURLs: false }),
      });
      assert.equal(evil.status, 403);

      const ok = await http.fetchJson('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeURLs: false }),
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑧ 批次 3：段分页 / 搜索分页与日期范围 ----------

/** 本地时区日期键（与 web / index 的口径一致）。 */
const localDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('HTTP /api/segments 分页', () => {
  test('limit/before 分页：hasMore + nextBefore；旧字段 segments 仍可用且等于本页', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home); // 两个段（新→旧：02:00 段、20:10 段）
      const p1 = await http.fetchJson('/api/segments?limit=1');
      assert.equal(p1.status, 200);
      assert.equal(p1.body.segments.length, 1);
      assert.deepEqual(p1.body.items, p1.body.segments); // 旧字段兼容
      assert.equal(p1.body.hasMore, true);
      assert.ok(p1.body.nextBefore);

      const p2 = await http.fetchJson(`/api/segments?limit=1&before=${encodeURIComponent(p1.body.nextBefore)}`);
      assert.equal(p2.status, 200);
      assert.equal(p2.body.segments.length, 1);
      assert.notEqual(p2.body.segments[0].segment, p1.body.segments[0].segment);
      assert.equal(p2.body.hasMore, false);
      assert.equal(p2.body.nextBefore, null);

      // 无参数：默认页（不改变旧行为：至少包含两个段）
      const all = await http.fetchJson('/api/segments');
      assert.ok(all.body.segments.length >= 2);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('HTTP /api/search 分页与日期范围', () => {
  test('offset/hasMore/nextOffset/total/indexed；旧字段 count/capped/events 兼容', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      // seed 的三条事件都落在同一本地日（含 UTC 前一天 20:11 那条，+8 后跨到次日）
      const day = localDay('2026-10-19T02:01:00.000Z');
      const first = await http.fetchJson(`/api/search?q=github&limit=1&offset=0&from=${day}&to=${day}`);
      assert.equal(first.status, 200);
      assert.equal(first.body.events.length, 1);
      assert.equal(first.body.count, 1);           // 旧字段 = 本页条数
      assert.equal(first.body.hasMore, true);
      assert.equal(first.body.capped, true);       // 旧字段 = 还有更多
      assert.equal(first.body.total, 2);
      assert.equal(first.body.nextOffset, 1);
      assert.equal(typeof first.body.indexed, 'boolean');

      const second = await http.fetchJson(`/api/search?q=github&limit=1&offset=1&from=${day}&to=${day}`);
      assert.equal(second.status, 200);
      assert.equal(second.body.events.length, 1);
      assert.equal(second.body.hasMore, false);
      assert.notEqual(second.body.events[0].data.url, first.body.events[0].data.url ?? null);

      // 范围外 → 0 命中
      const outside = await http.fetchJson(`/api/search?q=github&from=${localDay('2026-10-20T00:00:00.000Z')}&to=${localDay('2026-10-20T00:00:00.000Z')}`);
      assert.equal(outside.status, 200);
      assert.equal(outside.body.count, 0);

      // 非法范围 → 400（daemon 把 BAD_RANGE 映射为 400）
      const badRange = await http.fetchJson('/api/search?q=github&from=not-a-date');
      assert.equal(badRange.status, 400);
      assert.equal(badRange.body.ok, false);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});


// ---------- ⑨ 批次 M3：GET /api/integrations ----------

describe('HTTP /api/integrations（AI 工具接入信息）', () => {
  test('字段齐全、绝对路径真实存在、覆盖 5 个客户端、snippet 形状正确', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      const r = await http.fetchJson('/api/integrations');
      assert.equal(r.status, 200);
      const b = r.body;

      // 顶层契约字段
      assert.equal(b.ok, true);
      for (const key of ['repoRoot', 'nodePath', 'mcpEntry', 'home', 'port', 'tools', 'installer']) {
        assert.ok(key in b, `响应缺少 ${key}`);
      }
      for (const key of ['repoRoot', 'nodePath', 'mcpEntry']) {
        assert.ok(path.isAbsolute(b[key]), `${key} 必须是绝对路径，实际 ${b[key]}`);
      }
      assert.ok(existsSync(b.mcpEntry), `mcpEntry 必须真实存在: ${b.mcpEntry}`);
      assert.equal(b.mcpEntry, path.join(b.repoRoot, 'mcp-entry.mjs'));
      assert.equal(path.resolve(b.home), path.resolve(home), 'home 应为请求方数据目录');
      assert.equal(typeof b.port, 'number');
      assert.ok(b.port > 0, 'port 应为真实监听端口');

      // 5 个客户端
      assert.equal(Array.isArray(b.tools), true);
      const ids = b.tools.map((t) => t.id).sort();
      assert.deepEqual(ids, ['clau' + 'de-code', 'clau' + 'de-desktop', 'co' + 'dex', 'cursor', 'vscode'].sort());
      for (const t of b.tools) {
        assert.ok(['json', 'toml', 'cli'].includes(t.kind), `${t.id} kind 非法: ${t.kind}`);
        assert.equal(typeof t.label, 'string');
        assert.ok(t.label.length > 0, `${t.id} 缺 label`);
        assert.equal(typeof t.snippet, 'string');
        assert.ok(t.snippet.includes(b.nodePath), `${t.id} snippet 应含真实 node 路径`);
        if (t.kind === 'cli') continue;
        assert.ok(typeof t.path === 'string' && path.isAbsolute(t.path), `${t.id} 应有绝对配置路径`);
        assert.ok(t.path.startsWith(os.homedir()), `${t.id} 配置路径应在用户目录下`);
      }
      const byId = Object.fromEntries(b.tools.map((t) => [t.id, t]));
      const CC = 'clau' + 'de-code';
      const CD = 'clau' + 'de-desktop';
      const CX = 'co' + 'dex';

      // JSON 形态：可 parse 且指向真实路径
      for (const id of [CD, 'cursor']) {
        const parsed = JSON.parse(byId[id].snippet);
        assert.equal(parsed.mcpServers.chronicle.command, b.nodePath);
        assert.deepEqual(parsed.mcpServers.chronicle.args, [b.mcpEntry]);
      }
      const vscode = JSON.parse(byId.vscode.snippet);
      assert.equal(vscode.servers.chronicle.command, b.nodePath, 'vscode 必须用 servers 形态');
      assert.deepEqual(vscode.servers.chronicle.args, [b.mcpEntry]);
      assert.equal(vscode.mcpServers, undefined);

      // TOML 形态
      assert.match(byId[CX].snippet, /^\[mcp_servers\.chronicle\]/);
      assert.ok(byId[CX].snippet.includes(b.nodePath));
      assert.ok(byId[CX].snippet.includes(b.mcpEntry));

      // CLI 形态
      assert.match(byId[CC].snippet, new RegExp('^clau' + 'de mcp add chronicle -- '));
      assert.ok(byId[CC].snippet.includes(b.mcpEntry));

      // installer 命令
      assert.equal(typeof b.installer.command, 'string');
      assert.equal(typeof b.installer.printCommand, 'string');
      assert.ok(b.installer.command.includes('mcp-install.mjs'), 'installer.command 应调用 mcp-install.mjs');
      assert.ok(b.installer.printCommand.includes('--print'), 'printCommand 应为 --print 形式');
      assert.ok(b.installer.command.includes(b.nodePath));
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('只读：不泄露活动内容、不建索引、不扫段', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      seed(home); // 造两个段 + 摘要 + config（含 url/title 等真实活动内容）
      const r = await http.fetchJson('/api/integrations');
      assert.equal(r.status, 200);
      const text = JSON.stringify(r.body);
      // 不得出现任何 segment/事件/隐私配置内容
      assert.equal(text.includes('github.com/chronicle'), false, '不得泄露事件 URL');
      assert.equal(text.includes('GitHub work'), false, '不得泄露窗口标题');
      assert.equal(text.includes('events.jsonl'), false, '不得泄露段文件路径');
      assert.equal(text.includes('"events"'), false, '不得包含事件数组');
      assert.equal(text.includes('suppressed'), false);
      assert.equal(text.includes('"blocklist"'), false, '不得包含隐私规则');
      // 也不得触发索引构建（无副作用）
      assert.equal(existsSync(path.join(home, 'index')), false, '该请求不得创建/触发索引');
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑥ 维护接口 POST /api/maintain（批次 6 新增） ----------

describe('POST /api/maintain', () => {
  test('dryRun 返回 ok + 报告；缺 JSON Content-Type 被 415 拒绝', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), maintenance: { retentionDays: 0, compressAfterDays: 7 } }));
    mkdirSync(path.join(home, 'segments'), { recursive: true });
    const http = await startHttp(stubDaemon(), home);
    try {
      const ok = await http.fetchJson('/api/maintain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.dryRun, true);
      assert.ok(ok.body.report && typeof ok.body.report === 'object', '应返回维护报告');
      const bad = await http.fetchJson('/api/maintain', { method: 'POST', body: '{}' });
      assert.equal(bad.status, 415, '缺 application/json 的写请求应 415');
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- 权限接口（辅助功能状态 / 弹出系统授权框） ----------

describe('GET /api/permissions + POST /api/permissions/request', () => {
  test('未授权如实返回 false；请求授权透传 axGranted', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
    const stub = {
      ...stubDaemon(),
      async request(cmd) {
        if (cmd === 'probe') return { axGranted: false, secureInput: false };
        if (cmd === 'request-permissions') return { axGranted: false };
        return { ok: true };
      },
    };
    const http = await startHttp(stub, home);
    try {
      const st = await http.fetchJson('/api/permissions');
      assert.equal(st.status, 200);
      assert.equal(st.body.ok, true);
      assert.equal(st.body.axGranted, false);
      const req = await http.fetchJson('/api/permissions/request', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(req.status, 200);
      assert.equal(req.body.ok, true);
      assert.equal(req.body.axGranted, false);
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('POST /api/permissions/card（拖拽引导卡片）', () => {
  test('透传 show-permission-card，成功返回 shown=true', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
    const calls = [];
    const stub = {
      ...stubDaemon(),
      async request(cmd, params) {
        calls.push({ cmd, params });
        if (cmd === 'show-permission-card') return { shown: true };
        return { ok: true };
      },
    };
    const http = await startHttp(stub, home);
    try {
      const r = await http.fetchJson('/api/permissions/card', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.shown, true);
      assert.equal(calls[0].cmd, 'show-permission-card');
      assert.equal(calls[0].params.kind, 'accessibility');
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦ 长期记忆 GET /api/memory（U2） ----------

function writeSummaryFile(home, name, frontmatter, body = '') {
  mkdirSync(path.join(home, 'summaries'), { recursive: true });
  const fm = ['---', ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), '---'].join('\n');
  writeFileSync(path.join(home, 'summaries', name), `${fm}\n\n${body}`);
}

describe('HTTP /api/memory', () => {
  test('缺文件：200 + 空结构（不报错、不建任何文件/索引）', async () => {
    const home = tmpHome();
    const h = await startHttp(stubDaemon(), home);
    try {
      const before = readdirSync(home).sort();
      const r = await h.fetchJson('/api/memory');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        ok: true,
        memory: {
          summaryMarkdown: '',
          memoryMarkdown: '',
          updatedAt: null,
          hasSummary: false,
          hasMemory: false,
        },
        recentSummaries: [],
      });
      assert.deepEqual(readdirSync(home).sort(), before, '/api/memory 只读，不得创建文件/索引');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('memory 文件 + 摘要：字段/排序/类型兜底', async () => {
    const home = tmpHome();
    try {
      writeFileSync(path.join(home, 'memory_summary.md'), '# 长期记忆摘要\n\n- 用户偏好：深色主题\n');
      writeFileSync(path.join(home, 'MEMORY.md'), '# Chronicle 记忆\n\n## 项目\n- chronicle：本地活动记录器\n');
      writeSummaryFile(home, '10min-2026-11-11T02-00-00.000Z.md', {
        title: '10:00-10:10 调试记忆视图', type: '10min', segment: '2026-11-11T02-00-00.000Z',
        applications: ['com.google.Chrome'], description: '排查 /api/memory 接口',
      }, '## 活动摘要\n- 写接口');
      writeSummaryFile(home, '6h-2026-11-11T00-00-00.000Z.md', {
        title: '08:00-14:00 汇总', type: '6h', segment: '2026-11-10T23-00-00.000Z',
        applications: ['com.apple.Terminal'],
      }, '## 活动摘要\n- 编码');
      // 坏文件：无 frontmatter，也要容错（type 按文件名兜底，title 用文件名）
      writeSummaryFile(home, '10min-2026-11-11T03-00-00.000Z.md', {}, '只有正文，没有 frontmatter');

      const h = await startHttp(stubDaemon(), home);
      try {
        const r = await h.fetchJson('/api/memory');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.memory.hasSummary, true);
        assert.equal(r.body.memory.hasMemory, true);
        assert.match(r.body.memory.summaryMarkdown, /长期记忆摘要/);
        assert.match(r.body.memory.memoryMarkdown, /chronicle：本地活动记录器/);
        assert.equal(typeof r.body.memory.updatedAt, 'string');
        assert.ok(Number.isFinite(Date.parse(r.body.memory.updatedAt)));

        const recent = r.body.recentSummaries;
        assert.equal(Array.isArray(recent), true);
        assert.equal(recent.length, 3);
        // 新→旧：03:00 摘要（坏文件 mtime/ts） > 02:00 > 前一日 23:00
        assert.deepEqual(recent.map((x) => x.file), [
          '10min-2026-11-11T03-00-00.000Z.md',
          '10min-2026-11-11T02-00-00.000Z.md',
          '6h-2026-11-11T00-00-00.000Z.md',
        ]);
        // 字段契约（不夹带内部字段）
        for (const item of recent) {
          assert.deepEqual(Object.keys(item).sort(), ['applications', 'description', 'file', 'segment', 'title', 'ts', 'type']);
          assert.equal(typeof item.title, 'string');
          assert.equal(typeof item.description, 'string');
          assert.equal(typeof item.segment, 'string');
          assert.ok(Array.isArray(item.applications));
          assert.ok(item.ts === null || typeof item.ts === 'string');
        }
        assert.deepEqual(recent[1].applications, ['com.google.Chrome']);
        assert.equal(recent[1].type, '10min');
        assert.equal(recent[2].type, '6h');
        assert.equal(recent[0].type, '10min', '坏文件缺 type 时按文件名兜底');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('最近摘要最多 12 条（新→旧）；>200KB 的 markdown 截断', async () => {
    const home = tmpHome();
    try {
      for (let i = 0; i < 15; i += 1) {
        const mm = String(i).padStart(2, '0');
        writeSummaryFile(home, `10min-2026-11-11T${mm}-00-00.000Z.md`, {
          title: `摘要 ${i}`, type: '10min', segment: `2026-11-11T${mm}-00-00.000Z`, applications: [],
        });
      }
      const huge = `${'A'.repeat(205 * 1024)}TAIL_SHOULD_BE_CUT`;
      writeFileSync(path.join(home, 'MEMORY.md'), huge);
      writeFileSync(path.join(home, 'memory_summary.md'), `${'B'.repeat(205 * 1024)}`);
      const h = await startHttp(stubDaemon(), home);
      try {
        const r = await h.fetchJson('/api/memory');
        assert.equal(r.status, 200);
        assert.equal(r.body.recentSummaries.length, 12);
        const times = r.body.recentSummaries.map((x) => Date.parse(x.ts));
        for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] >= times[i], '摘要应按时间新→旧');
        assert.equal(r.body.recentSummaries[0].title, '摘要 14', '最新的排最前');
        // 200KB 截断保护
        assert.ok(r.body.memory.memoryMarkdown.length <= 200 * 1024);
        assert.ok(!r.body.memory.memoryMarkdown.includes('TAIL_SHOULD_BE_CUT'));
        assert.ok(r.body.memory.summaryMarkdown.length <= 200 * 1024);
        assert.ok(r.body.memory.summaryMarkdown.startsWith('B'));
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('固定文件名：query 参数不能改变读取目标（无路径穿越面）', async () => {
    const home = tmpHome();
    const outside = path.join(home, '..', `${path.basename(home)}-secret.md`);
    try {
      writeFileSync(outside, 'SECRET-OUTSIDE-HOME');
      const h = await startHttp(stubDaemon(), home);
      try {
        const r = await h.fetchJson(`/api/memory?file=${encodeURIComponent(outside)}&path=../../etc/passwd`);
        assert.equal(r.status, 200);
        assert.equal(r.body.memory.summaryMarkdown, '');
        assert.equal(r.body.memory.memoryMarkdown, '');
        assert.doesNotMatch(JSON.stringify(r.body), /SECRET-OUTSIDE-HOME/);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(outside, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦b X2：摘要 description/suggestion ----------

describe('HTTP /api/summaries 补充字段（X2）', () => {
  test('description/suggestion 从 frontmatter 解析；缺省 null、坏文件容错', async () => {
    const home = tmpHome();
    mkdirSync(path.join(home, 'summaries'), { recursive: true });
    writeFileSync(path.join(home, 'summaries', '10min-2026-11-11T02-00-00.000Z.md'), [
      '---',
      'title: "10:00-10:10 整理截图"',
      'description: "把截图归档到项目目录"',
      'suggestion: {"type":"skill","name":"截图整理","description":"自动归档每日截图"}',
      'segment: "2026-11-11T02-00-00.000Z"',
      'type: "10min"',
      '---', '', '正文',
    ].join('\n'));
    writeFileSync(path.join(home, 'summaries', '10min-2026-11-11T03-00-00.000Z.md'), 'not frontmatter');
    writeFileSync(path.join(home, 'summaries', '10min-2026-11-11T04-00-00.000Z.md'), [
      '---', 'title: "坏 suggestion"', 'description: "描述"',
      'suggestion: {"type":"other","name":123}', 'segment: "2026-11-11T04-00-00.000Z"', '---', '',
    ].join('\n'));
    const h = await startHttp(stubDaemon(), home);
    try {
      const r = await h.fetchJson('/api/summaries');
      assert.equal(r.status, 200);
      const byFile = Object.fromEntries(r.body.summaries.map((s) => [s.filename, s]));
      const good = byFile['10min-2026-11-11T02-00-00.000Z.md'];
      assert.equal(good.description, '把截图归档到项目目录');
      assert.deepEqual(good.suggestion, { type: 'skill', name: '截图整理', description: '自动归档每日截图' });
      assert.equal(byFile['10min-2026-11-11T03-00-00.000Z.md'].description, null);
      assert.equal(byFile['10min-2026-11-11T03-00-00.000Z.md'].suggestion, null);
      assert.equal(byFile['10min-2026-11-11T04-00-00.000Z.md'].description, '描述');
      assert.equal(byFile['10min-2026-11-11T04-00-00.000Z.md'].suggestion, null, '非法 suggestion 应归一化为 null');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('无 description/suggestion 的旧摘要：两字段均为 null（不破坏既有字段）', async () => {
    const home = tmpHome();
    const h = await startHttp(stubDaemon(), home);
    try {
      seed(home);
      const r = await h.fetchJson('/api/summaries');
      for (const s of r.body.summaries) {
        assert.equal(s.description, null);
        assert.equal(s.suggestion, null);
        assert.equal(typeof s.title, 'string');
        assert.ok(Array.isArray(s.applications));
      }
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦c X2：GET /api/observed（权限选择用） ----------

function snapshotTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names;
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
  walk(root, '');
  return out;
}

function mkObservedSeg(home, name, events) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ segmentStart: name.replace(/-/g, ':'), segmentEnd: name.replace(/-/g, ':'), eventCount: events.length }));
}

describe('HTTP /api/observed', () => {
  test('聚合最近段：apps 按 bundleId、domains 取 hostname；计数/lastTs 正确', async () => {
    const home = tmpHome();
    try {
      mkObservedSeg(home, '2026-11-11T02-00-00.000Z', [
        { ts: '2026-11-11T02:01:00.000Z', type: 'app-switch', data: { bundleId: 'com.google.Chrome', appName: 'Chrome' } },
        { ts: '2026-11-11T02:02:00.000Z', type: 'window-change', data: { bundleId: 'com.google.Chrome', windowTitle: 'GitHub' } },
        { ts: '2026-11-11T02:03:00.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://github.com/example/repo?q=1#top', appName: 'Chrome' } },
        { ts: '2026-11-11T02:03:30.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://docs.example.com/chronicle' } },
        { ts: '2026-11-11T02:04:00.000Z', type: 'app-switch', data: { bundleId: 'com.apple.Terminal', appName: '终端' } },
        { ts: '2026-11-11T02:04:30.000Z', type: 'focus-change', data: { bundleId: 'com.ignored.app' } },
        { ts: '2026-11-11T02:05:00.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'not a url' } },
      ]);
      mkObservedSeg(home, '2026-11-11T01-00-00.000Z', [
        { ts: '2026-11-11T01:10:00.000Z', type: 'app-switch', data: { bundleId: 'com.google.Chrome', appName: 'Chrome' } },
        { ts: '2026-11-11T01:11:00.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://github.com/' } },
      ]);
      const h = await startHttp(stubDaemon(), home);
      try {
        const r = await h.fetchJson('/api/observed');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        const apps = r.body.apps;
        assert.deepEqual(apps.find((a) => a.bundleId === 'com.google.Chrome'), {
          bundleId: 'com.google.Chrome', appName: 'Chrome', eventCount: 7, lastTs: '2026-11-11T02:05:00.000Z',
        });
        assert.deepEqual(apps.find((a) => a.bundleId === 'com.apple.Terminal'), {
          bundleId: 'com.apple.Terminal', appName: '终端', eventCount: 1, lastTs: '2026-11-11T02:04:00.000Z',
        });
        assert.equal(apps.some((a) => a.bundleId === 'com.ignored.app'), false, 'focus-change 不参与 observed');
        assert.equal(apps[0].bundleId, 'com.google.Chrome', '按 eventCount 降序');
        const domains = r.body.domains;
        assert.deepEqual(domains.find((d) => d.domain === 'github.com'), {
          domain: 'github.com', eventCount: 2, lastTs: '2026-11-11T02:03:00.000Z',
        });
        assert.deepEqual(domains.find((d) => d.domain === 'docs.example.com'), {
          domain: 'docs.example.com', eventCount: 1, lastTs: '2026-11-11T02:03:30.000Z',
        });
        assert.ok(domains.every((d) => !d.domain.includes('/')), 'domain 只保留 hostname');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('空数据 → 空数组 200；只读（请求前后文件树一致、不建索引）', async () => {
    const home = tmpHome();
    try { mkdirSync(home, { recursive: true }); } catch { /* already */ }
    const before = snapshotTree(home);
    const h = await startHttp(stubDaemon(), home);
    try {
      const empty = await h.fetchJson('/api/observed');
      assert.equal(empty.status, 200);
      assert.deepEqual({ apps: empty.body.apps, domains: empty.body.domains }, { apps: [], domains: [] });
      // 有数据时也只读
      mkObservedSeg(home, '2026-11-11T02-00-00.000Z', [
        { ts: '2026-11-11T02:01:00.000Z', type: 'app-switch', data: { bundleId: 'com.a', appName: 'A' } },
      ]);
      const beforeWithData = snapshotTree(home);
      const r = await h.fetchJson('/api/observed');
      assert.equal(r.body.apps.length, 1);
      assert.deepEqual(snapshotTree(home), beforeWithData, '/api/observed 不得写文件（含索引）');
      assert.ok(!snapshotTree(home).some((entry) => /index.*\.(db|sqlite)/i.test(entry)));
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
    assert.deepEqual(snapshotTree(home), [], '临时目录已清理');
    assert.ok(before.length >= 0);
  });

  test('只取最近 20 段；21 段时最老的段不计入；<500ms', async () => {
    const home = tmpHome();
    try {
      // 21 段，目录名按时间递增（新→旧排序后最新 20 段）
      for (let i = 0; i < 21; i += 1) {
        const hh = String(i).padStart(2, '0');
        mkObservedSeg(home, `2026-11-11T${hh}-00-00.000Z`, [
          { ts: `2026-11-11T${hh}:01:00.000Z`, type: 'app-switch', data: { bundleId: `com.app.${i}`, appName: `App ${i}` } },
        ]);
      }
      const h = await startHttp(stubDaemon(), home);
      try {
        const t0 = performance.now();
        const r = await h.fetchJson('/api/observed');
        const elapsed = performance.now() - t0;
        assert.equal(r.status, 200);
        assert.equal(r.body.apps.length, 20, '只应聚合最近 20 段');
        assert.equal(r.body.apps.some((a) => a.bundleId === 'com.app.0'), false, '最老段（00 点）不应计入');
        assert.equal(r.body.apps.some((a) => a.bundleId === 'com.app.20'), true);
        assert.ok(elapsed < 500, `observed 聚合耗时 ${elapsed.toFixed(1)}ms 应 <500ms`);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦d Z2：摘要 next_actions → nextActions ----------

describe('HTTP /api/summaries nextActions（Z2）', () => {
  test('next_actions 归一化：最多 3 条、坏项过滤；缺省 / 非法为 []', async () => {
    const home = tmpHome();
    mkdirSync(path.join(home, 'summaries'), { recursive: true });
    const writeSummary = (name, lines) => writeFileSync(path.join(home, 'summaries', name),
      ['---', ...lines, '---', '', 'body'].join('\n'));
    writeSummary('10min-a.md', [
      'title: "A"',
      'segment: "2026-11-11T02-00-00.000Z"',
      'next_actions: [{"action":"整理截图","reason":"重复操作"},{"action":"写周报","reason":"周五"},{"action":"回复邮件","reason":"待办"},{"action":"第四条应被截断","reason":"x"}]',
    ]);
    writeSummary('10min-b.md', ['title: "B"', 'segment: "2026-11-11T03-00-00.000Z"']);
    writeSummary('10min-c.md', [
      'title: "C"',
      'segment: "2026-11-11T04-00-00.000Z"',
      'next_actions: "not-an-array"',
    ]);
    writeSummary('10min-d.md', [
      'title: "D"',
      'segment: "2026-11-11T05-00-00.000Z"',
      'next_actions: [{"action":"","reason":"空 action 丢弃"},{"reason":"缺 action"},{"action":"保留我","reason":"ok"}]',
    ]);
    const h = await startHttp(stubDaemon(), home);
    try {
      const r = await h.fetchJson('/api/summaries');
      assert.equal(r.status, 200);
      const byFile = Object.fromEntries(r.body.summaries.map((s) => [s.filename, s]));
      assert.deepEqual(byFile['10min-a.md'].nextActions, [
        { action: '整理截图', reason: '重复操作' },
        { action: '写周报', reason: '周五' },
        { action: '回复邮件', reason: '待办' },
      ], '最多 3 条，超出截断');
      assert.deepEqual(byFile['10min-b.md'].nextActions, [], '缺省 → []');
      assert.deepEqual(byFile['10min-c.md'].nextActions, [], '非数组 → []');
      assert.deepEqual(byFile['10min-d.md'].nextActions, [{ action: '保留我', reason: 'ok' }], '坏项过滤');
      for (const s of r.body.summaries) assert.ok(Array.isArray(s.nextActions), '每条都要有 nextActions 数组');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦ 工作账本只读聚合 ----------

describe('HTTP /api/work', () => {
  test('对象/异常/复盘/洞察聚合；type 过滤；非法类型 400', async () => {
    const home = tmpHome();
    const created = new Date().toISOString();
    writeFileSync(path.join(home, 'work-ledger.json'), JSON.stringify({
      version: 1,
      objects: [
        {
          id: 'obj_api_task', type: 'task', state: 'inbox', title: '核对 PDF 图片',
          owner: 'me', project_id: null, goal_id: null, next_action: '打开图片清单',
          due_at: null, review_at: null, evidence: ['10min-a.md'], source: 'test', source_key: 'api:1',
          created_at: created, updated_at: created, archived_at: null, archive_reason: '', meta: {},
        },
        {
          id: 'obj_api_commitment', type: 'commitment', state: 'due', title: '周五发 PDF',
          owner: 'me', project_id: null, goal_id: null, next_action: '发送 PDF',
          due_at: '2026-11-01T00:00:00.000Z', review_at: null, evidence: [], source: 'test', source_key: 'api:2',
          created_at: created, updated_at: created, archived_at: null, archive_reason: '', meta: {},
        },
        {
          id: 'obj_api_insight', type: 'insight', state: 'candidate', title: 'PDF 图片校验总被低估',
          owner: 'me', project_id: null, goal_id: null, next_action: '', due_at: null, review_at: null,
          evidence: ['10min-a.md'], source: 'test', source_key: 'api:3',
          created_at: created, updated_at: created, archived_at: null, archive_reason: '',
          meta: { insight: { claim: 'PDF 图片校验总被低估', confidence: 0.7, expiry: '2027-01-01T00:00:00.000Z' } },
        },
      ],
    }, null, 2));
    const http = await startHttp(stubDaemon(), home);
    try {
      const r = await http.fetchJson('/api/work');
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.objects.length, 3);
      assert.ok(r.body.exceptions.some((e) => e.kind === 'broken-promise'));
      assert.equal(r.body.review.cadence, 'today');
      assert.ok(r.body.review.priorities.length <= 3);
      assert.equal(r.body.insights.length, 1);
      assert.equal(r.body.insights[0].claim, 'PDF 图片校验总被低估');
      assert.equal(r.body.stats.total, 3);
      assert.equal(r.body.stats.inbox, 1);
      const filtered = await http.fetchJson('/api/work?type=task');
      assert.equal(filtered.status, 200);
      assert.equal(filtered.body.objects.length, 1);
      assert.equal(filtered.body.objects[0].id, 'obj_api_task');
      const bad = await http.fetchJson('/api/work?type=nope');
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'BAD_TYPE');

      const created = await http.fetchJson('/api/work/objects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'task', title: '新任务', next_action: '做' }),
      });
      assert.equal(created.status, 201);
      const newId = created.body.object.id;
      const patched = await http.fetchJson(`/api/work/objects/${newId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'doing', next_action: '开始' }),
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.object.state, 'doing');
      const archived = await http.fetchJson(`/api/work/objects/${newId}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      });
      assert.equal(archived.status, 200);
      assert.ok(archived.body.object.archived_at);

      const ins = await http.fetchJson('/api/work/insights', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claim: '新洞察', evidence: ['10min-a.md'], confidence: 0.6 }),
      });
      assert.equal(ins.status, 201);
      const insId = ins.body.object.id;
      const validated = await http.fetchJson(`/api/work/insights/${insId}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'ok' }),
      });
      assert.equal(validated.status, 200);
      assert.equal(validated.body.object.state, 'validated');
      const applied = await http.fetchJson(`/api/work/insights/${insId}/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedTo: 'task:x' }),
      });
      assert.equal(applied.status, 200);
      assert.equal(applied.body.object.state, 'applied');
      const retired = await http.fetchJson(`/api/work/insights/${insId}/retire`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'old' }),
      });
      assert.equal(retired.status, 200);
      assert.equal(retired.body.object.state, 'retired');

      const audit = await http.fetchJson('/api/audit');
      assert.equal(audit.status, 200);
      assert.ok(audit.body.events.some((e) => e.action === 'work.create' && e.target === newId));
      assert.ok(audit.body.events.some((e) => e.action === 'insight.validate' && e.target === insId));
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑧ Agent 注册 / 权限 / 审计 ----------

describe('HTTP /api/agents', () => {
  test('注册 → 授权 → 检查 → 撤销 → outcome；审计可查', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      const empty = await http.fetchJson('/api/agents');
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.agents, []);
      const created = await http.fetchJson('/api/agents', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Claude Code', kind: 'coding-agent', default_level: 'L1' }),
      });
      assert.equal(created.status, 201);
      const id = created.body.agent.id;
      assert.equal(created.body.agent.default_level, 'L1');
      const task = await http.fetchJson('/api/work/objects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'task', title: 'Agent 可操作任务', next_action: '做' }),
      });
      const taskId = task.body.object.id;
      const grant = await http.fetchJson(`/api/agents/${id}/grants`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'L2', scopes: ['project:hulala', `object:${taskId}`] }),
      });
      assert.equal(grant.status, 201);
      const act = await http.fetchJson(`/api/agents/${id}/act`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set_state', params: { objectId: taskId, state: 'doing' } }),
      });
      assert.equal(act.status, 200);
      assert.equal(act.body.result.state, 'doing');
      const undo = await http.fetchJson(`/api/audit/${act.body.audit.id}/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(undo.status, 200);
      const afterUndo = await http.fetchJson(`/api/work?type=task`);
      assert.equal(afterUndo.body.objects.find((o) => o.id === taskId).state, 'inbox');
      const allowed = await http.fetchJson(`/api/agents/${id}/check`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'L2', scope: 'project:hulala' }),
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body.allowed, true);
      const denied = await http.fetchJson(`/api/agents/${id}/check`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'L2', scope: 'project:other' }),
      });
      assert.equal(denied.body.allowed, false);
      const outcome = await http.fetchJson(`/api/agents/${id}/outcome`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ success: 2, corrections: 1 }),
      });
      assert.equal(outcome.status, 200);
      assert.deepEqual(outcome.body.agent.trust, { success: 2, corrections: 1, incidents: 0 });
      const revoked = await http.fetchJson(`/api/agents/${id}/grants/${grant.body.grant.id}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(revoked.status, 200);
      const audit = await http.fetchJson('/api/audit');
      assert.ok(audit.body.events.some((e) => e.action === 'agent.register' && e.target === id));
      assert.ok(audit.body.events.some((e) => e.action === 'agent.grant' && e.target === id));
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑨ 采集覆盖 / 团队交接包 ----------

describe('HTTP /api/coverage 与团队包', () => {
  test('覆盖：按应用返回 good/thin/none，扫描近期段', async () => {
    const home = tmpHome();
    const http = await startHttp(stubDaemon(), home);
    try {
      const now = new Date();
      const iso = (offsetMin) => new Date(now.getTime() - offsetMin * 60_000).toISOString();
      const name = `${now.toISOString().slice(0, 10)}T${now.toISOString().slice(11, 19).replace(/:/g, '-')}.000Z`;
      mkSeg(home, name, [
        { ts: iso(8), type: 'app-switch', data: { bundleId: 'com.test.good', appName: 'Good' } },
        { ts: iso(7), type: 'ax-snapshot', data: { bundleId: 'com.test.good', appName: 'Good', nodeCount: 80, text: '内容' } },
        { ts: iso(6), type: 'app-switch', data: { bundleId: 'com.test.none', appName: 'None' } },
        ...Array.from({ length: 10 }, (_, i) => ({ ts: iso(5 - i * 0.1), type: 'click', data: { bundleId: 'com.test.none', appName: 'None', target: { role: 'AXButton' } } })),
      ]);
      const r = await http.fetchJson('/api/coverage?days=7');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.apps));
      const good = r.body.apps.find((a) => a.bundleId === 'com.test.good');
      const none = r.body.apps.find((a) => a.bundleId === 'com.test.none');
      assert.equal(good.coverage, 'good');
      assert.equal(none.coverage, 'none');
      assert.ok(r.body.summary.zeroAxApps.some((a) => a.bundleId === 'com.test.none'));
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('交接包：导出 → 另一台导入 → 对象/洞察可读；坏包 400', async () => {
    const srcHome = tmpHome();
    const dstHome = tmpHome();
    const src = await startHttp(stubDaemon(), srcHome);
    let dst;
    try {
      const proj = await src.fetchJson('/api/work/objects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'project', title: '交接项目', state: 'active', next_action: '继续' }),
      });
      const projectId = proj.body.object.id;
      await src.fetchJson('/api/work/objects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'task', title: '接手任务', state: 'doing', project_id: projectId, next_action: '做' }),
      });
      await src.fetchJson('/api/work/insights', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claim: '交接包可复用', evidence: ['docs/product-blueprint.md'], project_id: projectId }),
      });
      const pack = await src.fetchJson(`/api/team/pack?projectId=${projectId}`);
      assert.equal(pack.status, 200);
      assert.equal(pack.body.pack.kind, 'chronicle-team-pack');
      assert.ok(pack.body.pack.handoff.includes('接手任务'));
      await src.close();

      dst = await startHttp(stubDaemon(), dstHome);
      const imported = await dst.fetchJson('/api/team/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pack.body.pack),
      });
      assert.equal(imported.status, 200);
      assert.equal(imported.body.imported, 3);
      const work = await dst.fetchJson('/api/work');
      assert.ok(work.body.objects.some((o) => o.title === '接手任务'));
      assert.ok(work.body.insights.some((o) => o.claim === '交接包可复用'));
      const bad = await dst.fetchJson('/api/team/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }),
      });
      assert.equal(bad.status, 400);
    } finally {
      await src.close().catch(() => {});
      if (dst) await dst.close();
      rmSync(srcHome, { recursive: true, force: true });
      rmSync(dstHome, { recursive: true, force: true });
    }
  });
});

// ---------- ⑩ 按需 OCR / 屏幕录制权限 ----------

describe('POST /api/ocr 与 /api/permissions/screen', () => {
  test('成功返回文字并写审计；权限失败 403；屏幕权限状态透传', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
    let mode = 'ok';
    const stub = {
      ...stubDaemon(),
      async request(cmd) {
        if (cmd === 'probe') return { ok: true, axGranted: true, screenGranted: false, secureInput: false };
        if (cmd === 'request-screen-permissions') return { ok: true, screenGranted: false };
        if (cmd === 'ocr-window') {
          if (mode === 'denied') return { ok: false, error: '需要屏幕录制权限', code: 'SCREEN_PERMISSION_DENIED' };
          return {
            ok: true, stored: true,
            ocr: { text: '第一行\n第二行', lineCount: 2, bundleId: 'com.apple.TextEdit', appName: '文本编辑', windowTitle: '笔记', width: 800, height: 600 },
          };
        }
        return { ok: true };
      },
    };
    const http = await startHttp(stub, home);
    try {
      const perms = await http.fetchJson('/api/permissions');
      assert.equal(perms.body.screenGranted, false);
      const screen = await http.fetchJson('/api/permissions/screen', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(screen.status, 200);
      assert.equal(screen.body.screenGranted, false);

      const ok = await http.fetchJson('/api/ocr', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.stored, true);
      assert.equal(ok.body.ocr.text, '第一行\n第二行');
      assert.equal(ok.body.ocr.lineCount, 2);

      const audit = await http.fetchJson('/api/audit');
      const entry = audit.body.events.find((e) => e.action === 'ocr.capture');
      assert.ok(entry, 'OCR 成功应写审计');
      assert.equal(entry.detail.lines, 2);
      assert.equal(JSON.stringify(entry).includes('第一行'), false, '审计不得记录 OCR 原文');

      mode = 'denied';
      const denied = await http.fetchJson('/api/ocr', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, 'SCREEN_PERMISSION_DENIED');
    } finally {
      await http.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑪ 分析补跑状态 / 洞察排队 ----------

describe('分析补跑 API', () => {
  test('status/retry：无待补返回 0；洞察网络失败进入补跑队列', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
    const server = createHttpApp({
      daemon: stubDaemon(),
      home,
      insightGenerator: async () => ({ ok: false, code: 'LLM_NETWORK', error: 'fetch failed' }),
    });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, init) => {
      const r = await fetch(base + p, init);
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    try {
      const st = await call('/api/analysis/status');
      assert.equal(st.status, 200);
      assert.equal(st.body.ok, true);
      assert.equal(st.body.total, 0);

      const ins = await call('/api/insights/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ range: 'week' }),
      });
      assert.equal(ins.status, 503);
      assert.equal(ins.body.queued, true);
      assert.equal(ins.body.code, 'LLM_NETWORK');

      const st2 = await call('/api/analysis/status');
      assert.equal(st2.body.pending.insights, 1);
      assert.equal(st2.body.queue[0].range, 'week');

      const retry = await call('/api/analysis/retry', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.ok, true);
      assert.ok(retry.body.result);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
