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
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { globMatch, urlRuleMatch, privacyDecision, defaultConfig } from '../shared/privacy.mjs';
import {
  acquireInstanceLock,
  createDaemon,
  createHttpApp,
  chronicleHome,
  createLogger,
  isOurDaemonPid,
  listSegments,
  lockPath,
  logDateStamp,
  readInstanceLock,
  readPidFile,
  readSegmentEvents,
  releaseInstanceLock,
  stopManager,
  LOG_KEEP,
  LOG_MAX_BYTES,
  RESTART_DELAYS_MS,
  RESTART_STABLE_MS,
  waitForExit,
  writePidFile,
} from '../daemon.mjs';
import {
  compileDaemon,
  swiftcPath,
  ensureHomeDirs,
  ensureHelperApp,
  buildInfoPlist,
  buildLaunchAgentPlist,
  installLaunchAgent,
  uninstallLaunchAgent,
  writeLaunchAgent,
  ensureLocalSigningIdentity,
  codesignWithIdentity,
  parseSigningIdentities,
  selectSigningIdentity,
  APP_NAME,
  LAUNCHD_LABEL,
} from '../setup.mjs';
import { stopAndWait } from '../uninstall.mjs';

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

// ---------- 批次 3 测试辅助 ----------

const DAEMON_MJS = path.join(REPO_ROOT, 'daemon.mjs');

/** 轮询直到条件成立或超时（看护重启/进程退出用，避免固定 sleep 抖动）。 */
async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return Boolean(fn());
}

function readLogs(home) {
  try {
    const dir = path.join(home, 'logs');
    return readdirSync(dir).filter((n) => /^daemon-\d{8}\.log(\.\d+)?$/.test(n)).sort();
  } catch { return []; }
}

const fixedDate = (iso) => () => new Date(iso);

/** 桩 daemon：记录调用；支持 status/stats（HTTP 端点测试用）。 */
function stubDaemon({ running = false, stats = null } = {}) {
  const calls = [];
  return {
    calls,
    binary: '/stub/chronicle-daemon',
    proc: () => null,
    stats: () => stats ?? { restarts: 0, lastExit: null },
    async request(cmd, params = {}) {
      calls.push({ cmd, params });
      if (cmd === 'status') return { running, paused: false, currentSegment: null, totalEvents: 0, config: {} };
      return { ok: true, pausedAt: '2026-10-19T00:00:00.000Z', resumedAt: '2026-10-19T00:00:00.000Z' };
    },
  };
}

/** 造一个段（与 api.test 的 mkSeg 同构）。 */
function mkSeg(home, name, events) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ segmentStart: '2026-10-19T02:00:00.000Z', segmentEnd: '2026-10-19T02:10:00.000Z', eventCount: events.length }));
}

/** 原始 HTTP 请求（可自定义 Host/Origin/Content-Type；fetch 无法设置 Host）。 */
function rawRequest(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
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

      const pause = await http.fetchJson('/api/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationSec: 60 }) });
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

      // suppressed 记录：只有 {ts,type,scope[,reason]}，无内容字段
      assert.ok(data.suppressed.length > 0, '应有抑制记录');
      for (const s of data.suppressed) {
        const keys = Object.keys(s);
        for (const k of keys) assert.ok(['reason', 'scope', 'ts', 'type'].includes(k), `suppressed 不得含字段 ${k}`);
        for (const required of ['scope', 'ts', 'type']) assert.ok(required in s, `suppressed 缺少字段 ${required}`);
        assert.equal(s.type, 'sample');
        assert.equal(s.scope, 'app');
        if ('reason' in s) assert.equal(typeof s.reason, 'string');
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
    assert.match(plist, /<key>NSScreenCaptureUsageDescription<\/key>/, '按需 OCR 需要屏幕录制用途声明');
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
      // 图标：bundle 内 AppIcon.icns + Info.plist 的 CFBundleIconFile（TCC/辅助功能列表里会显示）
      const plistText = readFileSync(path.join(home, `${APP_NAME}.app`, 'Contents', 'Info.plist'), 'utf8');
      assert.match(plistText, /CFBundleIconFile/);
      assert.ok(existsSync(path.join(home, `${APP_NAME}.app`, 'Contents', 'Resources', 'AppIcon.icns')), '应安装 AppIcon.icns');
      // 幂等：未变不重拷
      const r2 = ensureHelperApp({ srcBinary: src, home, codesign: false });
      assert.equal(r2.copiedBinary, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑦ 单实例锁 ----------

describe('单实例锁（daemon.lock）', () => {
  test('首次获取写锁 {pid,startedAt,exe}；同进程重复获取被拒绝', () => {
    const home = tmpHome();
    try {
      const first = acquireInstanceLock(home);
      assert.equal(first.acquired, true);
      assert.equal(first.stale, false);
      const lock = readInstanceLock(home);
      assert.equal(lock.pid, process.pid);
      assert.equal(typeof lock.startedAt, 'string');
      assert.ok(lock.exe && lock.exe.length > 0);
      const second = acquireInstanceLock(home);
      assert.equal(second.acquired, false);
      assert.equal(second.lock.pid, process.pid);
      assert.equal(releaseInstanceLock(home), true);
      assert.equal(readInstanceLock(home), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('陈旧锁：pid 不存在 → 覆盖并标记 stale', () => {
    const home = tmpHome();
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(lockPath(home), JSON.stringify({ pid: 99999999, startedAt: '2026-01-01T00:00:00Z', exe: '/old/daemon.mjs' }));
      const r = acquireInstanceLock(home, { isAlive: () => false });
      assert.equal(r.acquired, true);
      assert.equal(r.stale, true);
      assert.equal(readInstanceLock(home).pid, process.pid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('陈旧锁：pid 存活但 cmdline 不是本仓库 daemon.mjs → 覆盖（防 pid 复用）', () => {
    const home = tmpHome();
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(lockPath(home), JSON.stringify({ pid: 424242, startedAt: '2026-01-01T00:00:00Z', exe: '/usr/bin/python3' }));
      const r = acquireInstanceLock(home, { isAlive: () => true, cmdlineOf: () => '/usr/bin/python3 -m http.server 8080' });
      assert.equal(r.acquired, true);
      assert.equal(r.stale, true);
      assert.equal(readInstanceLock(home).pid, process.pid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('有效锁：pid 存活且 cmdline 命中本仓库 daemon.mjs → 拒绝且不覆盖', () => {
    const home = tmpHome();
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(lockPath(home), JSON.stringify({ pid: 424242, startedAt: '2026-01-01T00:00:00Z', exe: DAEMON_MJS }));
      const r = acquireInstanceLock(home, { isAlive: () => true, cmdlineOf: () => `/usr/local/bin/node ${DAEMON_MJS} --start` });
      assert.equal(r.acquired, false);
      assert.equal(r.lock.pid, 424242);
      assert.equal(readInstanceLock(home).pid, 424242);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑧ 崩溃自动重启（看护；mock 崩溃，不打断真实 Swift 采集） ----------

describe('崩溃自动重启（看护）', () => {
  test('非预期退出 → 指数退避重启；restarts/lastExit 如实记录', async () => {
    const home = tmpHome();
    const d = createDaemon({
      binary: process.execPath,
      args: [MOCK],
      home,
      timeoutMs: 8000,
      restartDelays: [20, 40],
      restartStableMs: 60_000,
    });
    try {
      assert.equal((await d.request('probe')).ok, true);
      assert.equal((await d.request('start')).ok, true);
      const firstPid = d.proc().pid;
      d.proc().kill('SIGKILL');
      // 对抗：崩溃窗口内的高频 status 轮询不得吞掉看护重启计数
      let restarted = false;
      for (let i = 0; i < 80; i += 1) {
        try { await d.request('status'); } catch { /* 崩溃窗口内可能 DAEMON_DEAD */ }
        if (d.stats().restarts >= 1) { restarted = true; break; }
        await sleep(50);
      }
      assert.equal(restarted, true, '看护应在退避后重启守护（且 restarts 不被轮询吞掉）');
      const exit = d.stats().lastExit;
      assert.equal(exit.expected, false, '非预期退出的 lastExit.expected 应为 false');
      assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0, `lastExit 应记录异常退出: ${JSON.stringify(exit)}`);
      assert.equal((await d.request('probe')).ok, true);
      assert.notEqual(d.proc().pid, firstPid);
      // 进程复活 ≠ 在记录：崩前在采集，重启后必须自动恢复采集
      let running = false;
      for (let i = 0; i < 100; i += 1) {
        try { if ((await d.request('status')).running === true) { running = true; break; } } catch { /* 重启窗口 */ }
        await sleep(50);
      }
      assert.equal(running, true, '看护重启后应自动恢复采集（status.running === true）');
    } finally {
      d.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('正常 stop 不触发重启（lastExit.expected=true）', async () => {
    const home = tmpHome();
    const d = createDaemon({ binary: process.execPath, args: [MOCK], home, timeoutMs: 8000, restartDelays: [10], restartStableMs: 60_000 });
    try {
      await d.request('probe');
      d.stop();
      await sleep(200);
      assert.equal(d.stats().restarts, 0);
      assert.equal(d.proc(), null);
      assert.equal(d.stats().lastExit.expected, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- 可靠性常量（验收口径） ----------

describe('可靠性常量', () => {
  test('退避序列 1/2/4/8/16/30s、稳定 60s 重置、日志 10MB/7 份', () => {
    assert.deepEqual([...RESTART_DELAYS_MS], [1000, 2000, 4000, 8000, 16000, 30000]);
    assert.equal(RESTART_STABLE_MS, 60_000);
    assert.equal(LOG_MAX_BYTES, 10 * 1024 * 1024);
    assert.equal(LOG_KEEP, 7);
  });
});

// ---------- ⑨ 守护日志（轮转 / 脱敏 / 旧日期清理） ----------

describe('守护日志', () => {
  const DAY = '2026-11-10T12:00:00Z';

  test('超过大小上限轮转，文件总数不超过 keep（当前 + 轮转副本）', () => {
    const home = tmpHome();
    try {
      const logger = createLogger({ home, maxBytes: 400, keep: 3, now: fixedDate(DAY) });
      for (let i = 0; i < 40; i += 1) logger.info(`tick ${i} ${'x'.repeat(40)}`);
      const files = readLogs(home);
      assert.ok(files.length >= 2, `应发生轮转，实际文件: ${files.join(',')}`);
      assert.ok(files.length <= 3, `保留份数应 <= 3，实际: ${files.join(',')}`);
      assert.ok(files.includes(`daemon-${logDateStamp(new Date(DAY))}.log`), '应有当天主日志');
      const all = files.map((n) => readFileSync(path.join(home, 'logs', n), 'utf8')).join('');
      assert.ok(!all.includes('https://'), '日志不得包含未脱敏 URL');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('日志行 URL 脱敏（绝不落 URL 内容）', () => {
    const home = tmpHome();
    try {
      const logger = createLogger({ home, now: fixedDate(DAY) });
      logger.error('event=window-change 打开 https://secret.example.com/a?token=1 失败');
      const content = readFileSync(logger.file(), 'utf8');
      assert.ok(!content.includes('secret.example.com'), 'URL host 不得写入日志');
      assert.ok(!content.includes('token=1'), 'URL query 不得写入日志');
      assert.match(content, /\[redacted-url\]/);
      assert.match(content, /^2026-11-10T12:00:00\.000Z ERROR /);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('捕获 Swift stderr：逐行交给日志回调，再经 logger 脱敏落盘', async () => {
    const home = tmpHome();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chronicle-stderr-'));
    const wrapper = path.join(dir, 'wrap.sh');
    writeFileSync(wrapper, `#!/bin/sh\necho "swift-stderr https://secret.example.com/x" >&2\nexec "${process.execPath}" "${MOCK}"\n`);
    chmodSync(wrapper, 0o755);
    const lines = [];
    const d = createDaemon({ binary: wrapper, args: [], home, timeoutMs: 8000, restart: false, stderr: (l) => lines.push(l) });
    try {
      assert.equal((await d.request('probe')).ok, true);
      assert.equal(await waitUntil(() => lines.length > 0, { timeoutMs: 2000 }), true);
      assert.ok(lines.some((l) => l.includes('swift-stderr')), `stderr 行应被捕获: ${JSON.stringify(lines)}`);
      const logger = createLogger({ home, now: fixedDate(DAY) });
      for (const l of lines) logger.error(l);
      const content = readFileSync(logger.file(), 'utf8');
      assert.ok(!content.includes('secret.example.com'), 'stderr 里的 URL 也必须脱敏');
      assert.match(content, /\[redacted-url\]/);
    } finally {
      d.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('旧日期日志被清理（保留最近 keep 个日期）', () => {
    const home = tmpHome();
    try {
      mkdirSync(path.join(home, 'logs'), { recursive: true });
      writeFileSync(path.join(home, 'logs', 'daemon-20200101.log'), 'old\n');
      writeFileSync(path.join(home, 'logs', 'daemon-20200102.log'), 'old\n');
      const logger = createLogger({ home, keep: 2, now: fixedDate(DAY) });
      logger.info('hello');
      const files = readLogs(home);
      assert.ok(!files.includes('daemon-20200101.log'), '超出 keep 的旧日期应被清理');
      assert.ok(files.includes('daemon-20200102.log'));
      assert.ok(files.includes(`daemon-${logDateStamp(new Date(DAY))}.log`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑩ launchd 开机自启（plist 生成 / 安装 / 卸载） ----------

describe('launchd 开机自启', () => {
  test('plist 内容：RunAtLoad/KeepAlive/ThrottleInterval=10/日志/ProgramArguments(--service)', () => {
    const home = tmpHome();
    try {
      const plist = buildLaunchAgentPlist({ home, repoRoot: REPO_ROOT, nodePath: '/usr/local/bin/node' });
      assert.match(plist, /<key>Label<\/key>\s*<string>com\.chronicle\.daemon<\/string>/);
      assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
      assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
      assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
      assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
      assert.ok(plist.includes(`<string>${path.join(REPO_ROOT, 'daemon.mjs')}</string>`));
      assert.ok(plist.includes('<string>--service</string>'));
      assert.ok(plist.includes(path.join(home, 'logs', 'service-out.log')));
      assert.ok(plist.includes(path.join(home, 'logs', 'service-err.log')));
      assert.ok(plist.includes('<key>StandardOutPath</key>'));
      assert.ok(plist.includes('<key>StandardErrorPath</key>'));
      assert.equal(LAUNCHD_LABEL, 'com.chronicle.daemon');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('生成物通过 plutil -lint（真实校验，不 bootstrap）', () => {
    const home = tmpHome();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chronicle-la-'));
    try {
      const plistPath = path.join(dir, 'com.chronicle.daemon.plist');
      writeLaunchAgent({ home, repoRoot: REPO_ROOT, nodePath: process.execPath, plistPath });
      assert.ok(existsSync(plistPath));
      const r = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
      assert.equal(r.status, 0, `plutil -lint 失败: ${r.stderr}`);
      assert.match(String(r.stdout), /OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('安装：bootstrap 失败回退 load -w（注入命令，不实际注册）', () => {
    const home = tmpHome();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chronicle-la-'));
    try {
      const plistPath = path.join(dir, 'com.chronicle.daemon.plist');
      const calls = [];
      const run = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'plutil') return { status: 0, stdout: 'OK', stderr: '' };
        if (cmd === 'launchctl' && args[0] === 'bootstrap') return { status: 1, stderr: 'bootstrap failed' };
        if (cmd === 'launchctl' && args[0] === 'load') return { status: 0, stderr: '' };
        return { status: 1, stderr: 'unexpected' };
      };
      const r = installLaunchAgent({ home, repoRoot: REPO_ROOT, nodePath: '/usr/local/bin/node', plistPath, platform: 'darwin', uid: 501, run });
      assert.equal(r.installed, true);
      assert.equal(r.lintOk, true);
      assert.equal(r.method, 'load');
      assert.ok(existsSync(plistPath));
      assert.deepEqual(calls[0], ['plutil', '-lint', plistPath]);
      assert.deepEqual(calls[1], ['launchctl', 'bootstrap', 'gui/501', plistPath]);
      assert.deepEqual(calls[2], ['launchctl', 'load', '-w', plistPath]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('非 macOS：跳过并提示，不写 plist', () => {
    const home = tmpHome();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chronicle-la-'));
    try {
      const plistPath = path.join(dir, 'nope.plist');
      const r = installLaunchAgent({ home, plistPath, platform: 'linux', run: () => ({ status: 0 }) });
      assert.equal(r.skipped, true);
      assert.equal(r.installed, false);
      assert.match(r.reason, /仅 macOS/);
      assert.ok(!existsSync(plistPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('卸载：先 bootout，失败回退 unload -w，再删 plist', () => {
    const home = tmpHome();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chronicle-la-'));
    try {
      const plistPath = path.join(dir, 'com.chronicle.daemon.plist');
      writeFileSync(plistPath, '<plist/>');
      const calls = [];
      const run = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'launchctl' && args[0] === 'bootout') return { status: 1, stderr: 'not loaded' };
        if (cmd === 'launchctl' && args[0] === 'unload') return { status: 0 };
        return { status: 1 };
      };
      const r = uninstallLaunchAgent({ plistPath, platform: 'darwin', uid: 501, run });
      assert.equal(r.bootedOut, true);
      assert.equal(r.plistRemoved, true);
      assert.match(r.method, /unload/);
      assert.deepEqual(calls[0], ['launchctl', 'bootout', 'gui/501/com.chronicle.daemon']);
      assert.deepEqual(calls[1], ['launchctl', 'unload', '-w', plistPath]);
      assert.ok(!existsSync(plistPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑪ 停止/删除安全（pid 归属 + 等待退出） ----------

describe('停止/删除安全', () => {
  test('stopManager：pid 存活但 cmdline 不属于本仓库 daemon.mjs → 拒绝发送信号', () => {
    const home = tmpHome();
    const signals = [];
    try {
      mkdirSync(home, { recursive: true });
      writePidFile(home, 424242);
      assert.equal(readPidFile(home), 424242);
      const r = stopManager(home, {
        pid: 424242,
        isAlive: () => true,
        cmdlineOf: () => '/sbin/launchd',
        kill: (pid, sig) => signals.push([pid, sig]),
      });
      assert.equal(r.stopped, false);
      assert.equal(r.reason, 'pid-not-ours');
      assert.deepEqual(signals, []);
      assert.equal(isOurDaemonPid(424242, { isAlive: () => true, cmdlineOf: () => '/sbin/launchd' }), false);
      assert.equal(isOurDaemonPid(424242, { isAlive: () => true, cmdlineOf: () => `node ${DAEMON_MJS}` }), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('stopManager：归属匹配 → SIGTERM', () => {
    const home = tmpHome();
    const signals = [];
    try {
      mkdirSync(home, { recursive: true });
      writePidFile(home, 424242);
      const r = stopManager(home, {
        pid: 424242,
        isAlive: () => true,
        cmdlineOf: () => `node ${DAEMON_MJS} --start`,
        kill: (pid, sig) => signals.push([pid, sig]),
      });
      assert.equal(r.stopped, true);
      assert.deepEqual(signals, [[424242, 'SIGTERM']]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('waitForExit：退出 → true；持续存活到超时 → false', async () => {
    let alive = true;
    let sleeps = 0;
    assert.equal(await waitForExit(424242, {
      timeoutMs: 1000,
      intervalMs: 10,
      isAlive: () => alive,
      sleep: async () => { sleeps += 1; if (sleeps >= 3) alive = false; },
    }), true);

    let t = 0;
    assert.equal(await waitForExit(424242, {
      timeoutMs: 3000,
      intervalMs: 50,
      isAlive: () => true,
      sleep: async () => {},
      now: () => { t += 1000; return t; },
    }), false);
  });

  test('stopAndWait：pid-not-ours 不杀；仍存活 → ok:false（中止删除）；正常退出 → ok:true', async () => {
    const home = tmpHome();
    try {
      mkdirSync(home, { recursive: true });
      writePidFile(home, 424242);
      const notOurs = await stopAndWait(home, {
        isAlive: () => true,
        cmdlineOf: () => '/bin/sleep 100',
        kill: () => { throw new Error('不应被杀'); },
      });
      assert.equal(notOurs.ok, true);
      assert.equal(notOurs.reason, 'pid-not-ours');
      assert.equal(notOurs.stopped, false);

      writePidFile(home, 424242);
      const stuck = await stopAndWait(home, {
        isAlive: () => true,
        cmdlineOf: () => `node ${DAEMON_MJS}`,
        kill: () => {},
        now: (() => { let v = 0; return () => { v += 1000; return v; }; })(),
      });
      assert.equal(stuck.ok, false);
      assert.equal(stuck.reason, 'still-running');

      writePidFile(home, 424243);
      let alive = true;
      const okR = await stopAndWait(home, {
        isAlive: () => alive,
        cmdlineOf: () => `node ${DAEMON_MJS}`,
        kill: () => {},
        sleep: async () => { alive = false; },
      });
      assert.equal(okR.ok, true);
      assert.equal(okR.stopped, true);
      assert.equal(readPidFile(home), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑫ HTTP 写方法安全边界 ----------

async function startStubHttp({ home = tmpHome(), seedConfig = true } = {}) {
  if (seedConfig) writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
  const daemon = stubDaemon();
  const server = createHttpApp({ daemon, home });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  return { home, daemon, port, server, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('HTTP 写方法安全（Host/Origin/Content-Type）', () => {
  test('Host 非回环 → 403；Origin 非法 → 403；合法 Origin → 放行', async () => {
    const h = await startStubHttp();
    try {
      const badHost = await rawRequest(h.port, {
        method: 'POST', path: '/api/pause',
        headers: { Host: 'evil.example:1234', 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationSec: 1 }),
      });
      assert.equal(badHost.status, 403);

      const badOrigin = await rawRequest(h.port, {
        method: 'POST', path: '/api/pause',
        headers: { Host: `127.0.0.1:${h.port}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationSec: 1 }),
      });
      assert.equal(badOrigin.status, 403);

      const okOrigin = await rawRequest(h.port, {
        method: 'POST', path: '/api/pause',
        headers: { Host: `127.0.0.1:${h.port}`, Origin: `http://127.0.0.1:${h.port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationSec: 1 }),
      });
      assert.equal(okOrigin.status, 200);
      assert.equal(okOrigin.body.ok, true);
    } finally {
      await h.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  test('带 body 的写请求 Content-Type 非 JSON → 415；JSON → 放行', async () => {
    const h = await startStubHttp();
    try {
      const badCt = await rawRequest(h.port, {
        method: 'PUT', path: '/api/config',
        headers: { Host: `127.0.0.1:${h.port}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'blocklist=[]',
      });
      assert.equal(badCt.status, 415);

      const badCtPause = await rawRequest(h.port, {
        method: 'POST', path: '/api/pause',
        headers: { Host: `127.0.0.1:${h.port}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify({ durationSec: 1 }),
      });
      assert.equal(badCtPause.status, 415);

      const good = await rawRequest(h.port, {
        method: 'PUT', path: '/api/config',
        headers: { Host: `127.0.0.1:${h.port}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ includeURLs: false }),
      });
      assert.equal(good.status, 200);
      assert.equal(good.body.ok, true);
    } finally {
      await h.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  test('GET 保持宽松（自定义 Host 不拦）', async () => {
    const h = await startStubHttp();
    try {
      const r = await rawRequest(h.port, { method: 'GET', path: '/api/segments', headers: { Host: 'some-other-host:1' } });
      assert.equal(r.status, 200);
    } finally {
      await h.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  test('enabled:false → true：PUT /api/config 会真正 start（解死锁）', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), enabled: false }));
    const daemon = stubDaemon({ running: false });
    const server = createHttpApp({ daemon, home });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = server.address().port;
    try {
      const r = await rawRequest(port, {
        method: 'PUT', path: '/api/config',
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.applied, true);
      assert.deepEqual(daemon.calls.map((c) => c.cmd), ['status', 'start']);
      const onDisk = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.equal(onDisk.enabled, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('未发生 enabled 变化时保持旧行为（applied:false，不强行 start）', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(defaultConfig()));
    const daemon = stubDaemon({ running: false });
    const server = createHttpApp({ daemon, home });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = server.address().port;
    try {
      const r = await rawRequest(port, {
        method: 'PUT', path: '/api/config',
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocklist: [{ scope: 'app', value: 'com.x.*' }] }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.applied, false);
      assert.deepEqual(daemon.calls.map((c) => c.cmd), ['status']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('/api/status 暴露 restarts / lastExit', async () => {
    const home = tmpHome();
    const lastExit = { code: 1, signal: null, at: '2026-11-10T00:00:00.000Z', uptimeMs: 1234, expected: false };
    const daemon = stubDaemon({ running: true, stats: { restarts: 3, lastExit } });
    const server = createHttpApp({ daemon, home });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = server.address().port;
    try {
      const st = await rawRequest(port, { path: '/api/status', headers: { Host: `127.0.0.1:${port}` } });
      assert.equal(st.status, 200);
      assert.equal(st.body.restarts, 3);
      assert.deepEqual(st.body.lastExit, lastExit);
      assert.equal(st.body.managerPid, process.pid, 'managerPid 必须是守护管理器自身 pid');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑬ 段名严格校验与 realpath 包含 ----------

describe('段名安全（严格正则 + realpath 包含）', () => {
  test('非法段名 400；不存在 404；符号链接逃逸 400', async () => {
    const home = tmpHome();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'chronicle-outside-'));
    writeFileSync(path.join(outside, 'events.jsonl'), '');
    const httpApp = await startHttp(stubDaemon(), home);
    try {
      mkdirSync(path.join(home, 'segments'), { recursive: true });
      for (const p of [
        '/api/segment/..%2F..%2Fconfig.json/events',
        '/api/segment/not-a-timestamp/events',
        '/api/segment/2026-10-19T02-00-00Z/events',
      ]) {
        assert.equal((await httpApp.fetchJson(p)).status, 400, `${p} 应 400`);
      }
      assert.equal((await httpApp.fetchJson('/api/segment/1999-01-01T00-00-00.000Z/events')).status, 404);
      const escapeName = '2026-10-19T02-00-00.000Z';
      symlinkSync(outside, path.join(home, 'segments', escapeName));
      const escape = await httpApp.fetchJson(`/api/segment/${escapeName}/events`);
      assert.equal(escape.status, 400);
    } finally {
      await httpApp.close();
      rmSync(outside, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ⑭ 分页接线（/api/segments + /api/search） ----------

describe('分页接线', () => {
  function seedSegments(home, n) {
    for (let i = 0; i < n; i += 1) {
      const day = String(1 + Math.floor(i / 24)).padStart(2, '0');
      const hour = String(i % 24).padStart(2, '0');
      const name = `2026-10-${day}T${hour}-00-00.000Z`;
      mkSeg(home, name, [{ ts: `2026-10-${day}T${hour}:00:00.000Z`, type: 'app-switch', data: { bundleId: `com.example.${i}`, appName: 'Editor', pid: i } }]);
    }
  }

  test('/api/segments 默认 limit=20 + hasMore/nextBefore；旧 segments 字段兼容', async () => {
    const home = tmpHome();
    seedSegments(home, 25);
    const httpApp = await startHttp(stubDaemon(), home);
    try {
      const r = await httpApp.fetchJson('/api/segments');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.segments), '旧字段 segments 必须保留');
      assert.deepEqual(r.body.segments, r.body.items, 'items 与旧 segments 同值（向后兼容）');
      assert.equal(r.body.items.length, 20);
      assert.equal(r.body.hasMore, true);
      assert.equal(r.body.nextBefore, r.body.items[r.body.items.length - 1].segment);

      const limitMax = await httpApp.fetchJson('/api/segments?limit=999');
      assert.equal(limitMax.body.items.length, 25);
      assert.equal(limitMax.body.hasMore, false);
      assert.equal(limitMax.body.nextBefore, null);

      const page2 = await httpApp.fetchJson(`/api/segments?limit=10&before=${encodeURIComponent(r.body.nextBefore)}`);
      assert.equal(page2.body.items.length, 5);
      assert.equal(page2.body.hasMore, false);
      // 分页无重复
      const names1 = r.body.items.map((s) => s.segment);
      assert.ok(page2.body.items.every((s) => !names1.includes(s.segment)));
    } finally {
      await httpApp.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('/api/search 分页 + from/to 范围；旧 count/capped/events 字段保留；非法范围 400', async () => {
    const home = tmpHome();
    mkSeg(home, '2026-10-19T02-00-00.000Z', [
      { ts: '2026-10-19T02:01:00.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://github.com/chronicle' } },
    ]);
    mkSeg(home, '2026-10-18T20-10-00.000Z', [
      { ts: '2026-10-18T20:11:00.000Z', type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: 'GitHub work' } },
    ]);
    const httpApp = await startHttp(stubDaemon(), home);
    try {
      const all = await httpApp.fetchJson('/api/search?q=github');
      assert.equal(all.status, 200);
      assert.equal(all.body.count, 2);
      assert.equal(all.body.capped, false);
      assert.equal(all.body.events.length, 2);

      const one = await httpApp.fetchJson('/api/search?q=github&limit=1');
      assert.equal(one.body.count, 1);
      assert.equal(one.body.capped, true);

      const second = await httpApp.fetchJson('/api/search?q=github&limit=1&offset=1');
      assert.equal(second.status, 200);
      assert.equal(second.body.count, 1);
      assert.equal(second.body.offset, 1);
      assert.equal(second.body.hasMore, false);
      assert.equal(second.body.nextOffset, null);
      assert.equal(second.body.total, 2);

      // 用 UTC 毫秒边界，避免测试受本地时区影响
      const fromMs = Date.parse('2026-10-19T00:00:00.000Z');
      const toMs = Date.parse('2026-10-19T23:59:59.999Z');
      const ranged = await httpApp.fetchJson(`/api/search?q=github&from=${fromMs}&to=${toMs}`);
      assert.equal(ranged.status, 200);
      assert.equal(ranged.body.count, 1);
      assert.equal(ranged.body.events[0].data.url, 'https://github.com/chronicle');

      const bad = await httpApp.fetchJson('/api/search?q=github&from=not-a-date');
      assert.equal(bad.status, 400, '非法时间范围应 400');
    } finally {
      await httpApp.close();
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
        assert.deepEqual(Object.keys(s).sort(), ['reason', 'scope', 'ts', 'type']);
        assert.equal(s.scope, 'app');
        assert.equal(s.reason, 'app-blocklist');
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

// ---------- ⑰ /api/config：R1 内容采集字段（保留/校验） ----------

describe('/api/config 内容采集字段', () => {
  test('PUT 合法内容字段：持久化 + 归一化 + GET 可读回', async () => {
    const h = await startStubHttp();
    try {
      const r = await rawRequest(h.port, {
        method: 'PUT', path: '/api/config',
        headers: { Host: `127.0.0.1:${h.port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeContent: false,
          contentMaxChars: 4096,
          diffMaxChars: 1024,
          inputTextMaxChars: 500,
          selectionMaxChars: 120,
        }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.config.includeContent, false);
      assert.equal(r.body.config.contentMaxChars, 4096);
      assert.equal(r.body.config.diffMaxChars, 1024);
      assert.equal(r.body.config.inputTextMaxChars, 500);
      assert.equal(r.body.config.selectionMaxChars, 120);

      const disk = JSON.parse(readFileSync(path.join(h.home, 'config.json'), 'utf8'));
      assert.equal(disk.includeContent, false);
      assert.equal(disk.contentMaxChars, 4096);
      assert.equal(disk.diffMaxChars, 1024);
      assert.equal(disk.inputTextMaxChars, 500);
      assert.equal(disk.selectionMaxChars, 120);

      const get = await rawRequest(h.port, {
        path: '/api/config', headers: { Host: `127.0.0.1:${h.port}` },
      });
      assert.equal(get.status, 200);
      assert.equal(get.body.config.includeContent, false);
      assert.equal(get.body.config.selectionMaxChars, 120);
    } finally {
      await h.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });

  test('旧 config 缺内容字段：PUT 其他字段时补齐默认（不丢未知键）', async () => {
    const home = tmpHome();
    try {
      writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        enabled: true, allowlist: [], blocklist: [], includeURLs: true, includeFocusedElement: true,
        privacy: { safariPrivateDetection: 'heuristic', excludeSafariURLs: false, redactURLQuery: true },
        summarizer: { provider: 'deepseek' },
      }));
      const daemon = stubDaemon();
      const server = createHttpApp({ daemon, home });
      await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
      const port = server.address().port;
      try {
        const r = await rawRequest(port, {
          method: 'PUT', path: '/api/config',
          headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeURLs: false }),
        });
        assert.equal(r.status, 200);
        const disk = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
        assert.equal(disk.includeContent, true);
        assert.equal(disk.contentMaxChars, 16384);
        assert.equal(disk.diffMaxChars, 4096);
        assert.equal(disk.inputTextMaxChars, 2000);
        assert.equal(disk.selectionMaxChars, 300);
        assert.deepEqual(disk.summarizer, { provider: 'deepseek' }, '未知键必须保留');
        assert.equal(disk.includeURLs, false);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('非法内容字段：类型/整数/边界 → 400 且不写盘', async () => {
    const h = await startStubHttp();
    try {
      const cases = [
        { includeContent: 'yes', pattern: /includeContent/ },
        { contentMaxChars: '8192', pattern: /contentMaxChars 须为整数/ },
        { diffMaxChars: 1.5, pattern: /diffMaxChars 须为整数/ },
        { inputTextMaxChars: 1, pattern: /inputTextMaxChars 须在 32-20000/ },
        { selectionMaxChars: 99999, pattern: /selectionMaxChars 须在 16-10000/ },
      ];
      const before = readFileSync(path.join(h.home, 'config.json'), 'utf8');
      for (const c of cases) {
        const name = Object.keys(c)[0];
        const r = await rawRequest(h.port, {
          method: 'PUT', path: '/api/config',
          headers: { Host: `127.0.0.1:${h.port}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ [name]: c[name] }),
        });
        assert.equal(r.status, 400, `${name} 非法应 400`);
        assert.equal(r.body.ok, false);
        assert.ok(r.body.errors.some((e) => c.pattern.test(e)), `${name} 错误信息应为 /${c.pattern}/，实际 ${JSON.stringify(r.body.errors)}`);
      }
      assert.equal(readFileSync(path.join(h.home, 'config.json'), 'utf8'), before, '校验失败不得写盘');
    } finally {
      await h.close();
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});

// ---------- TCC 责任进程解绑 shim ----------

describe('spawnShimPath（TCC 责任进程解绑）', () => {
  test('环境变量覆盖 > home/chronicle-spawn > null', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { spawnShimPath } = await import('../daemon.mjs');
    assert.equal(spawnShimPath('/nonexistent-home', { CHRONICLE_SPAWN_SHIM: '/x/shim' }), '/x/shim');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-shim-'));
    try {
      assert.equal(spawnShimPath(home, {}), null);
      fs.writeFileSync(path.join(home, 'chronicle-spawn'), '#!/bin/sh\nexit 0\n');
      assert.equal(spawnShimPath(home, {}), path.join(home, 'chronicle-spawn'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});



// ---------- ⑱ 稳定代码签名（U2：复用本机已有 codesigning 身份） ----------

const SIGNING_ENV = (() => {
  if (process.platform !== 'darwin') return { ok: false, reason: '非 macOS' };
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return { ok: false, reason: 'security find-identity 不可用' };
  const identities = parseSigningIdentities(r.stdout);
  return { ok: identities.length > 0, identities, reason: identities.length ? null : '本机无有效 codesigning 身份' };
})();

function makeTinyApp(home, bundleId = 'com.chronicle.test-app') {
  const app = path.join(home, 'TestSign.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  const bin = path.join(app, 'Contents', 'MacOS', 'TestSign');
  writeFileSync(bin, '#!/bin/sh\necho test\n');
  chmodSync(bin, 0o755);
  writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`);
  return app;
}

describe('稳定代码签名（U2：复用本机身份）', { skip: SIGNING_ENV.ok ? false : `本机无 codesigning 身份（${SIGNING_ENV.reason}），SKIP` }, () => {
  test('解析/选择：优先 Apple Development，过滤 CSSMERR 无效条目', () => {
    const hex = (c) => c.repeat(40);
    const stdout = [
      '  1) ' + hex('a') + ' "Developer ID Application: Example (TEAM123)"',
      '  2) ' + hex('b') + ' "Apple Development: xiixiixixi@gmail.com (XZTBXM8859)"',
      '  3) ' + hex('c') + ' "Broken Identity (CSSMERR_TP_NOT_TRUSTED)"',
    ].join('\n');
    const ids = parseSigningIdentities(stdout);
    assert.equal(ids.length, 2, '有效身份应 2 个（CSSMERR 条目被过滤）');
    assert.equal(ids[0].hash, hex('a'));
    assert.equal(selectSigningIdentity(ids).identity, 'Apple Development: xiixiixixi@gmail.com (XZTBXM8859)', '应优先 Apple Development');
    assert.equal(selectSigningIdentity([]), null);
    assert.equal(selectSigningIdentity(parseSigningIdentities('  0 valid identities found')), null);
  });

  test('ensureLocalSigningIdentity：只读发现本机身份（优先 Apple Development）', () => {
    const r = ensureLocalSigningIdentity();
    assert.equal(r.ok, true, `应发现身份: ${r.reason ?? ''}`);
    assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 1);
    if (SIGNING_ENV.identities.some((item) => /Apple Development/i.test(item.identity))) {
      assert.match(r.identity, /Apple Development/i, '有 Apple Development 时必须优先它');
      assert.equal(r.source, 'apple-development');
    }
  });

  test('codesignWithIdentity：用稳定身份真签临时 app（非 ad-hoc，无信任/搜索列表改动）', () => {
    const home = tmpHome();
    try {
      const app = makeTinyApp(home);
      const found = ensureLocalSigningIdentity();
      assert.equal(found.ok, true);
      const r = codesignWithIdentity(app, { home });
      assert.equal(r.signed, true, `签名失败: ${r.reason ?? ''}`);
      assert.equal(r.adhoc, false, '应使用本机稳定身份，而不是 ad-hoc');
      assert.equal(r.identity, found.identity);
      const dv = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' });
      const dvText = String(dv.stderr);
      assert.match(dvText, new RegExp(`Authority=${found.identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(dvText, /Signature=adhoc/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('无身份/签名失败 → ad-hoc 回退：不崩、记录原因、签名仍存在', () => {
    const home = tmpHome();
    try {
      const app = makeTinyApp(home, 'com.chronicle.fallback');
      const r = codesignWithIdentity(app, { identity: { ok: false, reason: '测试：本机无身份' } });
      assert.equal(r.signed, true, '回退 ad-hoc 也必须签上');
      assert.equal(r.adhoc, true);
      assert.match(String(r.reason), /稳定签名不可用|回退 ad-hoc/);
      const dv = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' });
      assert.match(String(dv.stderr), /Signature=adhoc/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ensureHelperApp 使用本机稳定身份签名（非 ad-hoc）', () => {
    const home = tmpHome();
    try {
      const src = path.join(home, 'src-daemon');
      writeFileSync(src, '#!/bin/sh\necho mock\n');
      const found = ensureLocalSigningIdentity();
      const r = ensureHelperApp({ srcBinary: src, home });
      assert.equal(r.installed, true);
      assert.equal(r.copiedBinary, true);
      assert.equal(r.signed, true);
      assert.equal(r.signing?.identity, found.identity, `应使用稳定身份: ${JSON.stringify(r.signing)}`);
      assert.equal(r.signing?.adhoc, false);
      const dv = spawnSync('codesign', ['-dv', '--verbose=2', r.appPath], { encoding: 'utf8' });
      assert.match(String(dv.stderr), new RegExp(`Authority=${found.identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      // 再次 ensureHelperApp：内容未变 → 不重拷，签名仍有效
      const r2 = ensureHelperApp({ srcBinary: src, home });
      assert.equal(r2.copiedBinary, false);
      assert.equal(r2.signed, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('非 macOS 直接拒绝（不执行任何命令）', () => {
    const home = tmpHome();
    try {
      const id = ensureLocalSigningIdentity({ platform: 'linux' });
      assert.equal(id.ok, false);
      assert.match(String(id.reason), /仅支持 macOS/);
      const signed = codesignWithIdentity('/tmp/whatever.app', { home, platform: 'linux' });
      assert.equal(signed.signed, false);
      assert.match(String(signed.reason), /仅 macOS/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
