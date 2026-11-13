// test/privacy.test.mjs — 隐私闸门双实现对拍 + Swift 采集可靠性（A 批次）
//
// 覆盖：
//   ① JS 决策矩阵（glob/URL host/脱敏/block 恒胜/allowlist/secureInput/incognito/Safari 排除）
//   ② Swift↔JS 对拍：真实 swiftc 编译 chronicle-daemon，通过无副作用 `decide` 行协议命令
//      对 30+ golden case 逐条比较 {observe, blockedScope, reason, redactedURL}，不等即 fail
//   ③ decide 无副作用：不创建 segments/、不改运行状态
//   ④ Swift 采集可靠性（测试用 env 钩子加速，不改生产默认 2s/10min）：
//      懒建段（空段零目录）/ 抑制审计（reason+scope、metadata.suppressedEventCount）/
//      secure-input 整机抑制 / paused 到期关段 / 孤儿段修复（segmentEnd+closedBy=repair、删空段）
//
// 不依赖第三方包；无 swiftc 时 ②③④ 整个 suite SKIP（①照跑）。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateSample, redactURL, globMatch, urlRuleMatch, privacySettings, contentSettings,
  defaultConfig, validatePrivacyConfig,
} from '../shared/privacy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWIFT_SRC = path.join(REPO_ROOT, 'swift', 'chronicle-daemon.swift');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-privacy-'));

function probeSwiftc() {
  const probe = (cmd, args) => {
    try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 }).status === 0; } catch { return false; }
  };
  if (probe('swiftc', ['--version'])) return 'swiftc';
  try {
    const r = spawnSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* 无 xcrun */ }
  return null;
}

const SWIFTC = probeSwiftc();
const swiftWorkRoot = SWIFTC ? mkdtempSync(path.join(os.tmpdir(), 'chronicle-swift-privacy-')) : null;
let binaryPromise = null;

function ensureBinary() {
  if (binaryPromise) return binaryPromise;
  binaryPromise = (async () => {
    const out = path.join(swiftWorkRoot, 'chronicle-daemon');
    const r = spawnSync(SWIFTC, ['-O', '-framework', 'ScreenCaptureKit', '-framework', 'Vision', SWIFT_SRC, '-o', out], { encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) throw new Error(`swiftc 编译失败: ${(r.stderr || '').slice(0, 1200)}`);
    return out;
  })();
  return binaryPromise;
}

after(() => {
  if (swiftWorkRoot) rmSync(swiftWorkRoot, { recursive: true, force: true });
});

/** 最小行协议客户端（只依赖 node 内建；不与 daemon.mjs 的写域耦合）。 */
function startDaemon(binary, home, env = {}) {
  const proc = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHRONICLE_HOME: home, ...env },
  });
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  const stderr = [];
  proc.stderr.on('data', (c) => { stderr.push(c.toString('utf8')); });
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const rec = pending.get(msg.id);
      if (!rec) continue;
      pending.delete(msg.id);
      rec(msg);
    }
  });
  return {
    stderr: () => stderr.join(''),
    request(cmd, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`daemon 响应超时（cmd=${cmd}）stderr=${stderr.join('').slice(0, 400)}`));
        }, 10_000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        proc.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`, (err) => {
          if (!err) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`写入 daemon 失败: ${err.message}`));
        });
      });
    },
    stop() {
      try { proc.stdin.end(); } catch { /* 已退出 */ }
      try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
    },
  };
}

function writeConfig(home, cfg) {
  writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------- 配置与 golden case ----------

const P_DEFAULT = { safariPrivateDetection: 'heuristic', excludeSafariURLs: false, redactURLQuery: true };

function cfgBase() {
  return {
    enabled: true,
    allowlist: [],
    blocklist: [
      { scope: 'app', value: 'com.1password.*' },
      { scope: 'app', value: 'com.apple.keychainaccess' },
      { scope: 'url', value: '*banking*' },
      { scope: 'url', value: 'bank.example' },
    ],
    privacy: { ...P_DEFAULT },
  };
}

function cfgAllow() {
  return {
    enabled: true,
    allowlist: [
      { scope: 'app', value: 'com.allowed.*' },
      { scope: 'url', value: '*docs.example*' },
    ],
    blocklist: [
      { scope: 'app', value: 'com.secret.*' },
      { scope: 'url', value: '*banking*' },
    ],
    privacy: { ...P_DEFAULT },
  };
}

function cfgSafariExcluded() {
  const c = cfgBase();
  c.privacy.excludeSafariURLs = true;
  return c;
}

function cfgRedactOff() {
  const c = cfgBase();
  c.privacy.redactURLQuery = false;
  return c;
}

function cfgGreedy() {
  return {
    enabled: true,
    allowlist: [],
    blocklist: [
      { scope: 'app', value: 'a*b' },
      { scope: 'url', value: '*BANKING*' },
    ],
    privacy: { ...P_DEFAULT },
  };
}

const B = (bundleId, extra = {}) => ({ bundleId, ...extra });
const OBS = { observe: true, blockedScope: null, reason: 'default-observe', redactedURL: null };
const obsURL = (url) => ({ observe: true, blockedScope: null, reason: 'default-observe', redactedURL: url });
const blocked = (scope, reason) => ({ observe: false, blockedScope: scope, reason, redactedURL: null });

/** golden case：{name, config, sample, expected} —— expected 是规格手写的期望值。 */
const GOLDEN = [
  // ---- app 层 ----
  { name: 'app 默认观察', config: cfgBase, sample: B('com.apple.Terminal'), expected: OBS },
  { name: 'app glob block 命中', config: cfgBase, sample: B('com.1password.Mac'), expected: blocked('app', 'app-blocklist') },
  { name: 'app 精确 block 命中', config: cfgBase, sample: B('com.apple.keychainaccess'), expected: blocked('app', 'app-blocklist') },
  { name: 'app block 大小写不敏感', config: cfgBase, sample: B('COM.1PASSWORD.BETA'), expected: blocked('app', 'app-blocklist') },
  { name: 'app 近似名不误伤', config: cfgBase, sample: B('com.2password.Mac'), expected: OBS },
  // ---- url 层 ----
  {
    name: 'url contains block（原始 URL 匹配）', config: cfgBase,
    sample: B('com.apple.Safari', { url: 'https://ibank.example/banking/login?token=abc' }),
    expected: blocked('url', 'url-blocklist'),
  },
  {
    name: 'url host 精确 block', config: cfgBase,
    sample: B('com.apple.Safari', { url: 'https://bank.example/login' }),
    expected: blocked('url', 'url-blocklist'),
  },
  {
    name: 'url host block 带端口（host 不含端口）', config: cfgBase,
    sample: B('com.apple.Safari', { url: 'https://bank.example:8443/login' }),
    expected: blocked('url', 'url-blocklist'),
  },
  {
    name: 'url host block 大小写不敏感', config: cfgBase,
    sample: B('com.apple.Safari', { url: 'https://BANK.EXAMPLE/login' }),
    expected: blocked('url', 'url-blocklist'),
  },
  {
    name: 'url 未命中 → 观察并保留原路径', config: cfgBase,
    sample: B('com.apple.Safari', { url: 'https://example.com/docs' }),
    expected: obsURL('https://example.com/docs'),
  },
  // ---- URL 脱敏 ----
  {
    name: 'URL 脱敏去 query+fragment', config: cfgBase,
    sample: B('com.google.chrome', { url: 'https://example.com/search?q=secret#frag' }),
    expected: obsURL('https://example.com/search'),
  },
  {
    name: 'URL 脱敏 ? 在 # 前', config: cfgBase,
    sample: B('com.google.chrome', { url: 'https://example.com/a?x=1#y' }),
    expected: obsURL('https://example.com/a'),
  },
  {
    name: 'URL 无 query 原样保留', config: cfgBase,
    sample: B('com.google.chrome', { url: 'https://example.com/path' }),
    expected: obsURL('https://example.com/path'),
  },
  {
    name: 'URL 只有 query', config: cfgBase,
    sample: B('com.google.chrome', { url: 'https://example.com/?token=1' }),
    expected: obsURL('https://example.com/'),
  },
  {
    name: '关闭脱敏时原样存储', config: cfgRedactOff,
    sample: B('com.apple.Terminal', { url: 'https://example.com/search?q=1#f' }),
    expected: obsURL('https://example.com/search?q=1#f'),
  },
  // ---- 无痕 ----
  {
    name: 'incognito 无条件排除', config: cfgBase,
    sample: B('com.google.chrome', { url: 'https://example.com/x', incognito: true }),
    expected: blocked('url', 'incognito'),
  },
  {
    name: 'incognito 时 app block 仍先赢', config: cfgBase,
    sample: B('com.1password.Mac', { incognito: true }),
    expected: blocked('app', 'app-blocklist'),
  },
  {
    name: 'incognito 时 url block 仍先赢', config: cfgBase,
    sample: B('com.apple.Safari', { url: 'https://ibank.example/banking', incognito: true }),
    expected: blocked('url', 'url-blocklist'),
  },
  // ---- secure input 整机抑制 ----
  {
    name: 'secureInput 整机抑制', config: cfgBase,
    sample: B('com.apple.Terminal', { secureInput: true }),
    expected: blocked('system', 'secure-input'),
  },
  {
    name: 'secureInput 优先于 app block', config: cfgBase,
    sample: B('com.1password.Mac', { secureInput: true }),
    expected: blocked('system', 'secure-input'),
  },
  {
    name: 'secureInput 优先于 incognito', config: cfgBase,
    sample: B('com.google.chrome', { url: 'https://x.example/', incognito: true, secureInput: true }),
    expected: blocked('system', 'secure-input'),
  },
  // ---- allowlist ----
  {
    name: 'allowlist app 放行', config: cfgAllow,
    sample: B('com.allowed.editor'),
    expected: { observe: true, blockedScope: null, reason: 'allowlist-app', redactedURL: null },
  },
  {
    name: 'allowlist url 放行（app 不在白名单）', config: cfgAllow,
    sample: B('com.other.browser', { url: 'https://docs.example.com/a?q=1' }),
    expected: { observe: true, blockedScope: null, reason: 'allowlist-url', redactedURL: 'https://docs.example.com/a' },
  },
  {
    name: 'allowlist 未命中 app', config: cfgAllow,
    sample: B('com.other.app'),
    expected: blocked('app', 'not-in-allowlist'),
  },
  {
    name: 'allowlist 未命中 url', config: cfgAllow,
    sample: B('com.other.browser', { url: 'https://evil.example/' }),
    expected: blocked('app', 'not-in-allowlist'),
  },
  {
    name: 'app block 优先于 allowlist', config: cfgAllow,
    sample: B('com.secret.app'),
    expected: blocked('app', 'app-blocklist'),
  },
  {
    name: 'url block 优先于 allowlist app', config: cfgAllow,
    sample: B('com.allowed.browser', { url: 'https://ibank.example/banking' }),
    expected: blocked('url', 'url-blocklist'),
  },
  {
    name: 'incognito 优先于 allowlist', config: cfgAllow,
    sample: B('com.allowed.browser', { url: 'https://docs.example.com/a', incognito: true }),
    expected: blocked('url', 'incognito'),
  },
  // ---- Safari 手动排除 ----
  {
    name: 'Safari 强制排除 URL/内容', config: cfgSafariExcluded,
    sample: B('com.apple.Safari', { url: 'https://example.com/x' }),
    expected: blocked('url', 'safari-url-excluded'),
  },
  {
    name: 'Safari 排除不影响其他浏览器', config: cfgSafariExcluded,
    sample: B('com.google.chrome', { url: 'https://example.com/x' }),
    expected: obsURL('https://example.com/x'),
  },
  {
    name: 'Safari 排除时 app block 仍先赢', config: cfgSafariExcluded,
    sample: B('com.1password.Mac'),
    expected: blocked('app', 'app-blocklist'),
  },
  // ---- glob 贪婪/回溯与非法 URL ----
  {
    name: 'glob 贪婪回溯 a*b 命中 axbxb', config: cfgGreedy,
    sample: B('axbxb'),
    expected: blocked('app', 'app-blocklist'),
  },
  {
    name: 'glob 贪婪回溯 a*b 不命中 acbc', config: cfgGreedy,
    sample: B('acbc'),
    expected: OBS,
  },
  {
    name: 'url 规则大小写不敏感（完整 URL）', config: cfgGreedy,
    sample: B('com.apple.Safari', { url: 'https://x.example/Banking/y' }),
    expected: blocked('url', 'url-blocklist'),
  },
  {
    name: '非法 URL：host 匹配失败但仍可观', config: cfgGreedy,
    sample: B('com.apple.Safari', { url: 'not a url' }),
    expected: obsURL('not a url'),
  },
  // ---- 非浏览器带 URL（显式锁定决策层语义：sampler 只给浏览器传 URL） ----
  {
    name: '非浏览器 URL 仍参与 url block（决策层语义）', config: cfgBase,
    sample: B('com.apple.Terminal', { url: 'https://ibank.example/banking' }),
    expected: blocked('url', 'url-blocklist'),
  },
];

// ---------- ① JS 矩阵 ----------

describe('隐私规则 JS 矩阵', () => {
  test('glob：锚定/大小写/贪婪回溯/连续 *', () => {
    assert.equal(globMatch('com.1password.*', 'com.1password.Mac'), true);
    assert.equal(globMatch('com.1password.*', 'com.2password.Mac'), false);
    assert.equal(globMatch('com.foo*', 'com.foo'), true);
    assert.equal(globMatch('com.foo.*', 'com.foo'), false);
    assert.equal(globMatch('*banking*', 'https://IBK.Banking.example'), true);
    assert.equal(globMatch('a*b', 'axbxb'), true); // 旧 Swift 实现会因取首个 b 而误判 false
    assert.equal(globMatch('a*b', 'ab'), true);
    assert.equal(globMatch('a*b', 'acb'), true);
    assert.equal(globMatch('a*b', 'ac'), false);
    assert.equal(globMatch('**a**', 'xxaxx'), true);
    assert.equal(globMatch('', ''), true);
    assert.equal(globMatch('', 'x'), false);
  });

  test('urlRuleMatch：完整 URL、host（不含端口）、非法 URL', () => {
    assert.equal(urlRuleMatch('*mail.example.com*', 'https://mail.example.com/inbox'), true);
    assert.equal(urlRuleMatch('mail.example.com', 'https://mail.example.com/inbox'), true);
    assert.equal(urlRuleMatch('example.com', 'https://example.com:8080/x'), true); // JS 用 hostname，与 Swift URL.host 对齐
    assert.equal(urlRuleMatch('mail.example.com', 'https://other.example.com'), false);
    assert.equal(urlRuleMatch('*banking*', 'not a url'), false);
  });

  test('redactURL / privacySettings 默认与非法值回落', () => {
    assert.equal(redactURL('https://e.com/a?b=1#c'), 'https://e.com/a');
    assert.equal(redactURL('https://e.com/a#c?b=1'), 'https://e.com/a');
    assert.equal(redactURL('https://e.com/a'), 'https://e.com/a');
    assert.equal(redactURL('https://e.com/?q=1'), 'https://e.com/');
    assert.equal(redactURL(''), null);
    assert.equal(redactURL(null), null);
    assert.deepEqual(privacySettings({}), { safariPrivateDetection: 'heuristic', excludeSafariURLs: false, redactURLQuery: true });
    assert.equal(privacySettings({ privacy: { redactURLQuery: false } }).redactURLQuery, false);
    assert.equal(privacySettings({ privacy: { safariPrivateDetection: 'weird' } }).safariPrivateDetection, 'heuristic');
    assert.equal(privacySettings({ privacy: { safariPrivateDetection: 'off' } }).safariPrivateDetection, 'off');
  });

  test('evaluateSample：golden 期望值全部通过（JS 侧规格自检）', () => {
    for (const c of GOLDEN) {
      const got = evaluateSample(c.sample, c.config());
      assert.deepEqual(got, c.expected, `JS 决策不符: ${c.name}`);
    }
  });

  test('defaultConfig 含 privacy 子段且默认脱敏/Safari 启发式开启', () => {
    const cfg = defaultConfig();
    assert.deepEqual(cfg.privacy, { safariPrivateDetection: 'heuristic', excludeSafariURLs: false, redactURLQuery: true });
    // 旧字段仍在（setup/daemon/既有测试依赖）
    assert.equal(cfg.enabled, true);
    assert.ok(Array.isArray(cfg.blocklist) && cfg.blocklist.length >= 4);
    // R1 内容采集默认值（旧 config 缺字段时按此回退）
    assert.equal(cfg.includeContent, true);
    assert.equal(cfg.contentMaxChars, 16384);
    assert.equal(cfg.diffMaxChars, 4096);
    assert.equal(cfg.inputTextMaxChars, 2000);
    assert.equal(cfg.selectionMaxChars, 300);
    assert.deepEqual(contentSettings(cfg), {
      includeContent: true, contentMaxChars: 16384, diffMaxChars: 4096, inputTextMaxChars: 2000, selectionMaxChars: 300,
    });
  });

  test('内容采集配置：缺省/非法值回落默认，越界夹到边界（与 Swift fromJSON 同边界）', () => {
    assert.deepEqual(contentSettings({}), {
      includeContent: true, contentMaxChars: 16384, diffMaxChars: 4096, inputTextMaxChars: 2000, selectionMaxChars: 300,
    });
    assert.equal(contentSettings({ includeContent: false }).includeContent, false);
    assert.equal(contentSettings({ includeContent: 'no' }).includeContent, true, '非布尔按默认 true');
    const tight = contentSettings({ contentMaxChars: 1, diffMaxChars: 999999, inputTextMaxChars: 'abc', selectionMaxChars: 8 });
    assert.equal(tight.contentMaxChars, 256);
    assert.equal(tight.diffMaxChars, 16384);
    assert.equal(tight.inputTextMaxChars, 2000);
    assert.equal(tight.selectionMaxChars, 16);
    const huge = contentSettings({ contentMaxChars: 999999, diffMaxChars: 1, inputTextMaxChars: 999999, selectionMaxChars: 999999 });
    assert.equal(huge.contentMaxChars, 65536);
    assert.equal(huge.diffMaxChars, 256);
    assert.equal(huge.inputTextMaxChars, 20000);
    assert.equal(huge.selectionMaxChars, 10000);
  });

  test('validatePrivacyConfig：内容字段类型/整数/边界校验', () => {
    assert.deepEqual(validatePrivacyConfig({}), []);
    assert.deepEqual(validatePrivacyConfig({ includeContent: false, contentMaxChars: 4096 }), []);
    assert.match(validatePrivacyConfig({ includeContent: 'yes' })[0], /includeContent/);
    assert.match(validatePrivacyConfig({ contentMaxChars: '8192' })[0], /contentMaxChars 须为整数/);
    assert.match(validatePrivacyConfig({ diffMaxChars: 1.5 })[0], /diffMaxChars 须为整数/);
    assert.match(validatePrivacyConfig({ inputTextMaxChars: 1 })[0], /inputTextMaxChars 须在 32-20000/);
    assert.match(validatePrivacyConfig({ selectionMaxChars: 99999 })[0], /selectionMaxChars 须在 16-10000/);
  });
});

// ---------- ② ③ Swift↔JS 对拍 + decide 无副作用 ----------

describe('Swift↔JS decide 对拍', { skip: SWIFTC ? false : '本机无 swiftc，SKIP' }, () => {
  let binary;
  let home;
  let client;

  before(async () => {
    binary = await ensureBinary();
    home = tmpHome();
    client = startDaemon(binary, home);
  });

  after(() => {
    client?.stop();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('decide 无副作用：不创建 segments/、不改运行状态、零文件新增', async () => {
    writeConfig(home, defaultConfig());
    const before = readdirSync(home).sort();
    const r1 = await client.request('decide', { sample: { bundleId: 'com.apple.Terminal', url: 'https://example.com/a?q=1' } });
    const r2 = await client.request('decide', { sample: { bundleId: 'com.1password.Mac' } });
    assert.equal(r1.observe, true);
    assert.equal(r1.reason, 'default-observe');
    assert.equal(r1.redactedURL, 'https://example.com/a');
    assert.equal(r2.observe, false);
    assert.deepEqual(readdirSync(home).sort(), before, 'decide 不得新增任何文件/目录');
    assert.equal(existsSync(path.join(home, 'segments')), false, 'decide 不得创建 segments/');
    const st = await client.request('status');
    assert.equal(st.running, false);
    assert.equal(st.currentSegment, null);
  });

  test('decide configPath：可从任意配置文件做纯决策', async () => {
    const alt = path.join(home, 'alt-config.json');
    const altCfg = cfgBase();
    altCfg.blocklist = [{ scope: 'app', value: 'com.alt.blocked' }];
    writeFileSync(alt, JSON.stringify(altCfg));
    const r = await client.request('decide', { sample: { bundleId: 'com.alt.blocked' }, configPath: alt });
    assert.equal(r.observe, false);
    assert.equal(r.blockedScope, 'app');
    assert.equal(r.reason, 'app-blocklist');
  });

  test(`golden 对拍：${GOLDEN.length} 组逐条与 JS evaluateSample 一致`, async () => {
    for (const c of GOLDEN) {
      const cfg = c.config();
      writeConfig(home, cfg);
      const swift = await client.request('decide', { sample: c.sample });
      const got = {
        observe: swift.observe,
        blockedScope: swift.blockedScope ?? null,
        reason: swift.reason,
        redactedURL: swift.redactedURL ?? null,
      };
      assert.deepEqual(got, c.expected, `Swift 决策不符: ${c.name}`);
      assert.deepEqual(got, evaluateSample(c.sample, cfg), `Swift↔JS 不一致: ${c.name}`);
    }
    assert.ok(GOLDEN.length >= 20, 'golden case 数量须 ≥20');
  });
});

// ---------- ③b Swift 内容采集自检（selftest：无副作用） ----------

describe('Swift 内容采集自检（selftest）', { skip: SWIFTC ? false : '本机无 swiftc，SKIP' }, () => {
  let binary;
  let home;
  let client;

  before(async () => {
    binary = await ensureBinary();
    home = tmpHome();
    client = startDaemon(binary, home);
  });

  after(() => {
    client?.stop();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('配置默认值 + 旧 config 缺字段回退默认（不落盘）', async () => {
    writeConfig(home, { enabled: true });
    const before = readdirSync(home).sort();
    const r = await client.request('selftest', { configPath: path.join(home, 'config.json') });
    assert.equal(r.ok, true);
    assert.equal(r.config.includeContent, true);
    // S2：contentMaxChars 8192→16384、diffMaxChars 2048→4096
    assert.equal(r.config.contentMaxChars, 16384);
    assert.equal(r.config.diffMaxChars, 4096);
    assert.equal(r.config.inputTextMaxChars, 2000);
    assert.equal(r.config.selectionMaxChars, 300);
    assert.deepEqual(readdirSync(home).sort(), before, 'selftest 不得写文件');
    const st = await client.request('status');
    assert.equal(st.running, false);
  });

  test('配置归一化：布尔/整数边界与非法类型（与 JS contentSettings 一致）', async () => {
    const r = await client.request('selftest', {
      config: { includeContent: false, contentMaxChars: 999999, diffMaxChars: 1, inputTextMaxChars: 'abc', selectionMaxChars: 8 },
    });
    assert.equal(r.config.includeContent, false);
    assert.equal(r.config.contentMaxChars, 65536);
    assert.equal(r.config.diffMaxChars, 256);
    assert.equal(r.config.inputTextMaxChars, 2000, '非法字符串回落默认');
    assert.equal(r.config.selectionMaxChars, 16);
    assert.equal(r.limits.maxEventsPerSegment, 5000);
    // 采集增强：depth 20、节点 3000、单值 500、文本 flush 500ms
    assert.equal(r.limits.axMaxDepth, 20);
    assert.equal(r.limits.axMaxNodes, 3000);
    assert.equal(r.limits.axValueMax, 500);
    assert.equal(r.limits.clickDedupeMs, 80);
    assert.equal(r.limits.textIdleFlushMs, 500);
  });

  test('AX 序列化质量：role 中文化/空标题无 ? / 单值 500 / 深度 20 / 节点 3000', async () => {
    const r = await client.request('selftest', { config: {} });
    const snap = r.snapshot;
    const lines = snap.text.split('\n');
    assert.equal(lines[0], '窗口 「Editor — draft.md」');
    assert.equal(snap.nodeCount, 5);
    assert.ok(lines.some((l) => l.startsWith('  按钮 「Save」')), 'AXButton 应本地化为「按钮」');
    assert.ok(lines.some((l) => l.startsWith('  文本栏 「标题」 = draft')), 'title 与 value 应同时保留');
    assert.ok(!snap.text.includes('?'), '空标题不得输出 ?');
    assert.ok(!snap.text.includes('AXButton'), '序列化文本不应出现原始 AX role');
    assert.ok(snap.valueTruncated, '单值应被截断（含省略号）');
    assert.ok(!snap.text.includes('x'.repeat(501)), '单值长度不得超过 500 字符');
    assert.ok(snap.text.includes('x'.repeat(500) + '…'), '单值应截到 500 并加省略号');
    // 密码控件：localized role 有、value 无；绝不出现 secret
    assert.match(snap.secureLine, /^\s*安全文本栏 「Password」$/);
    assert.ok(!snap.secureLine.includes('='), '密码控件行不得包含 value');
    assert.ok(!snap.text.includes('secret'));
    // 浏览器/文档树：depth 20 → 根+20=21 行；wide fixture 1300 节点（上限 3000 不截断）
    assert.equal(snap.deepNodeCount, 21, 'depth≤20（根 depth=0）应序列化 21 行');
    assert.equal(snap.wideNodeCount, 1301, 'fixture 根+1300 节点（上限 3000）');
    assert.equal(snap.maxDepth, 20);
    assert.equal(snap.maxNodes, 3000);
  });

  test('AX 序列化质量：role 映射/空标题行/原始 role 保留/keyCode→键名', async () => {
    const r = await client.request('selftest', { config: {} });
    const q = r.quality;
    assert.deepEqual(q.roleLocalized, { button: '按钮', outline: '大纲', empty: '元素' });
    assert.equal(q.emptyTitleLine, '大纲', '空 title/description/value 只输出 role，不输出 ?');
    assert.equal(q.targetRoleLocalized, '文本域');
    assert.equal(q.targetRoleRaw, 'AXTextArea', '原始 role 保留在 role_raw');
    assert.deepEqual(q.keyMap, {
      0: 'a', 1: 's', 36: 'return', 48: 'tab', 49: 'Space', 51: 'delete',
      116: 'page_up', 117: 'forward_delete', 121: 'page_down',
      123: 'left_arrow', 124: 'right_arrow', 125: 'down_arrow', 126: 'up_arrow',
      250: 'keycode-250',
    });
    assert.equal(q.functionKeyChar, 'left_arrow', 'Fn+方向键的私有区字符必须落回键名');
    assert.equal(q.returnSubmitCheck, true, '无修饰键 + 有文本内容 → 需要复查是否清空（submit/shortcut）');
    assert.equal(q.returnShiftShortcut, true, 'Shift+Return 直接记 shortcut（换行，不提交）');
    assert.equal(q.returnEmptyShortcut, true, '无文本的 Return 直接记 shortcut');
    assert.deepEqual(q.returnSettle, { wechat: true, feishu: true, dialog: true, arc: true },
      '微信空 target/访达对话框/Arc 清空 → submit；飞书文本仍在 → shortcut');
    assert.deepEqual(q.returnSettleCheck, { wechat: true, feishu: true, idle: true, shift: true },
      '微信最近有输入、飞书有文本 → 复查；空闲/Shift+Return → 不复查');
    assert.equal(q.functionModifier, true, 'Fn 修饰键应记录为 function');
    assert.deepEqual(q.windowTitles, { spinnerSame: true, realChange: true },
      '终端 spinner 变化不算窗口变化；微信/图片和视频算');
    assert.deepEqual(q.windowTransitions, {
      untitledNew: true, untitledSame: true, titledChange: true,
      spinnerSame: true, sameTitleNewWindow: true, noWindow: true,
    }, '无标题弹层换窗口要记；同窗口标题暂时读不到不重复记；同标题新窗口要记');
    assert.deepEqual(q.selectionNotifications, [
      'AXSelectedTextChanged', 'AXSelectedChildrenChanged', 'AXSelectedChildrenMoved',
      'AXSelectedRowsChanged', 'AXSelectedColumnsChanged', 'AXSelectedCellsChanged',
    ]);
    assert.equal(r.shortcut.normal.target.role, '文本域');
    assert.equal(r.shortcut.normal.target.role_raw, 'AXTextArea');
    assert.deepEqual(r.shortcut.normal.modifiers, ['command']);
  });

  test('AX 快照 diff：+/- 行级对比且可截断', async () => {
    const r = await client.request('selftest', { config: { diffMaxChars: 4096 } });
    const diff = r.snapshot.diff;
    assert.ok(diff.split('\n').some((l) => l.startsWith('-')), 'diff 应含删除行');
    assert.ok(diff.split('\n').some((l) => l.startsWith('+')), 'diff 应含新增行');
    assert.match(diff, /Save All/);
    assert.match(diff, /按钮/, 'diff 行也应使用中文化 role');
    assert.ok(r.snapshot.diffTight.length <= 60, `紧 diff 截断应 ≤60，实际 ${r.snapshot.diffTight.length}`);
    const tight = await client.request('selftest', { config: { diffMaxChars: 256 } });
    assert.ok(tight.snapshot.diff.length <= 256, `diff 截断后应 ≤256，实际 ${tight.snapshot.diff.length}`);
  });

  test('文本输入/点击/快捷键/选区：截断、text_composed 与密码控件抑制', async () => {
    const r = await client.request('selftest', {
      config: { inputTextMaxChars: 500, selectionMaxChars: 50, includeContent: true },
    });
    assert.equal(r.textInput.truncatedChars, 500);
    assert.equal(r.textInput.charCount, 5000, 'charCount 报原文长度');
    assert.equal(r.textInput.targetRole, '文本域');
    assert.equal(r.textInput.targetRoleRaw, 'AXTextArea');
    assert.equal(r.textInput.targetHasValue, true, 'target.value 应来自 AXValue');
    assert.equal(r.textInput.composed, '你好', '输入法合成结果存 text_composed');
    assert.equal(r.textInput.composedCharCount, 6);
    assert.equal(r.textInput.secureDropped, true, '密码控件文本必须丢弃');
    assert.equal(r.click.secureDropped, true, '密码控件点击不记录');
    assert.equal(r.click.normal.button, 'left');
    assert.equal(r.click.normal.target.role, '文本域');
    assert.equal(r.shortcut.normal.keyEquivalent, 's');
    assert.deepEqual(r.shortcut.normal.modifiers, ['command']);
    assert.equal(r.shortcut.secureDropped, true);
    assert.equal(r.selection.truncatedChars, 50);
    assert.deepEqual(r.selection.range, { location: 2, length: 5 });
    assert.equal(r.selection.bareAllowed, true, 'bare selection（只有 target）应可落盘');
    assert.equal(r.selection.bareDropped, true, '轮询无内容时不应产生空选区事件');
    assert.equal(r.selection.secureDropped, true);
    assert.equal(r.privacy.secureRoleDetected, true);
    assert.equal(r.privacy.passwordTitleDetected, true);
    assert.equal(r.privacy.secureValueRead, null, '密码控件 value 必须为 nil');
    assert.equal(r.privacy.secureSerializedHasSecret, false);
  });
});

// ---------- ④ Swift 采集可靠性 ----------

describe('Swift 采集可靠性', { skip: SWIFTC ? false : '本机无 swiftc，SKIP' }, () => {
  let binary;
  const cleanup = [];
  const newHome = () => {
    const home = tmpHome();
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
  };
  const spawnFor = (home, env) => {
    const d = startDaemon(binary, home, env);
    cleanup.push(() => d.stop());
    return d;
  };

  before(async () => { binary = await ensureBinary(); });
  after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch { /* 忽略清理失败 */ } } });

  test('懒建段：start→立即 stop 不产生任何空段目录', async () => {
    const home = newHome();
    writeConfig(home, { enabled: true, allowlist: [], blocklist: [], privacy: { ...P_DEFAULT } });
    const d = spawnFor(home);
    const start = await d.request('start');
    assert.equal(start.ok, true);
    assert.deepEqual(start.repairedSegments, 0);
    const st = await d.request('status');
    assert.ok(st.currentSegment, 'start 后 status 应有 currentSegment（段对象懒物化，但窗口已开）');
    assert.equal(st.currentSegment.eventCount, 0);
    assert.equal(st.currentSegment.suppressedEventCount, 0);
    assert.deepEqual(existsSync(path.join(home, 'segments')) ? readdirSync(path.join(home, 'segments')) : [], []);
    await d.request('stop');
    assert.deepEqual(readdirSync(path.join(home, 'segments')), [], '无事件/无抑制 → 关闭时删空段');
  });

  test('抑制审计：suppressed 含 reason/scope，metadata.suppressedEventCount 与文件一致', async () => {
    const home = newHome();
    writeConfig(home, {
      enabled: true,
      allowlist: [{ scope: 'app', value: '*' }],
      blocklist: [{ scope: 'app', value: '*' }],
      includeURLs: true,
      includeFocusedElement: true,
      privacy: { ...P_DEFAULT },
    });
    const d = spawnFor(home, { CHRONICLE_SAMPLE_INTERVAL_MS: '100' });
    await d.request('start');
    await sleep(500);
    const stop = await d.request('stop');
    assert.equal(stop.stats.totalEvents, 0, 'block 一切 → 零内容事件');
    const dirs = readdirSync(path.join(home, 'segments'));
    assert.equal(dirs.length, 1, '抑制记录也要落段（审计不能丢）');
    const dir = path.join(home, 'segments', dirs[0]);
    const events = readJsonl(path.join(dir, 'events.jsonl'));
    const suppressed = readJsonl(path.join(dir, 'suppressed.jsonl'));
    assert.deepEqual(events, []);
    assert.ok(suppressed.length >= 1);
    for (const s of suppressed) {
      assert.deepEqual(Object.keys(s).sort(), ['reason', 'scope', 'ts', 'type']);
      assert.equal(s.reason, 'app-blocklist');
      assert.equal(s.scope, 'app');
    }
    const meta = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(meta.eventCount, 0);
    assert.equal(meta.suppressedEventCount, suppressed.length, 'metadata.suppressedEventCount 必须与文件一致');
    assert.ok(meta.segmentEnd, '关闭段必须有 segmentEnd');
  });

  test('secure input 整机抑制：零内容事件 + reason=secure-input/scope=system', async () => {
    const home = newHome();
    writeConfig(home, { enabled: true, allowlist: [], blocklist: [], privacy: { ...P_DEFAULT } });
    const d = spawnFor(home, { CHRONICLE_SAMPLE_INTERVAL_MS: '100', CHRONICLE_TEST_FORCE_SECURE_INPUT: '1' });
    await d.request('start');
    await sleep(400);
    const stop = await d.request('stop');
    assert.equal(stop.stats.totalEvents, 0);
    const dirs = readdirSync(path.join(home, 'segments'));
    assert.equal(dirs.length, 1);
    const dir = path.join(home, 'segments', dirs[0]);
    assert.deepEqual(readJsonl(path.join(dir, 'events.jsonl')), []);
    const suppressed = readJsonl(path.join(dir, 'suppressed.jsonl'));
    assert.ok(suppressed.length >= 1);
    assert.equal(suppressed[0].reason, 'secure-input');
    assert.equal(suppressed[0].scope, 'system');
  });

  test('paused 到期段关闭且不新建空段；resume 后按需懒建新段', async () => {
    const home = newHome();
    // 观察一切：段轮转后内容去重复位，resume 时产生的采样快照会懒建新段。
    writeConfig(home, { enabled: true, allowlist: [], blocklist: [], privacy: { ...P_DEFAULT } });
    const d = spawnFor(home, { CHRONICLE_SAMPLE_INTERVAL_MS: '100', CHRONICLE_SEGMENT_MS: '400' });
    await d.request('start');
    await sleep(250); // 产生第一条抑制记录 → 段目录物化
    const pause = await d.request('pause');
    assert.equal(pause.ok, true);
    const dirsAtPause = readdirSync(path.join(home, 'segments'));
    assert.equal(dirsAtPause.length, 1);
    await sleep(900); // 超过 2 个段时长；paused 时也应按期关闭旧段
    const dirsDuringPause = readdirSync(path.join(home, 'segments'));
    assert.equal(dirsDuringPause.length, 1, 'paused 期间不得新建空段');
    const meta = JSON.parse(readFileSync(path.join(home, 'segments', dirsDuringPause[0], 'metadata.json'), 'utf8'));
    assert.ok(meta.segmentEnd, 'paused 期间到期段必须关闭（写 segmentEnd）');
    await d.request('resume');
    await sleep(300); // resume 后首个记录懒建新段
    await d.request('stop');
    const dirsAfter = readdirSync(path.join(home, 'segments'));
    assert.ok(dirsAfter.length >= 2, 'resume 后新记录应懒建新段');
    for (const name of dirsAfter) {
      const m = JSON.parse(readFileSync(path.join(home, 'segments', name, 'metadata.json'), 'utf8'));
      assert.ok(m.segmentEnd, `段 ${name} 应已关闭`);
      assert.ok((m.eventCount + m.suppressedEventCount) > 0, `段 ${name} 不应是空段`);
    }
  });

  test('孤儿段修复：补 segmentEnd+closedBy=repair；空段删除；已关闭段不动', async () => {
    const home = newHome();
    writeConfig(home, { enabled: true, allowlist: [{ scope: 'app', value: 'com.never.match' }], blocklist: [], privacy: { ...P_DEFAULT } });
    const segRoot = path.join(home, 'segments');

    // 孤儿段（有 2 条事件，无 segmentEnd）
    const orphan = path.join(segRoot, '2026-01-01T00-00-00.000Z');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, 'events.jsonl'), [
      { ts: '2026-01-01T00:00:05.000Z', type: 'app-switch', data: { bundleId: 'com.a' } },
      { ts: '2026-01-01T00:09:59.000Z', type: 'window-change', data: { bundleId: 'com.a', windowTitle: 'w' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(path.join(orphan, 'metadata.json'), JSON.stringify({ segmentStart: '2026-01-01T00:00:00.000Z', eventCount: 2 }));

    // 空孤儿段（无任何记录行）→ 删除
    const emptyOrphan = path.join(segRoot, '2026-01-01T00-10-00.000Z');
    mkdirSync(emptyOrphan, { recursive: true });
    writeFileSync(path.join(emptyOrphan, 'metadata.json'), JSON.stringify({ segmentStart: '2026-01-01T00:10:00.000Z', eventCount: 0 }));

    // 已正常关闭的段 → 不得改写
    const closed = path.join(segRoot, '2025-12-31T23-50-00.000Z');
    mkdirSync(closed, { recursive: true });
    writeFileSync(path.join(closed, 'events.jsonl'), JSON.stringify({ ts: '2025-12-31T23:55:00.000Z', type: 'app-switch', data: { bundleId: 'com.b' } }) + '\n');
    const closedMeta = { segmentStart: '2025-12-31T23:50:00.000Z', segmentEnd: '2025-12-31T23:59:00.000Z', eventCount: 1, suppressedEventCount: 0 };
    writeFileSync(path.join(closed, 'metadata.json'), JSON.stringify(closedMeta));

    const d = spawnFor(home, { CHRONICLE_SAMPLE_INTERVAL_MS: '5000' });
    const start = await d.request('start');
    assert.equal(start.repairedSegments, 1);
    assert.equal(start.removedEmptySegments, 1);

    const repaired = JSON.parse(readFileSync(path.join(orphan, 'metadata.json'), 'utf8'));
    assert.equal(repaired.segmentEnd, '2026-01-01T00:09:59.000Z');
    assert.equal(repaired.closedBy, 'repair');
    assert.equal(repaired.eventCount, 2);
    assert.equal(repaired.suppressedEventCount, 0);
    assert.equal(existsSync(emptyOrphan), false, '空孤儿段应删除');
    assert.deepEqual(JSON.parse(readFileSync(path.join(closed, 'metadata.json'), 'utf8')), closedMeta, '已关闭段不应被改写');

    await d.request('stop');
  });
});

// ---------- ⑤ Swift 内容采集降级（无 AX / includeContent=false） ----------

describe('Swift 内容采集降级', { skip: SWIFTC ? false : '本机无 swiftc，SKIP' }, () => {
  let binary;
  const cleanup = [];
  const newHome = () => {
    const home = tmpHome();
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
  };
  const eventsOf = (home) => {
    const root = path.join(home, 'segments');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((name) => readJsonl(path.join(root, name, 'events.jsonl')));
  };

  before(async () => { binary = await ensureBinary(); });
  after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch { /* 忽略清理失败 */ } } });

  test('AX 未授权（测试钩子）：probe/selftest 报 axGranted=false，start/stop 不崩、无富内容事件', async () => {
    const home = newHome();
    writeConfig(home, { ...cfgBase(), includeContent: true });
    const d = startDaemon(binary, home, { CHRONICLE_SAMPLE_INTERVAL_MS: '60', CHRONICLE_TEST_FORCE_NO_AX: '1' });
    cleanup.push(() => d.stop());
    const probe = await d.request('probe');
    assert.equal(probe.axGranted, false, '测试钩子应强制未授权');
    const self = await d.request('selftest');
    assert.equal(self.axTrusted, false);
    const start = await d.request('start');
    assert.equal(start.ok, true);
    await sleep(400);
    const stop = await d.request('stop');
    assert.equal(stop.ok, true);
    const events = eventsOf(home);
    for (const e of events) {
      assert.ok(['app-switch', 'window-change', 'url-change', 'focus-change'].includes(e.type),
        `AX 未授权时不得出现富内容事件，实际 ${e.type}`);
      assert.ok(!['click', 'shortcut', 'text-input', 'submit', 'selection', 'ax-snapshot'].includes(e.type));
    }
  });

  test('includeContent=false：严格退化为 app-switch/window-change', async () => {
    const home = newHome();
    writeConfig(home, { ...cfgBase(), includeContent: false });
    const d = startDaemon(binary, home, { CHRONICLE_SAMPLE_INTERVAL_MS: '60' });
    cleanup.push(() => d.stop());
    assert.equal((await d.request('start')).ok, true);
    await sleep(400);
    assert.equal((await d.request('stop')).ok, true);
    const events = eventsOf(home);
    for (const e of events) {
      assert.ok(['app-switch', 'window-change'].includes(e.type),
        `includeContent=false 只允许 app-switch/window-change，实际 ${e.type}`);
    }
  });
});
