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
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, createDaemon, chronicleHome } from './daemon.mjs';
import { defaultConfig } from './shared/privacy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SWIFT_SRC = path.join(REPO_ROOT, 'swift', 'chronicle-daemon.swift');
const HOST_BIN = path.join(REPO_ROOT, 'host', 'chronicle-daemon');

export const APP_NAME = 'Chronicle Helper';
export const APP_BUNDLE_ID = 'com.chronicle.daemon-helper';
export const APP_VERSION = '0.3.0';
/** launchd 开机自启的 label（与 uninstall.mjs 共用）。 */
export const LAUNCHD_LABEL = 'com.chronicle.daemon';
/** 菜单栏 App（M1）：<home>/Chronicle.app，bundle id com.chronicle.menubar。 */
export const MENUBAR_APP_NAME = 'Chronicle';
export const MENUBAR_BUNDLE_ID = 'com.chronicle.menubar';
export const MENUBAR_EXECUTABLE = 'ChronicleMenuBar';
export const MENUBAR_LABEL = 'com.chronicle.menubar';
export const APP_CONFIG_FILENAME = 'app-config.json';
export const MENUBAR_SWIFT_SRC = path.join(REPO_ROOT, 'swift', 'ChronicleMenuBar.swift');
const isMac = process.platform === 'darwin';

const log = (s) => console.log(s);

// ---------- 参数 ----------

export function parseArgs(argv) {
  const out = { home: null, skipCompile: false, skipService: false, serviceInstall: false, skipMenubar: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--home') out.home = path.resolve(next());
    else if (a === '--skip-compile') out.skipCompile = true;
    else if (a === '--skip-service') out.skipService = true;
    else if (a === '--service-install') out.serviceInstall = true;
    else if (a === '--skip-menubar') out.skipMenubar = true;
    else if (a === '--help' || a === '-h') {
      log('用法: node setup.mjs [--home DIR] [--skip-compile] [--skip-service] [--skip-menubar] [--service-install]');
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
  const r = spawnSync(swiftc, ['-O', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', SWIFT_SRC, '-o', out], { encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) {
    return { compiled: false, swiftc: true, path: out, reason: `swiftc 退出码 ${r.status}: ${(r.stderr || '').slice(0, 400)}` };
  }
  chmodSync(out, 0o755);
  lg(`已编译 ${out}`);
  return { compiled: true, swiftc: true, path: out };
}

// ---------- ①b 责任进程解绑 shim（TCC：让 Helper 用自身授权） ----------

const SPAWN_SRC = path.join(REPO_ROOT, 'native', 'spawn-disclaim.c');

/** 编译 chronicle-spawn（私有 API responsibility_spawnattrs_setdisclaim 的极薄封装）。 */
export function compileSpawnShim({ out = path.join(chronicleHome(), 'chronicle-spawn'), log: lg = () => {} } = {}) {
  if (!isMac) return { compiled: false, skipped: true, path: out, reason: '仅 macOS 需要' };
  if (!existsSync(SPAWN_SRC)) return { compiled: false, path: out, reason: `源码缺失: ${SPAWN_SRC}` };
  mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync('clang', ['-O2', SPAWN_SRC, '-o', out], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) {
    lg(`shim 编译失败（` + (r.stderr || '').slice(0, 200) + '），TCC 仍按旧方式（可能需授权父进程）');
    return { compiled: false, path: out, reason: r.stderr };
  }
  chmodSync(out, 0o755);
  lg(`已编译 TCC 责任进程解绑 shim ${out}`);
  return { compiled: true, path: out };
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

const APP_ICON_ICNS = path.join(REPO_ROOT, 'assets', 'AppIcon.icns');

/** 把 App 图标拷进 bundle 的 Resources/（缺失时静默跳过）。 */
function installAppIcon(appPath) {
  try {
    if (!existsSync(APP_ICON_ICNS)) return false;
    const dir = path.join(appPath, 'Contents', 'Resources');
    mkdirSync(dir, { recursive: true });
    copyFileSync(APP_ICON_ICNS, path.join(dir, 'AppIcon.icns'));
    return true;
  } catch { return false; }
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
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
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
	<key>NSScreenCaptureUsageDescription</key>
	<string>Chronicle only reads the current window when you explicitly ask for on-screen text OCR. Images are never saved.</string>
</dict>
</plist>
`;
}

// ---------- 稳定代码签名（U2：复用本机已有 codesigning 身份，TCC 授权跨重编译保持） ----------
//
// 红线（用户明确要求，绝不可违反）：
//   · 绝不执行任何需要用户密码/系统授权弹窗的命令（例如 security add-trusted-cert）；
//   · 绝不修改 login keychain、系统证书信任设置、keychain 搜索列表；
//   · 绝不生成/导入自签名证书来“造”身份。
//
// 方案：只读发现本机已有有效 codesigning 身份（优先 Apple Development；无则第一个有效身份），
// 直接 codesign --force --sign "<身份>" --timestamp=none <app>（实测无弹窗；TCC 代码要求锚定证书，
// 重编译不失效）。无身份/签名失败 → 回退 ad-hoc 并记录原因，不阻塞安装。

export const SIGNING_IDENTITY_TIMEOUT_MS = 30_000;

/** 统一执行外部命令（spawnSync 可注入；永不抛；默认 30s 超时）。 */
function runTool(run, cmd, args, opts = {}) {
  try {
    const r = run(cmd, args, { encoding: 'utf8', timeout: SIGNING_IDENTITY_TIMEOUT_MS, ...opts });
    return { ok: Boolean(r && r.status === 0), status: r?.status ?? null, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? ''), error: r?.error ?? null };
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error };
  }
}

/**
 * 解析 `security find-identity -v -p codesigning` 输出（只读；不修改任何状态）。
 * 形如：`  1) 40HEX "Apple Development: x (TEAM)"`。
 */
export function parseSigningIdentities(stdout = '') {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.+)"\s*$/.exec(line);
    if (!m) continue;
    if (/\(CSSMERR_[A-Z_]+\)/i.test(line)) continue; // 无效/不可信条目
    out.push({ hash: m[1], identity: m[2] });
  }
  return out;
}

/** 选择身份：优先含 "Apple Development"，否则第一个有效身份。 */
export function selectSigningIdentity(identities = []) {
  if (!Array.isArray(identities) || identities.length === 0) return null;
  const preferred = identities.find((item) => /Apple Development/i.test(item.identity));
  return preferred ?? identities[0];
}

/**
 * 发现本机已有稳定签名身份（只读 security find-identity；无副作用、无弹窗）。
 * @returns {{ok:boolean, identity?:string, hash?:string, source?:string, candidates?:string[], reason?:string}}
 */
export function ensureLocalSigningIdentity({ run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { ok: false, reason: '稳定代码签名仅支持 macOS' };
  const r = runTool(run, 'security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!r.ok) return { ok: false, reason: `读取 codesigning 身份失败: ${(r.stderr || r.error?.message || '').slice(0, 160)}` };
  const identities = parseSigningIdentities(r.stdout);
  const chosen = selectSigningIdentity(identities);
  if (!chosen) {
    return { ok: false, reason: '本机无有效 codesigning 身份（可在 Xcode 登录 Apple ID 生成 Apple Development 证书后重试）', candidates: [] };
  }
  return {
    ok: true,
    identity: chosen.identity,
    hash: chosen.hash,
    source: /Apple Development/i.test(chosen.identity) ? 'apple-development' : 'local-keychain',
    candidates: identities.map((item) => item.identity),
  };
}

/** ad-hoc 回退（不需要身份/权限，不弹窗）。 */
function adhocSign(appPath, run) {
  return runTool(run, 'codesign', ['--force', '--sign', '-', '--timestamp=none', appPath]);
}

/**
 * 用本机已有稳定身份签名 .app；无身份/失败 → ad-hoc 回退（记录原因，不阻塞安装）。
 * @returns {{signed:boolean, adhoc:boolean, identity?:string|null, reason?:string, candidates?:string[]}}
 */
export function codesignWithIdentity(appPath, {
  run = spawnSync,
  log = () => {},
  platform = process.platform,
  identity = null,
} = {}) {
  if (platform !== 'darwin') return { signed: false, adhoc: false, reason: '仅 macOS 支持代码签名' };
  const found = identity ?? ensureLocalSigningIdentity({ run, platform });
  let reason = found.ok ? null : `稳定签名不可用：${found.reason}`;
  if (found.ok) {
    const r = runTool(run, 'codesign', ['--force', '--sign', found.identity, '--timestamp=none', appPath]);
    if (r.ok) {
      log(`已使用稳定代码签名身份（TCC 授权跨重编译保持）：${found.identity}`);
      return { signed: true, adhoc: false, identity: found.identity };
    }
    reason = `稳定身份签名失败：${(r.stderr || r.error?.message || '').slice(0, 200)}`;
  }
  const adhoc = adhocSign(appPath, run);
  return {
    signed: adhoc.ok,
    adhoc: true,
    identity: null,
    reason: adhoc.ok
      ? `${reason}；已回退 ad-hoc 签名（TCC 可能随重编译失效）`
      : `${reason}；ad-hoc 签名也失败`,
    candidates: found.candidates ?? [],
  };
}

/**
 * 创建/刷新 Chronicle Helper.app（幂等：二进制指纹未变不重拷，避免 TCC 无谓失效）。
 * @param {{srcBinary?: string, home?: string, version?: string, codesign?: boolean, log?: Function}} opts
 * @returns {{installed: boolean, appPath: string, binaryPath: string, reason?: string, copiedBinary: boolean, signed: boolean|string}}
 */
export function ensureHelperApp({ srcBinary = HOST_BIN, home = chronicleHome(), version, codesign, run = spawnSync, sign = null, log: lg = () => {} } = {}) {
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
  // 用二进制内容哈希做构建戳：仅当字节变化才重装/重签（mtime 变化不触发，避免 TCC 授权失效）
  const binSha256 = createHash('sha256').update(readFileSync(srcBinary)).digest('hex');
  // 构建戳放 Resources/ 内（Contents/ 根下的未知文件会让 codesign 拒签）
  const stampPath = path.join(appPath, 'Contents', 'Resources', 'chronicle-stamp.json');
  const iconStat = (() => { try { const st = statSync(APP_ICON_ICNS); return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }; } catch { return null; } })();
  const wantStamp = JSON.stringify({ binSha256, binSize: srcStat.size, plist, icon: iconStat });
  let copiedBinary = false;
  const upToDate = (() => {
    try { return readFileSync(stampPath, 'utf8') === wantStamp && existsSync(binaryPath) && existsSync(path.join(appPath, 'Contents', 'Resources', 'AppIcon.icns')); } catch { return false; }
  })();
  if (!upToDate) {
    copyFileSync(srcBinary, binaryPath);
    chmodSync(binaryPath, 0o755);
    writeFileSync(plistPath, plist);
    installAppIcon(appPath);
    writeFileSync(stampPath, wantStamp);
    copiedBinary = true;
  }

  // 稳定本地签名（失败回退 ad-hoc，不阻塞安装）
  let signed = 'skipped';
  let signing = null;
  const wantSign = codesign === undefined ? true : codesign;
  if (wantSign) {
    try {
      const probe = copiedBinary ? { ok: false } : runTool(run, 'codesign', ['-v', appPath], { timeout: 15_000 });
      if (!probe.ok) {
        signing = (sign ?? codesignWithIdentity)(appPath, { home, run, log: lg });
        signed = Boolean(signing.signed);
        if (!signed) lg(`签名失败（不影响本地使用）: ${String(signing.reason ?? '').slice(0, 200)}`);
      } else {
        signed = true;
        signing = { signed: true, adhoc: false, reused: true, reason: '已是有效签名，跳过重签' };
      }
    } catch (error) { signed = 'skipped'; lg(`签名异常（不影响本地使用）: ${String(error?.message ?? error).slice(0, 200)}`); }
  }
  return { installed: true, appPath, binaryPath, copiedBinary, signed, signing };
}

// ---------- ④ launchd 开机自启 ----------

/** ~/Library/LaunchAgents/<label>.plist；默认是 daemon 的自启项。 */
export function launchAgentPath(label = LAUNCHD_LABEL) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

/** 菜单栏 App 的 launchd 自启项路径。 */
export function menubarLaunchAgentPath() {
  return launchAgentPath(MENUBAR_LABEL);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 生成 launchd LaunchAgent plist（纯函数，测试不实际 bootstrap）。
 * RunAtLoad=true（登录即起）、KeepAlive=true（死了拉起）、ThrottleInterval=10、
 * 日志走 <home>/logs/，ProgramArguments=[node, <repo>/daemon.mjs, "--service"]。
 */
export function buildLaunchAgentPlist({
  home = chronicleHome(),
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  label = LAUNCHD_LABEL,
  logDir = path.join(home, 'logs'),
} = {}) {
  const stdoutPath = path.join(logDir, 'service-out.log');
  const stderrPath = path.join(logDir, 'service-err.log');
  const script = path.join(repoRoot, 'daemon.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(nodePath)}</string>
		<string>${xmlEscape(script)}</string>
		<string>--service</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>WorkingDirectory</key>
	<string>${xmlEscape(repoRoot)}</string>
	<key>StandardOutPath</key>
	<string>${xmlEscape(stdoutPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(stderrPath)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CHRONICLE_HOME</key>
		<string>${xmlEscape(home)}</string>
	</dict>
</dict>
</plist>
`;
}

/** 写 plist 到磁盘（生成 + 落盘；不 bootstrap）。 */
export function writeLaunchAgent({
  home = chronicleHome(),
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  label = LAUNCHD_LABEL,
  plistPath = launchAgentPath(),
} = {}) {
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  const content = buildLaunchAgentPlist({ home, repoRoot, nodePath, label });
  writeFileSync(plistPath, content);
  return { plistPath, content };
}

/**
 * 安装开机自启：写 plist → plutil -lint 校验 → launchctl bootstrap gui/$UID
 * （失败回退 launchctl load -w）。非 macOS 跳过并提示。
 * `run` 可注入（测试用假命令，不实际 bootstrap）。
 * @returns {{installed:boolean, skipped?:boolean, lintOk?:boolean, plistPath:string, method?:string, domain?:string, reason?:string, content?:string}}
 */
export function installLaunchAgent({
  home = chronicleHome(),
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  label = LAUNCHD_LABEL,
  plistPath = launchAgentPath(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  run = spawnSync,
  log: lg = () => {},
} = {}) {
  if (platform !== 'darwin') {
    return { installed: false, skipped: true, plistPath, reason: '仅 macOS 支持 launchd 开机自启（已跳过）' };
  }
  const { content } = writeLaunchAgent({ home, repoRoot, nodePath, label, plistPath });
  const lint = run('plutil', ['-lint', plistPath], { encoding: 'utf8', timeout: 15_000 });
  const lintOk = Boolean(lint && lint.status === 0);
  if (!lintOk) {
    return { installed: false, skipped: false, lintOk, plistPath, content, reason: `plutil -lint 失败: ${String(lint?.stderr ?? lint?.error ?? '').slice(0, 200)}` };
  }
  const domain = `gui/${uid}`;
  let method = 'bootstrap';
  let result = run('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8', timeout: 15_000 });
  if (!result || result.status !== 0) {
    method = 'load';
    result = run('launchctl', ['load', '-w', plistPath], { encoding: 'utf8', timeout: 15_000 });
  }
  const installed = Boolean(result && result.status === 0);
  if (installed) lg(`已注册开机自启: ${label}（${method}）`);
  return {
    installed, skipped: false, lintOk, plistPath, content, method, domain,
    reason: installed ? undefined : String(result?.stderr ?? result?.error ?? 'launchctl 注册失败').slice(0, 300),
  };
}

/**
 * 卸载开机自启：先 launchctl bootout（失败回退 unload -w），再删 plist。
 * 注意：launchd KeepAlive 会在进程被杀后立即拉起，所以必须先 bootout 再停进程/删数据。
 */
export function uninstallLaunchAgent({
  label = LAUNCHD_LABEL,
  plistPath = launchAgentPath(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  run = spawnSync,
  log: lg = () => {},
} = {}) {
  if (platform !== 'darwin') {
    return { skipped: true, bootedOut: false, plistRemoved: false, plistPath, reason: '仅 macOS 支持 launchd 开机自启（已跳过）' };
  }
  const domain = `gui/${uid}`;
  let bootedOut = false;
  let method = 'bootout';
  const boot = run('launchctl', ['bootout', `${domain}/${label}`], { encoding: 'utf8', timeout: 15_000 });
  if (boot && boot.status === 0) bootedOut = true;
  else {
    const unload = run('launchctl', ['unload', '-w', plistPath], { encoding: 'utf8', timeout: 15_000 });
    method = 'unload';
    bootedOut = Boolean(unload && unload.status === 0);
  }
  let plistRemoved = false;
  if (existsSync(plistPath)) {
    try { rmSync(plistPath, { force: true }); plistRemoved = true; lg(`已移除 ${plistPath}`); } catch { /* 忽略 */ }
  }
  return { skipped: false, bootedOut, method, plistRemoved, plistPath };
}

// ---------- ⑤ 菜单栏 App（Chronicle.app） ----------

/** 读取 package.json 的版本号（读不到回退 APP_VERSION）。 */
export function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.length ? pkg.version : APP_VERSION;
  } catch { return APP_VERSION; }
}

/** <home>/Chronicle.app 路径。 */
export function menubarAppPath(home = chronicleHome()) {
  return path.join(home, `${MENUBAR_APP_NAME}.app`);
}

/** 菜单栏 App 可执行文件路径。 */
export function menubarBinaryPath(home = chronicleHome()) {
  return path.join(menubarAppPath(home), 'Contents', 'MacOS', MENUBAR_EXECUTABLE);
}

/** <home>/app-config.json（菜单栏 App 读取：repoRoot/nodePath/home/port）。 */
export function appConfigPath(home = chronicleHome()) {
  return path.join(home, APP_CONFIG_FILENAME);
}

/** 写 app-config.json（幂等覆盖：内容是本机路径/端口，不含隐私数据）。 */
export function writeAppConfig({ home = chronicleHome(), repoRoot = REPO_ROOT, nodePath = process.execPath, port = DEFAULT_PORT } = {}) {
  mkdirSync(home, { recursive: true });
  const file = appConfigPath(home);
  writeFileSync(file, `${JSON.stringify({ repoRoot, nodePath, home, port }, null, 2)}\n`);
  return file;
}

/** 菜单栏 App 的 Info.plist（LSUIElement=true → 无 Dock 图标）。 */
export function buildMenubarInfoPlist({ version = APP_VERSION } = {}) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${esc(MENUBAR_APP_NAME)}</string>
	<key>CFBundleExecutable</key>
	<string>${esc(MENUBAR_EXECUTABLE)}</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>${esc(MENUBAR_BUNDLE_ID)}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${esc(MENUBAR_APP_NAME)}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${esc(version)}</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
}

/**
 * 编译菜单栏 App（swiftc -O -framework AppKit -framework Foundation）。
 * @returns {{compiled:boolean, path:string, skipped?:boolean, reason?:string}}
 */
export function compileMenubar({ out = menubarBinaryPath(), platform = process.platform, run = spawnSync, log: lg = () => {} } = {}) {
  if (platform !== 'darwin') return { compiled: false, skipped: true, path: out, reason: '仅 macOS 支持菜单栏 App' };
  const swiftc = swiftcPath();
  if (!swiftc) return { compiled: false, path: out, reason: '本机没有 swiftc（装 Xcode 或跑 xcode-select --install）' };
  if (!existsSync(MENUBAR_SWIFT_SRC)) return { compiled: false, path: out, reason: `源码缺失: ${MENUBAR_SWIFT_SRC}` };
  mkdirSync(path.dirname(out), { recursive: true });
  const r = run(swiftc, ['-O', '-framework', 'AppKit', '-framework', 'Foundation', MENUBAR_SWIFT_SRC, '-o', out], { encoding: 'utf8', timeout: 180_000 });
  if (!r || r.status !== 0) {
    return { compiled: false, path: out, reason: `swiftc 退出码 ${r?.status}: ${String(r?.stderr ?? r?.error ?? '').slice(0, 500)}` };
  }
  chmodSync(out, 0o755);
  lg(`已编译 ${out}`);
  return { compiled: true, path: out };
}

/**
 * 安装 <home>/Chronicle.app：编译（或拷贝注入二进制）→ Info.plist → ad-hoc codesign，
 * 并写 <home>/app-config.json。幂等可重复执行；非 macOS 跳过。
 * @returns {{installed:boolean, skipped?:boolean, appPath?:string, binaryPath?:string, configPath?:string, signed?:boolean|string, version?:string, reason?:string}}
 */
export function installMenubarApp({
  home = chronicleHome(),
  repoRoot = REPO_ROOT,
  nodePath = process.execPath,
  port = DEFAULT_PORT,
  version = packageVersion(),
  srcBinary = null,
  compile = true,
  platform = process.platform,
  codesign = true,
  run = spawnSync,
  sign = null,
  log: lg = () => {},
} = {}) {
  if (platform !== 'darwin') return { installed: false, skipped: true, reason: '仅 macOS 支持菜单栏 App' };
  const appPath = menubarAppPath(home);
  const binaryPath = menubarBinaryPath(home);
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  mkdirSync(path.join(appPath, 'Contents', 'Resources'), { recursive: true });

  if (srcBinary) {
    if (!existsSync(srcBinary)) return { installed: false, appPath, binaryPath, reason: `菜单栏二进制不存在: ${srcBinary}` };
    copyFileSync(srcBinary, binaryPath);
    chmodSync(binaryPath, 0o755);
  } else if (compile) {
    const r = compileMenubar({ out: binaryPath, platform, run, log: lg });
    if (!r.compiled) return { installed: false, appPath, binaryPath, reason: r.reason };
  } else if (!existsSync(binaryPath)) {
    return { installed: false, appPath, binaryPath, reason: '未编译且目标二进制不存在（compile=false）' };
  }

  writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), buildMenubarInfoPlist({ version }));
  installAppIcon(appPath);
  const configPath = writeAppConfig({ home, repoRoot, nodePath, port });

  let signed = 'skipped';
  let signing = null;
  if (codesign) {
    try {
      signing = (sign ?? codesignWithIdentity)(appPath, { home, run, log: lg });
      signed = Boolean(signing.signed);
      if (!signed) lg(`签名失败（不影响本地使用）: ${String(signing.reason ?? '').slice(0, 200)}`);
    } catch (error) { signed = 'skipped'; lg(`签名异常（不影响本地使用）: ${String(error?.message ?? error).slice(0, 200)}`); }
  }
  return { installed: true, appPath, binaryPath, configPath, signed, signing, version };
}

/** 菜单栏 App 的 LaunchAgent plist：KeepAlive={SuccessfulExit:false}（只有崩溃才拉起，菜单“退出”能真退）。 */
export function buildMenubarLaunchAgentPlist({
  home = chronicleHome(),
  binaryPath = menubarBinaryPath(home),
  port = DEFAULT_PORT,
  label = MENUBAR_LABEL,
  logDir = path.join(home, 'logs'),
  repoRoot = null,
} = {}) {
  const stdoutPath = path.join(logDir, 'menubar-out.log');
  const stderrPath = path.join(logDir, 'menubar-err.log');
  const envBlock = `		<key>CHRONICLE_HOME</key>
		<string>${xmlEscape(home)}</string>${repoRoot ? `
		<key>CHRONICLE_REPO_ROOT</key>
		<string>${xmlEscape(repoRoot)}</string>` : ''}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(binaryPath)}</string>
		<string>--port</string>
		<string>${xmlEscape(port)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>StandardOutPath</key>
	<string>${xmlEscape(stdoutPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(stderrPath)}</string>
	<key>EnvironmentVariables</key>
	<dict>
${envBlock}
	</dict>
</dict>
</plist>
`;
}

/** 写菜单栏 App 的 LaunchAgent plist（不 bootstrap）。 */
export function writeMenubarLaunchAgent({
  home = chronicleHome(),
  binaryPath = menubarBinaryPath(home),
  port = DEFAULT_PORT,
  label = MENUBAR_LABEL,
  plistPath = menubarLaunchAgentPath(),
  repoRoot = null,
} = {}) {
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  const content = buildMenubarLaunchAgentPlist({ home, binaryPath, port, label, repoRoot });
  writeFileSync(plistPath, content);
  return { plistPath, content };
}

/**
 * 注册菜单栏 App 开机自启：写 plist → plutil -lint → launchctl bootstrap（失败回退 load -w）。
 * run 可注入（测试不真实 bootstrap）。
 */
export function installMenubarLaunchAgent({
  home = chronicleHome(),
  binaryPath = menubarBinaryPath(home),
  port = DEFAULT_PORT,
  label = MENUBAR_LABEL,
  repoRoot = null,
  plistPath = menubarLaunchAgentPath(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  run = spawnSync,
  log: lg = () => {},
} = {}) {
  if (platform !== 'darwin') return { installed: false, skipped: true, plistPath, reason: '仅 macOS 支持 launchd 开机自启（已跳过）' };
  const { content } = writeMenubarLaunchAgent({ home, binaryPath, port, label, plistPath, repoRoot });
  const lint = run('plutil', ['-lint', plistPath], { encoding: 'utf8', timeout: 15_000 });
  const lintOk = Boolean(lint && lint.status === 0);
  if (!lintOk) return { installed: false, skipped: false, lintOk, plistPath, content, reason: `plutil -lint 失败: ${String(lint?.stderr ?? '').slice(0, 200)}` };
  const domain = `gui/${uid}`;
  let method = 'bootstrap';
  let result = run('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8', timeout: 15_000 });
  if (!result || result.status !== 0) {
    method = 'load';
    result = run('launchctl', ['load', '-w', plistPath], { encoding: 'utf8', timeout: 15_000 });
  }
  const installed = Boolean(result && result.status === 0);
  if (installed) lg(`已注册菜单栏 App 自启: ${label}（${method}）`);
  return { installed, skipped: false, lintOk, plistPath, content, method, domain, reason: installed ? undefined : String(result?.stderr ?? 'launchctl 注册失败').slice(0, 300) };
}

/** 菜单栏 App 是否已在运行（用于避免 launchd 已启动后又 open 一份，出现两个图标）。 */
export function menubarAppRunning({ binaryPath = menubarBinaryPath(), run = spawnSync } = {}) {
  try {
    const r = run('pgrep', ['-f', binaryPath], { encoding: 'utf8' });
    return !!(r && r.status === 0 && String(r.stdout || '').trim().length);
  } catch {
    return false;
  }
}

/** 启动一次菜单栏 App（open <app>；失败不致命）。 */
export function startMenubarApp({ appPath = menubarAppPath(), run = spawn, log: lg = () => {} } = {}) {
  if (!existsSync(appPath)) return { started: false, reason: `App 不存在: ${appPath}` };
  try {
    const r = run('open', [appPath], { detached: true, stdio: 'ignore' });
    if (typeof r?.unref === 'function') r.unref();
    return { started: true, appPath };
  } catch (err) {
    lg(`启动菜单栏 App 失败（稍后可从 Finder 打开）: ${err.message}`);
    return { started: false, reason: err.message };
  }
}

// ---------- ⑥ 权限引导 ----------

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
  // 主路径：先弹 macOS 标准授权框（用户点「打开系统设置」后列表里就有 Chronicle Helper，直接开开关）
  let requested = false;
  try {
    const r = await daemon.request('request-permissions');
    requested = true;
    if (r && r.axGranted === true) return { axGranted: true, cardsShown: false, guide: '辅助功能已授权' };
  } catch { /* 降级为卡片/文字 */ }

  // 兜底：浮琥珀引导卡片（可直接拖 app 进列表）+ 打开设置面板
  let cardsShown = false;
  try {
    await daemon.request('show-permission-card', { kind: 'accessibility', durationSec: 300 });
    cardsShown = true;
  } catch { /* 卡片失败降级纯文字 */ }
  try {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], { stdio: 'ignore', detached: true }).unref();
  } catch { /* 打不开面板不算事 */ }
  const guide = requested
    ? '已弹出系统授权框：点「打开系统设置」→ 在「辅助功能」列表里打开 Chronicle Helper 的开关（列表里是英文名）'
    : '系统设置 → 隐私与安全性 → 辅助功能：把「Chronicle Helper」加进列表并打开开关';
  lg('');
  lg(`⚠ 采集需要辅助功能权限：${guide}`);
  if (cardsShown) lg('  屏幕上同时浮出琥珀引导卡片——也可以把卡片左侧图标直接拖进列表；授权后卡片自动消失。');
  return { axGranted: false, cardsShown, guide };
}

// ---------- main ----------

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = args.home ?? chronicleHome();

  // 仅注册/刷新 launchd 开机自启（package.json 的 service:install）
  if (args.serviceInstall) {
    log('① 数据目录 …');
    ensureHomeDirs(home);
    log(`   ✓ ${home}`);
    log('② 注册 launchd 开机自启 …');
    const svc = installLaunchAgent({ home, log: (m) => log(`   ${m}`) });
    if (svc.skipped) log(`   - ${svc.reason}`);
    else if (svc.installed) log(`   ✓ ${svc.plistPath}（${svc.method}）`);
    else log(`   ✗ ${svc.reason}`);
    if (!args.skipMenubar) {
      log('③ 注册菜单栏 App …');
      const appInstall = installMenubarApp({ home, repoRoot: REPO_ROOT, nodePath: process.execPath, version: packageVersion(), log: (m) => log(`   ${m}`) });
      if (appInstall.installed) {
        const mla = installMenubarLaunchAgent({ home, binaryPath: appInstall.binaryPath, repoRoot: REPO_ROOT, log: (m) => log(`   ${m}`) });
        if (mla.skipped) log(`   - ${mla.reason}`);
        else if (mla.installed) log(`   ✓ ${mla.plistPath}（${mla.method}）`);
        else log(`   ✗ ${mla.reason}`);
      } else log(`   - ${appInstall.reason}`);
    }
    return svc.installed || svc.skipped ? 0 : 1;
  }

  log('① 编译采集守护（swift/chronicle-daemon.swift）…');
  if (args.skipCompile) {
    log('   跳过编译（--skip-compile）');
  } else {
    const r = compileDaemon({ log: (m) => log(`   ${m}`) });
    compileSpawnShim({ log: (m) => log(`   ${m}`) });
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
  const app = ensureHelperApp({ home, version: packageVersion(), log: (m) => log(`   ${m}`) });
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

  log('⑤ 注册 launchd 开机自启（登录自动运行、崩溃自动拉起）…');
  if (args.skipService) {
    log('   跳过（--skip-service）');
  } else {
    const svc = installLaunchAgent({ home, log: (m) => log(`   ${m}`) });
    if (svc.skipped) log(`   - ${svc.reason}`);
    else if (svc.installed) log(`   ✓ ${svc.plistPath}（RunAtLoad + KeepAlive，${svc.method}）`);
    else log(`   ✗ ${svc.reason}（不影响本次安装，可稍后 npm run service:install 重试）`);
  }

  log('⑥ 安装菜单栏 App（Chronicle.app，菜单栏常驻控制）…');
  if (args.skipMenubar) {
    log('   跳过（--skip-menubar）');
  } else {
    const appInstall = installMenubarApp({
      home,
      repoRoot: REPO_ROOT,
      nodePath: process.execPath,
      port: DEFAULT_PORT,
      version: packageVersion(),
      log: (m) => log(`   ${m}`),
    });
    if (appInstall.skipped) log(`   - ${appInstall.reason}`);
    else if (!appInstall.installed) log(`   ✗ ${appInstall.reason}（不影响采集功能，可稍后重跑 setup）`);
    else {
      log(`   ✓ ${appInstall.appPath}（v${appInstall.version}，codesign=${appInstall.signed}）`);
      const mla = installMenubarLaunchAgent({
        home,
        binaryPath: appInstall.binaryPath,
        port: DEFAULT_PORT,
        repoRoot: REPO_ROOT,
        log: (m) => log(`   ${m}`),
      });
      if (mla.skipped) log(`   - ${mla.reason}`);
      else if (mla.installed) log(`   ✓ ${mla.plistPath}（RunAtLoad + KeepAlive=仅崩溃重启，${mla.method}）`);
      else log(`   ✗ ${mla.reason}（不影响采集功能）`);
      // launchd bootstrap（RunAtLoad）通常已把菜单栏 App 拉起来；再 open 会多一份实例/多一个图标。
      if (menubarAppRunning({ binaryPath: appInstall.binaryPath })) {
        log('   ✓ 菜单栏 App 已由 launchd 启动（右上角菜单栏图标）');
      } else {
        const started = startMenubarApp({ appPath: appInstall.appPath, log: (m) => log(`   ${m}`) });
        if (started.started) log('   ✓ 菜单栏 App 已启动（菜单栏右上角图标）');
        else log(`   - 未自动启动: ${started.reason}`);
      }
    }
  }

  log('');
  log('⑦ 使用说明：');
  log('   启动采集 + 本地服务   npm run daemon        （HTTP 127.0.0.1:3777）');
  log('   查看状态              node daemon.mjs --status');
  log('   停止                  node daemon.mjs --stop');
  log('   时间线 UI             打开 http://127.0.0.1:3777/ （骨架，后续批次上线）');
  log(`   数据与隐私规则        ${home}/config.json（blocklist 永远优先于 allowlist）`);
  log(`   菜单栏                ${home}/Chronicle.app（状态/暂停/恢复/接入/复制配置/开机自启/退出）`);
  log(`   日志                  ${home}/logs/daemon-YYYYMMDD.log（10MB 轮转，保留 7 份）`);
  log('   开机自启              守护 + 菜单栏均已注册（uninstall --service-only 可移除）');
  log('   卸载                  npm run uninstall（可保留数据）');
  log('');
  log('产品红线：Chronicle 不截屏、不录音；只记录结构化事件（应用/窗口/URL/焦点元素）。');
  log('密码框内容与无痕浏览无条件排除。随时可暂停/清空（数据都是纯文件，删了就没了）。');
  return guide.axGranted ? 0 : 0; // 权限未授予不算安装失败（可稍后补授权）
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[setup] 失败: ${e.message}`); process.exit(1); });
}
