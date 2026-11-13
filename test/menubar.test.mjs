// test/menubar.test.mjs — 任务 M1：macOS 菜单栏 App + setup/uninstall 接线
//
// 覆盖：
//   ① 真实 swiftc 编译后：--selftest 三态菜单模型（running/paused/not-running）、今日计数、
//      配置缺失提示、autostart 勾选、--action 各动作（pause15/60/forever/resume/status/
//      copy-mcp/open-*，含 open-model / open-ai 的 ?view= URL）
//   ② setup.mjs：Info.plist（LSUIElement/com.chronicle.menubar/NSHighResolutionCapable）、
//      installMenubarApp（app 结构 + app-config.json + 幂等 + codesign 关闭）、
//      buildMenubarLaunchAgentPlist（RunAtLoad/KeepAlive{SuccessfulExit:false}/Aqua/日志路径）、
//      writeMenubarLaunchAgent + 真实 plutil -lint、installMenubarLaunchAgent（注入 runner，
//      bootstrap 失败回退 load -w）、--skip-menubar 不产生 app
//   ③ uninstall.mjs：removeMenubarProgram、stopMenubarApp（pid 归属校验）、
//      uninstallMenubarLaunchAgent（注入 runner，bootout 再删 plist）、uninstallMenubar 全量
//
// 所有测试数据都在系统临时目录；不真实 bootstrap 到用户 LaunchAgents、不启动真实 UI。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  MENUBAR_BUNDLE_ID,
  MENUBAR_EXECUTABLE,
  MENUBAR_LABEL,
  appConfigPath,
  buildMenubarInfoPlist,
  buildMenubarLaunchAgentPlist,
  compileMenubar,
  installMenubarApp,
  installMenubarLaunchAgent,
  menubarAppPath,
  menubarBinaryPath,
  menubarLaunchAgentPath,
  packageVersion,
  writeMenubarLaunchAgent,
} from '../setup.mjs';
import {
  removeMenubarProgram,
  stopMenubarApp,
  uninstallMenubar,
  uninstallMenubarLaunchAgent,
} from '../uninstall.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(REPO_ROOT, 'setup.mjs');
const swiftcAvailable = (() => {
  try { return spawnSync('swiftc', ['--version'], { encoding: 'utf8', timeout: 20_000 }).status === 0; } catch { return false; }
})();

const tmpDir = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));
const tmpHome = () => tmpDir('chronicle-menubar-');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localDatePrefix(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 假 Chronicle HTTP 服务：/api/status、/api/segments、/api/pause、/api/resume，记录请求。 */
async function startFakeServer({ running = true, paused = false, todayEvents = 7, segmentIsToday = true, axGranted = true, screenGranted = true } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      calls.push({ method: req.method, path: url.pathname, query: url.search, body });
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (url.pathname === '/api/status') {
        res.end(JSON.stringify({ ok: true, status: { running, paused, totalEvents: 1, config: {} }, managerPid: process.pid }));
        return;
      }
      if (url.pathname === '/api/segments') {
        const day = segmentIsToday ? localDatePrefix() : '2020-01-01';
        res.end(JSON.stringify({ ok: true, items: [{ segment: `${day}T10-00-00.000Z`, segmentStart: `${day}T10:00:00.000Z`, eventCount: todayEvents, open: true }], hasMore: false, nextBefore: null }));
        return;
      }
      if (url.pathname === '/api/pause') { res.end(JSON.stringify({ ok: true, pausedAt: '2026-11-10T00:00:00.000Z' })); return; }
      if (url.pathname === '/api/resume') { res.end(JSON.stringify({ ok: true, resumedAt: '2026-11-10T00:00:00.000Z' })); return; }
      if (url.pathname === '/api/permissions') {
        res.end(JSON.stringify({ ok: true, axGranted, screenGranted, secureInput: false }));
        return;
      }
      if (url.pathname === '/api/permissions/request') { res.end(JSON.stringify({ ok: true, axGranted: false })); return; }
      if (url.pathname === '/api/permissions/screen') { res.end(JSON.stringify({ ok: true, screenGranted: false })); return; }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return {
    port: server.address().port,
    calls: () => calls.slice(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 抢一个当前空闲的端口（然后立刻释放，用于“服务未运行”用例）。 */
async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function writeAppConfigFile(home, port, extra = {}) {
  const cfg = { repoRoot: REPO_ROOT, nodePath: process.execPath, home, port, ...extra };
  writeFileSync(path.join(home, 'app-config.json'), JSON.stringify(cfg));
  return path.join(home, 'app-config.json');
}

/** 异步运行客户端：不能用 spawnSync（会阻塞本进程事件循环，假 HTTP 服务就无法响应）。 */
function runBinary(bin, args, home) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, HOME: home } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 20_000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* 非 JSON */ }
      resolve({ status, stdout, stderr, json });
    });
  });
}

function assertClientDidNotCrash(r) {
  assert.ok(!/Fatal error|Crash|Segmentation fault/.test(r.stderr || ''), `客户端崩溃: ${r.stderr}`);
}

// ---------- ① 菜单栏 App（真实 swiftc 编译） ----------

describe('菜单栏 App（Swift 编译 + 无头模式）', { skip: swiftcAvailable ? false : '本机无 swiftc，SKIP' }, () => {
  const buildDir = tmpDir('chronicle-menubar-bin-');
  const BIN = path.join(buildDir, MENUBAR_EXECUTABLE);

  before(() => {
    const r = compileMenubar({ out: BIN });
    assert.equal(r.compiled, true, `编译失败: ${r.reason}`);
    assert.ok(existsSync(BIN));
  });

  after(() => { rmSync(buildDir, { recursive: true, force: true }); });

  test('--selftest 运行中：状态行/三态图标/今日计数/菜单 enabled 矩阵', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true, paused: false, todayEvents: 7 });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      const r = await runBinary(BIN, ['--selftest', '--config', cfg], home);
      assert.equal(r.status, 0, r.stderr);
      assertClientDidNotCrash(r);
      const out = r.json;
      assert.equal(out.app, 'Chronicle');
      assert.equal(out.bundleId, MENUBAR_BUNDLE_ID);
      assert.equal(out.config.missing, false);
      assert.equal(out.config.port, server.port);
      assert.equal(out.status.state, 'running');
      assert.equal(out.status.icon, 'chart.bar.doc.horizontal');
      assert.equal(out.status.todayEvents, 7);
      assert.equal(out.menu[0].id, 'status');
      assert.equal(out.menu[0].enabled, false);
      assert.match(out.menu[0].label, /运行中/);
      assert.match(out.menu[0].label, /今日 7 条事件/);
      const byId = Object.fromEntries(out.menu.map((m) => [m.id, m]));
      for (const id of ['status', 'open-timeline', 'open-model', 'pause-15', 'pause-60', 'pause-forever', 'resume', 'ai-tools', 'copy-mcp', 'open-data', 'open-logs', 'autostart', 'quit']) {
        assert.ok(byId[id], `菜单缺少 id=${id}`);
      }
      // 顺序：模型配置在「打开时间线」之后
      const ids = out.menu.map((m) => m.id);
      assert.ok(ids.indexOf('open-model') === ids.indexOf('open-timeline') + 1, `open-model 应紧跟 open-timeline: ${ids.join(',')}`);
      assert.equal(byId['open-model'].label, '模型配置…');
      assert.equal(byId['open-model'].enabled, true);
      assert.equal(byId['ai-tools'].label, 'AI 工具接入…');
      assert.equal(byId['pause-15'].enabled, true);
      assert.equal(byId['pause-60'].enabled, true);
      assert.equal(byId['pause-forever'].enabled, true);
      assert.equal(byId.resume.enabled, false);
      assert.equal(byId.autostart.checked, false);
      assert.equal(out.autostart.installed, false);
      assert.equal(out.autostart.label, 'com.chronicle.daemon');
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--selftest 权限缺失：状态行后提示辅助功能/屏幕录制授权，动作请求对应接口', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ axGranted: false, screenGranted: false });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      const r = await runBinary(BIN, ['--selftest', '--config', cfg], home);
      assertClientDidNotCrash(r);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.status.axGranted, false);
      assert.equal(r.json.status.screenGranted, false);
      const ids = r.json.menu.map((m) => m.id);
      assert.equal(ids[0], 'status');
      assert.equal(ids[1], 'permission-accessibility', `权限项应紧跟状态行: ${ids.join(',')}`);
      assert.equal(ids[2], 'permission-screen');
      assert.equal(ids[3], 'open-timeline');
      const byId = Object.fromEntries(r.json.menu.map((m) => [m.id, m]));
      assert.match(byId['permission-accessibility'].label, /辅助功能权限/);
      assert.match(byId['permission-screen'].label, /屏幕录制权限/);
      assert.match(byId['permission-screen'].label, /点击授权/);

      const act = await runBinary(BIN, ['--action', 'permission-screen', '--config', cfg], home);
      assertClientDidNotCrash(act);
      assert.equal(act.json.ok, true);
      assert.equal(act.json.action, 'permission-screen');
      assert.ok(server.calls().some((c) => c.path === '/api/permissions/screen' && c.method === 'POST'),
        '应调用 /api/permissions/screen');
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--selftest 已暂停：pause.circle / 暂停项 disabled / 恢复 enabled', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true, paused: true });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      const r = await runBinary(BIN, ['--selftest', '--config', cfg], home);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.status.state, 'paused');
      assert.equal(r.json.status.icon, 'pause.circle');
      assert.match(r.json.menu[0].label, /已暂停/);
      const byId = Object.fromEntries(r.json.menu.map((m) => [m.id, m]));
      assert.equal(byId['pause-15'].enabled, false);
      assert.equal(byId['pause-60'].enabled, false);
      assert.equal(byId['pause-forever'].enabled, false);
      assert.equal(byId.resume.enabled, true);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--selftest 服务未运行：exclamationmark.circle / 暂停与恢复 disabled / label 未运行', async () => {
    const home = tmpHome();
    const port = await freePort();
    try {
      const cfg = writeAppConfigFile(home, port);
      const r = await runBinary(BIN, ['--selftest', '--config', cfg], home);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.status.state, 'not-running');
      assert.equal(r.json.status.icon, 'exclamationmark.circle');
      assert.equal(r.json.status.reachable, false);
      assert.equal(r.json.menu[0].label, '未运行');
      const byId = Object.fromEntries(r.json.menu.map((m) => [m.id, m]));
      assert.equal(byId['pause-15'].enabled, false);
      assert.equal(byId.resume.enabled, false);
      assert.equal(byId['open-timeline'].enabled, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--selftest 配置缺失：提示“配置缺失，重跑 setup”；今日不是今天 → 计数 0', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true, segmentIsToday: false });
    try {
      const missingCfg = path.join(home, 'no-such-config.json');
      const missing = await runBinary(BIN, ['--selftest', '--config', missingCfg, '--port', String(server.port)], home);
      assert.equal(missing.status, 0, missing.stderr);
      assert.equal(missing.json.config.missing, true);
      assert.match(missing.json.menu[0].label, /配置缺失，重跑 setup/);
      assert.equal(missing.json.status.state, 'running');

      const cfg = writeAppConfigFile(home, server.port);
      const r = await runBinary(BIN, ['--selftest', '--config', cfg], home);
      assert.equal(r.json.config.missing, false);
      assert.equal(r.json.status.todayEvents, 0, '最新段不在今天 → 今日计数应为 0');
      assert.match(r.json.menu[0].label, /今日 0 条事件/);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('autostart 勾选跟随 <HOME>/Library/LaunchAgents/com.chronicle.daemon.plist', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.chronicle.daemon.plist'), '<plist><dict/></plist>');
      const r = await runBinary(BIN, ['--selftest', '--config', cfg], home);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.autostart.installed, true);
      const autostart = r.json.menu.find((m) => m.id === 'autostart');
      assert.equal(autostart.checked, true);
      assert.ok(r.json.autostart.plistPath.startsWith(home), `plistPath 应在临时 HOME 下: ${r.json.autostart.plistPath}`);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--action pause15/pause60/pause-forever/resume：请求体契约', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      const p15 = await runBinary(BIN, ['--action', 'pause15', '--config', cfg], home);
      assert.equal(p15.status, 0, p15.stderr);
      assert.equal(p15.json.ok, true);
      assert.equal(p15.json.durationSec, 900);

      const p60 = await runBinary(BIN, ['--action', 'pause60', '--config', cfg], home);
      assert.equal(p60.status, 0, p60.stderr);
      assert.equal(p60.json.durationSec, 3600);

      const forever = await runBinary(BIN, ['--action', 'pause-forever', '--config', cfg], home);
      assert.equal(forever.status, 0, forever.stderr);
      assert.equal('durationSec' in forever.json, false, 'pause-forever 不应带 durationSec');

      const resume = await runBinary(BIN, ['--action', 'resume', '--config', cfg], home);
      assert.equal(resume.status, 0, resume.stderr);
      assert.equal(resume.json.ok, true);

      const pauses = server.calls().filter((c) => c.path === '/api/pause');
      assert.equal(pauses.length, 3);
      const bodies = pauses.map((c) => { try { return JSON.parse(c.body || '{}'); } catch { return {}; } });
      assert.equal(bodies[0].durationSec, 900);
      assert.equal(bodies[1].durationSec, 3600);
      assert.equal('durationSec' in bodies[2], false, 'pause-forever 的 body 不应有 durationSec');
      assert.equal(server.calls().filter((c) => c.path === '/api/resume').length, 1);
      assert.ok(server.calls().every((c) => c.path !== '/api/pause' || c.method === 'POST'));
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--action copy-mcp：仓库无 mcp-install.mjs 时输出合法 fallback JSON', async () => {
    const home = tmpHome();
    const emptyRepo = tmpDir('chronicle-empty-repo-');
    try {
      const cfg = writeAppConfigFile(home, 1, { repoRoot: emptyRepo });
      const r = await runBinary(BIN, ['--action', 'copy-mcp', '--config', cfg], home);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.source, 'fallback');
      assert.equal(r.json.config.mcpServers.chronicle.command, 'node');
      assert.ok(r.json.config.mcpServers.chronicle.args[0].endsWith('mcp-entry.mjs'));
      const parsed = JSON.parse(r.json.text);
      assert.ok(parsed.mcpServers.chronicle, 'text 必须是合法 MCP JSON 片段');
      assert.ok(parsed.mcpServers.chronicle.args[0].includes('mcp-entry.mjs'));
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--action open-model / open-ai：输出 ?view=model / ?view=ai 的本地 URL', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      const model = await runBinary(BIN, ['--action', 'open-model', '--config', cfg], home);
      assert.equal(model.status, 0, model.stderr);
      assert.equal(model.json.ok, true);
      assert.equal(model.json.url, `http://127.0.0.1:${server.port}/?view=model`);

      const ai = await runBinary(BIN, ['--action', 'open-ai', '--config', cfg], home);
      assert.equal(ai.status, 0, ai.stderr);
      assert.equal(ai.json.ok, true);
      assert.equal(ai.json.url, `http://127.0.0.1:${server.port}/?view=ai`);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--action status / open-timeline / open-data / open-logs：输出正确 URL，不弹 UI', async () => {
    const home = tmpHome();
    const server = await startFakeServer({ running: true, todayEvents: 3 });
    try {
      const cfg = writeAppConfigFile(home, server.port);
      const status = await runBinary(BIN, ['--action', 'status', '--config', cfg], home);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(status.json.status.state, 'running');
      assert.equal(status.json.status.todayEvents, 3);

      const timeline = await runBinary(BIN, ['--action', 'open-timeline', '--config', cfg], home);
      assert.equal(timeline.json.url, `http://127.0.0.1:${server.port}/`);

      const data = await runBinary(BIN, ['--action', 'open-data', '--config', cfg], home);
      assert.equal(data.json.url, `file://${home}`);

      const logs = await runBinary(BIN, ['--action', 'open-logs', '--config', cfg], home);
      assert.equal(logs.json.url, `file://${home}/logs`);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('未知 --action：exit 1 且输出 JSON 错误', async () => {
    const home = tmpHome();
    try {
      const cfg = writeAppConfigFile(home, 1);
      const r = await runBinary(BIN, ['--action', 'frobnicate', '--config', cfg], home);
      assert.equal(r.status, 1);
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, /未知动作/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ② setup.mjs：Info.plist / app 安装 / LaunchAgent ----------

describe('setup：菜单栏 App 安装件', () => {
  test('buildMenubarInfoPlist：bundle id / LSUIElement / 可执行名 / Retina / 版本', () => {
    const plist = buildMenubarInfoPlist({ version: '9.9.9' });
    assert.match(plist, /<string>com\.chronicle\.menubar<\/string>/);
    assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>ChronicleMenuBar<\/string>/);
    assert.match(plist, /<key>CFBundleName<\/key>\s*<string>Chronicle<\/string>/);
    assert.match(plist, /<key>NSHighResolutionCapable<\/key>\s*<true\/>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
    assert.match(plist, /<string>9\.9\.9<\/string>/);
    assert.ok(plist.includes(`<string>${MENUBAR_EXECUTABLE}</string>`));
  });

  test('installMenubarApp（注入二进制、不签名）：app 结构 + app-config.json + 幂等', () => {
    const home = tmpHome();
    const src = path.join(home, 'fake-menubar');
    writeFileSync(src, '#!/bin/sh\nexit 0\n');
    try {
      const r1 = installMenubarApp({ home, srcBinary: src, compile: false, codesign: false, version: '1.2.3', port: 4567 });
      assert.equal(r1.installed, true, r1.reason);
      assert.ok(existsSync(menubarBinaryPath(home)));
      assert.ok(existsSync(path.join(menubarAppPath(home), 'Contents', 'Info.plist')));
      assert.ok(existsSync(path.join(menubarAppPath(home), 'Contents', 'Resources', 'AppIcon.icns')), '菜单栏 App 应安装图标');
      const plist = readFileSync(path.join(menubarAppPath(home), 'Contents', 'Info.plist'), 'utf8');
      assert.match(plist, /com\.chronicle\.menubar/);
      assert.match(plist, /1\.2\.3/);
      const cfg = JSON.parse(readFileSync(appConfigPath(home), 'utf8'));
      assert.equal(cfg.port, 4567);
      assert.equal(cfg.home, home);
      assert.equal(cfg.repoRoot, REPO_ROOT);
      assert.ok(cfg.nodePath.length > 0);
      // 幂等：再跑一次仍然 installed，配置同样可读
      const r2 = installMenubarApp({ home, srcBinary: src, compile: false, codesign: false, version: '1.2.3', port: 4567 });
      assert.equal(r2.installed, true);
      assert.equal(JSON.parse(readFileSync(appConfigPath(home), 'utf8')).port, 4567);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('installMenubarApp 真实编译：app Info.plist 通过 plutil -lint，二进制可执行', { skip: swiftcAvailable ? false : '本机无 swiftc，SKIP' }, () => {
    const home = tmpHome();
    try {
      // 用不常见端口，避免与用户真实安装的 3777 冲突（本测试断言服务未运行）
      const r = installMenubarApp({ home, compile: true, codesign: true, version: '9.9.9', port: 47771 });
      assert.equal(r.installed, true, r.reason);
      assert.ok(existsSync(menubarBinaryPath(home)), '应产出可执行文件');
      const lint = spawnSync('plutil', ['-lint', path.join(menubarAppPath(home), 'Contents', 'Info.plist')], { encoding: 'utf8' });
      assert.equal(lint.status, 0, `Info.plist 校验失败: ${lint.stderr}`);
      const plist = readFileSync(path.join(menubarAppPath(home), 'Contents', 'Info.plist'), 'utf8');
      assert.match(plist, /LSUIElement/);
      assert.match(plist, /9\.9\.9/);
      // --selftest 可直接跑（用刚装好的 app 二进制，服务未运行 → not-running）
      const probe = spawnSync(menubarBinaryPath(home), ['--selftest', '--config', appConfigPath(home)], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home } });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(JSON.parse(probe.stdout).status.state, 'not-running');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('installMenubarApp：非 macOS 跳过；源码缺失时如实报错', () => {
    const home = tmpHome();
    try {
      const skipped = installMenubarApp({ home, platform: 'linux', srcBinary: '/nope', compile: false });
      assert.equal(skipped.skipped, true);
      assert.equal(skipped.installed, false);
      if (swiftcAvailable) {
        const missingSrc = installMenubarApp({ home, compile: true, srcBinary: path.join(home, 'missing') });
        assert.equal(missingSrc.installed, false);
        assert.match(missingSrc.reason, /不存在/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('buildMenubarLaunchAgentPlist：RunAtLoad + KeepAlive{SuccessfulExit:false} + Aqua + 日志 + 参数', () => {
    const home = tmpHome();
    try {
      const binaryPath = menubarBinaryPath(home);
      const plist = buildMenubarLaunchAgentPlist({ home, binaryPath, port: 4567, repoRoot: REPO_ROOT });
      assert.match(plist, new RegExp(`<string>${MENUBAR_LABEL.replace(/\./g, '\\.')}</string>`));
      assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
      assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
      assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
      assert.ok(plist.includes(`<string>${binaryPath}</string>`));
      assert.ok(plist.includes('<string>--port</string>'));
      assert.ok(plist.includes('<string>4567</string>'));
      assert.ok(plist.includes(path.join(home, 'logs', 'menubar-out.log')));
      assert.ok(plist.includes(path.join(home, 'logs', 'menubar-err.log')));
      assert.ok(plist.includes('<key>CHRONICLE_HOME</key>'));
      // 真实 plutil -lint
      const { plistPath } = writeMenubarLaunchAgent({ home, binaryPath, port: 4567, repoRoot: REPO_ROOT, plistPath: path.join(home, 'com.chronicle.menubar.plist') });
      const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
      assert.equal(lint.status, 0, `plutil -lint 失败: ${lint.stderr}`);
      assert.match(String(lint.stdout), /OK/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('installMenubarLaunchAgent：bootstrap 失败回退 load -w（注入 runner，不真实注册）', () => {
    const home = tmpHome();
    const dir = tmpDir('chronicle-menubar-la-');
    try {
      const plistPath = path.join(dir, 'com.chronicle.menubar.plist');
      const calls = [];
      const run = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'plutil') return { status: 0, stdout: 'OK', stderr: '' };
        if (cmd === 'launchctl' && args[0] === 'bootstrap') return { status: 1, stderr: 'bootstrap failed' };
        if (cmd === 'launchctl' && args[0] === 'load') return { status: 0, stderr: '' };
        return { status: 1 };
      };
      const r = installMenubarLaunchAgent({ home, binaryPath: menubarBinaryPath(home), port: 3777, plistPath, platform: 'darwin', uid: 501, run, repoRoot: REPO_ROOT });
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

  test('menubarLaunchAgentPath 跟随 HOME（临时目录），label 正确', () => {
    const saved = process.env.HOME;
    const home = tmpHome();
    try {
      process.env.HOME = home;
      const p = menubarLaunchAgentPath();
      assert.equal(p, path.join(home, 'Library', 'LaunchAgents', 'com.chronicle.menubar.plist'));
      assert.equal(MENUBAR_LABEL, 'com.chronicle.menubar');
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--skip-menubar：setup 不产生 Chronicle.app 与 app-config.json', () => {
    const home = tmpHome();
    try {
      const r = spawnSync(process.execPath, [SETUP, '--home', home, '--skip-compile', '--skip-service', '--skip-menubar'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, CHRONICLE_HOME: home },
      });
      assert.equal(r.status, 0, `setup 失败: ${r.stderr}`);
      assert.ok(!existsSync(menubarAppPath(home)), '--skip-menubar 不应安装 Chronicle.app');
      assert.ok(!existsSync(appConfigPath(home)), '--skip-menubar 不应写 app-config.json');
      assert.ok(existsSync(path.join(home, 'config.json')), '数据目录/默认配置仍应创建');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ③ uninstall.mjs：菜单栏移除 ----------

describe('uninstall：菜单栏 App 移除', () => {
  test('removeMenubarProgram：删 Chronicle.app 与 app-config.json', () => {
    const home = tmpHome();
    try {
      mkdirSync(path.join(menubarAppPath(home), 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(menubarBinaryPath(home), 'x');
      writeFileSync(appConfigPath(home), '{}');
      const r = removeMenubarProgram({ home });
      assert.equal(r.appRemoved, true);
      assert.equal(r.configRemoved, true);
      assert.ok(!existsSync(menubarAppPath(home)));
      assert.ok(!existsSync(appConfigPath(home)));
      // 再删一次：幂等
      const again = removeMenubarProgram({ home });
      assert.equal(again.appRemoved, false);
      assert.equal(again.configRemoved, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('stopMenubarApp：按绝对路径匹配 pid + cmdline 归属校验（不误杀）', () => {
    const home = tmpHome();
    try {
      mkdirSync(path.dirname(menubarBinaryPath(home)), { recursive: true });
      writeFileSync(menubarBinaryPath(home), 'x');
      const binaryPath = menubarBinaryPath(home);
      const killed = [];
      // 两个 pid：一个 cmdline 不属于本 App（跳过），一个属于（杀）
      const run = (cmd, args) => {
        if (cmd === 'pgrep') return { status: 0, stdout: '111\n222\n' };
        return { status: 0 };
      };
      const r = stopMenubarApp({
        home,
        run,
        isAlive: () => true,
        cmdlineOf: (pid) => (pid === 222 ? `${binaryPath} --port 3777` : '/usr/bin/something-else'),
        kill: (pid, sig) => killed.push([pid, sig]),
      });
      assert.deepEqual(r.stopped, [222]);
      assert.deepEqual(r.skipped, [111]);
      assert.deepEqual(killed, [[222, 'SIGTERM']]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('stopMenubarApp：未安装时直接返回（不调 pgrep）', () => {
    const home = tmpHome();
    try {
      let called = 0;
      const r = stopMenubarApp({ home, run: () => { called += 1; return { status: 0, stdout: '' }; } });
      assert.equal(r.installed, false);
      assert.equal(called, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uninstallMenubarLaunchAgent：先 bootout 再删 plist（注入 runner，HOME=临时目录）', () => {
    const savedHome = process.env.HOME;
    const home = tmpHome();
    try {
      process.env.HOME = home;
      const plistPath = menubarLaunchAgentPath();
      mkdirSync(path.dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, '<plist><dict/></plist>');
      const calls = [];
      const run = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'launchctl' && args[0] === 'bootout') return { status: 0 };
        return { status: 1 };
      };
      const r = uninstallMenubarLaunchAgent({ run, platform: 'darwin', uid: 501 });
      assert.equal(r.bootedOut, true);
      assert.equal(r.plistRemoved, true);
      assert.deepEqual(calls[0], ['launchctl', 'bootout', 'gui/501/com.chronicle.menubar']);
      assert.ok(!existsSync(plistPath));
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uninstallMenubar：自启项 + 进程 + 程序本体一次清（全部注入）', () => {
    const savedHome = process.env.HOME;
    const home = tmpHome();
    try {
      process.env.HOME = home;
      // 准备：plist / app / app-config / pgrep 结果
      const plistPath = menubarLaunchAgentPath();
      mkdirSync(path.dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, '<plist/>');
      mkdirSync(path.dirname(menubarBinaryPath(home)), { recursive: true });
      writeFileSync(menubarBinaryPath(home), 'x');
      writeFileSync(appConfigPath(home), '{}');
      const binaryPath = menubarBinaryPath(home);
      const killed = [];
      const run = (cmd, args) => {
        if (cmd === 'launchctl' && args[0] === 'bootout') return { status: 0 };
        if (cmd === 'pgrep') return { status: 0, stdout: '4242\n' };
        return { status: 1 };
      };
      const r = uninstallMenubar({
        home,
        run,
        platform: 'darwin',
        uid: 501,
        isAlive: () => true,
        cmdlineOf: () => `${binaryPath} --port 3777`,
        kill: (pid, sig) => killed.push([pid, sig]),
      });
      assert.equal(r.launchAgent.bootedOut, true);
      assert.deepEqual(r.app.stopped, [4242]);
      assert.equal(r.program.appRemoved, true);
      assert.equal(r.program.configRemoved, true);
      assert.ok(!existsSync(plistPath));
      assert.ok(!existsSync(menubarAppPath(home)));
      assert.ok(!existsSync(appConfigPath(home)));
      assert.deepEqual(killed, [[4242, 'SIGTERM']]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- ④ 版本号与既有语义兼容 ----------

describe('兼容性', () => {
  test('packageVersion 读取 package.json；老 setup 参数语义保留', () => {
    assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
    // 旧参数解析仍然工作（不因新增 --skip-menubar 破坏）
    const r = spawnSync(process.execPath, [SETUP, '--help'], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--skip-menubar/);
    assert.match(r.stdout, /--skip-service/);
  });
});

// ---------- 菜单栏 App 单实例：launchd 已启动时不再 open ----------

describe('menubarAppRunning（避免重复实例/重复图标）', () => {
  test('pgrep 命中 → true；未命中/异常 → false', async () => {
    const { menubarAppRunning } = await import('../setup.mjs');
    assert.equal(menubarAppRunning({ binaryPath: '/x/ChronicleMenuBar', run: () => ({ status: 0, stdout: '12345\n' }) }), true);
    assert.equal(menubarAppRunning({ binaryPath: '/x/ChronicleMenuBar', run: () => ({ status: 1, stdout: '' }) }), false);
    assert.equal(menubarAppRunning({ binaryPath: '/x/ChronicleMenuBar', run: () => { throw new Error('pgrep missing'); } }), false);
  });
});
