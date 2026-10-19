// test/daemon.test.mjs — 批次 1 测试
//
// 覆盖：
//   ① 隐私闸门纯逻辑（block 永远赢、glob、白名单语义）—— shared/privacy.mjs
//   ② mock 守护生命周期（start/stop/pause/resume/status/probe）—— 行协议客户端
//   ③ HTTP API 各端点（/ /api/status /api/segments /api/segment/:ts/events pause resume 404）
//   ④ 段轮转（mock 的短 SEGMENT_MS → 多段、旧段 closed、新段 open）
//   ⑤ 隐私过滤端到端（mock 落盘：被 block 的 app 不进 events.jsonl，只进 suppressed.jsonl
//      且只含 type/ts/scope；密码框焦点不落盘）
//   ⑥ Swift 真编译自检（无 swiftc 则 SKIP；有则真编译、真跑 start/stop，
//      用「block 一切」的配置确定性验证隐私闸门）

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { globMatch, urlRuleMatch, privacyDecision, defaultConfig } from '../shared/privacy.mjs';
import { createDaemon, createHttpApp, listSegments, readSegmentEvents, chronicleHome } from '../daemon.mjs';
import { compileDaemon, swiftcPath, ensureHomeDirs, ensureHelperApp, buildInfoPlist, APP_NAME } from '../setup.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO_ROOT, 'test', 'fixtures', 'mock-daemon.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-test-'));

/** mock 守护控制端（Node 桩进程说同一套行协议）。 */
function mockDaemon(home, env = {}) {
  return createDaemon({
    binary: process.execPath,
    args: [MOCK],
    home,
    env,
    timeoutMs: 8000,
  });
}

/** 在临时端口上起 HTTP app；返回 {server, port, fetchJson, fetchText, close}。 */
async function startHttp(daemon, home) {
  const server = createHttpApp({ daemon, home });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const fetchJson = async (p, init) => {
    const r = await fetch(base + p, init);
    return { status: r.status, body: await r.json() };
  };
  const fetchText = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.text(), contentType: r.headers.get('content-type') };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { server, port, base, fetchJson, fetchText, close };
}

function writeConfig(home, cfg) {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
}

// ---------- ① 隐私闸门纯逻辑 ----------

describe('隐私闸门（shared/privacy.mjs）', () => {
  test('glob：前缀/包含/精确/大小写', () => {
    assert.equal(globMatch('com.1password.Mac', 'com.1password.Mac'), true); // 精确
    assert.equal(globMatch('com.1password.*', 'com.1password.Mac'), true); // 前缀
    assert.equal(globMatch('com.1password.*', 'com.2password.Mac'), false);
  });

  test('glob：* 可匹配空串（com.foo* 命中 com.foo；com.foo.* 不命中 com.foo——尾点算字面）', () => {
    assert.equal(globMatch('com.foo*', 'com.foo'), true);
    assert.equal(globMatch('com.foo.*', 'com.foo'), false);
  });

  test('glob 包含匹配与大小写不敏感', () => {
    assert.equal(globMatch('*banking*', 'https://IBK.Banking.example.com/login'), true);
    assert.equal(globMatch('*Banking*', 'https://x.banking.example'), true);
    assert.equal(globMatch('*banking*', 'https://example.com/docs'), false);
  });

  test('URL 规则命中 host（子域靠 glob 表达）', () => {
    assert.equal(urlRuleMatch('*mail.example.com*', 'https://mail.example.com/inbox'), true);
    assert.equal(urlRuleMatch('mail.example.com', 'https://mail.example.com/inbox'), true);
    assert.equal(urlRuleMatch('mail.example.com', 'https://other.example.com'), false);
  });

  test('默认观察：无规则时全放行', () => {
    const d = privacyDecision({ bundleId: 'com.anything.app' }, { allowlist: [], blocklist: [] });
    assert.deepEqual({ observe: d.observe, blockedScope: d.blockedScope }, { observe: true, blockedScope: null });
  });

  test('block 永远赢：同时命中 allow 与 block → 阻断', () => {
    const d = privacyDecision(
      { bundleId: 'com.secret.app' },
      {
        allowlist: [{ scope: 'app', value: '*' }],
        blocklist: [{ scope: 'app', value: 'com.secret.*' }],
      },
    );
    assert.equal(d.observe, false);
    assert.equal(d.blockedScope, 'app');
  });

  test('block url 命中 → 该采样不观察', () => {
    const d = privacyDecision(
      { bundleId: 'com.example.browser', url: 'https://secure.mybanking.com/x' },
      { blocklist: [{ scope: 'url', value: '*banking*' }] },
    );
    assert.equal(d.observe, false);
    assert.equal(d.blockedScope, 'url');
  });

  test('allowlist 非空：白名单外不观察（即便无 block 规则）', () => {
    const d = privacyDecision(
      { bundleId: 'com.other.app' },
      { allowlist: [{ scope: 'app', value: 'com.allowed.*' }], blocklist: [] },
    );
    assert.equal(d.observe, false);
    assert.equal(d.blockedScope, 'app');
  });

  test('allowlist 非空：白名单内观察', () => {
    const d = privacyDecision(
      { bundleId: 'com.allowed.editor' },
      { allowlist: [{ scope: 'app', value: 'com.allowed.*' }] },
    );
    assert.equal(d.observe, true);
  });

  test('allowlist 的 url 规则可放行 app 白名单外的浏览', () => {
    const d = privacyDecision(
      { bundleId: 'com.any.browser', url: 'https://docs.example.com/a' },
      { allowlist: [{ scope: 'url', value: '*docs.example.com*' }] },
    );
    assert.equal(d.observe, true);
  });

  test('默认配置屏蔽密码管理器与银行站点', () => {
    const cfg = defaultConfig();
    assert.equal(privacyDecision({ bundleId: 'com.1password.Mac' }, cfg).observe, false);
    assert.equal(privacyDecision({ bundleId: 'com.apple.keychainaccess' }, cfg).observe, false);
    assert.equal(privacyDecision({ bundleId: 'com.apple.Safari', url: 'https://www.chase-banking.com/' }, cfg).observe, false);
    assert.equal(privacyDecision({ bundleId: 'com.apple.Safari', url: 'https://example.com/' }, cfg).observe, true);
  });
});

// ---------- ② mock 守护生命周期 ----------

describe('守护生命周期（mock 行协议）', () => {
  test('probe → start → status(running) → pause → status(paused) → resume → stop(stats)', async () => {
    const home = tmpHome();
    const d = mockDaemon(home, { MOCK_AX: '1' });
    try {
      const probe = await d.request('probe');
      assert.equal(probe.ok, true);
      assert.equal(probe.axGranted, true);

      const start = await d.request('start');
      assert.equal(start.ok, true);
      assert.equal(start.segmentsDir, path.join(home, 'segments'));

      let st = await d.request('status');
      assert.equal(st.running, true);
      assert.equal(st.paused, false);
      assert.ok(st.currentSegment && st.currentSegment.startTs);

      const pause = await d.request('pause', { durationSec: 3600 });
      assert.equal(pause.ok, true);
      assert.ok(pause.pausedAt);
      st = await d.request('status');
      assert.equal(st.paused, true);
      assert.equal(st.config.paused, true);

      const resume = await d.request('resume');
      assert.equal(resume.ok, true);
      assert.ok(resume.resumedAt);
      st = await d.request('status');
      assert.equal(st.paused, false);

      await sleep(400); // 让 mock 产几个事件
      const stop = await d.request('stop');
      assert.equal(stop.ok, true);
      assert.ok(stop.stats.totalEvents > 0, `应记录到事件，got ${stop.stats.totalEvents}`);
      assert.ok(stop.stats.durationMs > 0);

      st = await d.request('status');
      assert.equal(st.running, false);
      assert.equal(st.currentSegment, null);
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('重复 start 报 ALREADY_RUNNING；未 start 时 pause 报 NOT_RUNNING', async () => {
    const home = tmpHome();
    const d = mockDaemon(home);
    try {
      await assert.rejects(() => d.request('pause'), (e) => e.code === 'NOT_RUNNING');
      await d.request('start');
      await assert.rejects(() => d.request('start'), (e) => e.code === 'ALREADY_RUNNING');
      await d.request('stop');
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('config.enabled=false 时 start 报 CONFIG_DISABLED', async () => {
    const home = tmpHome();
    writeConfig(home, { ...defaultConfig(), enabled: false });
    const d = mockDaemon(home);
    try {
      await assert.rejects(() => d.request('start'), (e) => e.code === 'CONFIG_DISABLED');
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('未知命令报 UNKNOWN_CMD', async () => {
    const home = tmpHome();
    const d = mockDaemon(home);
    try {
      await assert.rejects(() => d.request('frobnicate'), (e) => e.code === 'UNKNOWN_CMD');
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('坏行（非 JSON）不影响后续请求', async () => {
    const home = tmpHome();
    const d = mockDaemon(home);
    try {
      await d.request('probe'); // 先拉起进程（懒 spawn）
      d.proc().stdin.write('this is not json\n');
      await sleep(150);
      const probe = await d.request('probe');
      assert.equal(probe.ok, true);
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ③④ HTTP API + 段轮转 ----------

describe('HTTP API（daemon.mjs + mock）', () => {
  test('各端点：/ /api/status /api/segments /api/segment/:ts/events pause resume 404', async () => {
    const home = tmpHome();
    const d = mockDaemon(home, { MOCK_TICK_MS: '60' });
    const http = await startHttp(d, home);
    try {
      const index = await http.fetchText('/');
      assert.equal(index.status, 200);
      assert.match(index.contentType, /text\/html/);
      assert.match(index.body, /Chronicle/);

      await d.request('start');
      await sleep(500);

      const st = await http.fetchJson('/api/status');
      assert.equal(st.status, 200);
      assert.equal(st.body.ok, true);
      assert.equal(st.body.status.running, true);

      const pause = await http.fetchJson('/api/pause', { method: 'POST', body: JSON.stringify({ durationSec: 60 }) });
      assert.equal(pause.status, 200);
      assert.equal(pause.body.ok, true);
      assert.ok(pause.body.pausedAt);
      assert.equal((await http.fetchJson('/api/status')).body.status.paused, true);

      const resume = await http.fetchJson('/api/resume', { method: 'POST' });
      assert.equal(resume.status, 200);
      assert.equal(resume.body.ok, true);
      assert.ok(resume.body.resumedAt);

      const segs = await http.fetchJson('/api/segments');
      assert.equal(segs.status, 200);
      assert.ok(Array.isArray(segs.body.segments));
      assert.ok(segs.body.segments.length >= 1);
      const seg = segs.body.segments[0];
      assert.equal(seg.open, true);
      assert.ok(seg.eventCount >= 1);

      const events = await http.fetchJson(`/api/segment/${encodeURIComponent(seg.segment)}/events`);
      assert.equal(events.status, 200);
      assert.ok(events.body.events.length >= 1);
      assert.ok(events.body.events.every((e) => ['app-switch', 'window-change', 'url-change', 'focus-change'].includes(e.type)));

      const withSup = await http.fetchJson(`/api/segment/${encodeURIComponent(seg.segment)}/events?withSuppressed=1`);
      assert.ok(Array.isArray(withSup.body.suppressed));

      const notFound = await http.fetchJson('/api/nope');
      assert.equal(notFound.status, 404);

      const badSeg = await http.fetchJson('/api/segment/1999-01-01T00-00-00.000Z/events');
      assert.equal(badSeg.status, 404);

      await d.request('stop');
    } finally {
      await http.close();
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('段轮转：MOCK_SEGMENT_MS=400 → 至少两段，旧段 closed、新段 open', async () => {
    const home = tmpHome();
    const d = mockDaemon(home, { MOCK_TICK_MS: '60', MOCK_SEGMENT_MS: '400' });
    try {
      await d.request('start');
      await sleep(1300);
      await d.request('stop');
      const segs = listSegments(home);
      assert.ok(segs.length >= 2, `应至少两段，got ${segs.length}`);
      for (const s of segs.slice(0, -1)) {
        assert.equal(s.open, false, `旧段 ${s.segment} 应已关闭`);
        assert.ok(s.segmentEnd);
      }
      // metadata 与目录内文件一致性
      for (const s of segs) {
        assert.ok(existsSync(path.join(s.path, 'events.jsonl')) || existsSync(path.join(s.path, 'suppressed.jsonl')));
      }
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑤ 隐私过滤端到端（mock 落盘） ----------

describe('隐私过滤端到端（mock 落盘）', () => {
  test('被 block 的 app 不进 events.jsonl；suppressed 只记 type/ts/scope；密码框不落盘', async () => {
    const home = tmpHome();
    // 同时放行与阻断 1Password —— block 必须赢
    writeConfig(home, {
      enabled: true,
      allowlist: [{ scope: 'app', value: '*' }],
      blocklist: [{ scope: 'app', value: 'com.1password.*' }],
      includeURLs: true,
      includeFocusedElement: true,
    });
    const d = mockDaemon(home, { MOCK_TICK_MS: '80' });
    try {
      await d.request('start');
      await sleep(2000); // 三幕样本至少各跑一轮（含多轮循环）
      await d.request('stop');

      const segs = listSegments(home);
      assert.ok(segs.length >= 1);
      const seg = segs[0];
      const data = readSegmentEvents(home, seg.segment, { withSuppressed: true });
      assert.ok(data.events.length > 0);

      // 1Password 不得出现在任何事件的任何字段
      const raw = JSON.stringify(data.events);
      assert.ok(!raw.includes('1password'), '被 block 的 app 不得出现在 events.jsonl');
      assert.ok(!raw.includes('Vault'), '被 block 的 app 窗口标题不得泄漏');
      // 密码框焦点内容不落盘（scenario 第三幕的 focus 是 AXSecureTextField）
      assert.ok(!raw.includes('AXSecureTextField'));
      assert.ok(!raw.includes('master password'));

      // suppressed 记录：只有 type/ts/scope，无内容字段
      assert.ok(data.suppressed.length > 0, '应有抑制记录');
      for (const s of data.suppressed) {
        assert.deepEqual(Object.keys(s).sort(), ['scope', 'ts', 'type']);
        assert.equal(s.type, 'sample');
        assert.equal(s.scope, 'app');
      }
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('includeURLs=false → 不落 URL 事件', async () => {
    const home = tmpHome();
    writeConfig(home, { ...defaultConfig(), includeURLs: false });
    const d = mockDaemon(home, { MOCK_TICK_MS: '80' });
    try {
      await d.request('start');
      await sleep(1500);
      await d.request('stop');
      const seg = listSegments(home)[0];
      const { events } = readSegmentEvents(home, seg.segment);
      assert.ok(events.every((e) => e.type !== 'url-change'));
      assert.ok(!JSON.stringify(events).includes('https://docs.example.com'));
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- setup 辅助 ----------

describe('setup 辅助', () => {
  test('ensureHomeDirs：建目录 + 默认配置；二次运行不覆盖', () => {
    const home = tmpHome();
    try {
      const r1 = ensureHomeDirs(home);
      assert.equal(r1.createdConfig, true);
      assert.ok(existsSync(path.join(home, 'segments')));
      const raw = readFileSync(r1.configPath, 'utf8');
      assert.deepEqual(JSON.parse(raw), defaultConfig());
      writeConfig(home, { ...defaultConfig(), blocklist: [{ scope: 'app', value: 'com.custom.blocked' }] });
      const r2 = ensureHomeDirs(home);
      assert.equal(r2.createdConfig, false);
      assert.ok(readFileSync(r2.configPath, 'utf8').includes('com.custom.blocked'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('buildInfoPlist：品牌字段与 LSUIElement/Apple Events 声明；无外部品牌词', () => {
    const plist = buildInfoPlist();
    assert.match(plist, /Chronicle Helper/);
    assert.match(plist, /com\.chronicle\.daemon-helper/);
    assert.match(plist, /<key>LSUIElement<\/key>/);
    assert.match(plist, /<key>NSAppleEventsUsageDescription<\/key>/);
    // 红线：品牌词零命中（拼串构造正则，避免本文件自己成为命中点）
    const banned = ['cod' + 'ex', 'ope' + 'nai', 'chat' + 'gpt', 'anth' + 'ropic', 'cla' + 'ude'];
    for (const w of banned) assert.ok(!new RegExp(w, 'i').test(plist), `plist 不得包含 ${w}`);
  });

  test('ensureHelperApp：落 .app 结构 + 二进制可执行 + 幂等不重拷', () => {
    const home = tmpHome();
    const src = path.join(home, 'src-bin');
    writeFileSync(src, '#!/bin/sh\necho mock\n');
    try {
      const r1 = ensureHelperApp({ srcBinary: src, home, codesign: false });
      assert.equal(r1.installed, true);
      assert.equal(r1.copiedBinary, true);
      const bin = path.join(r1.binaryPath);
      assert.ok(existsSync(bin));
      assert.ok(existsSync(path.join(home, `${APP_NAME}.app`, 'Contents', 'Info.plist')));
      // 幂等：未变不重拷
      const r2 = ensureHelperApp({ srcBinary: src, home, codesign: false });
      assert.equal(r2.copiedBinary, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑥ Swift 真编译自检 ----------

describe('Swift 守护真编译自检', { skip: swiftcPath() ? false : '本机无 swiftc，SKIP' }, () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'chronicle-swift-'));
  let bin = null;

  before(() => {
    const r = compileDaemon({ out: path.join(work, 'chronicle-daemon') });
    if (!r.compiled) throw new Error(`编译失败: ${r.reason}`);
    bin = r.path;
  });

  after(() => { rmSync(work, { recursive: true, force: true }); });

  test('probe/status/协议往返', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'chronicle-swift-home-'));
    const d = createDaemon({ binary: bin, home, timeoutMs: 10000 });
    try {
      const probe = await d.request('probe');
      assert.equal(probe.ok, true);
      assert.equal(typeof probe.axGranted, 'boolean');

      const st0 = await d.request('status');
      assert.equal(st0.running, false);
      assert.equal(st0.currentSegment, null);
      assert.equal(st0.config.paused, false);

      await assert.rejects(() => d.request('pause'), (e) => e.code === 'NOT_RUNNING');
      await assert.rejects(() => d.request('frobnicate'), (e) => e.code === 'UNKNOWN_CMD');
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('start→status→stop 全链路 + 「block 一切」隐私闸门端到端（确定性）', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'chronicle-swift-home-'));
    writeConfig(home, {
      enabled: true,
      allowlist: [{ scope: 'app', value: '*' }],   // 全放行
      blocklist: [{ scope: 'app', value: '*' }],   // 同时全阻断 —— block 必须赢
      includeURLs: true,
      includeFocusedElement: true,
    });
    const d = createDaemon({ binary: bin, home, timeoutMs: 10000 });
    try {
      const start = await d.request('start');
      assert.equal(start.ok, true);
      const st = await d.request('status');
      assert.equal(st.running, true);
      assert.equal(st.currentSegment.eventCount, 0);
      await sleep(4500); // 至少两个采样周期（2s/次）
      const stop = await d.request('stop');
      assert.equal(stop.ok, true);
      assert.equal(stop.stats.totalEvents, 0, 'block 一切 → 零事件');

      const segs = listSegments(home);
      assert.equal(segs.length, 1);
      const data = readSegmentEvents(home, segs[0].segment, { withSuppressed: true });
      assert.equal(data.events.length, 0, 'events.jsonl 必须为空');
      assert.ok(data.suppressed.length >= 1, '应有抑制记录（采样进 blocked 上下文的转换）');
      for (const s of data.suppressed) {
        assert.deepEqual(Object.keys(s).sort(), ['scope', 'ts', 'type']);
        assert.equal(s.scope, 'app');
      }
      // 段已关闭
      assert.equal(listSegments(home)[0].open, false);
      assert.ok(listSegments(home)[0].segmentEnd);
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
