// test/mcp-install.test.mjs — AI 工具接入器测试（零依赖，临时 HOME 隔离）
//
// 覆盖：
//   ① --print 严格契约：单行 JSON、精确形状、绝对路径
//   ② --list：JSON 数组、5 客户端、kind/path/configured、不写盘
//   ③ dry-run（默认/显式）零写入、不备份、不建目录
//   ④ --yes：JSON merge 保留其他条目、备份=原文件、回读正确
//   ⑤ 幂等：二次执行不重复写、不新增备份
//   ⑥ 损坏 JSON：原文件不被覆盖、备份存在、退出码 1、输出不泄露内容
//   ⑦ codex TOML：追加不重复、原内容保留、结构自检、坏 TOML 拒绝
//   ⑧ vscode 形态（servers.chronicle + type:"stdio"）
//   ⑨ claude-code：无 .claude.json 只出 CLI 命令；有则同时 merge
//   ⑩ 未知 target / 未知参数 → 退出码 2
//   ⑪ --json 只输出 JSON；默认模式最后一行是 JSON
//   ⑫ 符号链接/目录等非普通文件拒绝写入
//   ⑬ --target all：五个目标全部处理，成功时退出码 0，不泄露其他配置内容
//
// 全部路径通过 --home/--codex-home 隔离到临时目录；绝不触碰真实 ~/.codex、~/.cursor 等。

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'mcp-install.mjs');
const MCP_ENTRY = path.join(REPO_ROOT, 'mcp-entry.mjs');
// 客户端配置里的 node 命令应为绝对路径（GUI 客户端 PATH 不可靠）
const NODE_CMD = process.execPath;

const tmpRoots = [];
after(() => {
  for (const dir of tmpRoots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
});

function tmpHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chronicle-mcp-install-'));
  tmpRoots.push(dir);
  return dir;
}

/** 运行 CLI；json = 最后一行 JSON（若可解析）。 */
function run(args, { timeout = 20_000 } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout });
  const lines = String(r.stdout ?? '').trim().split('\n').filter(Boolean);
  let json = null;
  if (lines.length) {
    try { json = JSON.parse(lines[lines.length - 1]); } catch { json = null; }
  }
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), lines, json };
}

function writeFileMk(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function countBackups(dir) {
  try { return readdirSync(dir).filter((f) => f.includes('.chronicle-backup-')).length; } catch { return 0; }
}

const claudeDesktopPath = (home) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const cursorPath = (home) => path.join(home, '.cursor', 'mcp.json');
const vscodePath = (home) => path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
const claudeCodePath = (home) => path.join(home, '.claude.json');
const codexPath = (codexHome) => path.join(codexHome, 'config.toml');

function prepareClients(home) {
  // 让所有客户端目录“看起来已安装”，供 --target all / 各目标写入测试使用。
  mkdirSync(path.dirname(claudeDesktopPath(home)), { recursive: true });
  mkdirSync(path.dirname(cursorPath(home)), { recursive: true });
  mkdirSync(path.dirname(vscodePath(home)), { recursive: true });
  const codexHome = path.join(home, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  return codexHome;
}

describe('mcp-install.mjs', () => {
  test('--print：单行 JSON、精确契约、绝对路径', () => {
    const r = run(['--print']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '', '--print 不应向 stderr 输出');
    assert.equal(r.lines.length, 1, '--print 必须是单行输出');
    const payload = JSON.parse(r.lines[0]);
    assert.deepEqual(payload, { mcpServers: { chronicle: { command: NODE_CMD, args: [MCP_ENTRY] } } });
    assert.ok(path.isAbsolute(payload.mcpServers.chronicle.args[0]));
    assert.ok(payload.mcpServers.chronicle.args[0].endsWith('mcp-entry.mjs'));
  });

  test('--list：JSON 数组、5 客户端、kind/path/configured，且零写入', () => {
    const home = tmpHome();
    const before = readdirSync(home);
    const r = run(['--list', '--home', home]);
    assert.equal(r.status, 0);
    const list = JSON.parse(r.stdout.trim());
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((x) => x.id).sort(), ['claude-code', 'claude-desktop', 'codex', 'cursor', 'vscode']);
    for (const item of list) {
      assert.equal(typeof item.label, 'string');
      assert.ok(['json', 'toml', 'cli'].includes(item.kind));
      assert.equal(typeof item.configured, 'boolean');
      assert.ok(item.path.startsWith(home), `路径应在临时 home 下: ${item.path}`);
    }
    assert.equal(list.find((x) => x.id === 'claude-desktop').kind, 'json');
    assert.equal(list.find((x) => x.id === 'vscode').kind, 'json');
    assert.equal(list.find((x) => x.id === 'codex').kind, 'toml');
    const cc = list.find((x) => x.id === 'claude-code');
    assert.equal(cc.kind, 'cli');
    assert.match(cc.cliCommand, /^claude mcp add chronicle -- /);
    assert.ok(cc.cliCommand.includes(NODE_CMD), 'cli 命令应使用 node 绝对路径');
    assert.deepEqual(readdirSync(home), before, '--list 不得创建任何文件/目录');
  });

  test('dry-run（默认与显式）：零写入、无备份、不创建客户端目录', () => {
    const home = tmpHome();
    const file = claudeDesktopPath(home);
    const original = `${JSON.stringify({ mcpServers: { other: { command: 'other-cmd' } }, theme: 'dark' }, null, 2)}\n`;
    writeFileMk(file, original);

    const r1 = run(['--target', 'claude-desktop', '--home', home]);
    assert.equal(r1.status, 0);
    assert.equal(r1.json.mode, 'dry-run');
    assert.equal(r1.json.results[0].status, 'planned');
    assert.equal(r1.json.results[0].wrote, false);
    assert.equal(readFileSync(file, 'utf8'), original, 'dry-run 不得改文件');
    assert.equal(countBackups(path.dirname(file)), 0, 'dry-run 不得备份');

    const r2 = run(['--target', 'claude-desktop', '--home', home, '--dry-run', '--yes']);
    assert.equal(r2.status, 0, '显式 --dry-run 应优先于 --yes');
    assert.equal(r2.json.mode, 'dry-run');
    assert.equal(readFileSync(file, 'utf8'), original);

    // 客户端目录不存在时：dry-run / --yes 都只跳过，不替用户创建目录
    const fresh = tmpHome();
    const r3 = run(['--target', 'claude-desktop', '--home', fresh]);
    assert.equal(r3.status, 0);
    assert.equal(r3.json.results[0].status, 'skipped-client-missing');
    assert.equal(existsSync(path.dirname(claudeDesktopPath(fresh))), false, '不得创建客户端目录');
  });

  test('--yes：merge 保留其他条目 + 备份=原文件 + 回读正确', () => {
    const home = tmpHome();
    const file = claudeDesktopPath(home);
    const originalObj = {
      theme: 'dark',
      mcpServers: { other: { command: 'other-cmd', args: ['--x'], env: { A: '1' } } },
      extra: { nested: [1, 2, 3] },
    };
    const original = `${JSON.stringify(originalObj, null, 2)}\n`;
    writeFileMk(file, original);

    const r = run(['--target', 'claude-desktop', '--yes', '--home', home]);
    assert.equal(r.status, 0);
    const after = readJsonFile(file);
    assert.deepEqual(after.mcpServers.chronicle, { command: NODE_CMD, args: [MCP_ENTRY] });
    assert.deepEqual(after.mcpServers.other, originalObj.mcpServers.other, '其他 MCP 条目必须保留');
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.extra, originalObj.extra, '其他顶层键必须保留');

    const result = r.json.results[0];
    assert.equal(result.status, 'written');
    assert.equal(result.wrote, true);
    assert.ok(result.backup && result.backup.includes('.chronicle-backup-'), '写前必须备份');
    assert.equal(readFileSync(result.backup, 'utf8'), original, '备份内容应等于原文件');
  });

  test('幂等：重复 --yes 不重复写、不新增备份', () => {
    const home = tmpHome();
    const file = cursorPath(home);
    writeFileMk(file, `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`);

    const r1 = run(['--target', 'cursor', '--yes', '--home', home]);
    assert.equal(r1.status, 0);
    assert.equal(r1.json.results[0].status, 'written');
    const afterFirst = readFileSync(file, 'utf8');
    const backupsAfterFirst = countBackups(path.dirname(file));
    assert.equal(backupsAfterFirst, 1);

    const r2 = run(['--target', 'cursor', '--yes', '--home', home]);
    assert.equal(r2.status, 0);
    assert.equal(r2.json.results[0].status, 'already-configured');
    assert.equal(r2.json.results[0].wrote, false);
    assert.equal(readFileSync(file, 'utf8'), afterFirst, '幂等执行不得改动文件');
    assert.equal(countBackups(path.dirname(file)), backupsAfterFirst, '幂等执行不应新增备份');
  });

  test('损坏 JSON：不覆盖、备份存在、退出码 1、输出不泄露内容', () => {
    const home = tmpHome();
    const file = cursorPath(home);
    const sentinel = 'TOP-SECRET-SENTINEL-DO-NOT-LEAK-42';
    const corrupt = `{ "${sentinel}": this-is-not-json,`;
    writeFileMk(file, corrupt);

    const r = run(['--target', 'cursor', '--yes', '--home', home]);
    assert.equal(r.status, 1, '损坏 JSON 应失败（退出码 1）');
    assert.equal(readFileSync(file, 'utf8'), corrupt, '损坏 JSON 必须保持原样');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.results[0].status, 'failed');
    const backups = readdirSync(path.dirname(file)).filter((f) => f.includes('.chronicle-backup-'));
    assert.equal(backups.length, 1, '损坏文件应备份');
    assert.equal(readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), corrupt);
    assert.ok(!r.stdout.includes(sentinel), 'stdout 不得泄露配置内容');
    assert.ok(!r.stderr.includes(sentinel), 'stderr 不得泄露配置内容');
  });

  test('codex TOML：追加不重复、原内容保留、结构正确、备份存在', () => {
    const home = tmpHome();
    const codexHome = path.join(home, 'codex-home');
    const file = codexPath(codexHome);
    const original = 'model = "gpt-5-codex"\napproval_policy = "on-request"\n\n[features]\nweb_search = true\n';
    writeFileMk(file, original);

    const r = run(['--target', 'codex', '--yes', '--home', home, '--codex-home', codexHome]);
    assert.equal(r.status, 0);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(original), '原有 TOML 内容必须保留');
    assert.ok(text.includes(`[mcp_servers.chronicle]\ncommand = ${JSON.stringify(NODE_CMD)}\n`), '应追加 command（绝对 node 路径）');
    assert.ok(text.includes(`args = ["${MCP_ENTRY}"]`), '应追加绝对路径 args');
    assert.equal((text.match(/^\[mcp_servers\.chronicle\]$/gm) ?? []).length, 1, 'section 不得重复');
    const result = r.json.results[0];
    assert.equal(result.status, 'written');
    assert.ok(result.backup && result.backup.includes('.chronicle-backup-'));
    assert.equal(readFileSync(result.backup, 'utf8'), original);

    // 二次执行：只报告不重复写
    const r2 = run(['--target', 'codex', '--yes', '--home', home, '--codex-home', codexHome]);
    assert.equal(r2.status, 0);
    assert.equal(r2.json.results[0].status, 'already-configured');
    assert.equal(readFileSync(file, 'utf8'), text, '不得重复追加');
    assert.equal((readFileSync(file, 'utf8').match(/^\[mcp_servers\.chronicle\]$/gm) ?? []).length, 1);
  });

  test('codex TOML：已存在 chronicle section 时只报告不重复写', () => {
    const home = tmpHome();
    const codexHome = path.join(home, 'codex-home');
    const file = codexPath(codexHome);
    const original = '[mcp_servers.chronicle]\ncommand = "node"\nargs = ["/old/path/mcp-entry.mjs"]\n';
    writeFileMk(file, original);
    const r = run(['--target', 'codex', '--yes', '--home', home, '--codex-home', codexHome]);
    assert.equal(r.status, 0);
    assert.equal(r.json.results[0].status, 'already-configured');
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(countBackups(codexHome), 0, '无需动作时不应备份');
  });

  test('codex TOML：现有结构自检失败时拒绝追加且不破坏原文件', () => {
    const home = tmpHome();
    const codexHome = path.join(home, 'codex-home');
    const file = codexPath(codexHome);
    const broken = 'model = "unclosed-quote\n[features]\n';
    writeFileMk(file, broken);
    const r = run(['--target', 'codex', '--yes', '--home', home, '--codex-home', codexHome]);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(file, 'utf8'), broken, '坏 TOML 不得被追加/覆盖');
    assert.equal(r.json.results[0].status, 'failed');
    assert.ok(countBackups(codexHome) >= 1, '应备份后再报错');
  });

  test('vscode 形态：servers.chronicle + type="stdio"', () => {
    const home = tmpHome();
    const file = vscodePath(home);
    writeFileMk(file, `${JSON.stringify({ servers: { other: { type: 'stdio', command: 'x', args: [] } } }, null, 2)}\n`);
    const r = run(['--target', 'vscode', '--yes', '--home', home]);
    assert.equal(r.status, 0);
    const after = readJsonFile(file);
    assert.deepEqual(after.servers.chronicle, { type: 'stdio', command: NODE_CMD, args: [MCP_ENTRY] });
    assert.deepEqual(after.servers.other, { type: 'stdio', command: 'x', args: [] });
  });

  test('claude-code：无 .claude.json 时只输出 CLI 命令；存在时同时 merge', () => {
    // 场景 A：没有 ~/.claude.json → 不创建文件，只给命令
    const homeA = tmpHome();
    const rA = run(['--target', 'claude-code', '--yes', '--home', homeA]);
    assert.equal(rA.status, 0);
    assert.equal(rA.json.results[0].status, 'cli-only');
    assert.equal(existsSync(claudeCodePath(homeA)), false, '不得擅自创建 ~/.claude.json');
    assert.match(rA.json.results[0].cliCommand, /^claude mcp add chronicle -- /);
    assert.ok(rA.json.results[0].cliCommand.includes(NODE_CMD));
    assert.ok(rA.stdout.includes('claude mcp add chronicle -- '));

    // 场景 B：已有 ~/.claude.json → JSON merge + 备份
    const homeB = tmpHome();
    const file = claudeCodePath(homeB);
    writeFileMk(file, `${JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2)}\n`);
    const rB = run(['--target', 'claude-code', '--yes', '--home', homeB]);
    assert.equal(rB.status, 0);
    const after = readJsonFile(file);
    assert.deepEqual(after.mcpServers.chronicle, { command: NODE_CMD, args: [MCP_ENTRY] });
    assert.deepEqual(after.mcpServers.other, { command: 'x' });
    assert.equal(after.theme, 'dark');
    assert.ok(rB.json.results[0].backup);
    assert.ok(rB.json.results[0].cliCommand, '始终附带 CLI 命令');
  });

  test('未知 target / 未知参数 → 退出码 2', () => {
    const home = tmpHome();
    const bad = run(['--target', 'slack', '--home', home]);
    assert.equal(bad.status, 2);
    const badFlag = run(['--bogus']);
    assert.equal(badFlag.status, 2);
    const missingValue = run(['--target']);
    assert.equal(missingValue.status, 2);
  });

  test('输出模式：--json 只输出 JSON 一行；默认模式最后一行是 JSON', () => {
    const home = tmpHome();
    mkdirSync(path.dirname(cursorPath(home)), { recursive: true });
    const rJson = run(['--target', 'cursor', '--json', '--home', home]);
    assert.equal(rJson.status, 0);
    assert.equal(rJson.lines.length, 1, '--json 只应输出一行');
    const payload = JSON.parse(rJson.lines[0]);
    assert.equal(payload.ok, true);

    const rDefault = run(['--target', 'cursor', '--home', home]);
    assert.equal(rDefault.status, 0);
    assert.ok(rDefault.lines.length > 1, '默认模式应有人读摘要');
    assert.ok(rDefault.stdout.includes('AI 工具接入'));
    const last = JSON.parse(rDefault.lines[rDefault.lines.length - 1]);
    assert.equal(last.ok, true);
  });

  test('空 JSON 文件视为全新配置；写入保留原文件权限位', () => {
    const home = tmpHome();
    const file = cursorPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    chmodSync(file, 0o640);

    const r = run(['--target', 'cursor', '--yes', '--home', home]);
    assert.equal(r.status, 0);
    assert.equal(r.json.results[0].status, 'written');
    assert.deepEqual(readJsonFile(file).mcpServers.chronicle, { command: NODE_CMD, args: [MCP_ENTRY] });
    assert.equal(statSync(file).mode & 0o777, 0o640, '写入应保留原文件权限位');
    const backups = readdirSync(path.dirname(file)).filter((f) => f.includes('.chronicle-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), '', '空文件备份也应为空');
  });

  test('符号链接/非普通文件：拒绝写入，原目标不变', () => {
    const home = tmpHome();
    mkdirSync(path.dirname(cursorPath(home)), { recursive: true });
    const target = path.join(home, 'real-config.json');
    writeFileMk(target, '{"mcpServers":{}}\n');
    symlinkSync(target, cursorPath(home));

    const r = run(['--target', 'cursor', '--yes', '--home', home]);
    assert.equal(r.status, 1);
    assert.equal(r.json.results[0].status, 'failed');
    assert.ok(lstatSync(cursorPath(home)).isSymbolicLink(), '符号链接应保持原样');
    assert.equal(readFileSync(target, 'utf8'), '{"mcpServers":{}}\n', '链接目标不得被改动');

    // 目录占位（非普通文件）同样拒绝
    const home2 = tmpHome();
    mkdirSync(cursorPath(home2), { recursive: true });
    const r2 = run(['--target', 'cursor', '--yes', '--home', home2]);
    assert.equal(r2.status, 1);
    assert.equal(r2.json.results[0].status, 'failed');
  });

  test('--target all：五个目标全部处理、退出码 0、不泄露其他配置内容', () => {
    const home = tmpHome();
    const codexHome = prepareClients(home);
    const sentinel = 'OTHER-CONFIG-SENTINEL-9F3';
    writeFileMk(claudeCodePath(home), `${JSON.stringify({ theme: 'dark', mcpServers: { other: { command: sentinel } } }, null, 2)}\n`);
    writeFileMk(claudeDesktopPath(home), `${JSON.stringify({ mcpServers: { other: { command: sentinel } } }, null, 2)}\n`);
    writeFileMk(vscodePath(home), `${JSON.stringify({ servers: { other: { type: 'stdio', command: sentinel, args: [] } } }, null, 2)}\n`);
    writeFileMk(codexPath(codexHome), `model = "x"\n[mcp_servers.other]\ncommand = "${sentinel}"\n`);

    const r = run(['--target', 'all', '--yes', '--home', home, '--codex-home', codexHome]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.json.results.map((x) => x.id).sort(), ['claude-code', 'claude-desktop', 'codex', 'cursor', 'vscode']);
    assert.ok(r.json.results.every((x) => ['written', 'already-configured', 'cli-only'].includes(x.status)), JSON.stringify(r.json.results));
    assert.equal(r.json.errors.length, 0);

    // 各配置均正确、其他条目保留
    assert.deepEqual(readJsonFile(claudeCodePath(home)).mcpServers.chronicle, { command: NODE_CMD, args: [MCP_ENTRY] });
    assert.deepEqual(readJsonFile(claudeDesktopPath(home)).mcpServers.chronicle, { command: NODE_CMD, args: [MCP_ENTRY] });
    assert.deepEqual(readJsonFile(cursorPath(home)).mcpServers.chronicle, { command: NODE_CMD, args: [MCP_ENTRY] });
    assert.deepEqual(readJsonFile(vscodePath(home)).servers.chronicle, { type: 'stdio', command: NODE_CMD, args: [MCP_ENTRY] });
    const toml = readFileSync(codexPath(codexHome), 'utf8');
    assert.ok(toml.includes('[mcp_servers.chronicle]'));
    assert.ok(toml.includes('[mcp_servers.other]'), '原有 codex section 必须保留');
    assert.ok(!r.stdout.includes(sentinel), 'stdout 不得泄露其他配置内容');
    assert.ok(!r.stderr.includes(sentinel), 'stderr 不得泄露其他配置内容');
  });
});
