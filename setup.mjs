#!/usr/bin/env node
// setup.mjs — 一条命令安装 Chronicle：
//   ① swiftc 编译采集守护 → host/chronicle-daemon
//   ② 建 ~/.chronicle/（segments/ + config.json 默认值；已有配置不覆盖）
//   ③ 装 ~/.chronicle/Chronicle Helper.app（TCC 权限主体：辅助功能挂在这个 .app 上，
//      终端是谁无关，授权一次永久生效）
//   ④ 权限引导：探测 AXIsProcessTrusted；未授权则打开系统设置面板 + 浮琥珀引导卡片
//      （卡片左侧图标拖进「辅助功能」列表即授权；卡片 1.2s 轮询，生效自动消失）
//   ⑤ 打印使用说明
//
// 用法：node setup.mjs [--home DIR] [--skip-compile]
// 环境变量：CHRONICLE_HOME（数据根，同守护）

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createDaemon, chronicleHome } from './daemon.mjs';
import { defaultConfig } from './shared/privacy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SWIFT_SRC = path.join(REPO_ROOT, 'swift', 'chronicle-daemon.swift');
const HOST_BIN = path.join(REPO_ROOT, 'host', 'chronicle-daemon');

export const APP_NAME = 'Chronicle Helper';
export const APP_BUNDLE_ID = 'com.chronicle.daemon-helper';
export const APP_VERSION = '0.1.0';
const isMac = process.platform === 'darwin';

const log = (s) => console.log(s);

// ---------- 参数 ----------

export function parseArgs(argv) {
  const out = { home: null, skipCompile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--home') out.home = path.resolve(next());
    else if (a === '--skip-compile') out.skipCompile = true;
    else if (a === '--help' || a === '-h') {
      log('用法: node setup.mjs [--home DIR] [--skip-compile]');
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

// ---------- ① 编译 ----------

let swiftcMemo;
export function swiftcPath() {
  if (swiftcMemo !== undefined) return swiftcMemo;
  swiftcMemo = (() => {
    const probe = (cmd, args) => {
      try {
        const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
        return r.status === 0;
      } catch { return false; }
    };
    if (probe('swiftc', ['--version'])) return 'swiftc';
    try {
      const r = spawnSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8', timeout: 15_000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch { /* 无 xcrun */ }
    return null;
  })();
  return swiftcMemo;
}

/**
 * 编译守护。@returns {{compiled: boolean, swiftc: boolean, skipped?: boolean, reason?: string, path: string}}
 */
export function compileDaemon({ log: lg = () => {}, out = HOST_BIN } = {}) {
  if (!isMac) return { compiled: false, swiftc: false, skipped: true, path: out, reason: '仅支持 macOS（采集依赖 AppKit/AX）' };
  const swiftc = swiftcPath();
  if (!swiftc) return { compiled: false, swiftc: false, path: out, reason: '本机没有 swiftc（装 Xcode 或跑 xcode-select --install）' };
  if (!existsSync(SWIFT_SRC)) return { compiled: false, swiftc: true, path: out, reason: `源码缺失: ${SWIFT_SRC}` };
  mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(swiftc, ['-O', SWIFT_SRC, '-o', out], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) {
    return { compiled: false, swiftc: true, path: out, reason: `swiftc 退出码 ${r.status}: ${(r.stderr || '').slice(0, 400)}` };
  }
  chmodSync(out, 0o755);
  lg(`已编译 ${out}`);
  return { compiled: true, swiftc: true, path: out };
}

// ---------- ② 目录与默认配置 ----------

/**
 * 建 <home>/segments 与 config.json（已有配置不覆盖——用户的隐私规则是敏感数据）。
 * @returns {{home: string, configPath: string, createdConfig: boolean}}
 */
export function ensureHomeDirs(home = chronicleHome()) {
  mkdirSync(path.join(home, 'segments'), { recursive: true });
  const configPath = path.join(home, 'config.json');
  let createdConfig = false;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
    createdConfig = true;
  }
  return { home, configPath, createdConfig };
}

// ---------- ③ Chronicle Helper.app ----------

/** Info.plist（XML；LSUIElement 后台 App；Apple Events 用于读浏览器标签 URL）。 */
export function buildInfoPlist({ version = APP_VERSION } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${esc(APP_NAME)}</string>
	<key>CFBundleExecutable</key>
	<string>chronicle-daemon</string>
	<key>CFBundleIdentifier</key>
	<string>${esc(APP_BUNDLE_ID)}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${esc(APP_NAME)}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${esc(version)}</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>10.13</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppleEventsUsageDescription</key>
	<string>Chronicle reads the current browser tab URL to record your activity timeline.</string>
</dict>
</plist>
`;
}

/**
 * 创建/刷新 Chronicle Helper.app（幂等：二进制指纹未变不重拷，避免 TCC 无谓失效）。
 * @param {{srcBinary?: string, home?: string, version?: string, codesign?: boolean, log?: Function}} opts
 * @returns {{installed: boolean, appPath: string, binaryPath: string, reason?: string, copiedBinary: boolean, signed: boolean|string}}
 */
export function ensureHelperApp({ srcBinary = HOST_BIN, home = chronicleHome(), version, codesign, log: lg = () => {} } = {}) {
  const appPath = path.join(home, `${APP_NAME}.app`);
  const binaryPath = path.join(appPath, 'Contents', 'MacOS', 'chronicle-daemon');
  if (process.platform !== 'darwin') {
    return { installed: false, appPath, binaryPath, reason: 'Chronicle Helper.app 仅支持 macOS', copiedBinary: false, signed: 'skipped' };
  }
  if (!existsSync(srcBinary)) {
    return { installed: false, appPath, binaryPath, reason: `守护二进制不存在: ${srcBinary}（先编译）`, copiedBinary: false, signed: 'skipped' };
  }

  mkdirSync(path.dirname(binaryPath), { recursive: true });
  mkdirSync(path.join(appPath, 'Contents', 'Resources'), { recursive: true });
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const plist = buildInfoPlist(version ? { version } : {});
  const srcStat = statSync(srcBinary);
  // 构建戳放 Resources/ 内（Contents/ 根下的未知文件会让 codesign 拒签）
  const stampPath = path.join(appPath, 'Contents', 'Resources', 'chronicle-stamp.json');
  const wantStamp = JSON.stringify({ binSize: srcStat.size, binMtimeUs: Math.round(srcStat.mtimeMs * 1000), plist });
  let copiedBinary = false;
  const upToDate = (() => {
    try { return readFileSync(stampPath, 'utf8') === wantStamp && existsSync(binaryPath); } catch { return false; }
  })();
  if (!upToDate) {
    copyFileSync(srcBinary, binaryPath);
    chmodSync(binaryPath, 0o755);
    writeFileSync(plistPath, plist);
    writeFileSync(stampPath, wantStamp);
    copiedBinary = true;
  }

  // adhoc 签名（尽力而为）：失败不致命
  let signed = 'skipped';
  const wantSign = codesign === undefined ? true : codesign;
  if (wantSign) {
    try {
      const probe = copiedBinary ? { status: 1 } : spawnSync('codesign', ['-v', appPath], { encoding: 'utf8', timeout: 15_000 });
      if (probe.status !== 0) {
        const r = spawnSync('codesign', ['--force', '--sign', '-', appPath], { encoding: 'utf8', timeout: 30_000 });
        signed = r.status === 0;
        if (r.status !== 0) lg(`codesign adhoc 签名跳过（不影响使用）: ${(r.stderr || '').slice(0, 160)}`);
      } else signed = true;
    } catch { signed = 'skipped'; }
  }
  return { installed: true, appPath, binaryPath, copiedBinary, signed };
}

// ---------- ④ 权限引导 ----------

/**
 * 非交互权限引导：探测 → 未授权则开设置面板 + 浮引导卡片 + 打文字指引。
 * 卡片是守护进程的窗口，本脚本退出后仍留守（授权生效自动收卡）。
 * @returns {{axGranted: boolean, cardsShown: boolean, guide: string}}
 */
export async function guidePermissions(daemon, { log: lg = () => {} } = {}) {
  const probe = await daemon.request('probe');
  if (probe.axGranted === true) {
    return { axGranted: true, cardsShown: false, guide: '辅助功能已授权' };
  }
  // 主路径（.app 已装）：不弹系统申请对话框，直接开面板 + 浮卡片拖拽授权
  let cardsShown = false;
  try {
    await daemon.request('show-permission-card', { kind: 'accessibility', durationSec: 300 });
    cardsShown = true;
  } catch { /* 卡片失败降级纯文字 */ }
  try {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { stdio: 'ignore', detached: true }).unref();
  } catch { /* 打不开面板不算事 */ }
  const guide = '系统设置 → 隐私与安全性 → 辅助功能：把「Chronicle Helper」加进列表并打开开关';
  lg('');
  lg(`⚠ 采集需要辅助功能权限：${guide}`);
  if (cardsShown) lg('  屏幕上已浮出琥珀引导卡片——把卡片左侧的「Chronicle Helper」图标拖进列表即可；授权后卡片自动消失。');
  return { axGranted: false, cardsShown, guide };
}

// ---------- main ----------

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = args.home ?? chronicleHome();

  log('① 编译采集守护（swift/chronicle-daemon.swift）…');
  if (args.skipCompile) {
    log('   跳过编译（--skip-compile）');
  } else {
    const r = compileDaemon({ log: (m) => log(`   ${m}`) });
    if (!r.compiled) {
      log(`   ✗ ${r.reason}`);
      log('     装好 Xcode 或跑 xcode-select --install 后重跑 npm run setup。');
      return 1;
    }
    log(`   ✓ ${r.path}`);
  }

  log(`② 数据目录 ${home} …`);
  const dirs = ensureHomeDirs(home);
  log(`   ✓ segments/ 就位；config.json ${dirs.createdConfig ? '已写入默认值（含密码管理器/银行站点屏蔽规则）' : '已存在（保留你的配置）'}`);

  log('③ 安装 Chronicle Helper.app（权限主体）…');
  const app = ensureHelperApp({ home, log: (m) => log(`   ${m}`) });
  if (app.installed) {
    log(`   ✓ ${app.appPath}${app.copiedBinary ? '' : '（未变化，保持 TCC 授权有效）'}`);
  } else {
    log(`   ✗ ${app.reason}`);
  }

  log('④ 检查辅助功能权限…');
  const daemon = createDaemon({ home });
  let guide;
  try {
    guide = await guidePermissions(daemon, { log });
  } catch (err) {
    log(`   ✗ 守护探测失败: ${err.message}`);
    guide = { axGranted: false, cardsShown: false, guide: '重跑 npm run setup 再试' };
  } finally {
    // 卡片留在屏上时不能杀守护（卡片与守护共存亡）；没浮卡则正常收尾
    if (!guide.cardsShown) daemon.stop();
  }

  log('');
  log('⑤ 使用说明：');
  log('   启动采集 + 本地服务   npm run daemon        （HTTP 127.0.0.1:3777）');
  log('   查看状态              node daemon.mjs --status');
  log('   停止                  node daemon.mjs --stop');
  log('   时间线 UI             打开 http://127.0.0.1:3777/ （骨架，后续批次上线）');
  log(`   数据与隐私规则        ${home}/config.json（blocklist 永远优先于 allowlist）`);
  log('   卸载                  npm run uninstall（可保留数据）');
  log('');
  log('产品红线：Chronicle 不截屏、不录音；只记录结构化事件（应用/窗口/URL/焦点元素）。');
  log('密码框内容与无痕浏览无条件排除。随时可暂停/清空（数据都是纯文件，删了就没了）。');
  return guide.axGranted ? 0 : 0; // 权限未授予不算安装失败（可稍后补授权）
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[setup] 失败: ${e.message}`); process.exit(1); });
}
