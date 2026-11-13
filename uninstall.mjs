#!/usr/bin/env node
// uninstall.mjs — 卸载：移除 launchd 自启（守护 + 菜单栏）→ 停守护 → 停菜单栏 App →
//   删 Chronicle.app/app-config/Helper.app → 清数据目录（可选保留数据）
//
// 顺序很重要：launchd KeepAlive=true 会在进程被杀后立刻拉起，所以必须先 bootout
// 再停进程/删数据；停止时用 pidfile + 进程命令行归属校验（防 pid 复用误杀），
// 且必须等进程真正退出（最多 5s 轮询）才删数据——仍活则中止，不删任何东西。
//
// 用法：node uninstall.mjs [--home DIR] [--keep-data] [--service-only]
//   默认连 ~/.chronicle/ 一起删（含 segments 数据与 config.json）；
//   --keep-data    只删 Chronicle Helper.app / 编译产物 / 自启项，保留活动记录与隐私配置；
//   --service-only 只移除两个开机自启项（守护 + 菜单栏 launchd plist），不动数据与进程。

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  chronicleHome,
  clearPidFile,
  isPidAlive,
  probeManagerIdentity,
  processCmdline,
  readManagerPid,
  stopManager,
  waitForExit,
} from './daemon.mjs';
import {
  APP_NAME,
  MENUBAR_LABEL,
  appConfigPath,
  menubarAppPath,
  menubarBinaryPath,
  menubarLaunchAgentPath,
  uninstallLaunchAgent,
} from './setup.mjs';

const log = (s) => console.log(s);

export function parseArgs(argv) {
  const out = { home: null, keepData: false, serviceOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--home') out.home = path.resolve(next());
    else if (a === '--keep-data') out.keepData = true;
    else if (a === '--service-only') out.serviceOnly = true;
    else if (a === '--help' || a === '-h') { log('用法: node uninstall.mjs [--home DIR] [--keep-data] [--service-only]'); process.exit(0); }
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

/**
 * 停守护并等待退出（供 main 与测试复用；依赖全部可注入）。
 * 必须先通过命令行归属校验（或调用方注入的 HTTP 身份校验）才会发 SIGTERM；
 * 退出等待最多 timeoutMs，仍存活则返回 ok:false，调用方必须中止删除。
 * @returns {Promise<{ok:boolean, stopped:boolean, reason:string, pid?:number, waitedMs?:number}>}
 */
export async function stopAndWait(home, {
  timeoutMs = 5000,
  intervalMs = 100,
  isAlive = isPidAlive,
  cmdlineOf = processCmdline,
  kill = process.kill,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  pid = readManagerPid(home),
  verifyPid = null,
} = {}) {
  if (!pid) return { ok: true, stopped: false, reason: 'no-pidfile' };
  if (!isAlive(pid)) {
    clearPidFile(home);
    return { ok: true, stopped: false, reason: 'not-running', pid };
  }
  const stop = stopManager(home, { pid, isAlive, cmdlineOf, kill });
  let signalSent = false;
  if (stop.stopped) signalSent = true;
  else if (stop.reason === 'pid-not-ours') {
    // ps 命令行可能因相对路径启动而不含绝对路径：允许调用方用 HTTP /api/status 自证 pid 身份
    let verified = false;
    if (typeof verifyPid === 'function') {
      try { verified = Boolean(await verifyPid(pid)); } catch { verified = false; }
    }
    if (!verified) {
      clearPidFile(home);
      return { ok: true, stopped: false, reason: 'pid-not-ours', pid, cmdline: stop.cmdline ?? null };
    }
    try { kill(pid, 'SIGTERM'); signalSent = true; } catch (err) {
      return { ok: false, stopped: false, reason: 'kill-failed', pid, error: err.message };
    }
  } else {
    return { ok: false, stopped: false, reason: stop.reason ?? 'kill-failed', pid };
  }
  const startedAt = now();
  const exited = await waitForExit(pid, { timeoutMs, intervalMs, isAlive, sleep, now });
  const waitedMs = Math.max(0, now() - startedAt);
  if (!exited) return { ok: false, stopped: false, reason: 'still-running', pid, waitedMs };
  clearPidFile(home);
  return { ok: true, stopped: signalSent, reason: 'stopped', pid, waitedMs };
}

/** 停止菜单栏 App 进程（按二进制绝对路径匹配 pid + cmdline 归属校验，防误杀）。 */
export function stopMenubarApp({
  home = chronicleHome(),
  run = spawnSync,
  kill = process.kill,
  isAlive = isPidAlive,
  cmdlineOf = processCmdline,
  log: lg = () => {},
} = {}) {
  const binaryPath = menubarBinaryPath(home);
  if (!existsSync(binaryPath)) return { installed: false, stopped: [], skipped: [] };
  const r = run('pgrep', ['-f', binaryPath], { encoding: 'utf8', timeout: 5000 });
  const pids = String(r?.stdout ?? '').split('\n').map((v) => Number.parseInt(v.trim(), 10)).filter((v) => Number.isInteger(v) && v > 0);
  const stopped = [];
  const skipped = [];
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    const cmdline = cmdlineOf(pid) ?? '';
    if (!cmdline.includes(binaryPath)) { skipped.push(pid); continue; }
    try { kill(pid, 'SIGTERM'); stopped.push(pid); } catch { skipped.push(pid); }
  }
  if (stopped.length) lg(`   已停止菜单栏 App pid ${stopped.join(',')}`);
  return { installed: true, stopped, skipped };
}

/** 删除菜单栏 App 程序本体与 app-config（---keep-data 也要清，数据保留语义只针对 segments/config）。 */
export function removeMenubarProgram({ home = chronicleHome(), log: lg = () => {} } = {}) {
  const appPath = menubarAppPath(home);
  const configPath = appConfigPath(home);
  let appRemoved = false;
  let configRemoved = false;
  if (existsSync(appPath)) { rmSync(appPath, { recursive: true, force: true }); appRemoved = true; lg(`   已删除 ${appPath}`); }
  if (existsSync(configPath)) { rmSync(configPath, { force: true }); configRemoved = true; lg(`   已删除 ${configPath}`); }
  return { appRemoved, configRemoved, appPath, configPath };
}

/** 移除菜单栏 App 的开机自启项（bootout → 删 plist）。 */
export function uninstallMenubarLaunchAgent({
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  run = spawnSync,
  log: lg = () => {},
} = {}) {
  return uninstallLaunchAgent({ label: MENUBAR_LABEL, plistPath: menubarLaunchAgentPath(), platform, uid, run, log: lg });
}

/** 菜单栏 App 完整移除（自启项 + 进程 + 程序本体 + app-config）；测试可注入 run/kill。 */
export function uninstallMenubar({
  home = chronicleHome(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  run = spawnSync,
  kill = process.kill,
  isAlive = isPidAlive,
  cmdlineOf = processCmdline,
  log: lg = () => {},
} = {}) {
  const launchAgent = uninstallMenubarLaunchAgent({ platform, uid, run, log: lg });
  const app = stopMenubarApp({ home, run, kill, isAlive, cmdlineOf, log: lg });
  const program = removeMenubarProgram({ home, log: lg });
  return { launchAgent, app, program };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = args.home ?? chronicleHome();

  // ① 先移除开机自启（bootout 后 launchd 才不会把即将停止的进程再拉起）
  log('① 移除 launchd 开机自启 …');
  const launch = uninstallLaunchAgent({ home });
  if (launch.skipped) log(`   - ${launch.reason}`);
  else {
    log(`   ${launch.bootedOut ? '✓ 已 bootout' : '- 未在运行/未注册'}（${launch.method}）`);
    log(`   ${launch.plistRemoved ? '✓ 已删除 plist' : '- plist 不存在'}: ${launch.plistPath}`);
  }
  log('①b 移除菜单栏 App 开机自启 …');
  const mla = uninstallMenubarLaunchAgent({});
  if (mla.skipped) log(`   - ${mla.reason}`);
  else {
    log(`   ${mla.bootedOut ? '✓ 已 bootout' : '- 未在运行/未注册'}（${mla.method}）`);
    log(`   ${mla.plistRemoved ? '✓ 已删除 plist' : '- plist 不存在'}: ${mla.plistPath}`);
  }
  if (args.serviceOnly) {
    log('（--service-only）仅移除开机自启项（守护 + 菜单栏），数据与进程保持不变。');
    return 0;
  }

  // ② 停守护并等待退出（最多 5s）；仍活则中止，绝不删数据
  log('② 停止守护进程 …');
  let stop;
  try {
    stop = await stopAndWait(home, {
      verifyPid: async (pid) => (await probeManagerIdentity(home, pid)).verified,
    });
  } catch (err) {
    log(`   ✗ 停止失败: ${err.message}`);
    return 1;
  }
  if (!stop.ok) {
    log(`   ✗ 中止卸载：守护进程（pid ${stop.pid}）在 5s 内未退出，未删除任何数据。`);
    log('     请稍后重试，或先手动结束该进程再跑 uninstall。');
    return 1;
  }
  if (stop.stopped) log(`   ✓ 已停止守护管理器 pid ${stop.pid}（等待 ${stop.waitedMs}ms 确认退出）`);
  else if (stop.reason === 'pid-not-ours') log(`   - pidfile 里的 pid 不属于本仓库 daemon.mjs（疑似 pid 复用），已忽略且未发送信号: ${stop.cmdline ?? ''}`);
  else log('   - 守护未在运行');

  // ③ 停止菜单栏 App，删 <home>/Chronicle.app 与 app-config.json（即使 --keep-data 也清程序本体）
  log('③ 停止菜单栏 App 并移除 Chronicle.app …');
  const menubarStop = stopMenubarApp({ home });
  if (!menubarStop.installed) log('   - 菜单栏 App 未安装（跳过）');
  else if (!menubarStop.stopped.length) log('   - 菜单栏 App 未在运行');
  const menubarProgram = removeMenubarProgram({ home, log });
  if (!menubarProgram.appRemoved && !menubarProgram.configRemoved) log('   - Chronicle.app / app-config.json 不存在（跳过）');

  // ④ 删 Chronicle Helper.app（系统设置「辅助功能」列表里的条目会随之失效，可手动移除）
  const appPath = path.join(home, `${APP_NAME}.app`);
  if (existsSync(appPath)) {
    rmSync(appPath, { recursive: true, force: true });
    log(`④ 已删除 ${appPath}`);
    log('   （系统设置 → 隐私与安全性 → 辅助功能 里的残留条目可手动移除）');
  } else {
    log('④ Chronicle Helper.app 不存在（跳过）');
  }

  // ⑤ 数据目录
  if (args.keepData) {
    log(`⑤ 保留数据目录 ${home}（--keep-data）`);
  } else if (existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
    log(`⑤ 已删除数据目录 ${home}（活动记录与配置一并清除，不可恢复）`);
  } else {
    log('⑤ 数据目录不存在（跳过）');
  }

  // ⑥ 仓库内的编译产物（源码保留，随时 npm run setup 重装）
  const repoHost = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'host');
  if (existsSync(repoHost)) {
    rmSync(repoHost, { recursive: true, force: true });
    log('⑥ 已删除编译产物 host/（源码保留，npm run setup 可随时重装）');
  }
  log('卸载完成。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[uninstall] 失败: ${e.message}`); process.exit(1); });
}
