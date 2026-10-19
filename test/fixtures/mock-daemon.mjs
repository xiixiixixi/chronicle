#!/usr/bin/env node
// test/fixtures/mock-daemon.mjs — Swift 采集守护的 Node 桩（测试用）
//
// 说同一套行协议（stdin 一行 JSON 请求 → stdout 一行 JSON 响应，按 id 配对），
// 并在 <home>/segments/ 落同构的 events.jsonl / suppressed.jsonl / metadata.json。
// 场景回放：start 后按 MOCK_TICK_MS 间隔循环产出三幕样本（编辑器 → 浏览器 →
// 密码管理器[默认被 block]），MOCK_SEGMENT_MS 控制段轮转周期。
// 隐私闸门直接复用 shared/privacy.mjs（与 Swift 端同语义的镜像）。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { privacyDecision, defaultConfig } from '../../shared/privacy.mjs';

const HOME = process.env.CHRONICLE_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME, '.chronicle');
const TICK_MS = Number.parseInt(process.env.MOCK_TICK_MS ?? '150', 10);
const SEGMENT_MS = Number.parseInt(process.env.MOCK_SEGMENT_MS ?? '600000', 10);

// 三幕样本（第三幕默认被 defaultConfig 的 com.1password.* 屏蔽）
const SCENARIO = [
  { bundleId: 'com.example.editor', appName: 'Editor', pid: 1001, windowTitle: 'Notes — chapter 1', focus: { role: 'AXTextArea', title: 'Notes body' } },
  { bundleId: 'com.example.browser', appName: 'Browser', pid: 1002, windowTitle: 'Docs — Example', url: 'https://docs.example.com/chronicle', focus: { role: 'AXWebArea', title: '' } },
  { bundleId: 'com.1password.Mac', appName: 'Passwords', pid: 1003, windowTitle: 'Vault — 1Password', focus: { role: 'AXSecureTextField', title: 'master password' } },
];

let running = false;
let paused = false;
let config = defaultConfig();
let segment = null;
let totalEvents = 0;
let lifetimeEvents = 0;
let startedAt = 0;
let pausedAt = null;
let scenarioIdx = 0;
let last = { bundleId: '', windowTitle: '', url: '', focusKey: '', suppressedKey: '' };
let tickTimer = null;

function iso() { return new Date().toISOString(); }

function segDirName(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, (c) => (c === ':' ? '-' : '.'));
}

function newSegment() {
  const dir = path.join(HOME, 'segments', segDirName());
  mkdirSync(dir, { recursive: true });
  segment = { dir, startTs: iso(), startMs: Date.now(), eventCount: 0, suppressedCount: 0 };
  writeMetadata(null);
  return segment;
}

function writeMetadata(end) {
  if (!segment) return;
  const m = { segmentStart: segment.startTs, eventCount: segment.eventCount };
  if (end) m.segmentEnd = end;
  writeFileSync(path.join(segment.dir, 'metadata.json'), `${JSON.stringify(m)}\n`);
}

import { appendFileSync } from 'node:fs';

function emitEvent(type, data) {
  appendFileSync(path.join(segment.dir, 'events.jsonl'), `${JSON.stringify({ ts: iso(), type, data })}\n`);
  segment.eventCount += 1;
  totalEvents += 1;
  lifetimeEvents += 1;
  writeMetadata(null);
}

function emitSuppressed(type, scope) {
  appendFileSync(path.join(segment.dir, 'suppressed.jsonl'), `${JSON.stringify({ ts: iso(), type, scope })}\n`);
  segment.suppressedCount += 1;
}

function tick() {
  if (!running || paused || !segment) return;
  // 段轮转
  if (Date.now() - segment.startMs >= SEGMENT_MS) {
    writeMetadata(iso());
    newSegment();
  }
  const s = SCENARIO[scenarioIdx % SCENARIO.length];
  scenarioIdx += 1;

  const decision = privacyDecision({ bundleId: s.bundleId, url: s.url ?? null }, config);
  if (!decision.observe) {
    const key = `${decision.blockedScope}:${s.bundleId}`;
    if (key !== last.suppressedKey) {
      emitSuppressed('sample', decision.blockedScope);
      last.suppressedKey = key;
    }
    last = { bundleId: s.bundleId, windowTitle: '', url: '', focusKey: '', suppressedKey: key };
    return;
  }

  let emitted = false;
  if (s.bundleId !== last.bundleId) {
    emitEvent('app-switch', { bundleId: s.bundleId, appName: s.appName, pid: s.pid });
    last.bundleId = s.bundleId;
    emitted = true;
  }
  if (s.windowTitle && s.windowTitle !== last.windowTitle) {
    emitEvent('window-change', { bundleId: s.bundleId, windowTitle: s.windowTitle });
    last.windowTitle = s.windowTitle;
    emitted = true;
  }
  if (config.includeURLs !== false && s.url && s.url !== last.url) {
    emitEvent('url-change', { bundleId: s.bundleId, url: s.url });
    last.url = s.url;
    emitted = true;
  }
  // 密码框焦点：内容永远不记录（与 Swift 端一致——直接跳过）
  if (config.includeFocusedElement !== false && s.focus && s.focus.role !== 'AXSecureTextField') {
    const key = `${s.focus.role}|${s.focus.title ?? ''}`;
    if (key !== last.focusKey) {
      const data = { bundleId: s.bundleId, role: s.focus.role };
      if (s.focus.title) data.title = s.focus.title;
      emitEvent('focus-change', data);
      last.focusKey = key;
      emitted = true;
    }
  }
  if (emitted) last.suppressedKey = '';
}

function loadConfig(configPath) {
  const p = configPath && configPath.length ? configPath : path.join(HOME, 'config.json');
  if (existsSync(p)) {
    try { return { ...defaultConfig(), ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { return defaultConfig(); }
  }
  return defaultConfig();
}

function stopObservation() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  const durationMs = running ? Date.now() - startedAt : 0;
  if (segment) { writeMetadata(iso()); segment = null; }
  running = false;
  paused = false;
  return { totalEvents, durationMs };
}

function handle(req) {
  const { id, cmd, ...params } = req;
  const ok = (extra = {}) => process.stdout.write(`${JSON.stringify({ id, ok: true, ...extra })}\n`);
  const fail = (error, code) => process.stdout.write(`${JSON.stringify({ id, ok: false, error, code })}\n`);
  switch (cmd) {
    case 'probe':
      return ok({ axGranted: process.env.MOCK_AX === '1', protocol: 'mock' });
    case 'start': {
      if (running) return fail('already running', 'ALREADY_RUNNING');
      config = loadConfig(params.configPath);
      if (config.enabled === false) return fail('config.enabled=false', 'CONFIG_DISABLED');
      newSegment();
      running = true;
      paused = false;
      totalEvents = 0;
      startedAt = Date.now();
      last = { bundleId: '', windowTitle: '', url: '', focusKey: '', suppressedKey: '' };
      tickTimer = setInterval(tick, TICK_MS);
      return ok({ segmentsDir: path.join(HOME, 'segments') });
    }
    case 'stop':
      return ok({ stats: stopObservation() });
    case 'pause':
      if (!running) return fail('not running', 'NOT_RUNNING');
      paused = true;
      pausedAt = iso();
      return ok({ pausedAt });
    case 'resume':
      if (!running) return fail('not running', 'NOT_RUNNING');
      paused = false;
      pausedAt = null;
      return ok({ resumedAt: iso() });
    case 'status':
      return ok({
        running,
        paused,
        segmentsDir: path.join(HOME, 'segments'),
        totalEvents: lifetimeEvents,
        currentSegment: segment && running ? { startTs: segment.startTs, eventCount: segment.eventCount } : null,
        config: { ...config, paused },
      });
    default:
      return fail(`unknown-cmd: ${cmd}`, 'UNKNOWN_CMD');
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    try { handle(req); } catch (err) {
      process.stdout.write(`${JSON.stringify({ id: req.id ?? 0, ok: false, error: String(err.message) })}\n`);
    }
  }
});
process.stdin.on('end', () => { stopObservation(); process.exit(0); });
