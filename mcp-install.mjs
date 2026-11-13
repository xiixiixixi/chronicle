#!/usr/bin/env node
// mcp-install.mjs — 把 Chronicle 的 MCP 服务一键接入各种 AI 工具（零依赖，Node 18+）
//
// 用法：
//   node mcp-install.mjs --print
//       输出**单行 JSON**（菜单栏/脚本直接复制到剪贴板）：
//       {"mcpServers":{"chronicle":{"command":"<node 绝对路径>","args":["<绝对路径 mcp-entry.mjs>"]}}}
//   node mcp-install.mjs --list
//       输出 JSON 数组：每个客户端 {id,label,kind,path,configured,...}（kind = json|toml|cli）
//   node mcp-install.mjs --target <claude-code|claude-desktop|cursor|codex|vscode|all> [--yes]
//       默认 dry-run：只打印将要做的事，**不写盘**；加 --yes 才真正写入。
//         --dry-run       显式 dry-run（与默认相同；显式给出时即便同时有 --yes 也不写）
//         --home <dir>    覆盖用户目录（测试/隔离用）
//         --codex-home <dir>  覆盖 Codex 配置目录（默认 <home>/.codex）
//         --json          只输出 JSON 一行（默认：人读摘要 + 末尾一行 JSON）
//
// 各目标（写前备份 <path>.chronicle-backup-<UTC 时间戳>，写后回读校验；失败恢复备份）：
//   claude-code     kind=cli   输出 `claude mcp add chronicle -- <abs node> <abs mcp-entry>`；
//                              若 <home>/.claude.json 存在，同时 merge 其 mcpServers.chronicle
//   claude-desktop  kind=json  <home>/Library/Application Support/Claude/claude_desktop_config.json → mcpServers.chronicle
//   cursor          kind=json  <home>/.cursor/mcp.json → mcpServers.chronicle
//   codex           kind=toml  <codex-home>/config.toml → 追加 [mcp_servers.chronicle]（已存在则只报告不重复写）
//   vscode          kind=json  <home>/Library/Application Support/Code/User/mcp.json → servers.chronicle（含 type:"stdio"）
//
// 安全约束（不可退让）：
//   - 只增删改 chronicle 这一个条目，其余配置语义上原样保留（JSON merge；TOML 仅追加 section）
//   - 损坏 JSON 绝不覆盖：备份后报错（原文件保持原样）
//   - 符号链接/非普通文件拒绝写入
//   - 绝不打印或写入任何隐私配置内容（只输出路径/状态；解析错误不附带原文片段）
//   - 客户端目录不存在时跳过（不替用户创建客户端目录）
//
// 退出码：0=全部成功/无需动作；1=有目标失败；2=参数/目标非法。
// 本文件不依赖第三方包，也不读取 ~/.chronicle 的任何隐私数据。

import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------- 常量与入口 ----------

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
/** MCP 入口的绝对路径（不解析软链，避免把仓库路径写歪）。 */
export const MCP_ENTRY_PATH = path.join(REPO_ROOT, 'mcp-entry.mjs');
/**
 * 写进客户端配置的 node 可执行文件路径：默认用当前 node 的绝对路径。
 * GUI 客户端（Claude Desktop 等）启动 MCP 子进程时 PATH 常不含 /opt/homebrew/bin，
 * 只写 `node` 会找不到解释器；绝对路径更可靠（重装/升级 node 后重跑一次 mcp-install 即可）。
 * 可用 CHRONICLE_NODE_PATH 覆盖（测试/特殊环境）。
 */
export const NODE_CMD = process.env.CHRONICLE_NODE_PATH || process.execPath || 'node';
export const SERVER_NAME = 'chronicle';
export const CLI_BIN = 'claude';
export const TARGET_IDS = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'vscode'];


/** `--print` 的严格契约：单行 JSON，供菜单栏「AI 工具接入…」等直接复制。 */
export function printPayload() {
  return { mcpServers: { [SERVER_NAME]: serverEntry() } };
}

/** JSON 客户端（Claude Desktop / Cursor / claude-code 的 .claude.json）使用的条目。 */
export function serverEntry() {
  return { command: NODE_CMD, args: [MCP_ENTRY_PATH] };
}

/** VS Code 的 mcp.json 需要 type: "stdio"。 */
export function vscodeEntry() {
  return { type: 'stdio', command: NODE_CMD, args: [MCP_ENTRY_PATH] };
}

/** Claude Code CLI 接入命令（路径含空格时自动加双引号）。 */
export function cliCommand() {
  return `${CLI_BIN} mcp add ${SERVER_NAME} -- ${shellQuote(NODE_CMD)} ${shellQuote(MCP_ENTRY_PATH)}`;
}

function shellQuote(s) {
  const str = String(s ?? '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(str)) return str;
  return `"${str.replace(/(["\\$`])/g, '\\$1')}"`;
}

// ---------- 目标解析 ----------

/**
 * 解析各客户端配置位置（纯函数，便于测试/--home 隔离）。
 * @param {{home?: string, codexHome?: string|null}} [opts]
 */
export function resolveTargets({ home = os.homedir(), codexHome = null } = {}) {
  const userHome = path.resolve(home);
  const codexDir = path.resolve(codexHome ?? path.join(userHome, '.codex'));
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'cli',
      path: path.join(userHome, '.claude.json'),
      container: 'mcpServers',
      entry: serverEntry,
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      kind: 'json',
      path: path.join(userHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      container: 'mcpServers',
      entry: serverEntry,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'json',
      path: path.join(userHome, '.cursor', 'mcp.json'),
      container: 'mcpServers',
      entry: serverEntry,
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      kind: 'toml',
      path: path.join(codexDir, 'config.toml'),
      container: null,
      entry: serverEntry,
    },
    {
      id: 'vscode',
      label: 'VS Code',
      kind: 'json',
      path: path.join(userHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      container: 'servers',
      entry: vscodeEntry,
    },
  ];
}

/** 按 --target 选择目标；'all' 返回全部。非法 target 抛 UsageError(code=2)。 */
export function selectTargets(allTargets, target) {
  if (target === 'all') return allTargets;
  if (!TARGET_IDS.includes(target)) {
    throw new UsageError(`未知目标: ${target}（可选：${[...TARGET_IDS, 'all'].join('|')}）`);
  }
  const found = allTargets.find((t) => t.id === target);
  if (!found) throw new UsageError(`未知目标: ${target}`);
  return [found];
}

// ---------- 共用小工具 ----------

function plainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!plainObject(a) || !plainObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function lstatSafe(file) {
  try { return lstatSync(file); } catch { return null; }
}

/** 文件是否可安全写入：不存在 = true（将在父目录已存在时新建）；存在则必须是普通文件。 */
function assertWritableTarget(file) {
  const st = lstatSafe(file);
  if (!st) return { ok: true, exists: false };
  if (st.isSymbolicLink()) return { ok: false, exists: true, reason: '配置文件是符号链接，拒绝写入（未改动）' };
  if (!st.isFile()) return { ok: false, exists: true, reason: '目标不是普通文件，拒绝写入（未改动）' };
  return { ok: true, exists: true };
}

function parentExists(file) {
  try { return lstatSync(path.dirname(file)).isDirectory(); } catch { return false; }
}

/** XML/TOML 无关的纯文本备份（不打印内容；文件不存在返回 null）。 */
export function backupFile(file) {
  if (!existsSync(file)) return null;
  const stamp = utcStamp();
  let backup = `${file}.${BACKUP_SUFFIX}-${stamp}`;
  let i = 1;
  while (existsSync(backup)) backup = `${file}.${BACKUP_SUFFIX}-${stamp}-${i++}`;
  copyFileSync(file, backup);
  try { chmodSync(backup, 0o600); } catch { /* 权限收紧失败不致命 */ }
  return backup;
}

const BACKUP_SUFFIX = 'chronicle-backup';

function utcStamp() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

/** 原子写：同目录临时文件 + rename（避免写一半留下坏配置）；保留原文件权限位。 */
function writeFileAtomic(file, content, mode = null) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.chronicle-tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, content, { encoding: 'utf8', mode: mode ?? 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能已不存在 */ }
    throw err;
  }
  if (mode !== null) { try { chmodSync(file, mode); } catch { /* 权限位设置失败不致命 */ } }
}

/** 读取现有文件权限位（不存在/不可 stat 返回 null）。 */
function fileMode(file) {
  const st = lstatSafe(file);
  return st && st.isFile() ? (st.mode & 0o777) : null;
}

// ---------- JSON 目标 ----------

/**
 * 只读检测某 JSON 目标当前是否已配置 chronicle（不抛异常；坏文件视为未配置）。
 * @returns {{configured:boolean, readable:boolean, pathExists:boolean}}
 */
function inspectJson(spec) {
  const st = lstatSafe(spec.path);
  if (!st || !st.isFile()) return { configured: false, readable: false, pathExists: Boolean(st) };
  try {
    const obj = JSON.parse(readFileSync(spec.path, 'utf8').replace(/^\uFEFF/, ''));
    const entry = plainObject(obj) && plainObject(obj[spec.container]) ? obj[spec.container][SERVER_NAME] : undefined;
    return { configured: entry !== undefined, readable: true, pathExists: true };
  } catch {
    return { configured: false, readable: false, pathExists: true };
  }
}

/**
 * 应用一个 JSON 目标（claude-code / claude-desktop / cursor / vscode）。
 * @returns {{status:string, backup?:string|null, wrote:boolean, message?:string, cliCommand?:string}}
 */
function applyJsonTarget(spec, { dryRun = true } = {}) {
  const expected = spec.entry();
  const cli = spec.kind === 'cli' ? { cliCommand: cliCommand() } : {};

  const writable = assertWritableTarget(spec.path);
  if (!writable.ok) return { status: 'failed', wrote: false, message: writable.reason, ...cli };
  if (!writable.exists && !parentExists(spec.path)) {
    // 客户端目录不存在：不替用户创建；claude-code 仍可输出 CLI 命令。
    return { status: 'skipped-client-missing', wrote: false, message: '客户端目录不存在（跳过；请先安装并启动该工具）', ...cli };
  }

  let beforeText = '';
  let before = {};
  if (writable.exists) {
    try {
      beforeText = readFileSync(spec.path, 'utf8');
    } catch {
      return { status: 'failed', wrote: false, message: '读取配置失败（未改动）', ...cli };
    }
    const stripped = beforeText.replace(/^\uFEFF/, '').trim();
    if (stripped === '') {
      before = {}; // 空文件视为全新配置（不是损坏）
    } else {
      try {
        before = JSON.parse(stripped);
      } catch {
        const backup = backupFile(spec.path);
        return { status: 'failed', wrote: false, backup, message: '配置不是合法 JSON（已备份，未覆盖原文件）', ...cli };
      }
    }
    if (!plainObject(before)) {
      const backup = backupFile(spec.path);
      return { status: 'failed', wrote: false, backup, message: '配置文件顶层不是 JSON 对象（已备份，未改动）', ...cli };
    }
    if (before[spec.container] !== undefined && !plainObject(before[spec.container])) {
      const backup = backupFile(spec.path);
      return { status: 'failed', wrote: false, backup, message: `已有 "${spec.container}" 不是对象（已备份，未改动）`, ...cli };
    }
    const current = before[spec.container]?.[SERVER_NAME];
    if (deepEqual(current, expected)) {
      return { status: 'already-configured', wrote: false, ...cli };
    }
  } else if (spec.kind === 'cli') {
    // 没有 ~/.claude.json：只给 CLI 命令，不创建文件。
    return { status: 'cli-only', wrote: false, ...cli };
  }

  const after = {
    ...before,
    [spec.container]: { ...(plainObject(before[spec.container]) ? before[spec.container] : {}), [SERVER_NAME]: expected },
  };
  if (dryRun) {
    return { status: 'planned', wrote: false, message: `计划 merge ${spec.container}.${SERVER_NAME}`, ...cli };
  }

  const backup = writable.exists ? backupFile(spec.path) : null;
  let wrote = false;
  try {
    writeFileAtomic(spec.path, `${JSON.stringify(after, null, 2)}\n`, fileMode(spec.path));
    wrote = true;
    // 回读校验：条目正确 + 其他配置语义未变
    const readBack = JSON.parse(readFileSync(spec.path, 'utf8').replace(/^\uFEFF/, ''));
    if (!deepEqual(readBack?.[spec.container]?.[SERVER_NAME], expected)) {
      throw new Error(`回读校验失败：${spec.container}.${SERVER_NAME} 与预期不一致`);
    }
    // 其他 mcpServers/servers 条目必须原样保留
    const beforeContainer = plainObject(before[spec.container]) ? before[spec.container] : {};
    const afterContainer = plainObject(readBack[spec.container]) ? readBack[spec.container] : {};
    for (const key of Object.keys(beforeContainer)) {
      if (key === SERVER_NAME) continue;
      if (!deepEqual(beforeContainer[key], afterContainer[key])) {
        throw new Error(`回读校验失败：原有条目 ${key} 被改动`);
      }
    }
    // 其他顶层键必须原样保留
    for (const key of Object.keys(before)) {
      if (key === spec.container) continue;
      if (!deepEqual(before[key], readBack[key])) throw new Error(`回读校验失败：顶层键 ${key} 被改动`);
    }
  } catch (err) {
    // 失败恢复备份；没有备份（原本不存在）则删除写坏的新文件
    try {
      if (backup) writeFileAtomic(spec.path, beforeText, fileMode(spec.path));
      else if (existsSync(spec.path)) unlinkSync(spec.path);
    } catch { /* 恢复失败时下方报告仍会带备份路径 */ }
    return { status: 'failed', wrote: false, backup, message: `写入失败，已恢复原配置：${sanitizeMessage(err)}`, ...cli };
  }
  return { status: 'written', wrote, backup, ...cli };
}

// ---------- TOML 目标（codex） ----------

const CODEX_SECTION_RE = /^[ \t]*\[\[?[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"chronicle"|'chronicle'|chronicle)[ \t]*\]\]?[ \t]*(?:#.*)?$/m;

/**
 * 轻量 TOML 结构自检（不引第三方 parser）：拒绝 NUL、未闭合字符串、括号不平衡。
 * 目的只是确保「追加一个 section」不会破坏现有文件的整体结构；不是完整 TOML 解析。
 * @returns {{ok:boolean, reason?:string}}
 */
export function scanTomlStructure(text) {
  const s = String(text ?? '');
  if (s.includes('\u0000')) return { ok: false, reason: '含 NUL 字节' };
  let mode = 'normal'; // normal | basic | literal | mlbasic | mlliteral | comment
  let square = 0;
  let brace = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (mode === 'comment') {
      if (ch === '\n') mode = 'normal';
      i += 1;
      continue;
    }
    if (mode === 'basic') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') mode = 'normal';
      i += 1;
      continue;
    }
    if (mode === 'literal') {
      if (ch === "'") mode = 'normal';
      i += 1;
      continue;
    }
    if (mode === 'mlbasic') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"' && s[i + 1] === '"' && s[i + 2] === '"') { mode = 'normal'; i += 3; continue; }
      i += 1;
      continue;
    }
    if (mode === 'mlliteral') {
      if (ch === "'" && s[i + 1] === "'" && s[i + 2] === "'") { mode = 'normal'; i += 3; continue; }
      i += 1;
      continue;
    }
    // normal
    if (ch === '#') { mode = 'comment'; i += 1; continue; }
    if (ch === '"' && s[i + 1] === '"' && s[i + 2] === '"') { mode = 'mlbasic'; i += 3; continue; }
    if (ch === "'" && s[i + 1] === "'" && s[i + 2] === "'") { mode = 'mlliteral'; i += 3; continue; }
    if (ch === '"') { mode = 'basic'; i += 1; continue; }
    if (ch === "'") { mode = 'literal'; i += 1; continue; }
    if (ch === '[') { square += 1; i += 1; continue; }
    if (ch === ']') { square -= 1; if (square < 0) return { ok: false, reason: '方括号不匹配' }; i += 1; continue; }
    if (ch === '{') { brace += 1; i += 1; continue; }
    if (ch === '}') { brace -= 1; if (brace < 0) return { ok: false, reason: '花括号不匹配' }; i += 1; continue; }
    i += 1;
  }
  if (mode === 'basic' || mode === 'literal' || mode === 'mlbasic' || mode === 'mlliteral') {
    return { ok: false, reason: '字符串未闭合' };
  }
  if (square !== 0) return { ok: false, reason: '方括号不平衡' };
  if (brace !== 0) return { ok: false, reason: '花括号不平衡' };
  return { ok: true };
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** codex 的 TOML 追加块（section 名固定 mcp_servers.chronicle）。 */
export function codexTomlBlock() {
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(NODE_CMD)}\nargs = [${tomlString(MCP_ENTRY_PATH)}]\n`;
}

function inspectToml(spec) {
  const st = lstatSafe(spec.path);
  if (!st || !st.isFile()) return { configured: false, readable: false, pathExists: Boolean(st) };
  try {
    const text = readFileSync(spec.path, 'utf8');
    return { configured: CODEX_SECTION_RE.test(text), readable: true, pathExists: true };
  } catch {
    return { configured: false, readable: false, pathExists: true };
  }
}

function applyTomlTarget(spec, { dryRun = true } = {}) {
  const writable = assertWritableTarget(spec.path);
  if (!writable.ok) return { status: 'failed', wrote: false, message: writable.reason };
  if (!writable.exists && !parentExists(spec.path)) {
    return { status: 'skipped-client-missing', wrote: false, message: '客户端目录不存在（跳过；请先安装并启动 Codex）' };
  }

  let beforeText = '';
  if (writable.exists) {
    try { beforeText = readFileSync(spec.path, 'utf8'); } catch {
      return { status: 'failed', wrote: false, message: '读取配置失败（未改动）' };
    }
    if (CODEX_SECTION_RE.test(beforeText)) {
      return { status: 'already-configured', wrote: false, message: '[mcp_servers.chronicle] 已存在，未重复写入' };
    }
    const scanBefore = scanTomlStructure(beforeText);
    if (!scanBefore.ok) {
      const backup = backupFile(spec.path);
      return { status: 'failed', wrote: false, backup, message: `现有 TOML 结构自检失败（${scanBefore.reason}），已备份，未追加` };
    }
  }

  const block = codexTomlBlock();
  const base = beforeText ? (beforeText.endsWith('\n') ? beforeText : `${beforeText}\n`) : '';
  const afterText = `${base}${base && !base.endsWith('\n\n') ? '\n' : ''}${block}`;
  const scanAfter = scanTomlStructure(afterText);
  if (!scanAfter.ok) {
    return { status: 'failed', wrote: false, message: `追加后 TOML 自检失败（${scanAfter.reason}），未写入` };
  }
  if (dryRun) return { status: 'planned', wrote: false, message: '计划追加 [mcp_servers.chronicle]' };

  const backup = writable.exists ? backupFile(spec.path) : null;
  try {
    writeFileAtomic(spec.path, afterText, fileMode(spec.path));
    const readBack = readFileSync(spec.path, 'utf8');
    if (!readBack.includes(block)) throw new Error('回读校验失败：追加块缺失');
    const headers = readBack.match(new RegExp(CODEX_SECTION_RE.source, 'gm')) ?? [];
    if (headers.length !== 1) throw new Error('回读校验失败：mcp_servers.chronicle section 数量不为 1');
    if (!scanTomlStructure(readBack).ok) throw new Error('回读校验失败：TOML 结构自检未通过');
    if (!writable.exists && existsSync(spec.path)) { /* 新建文件无需备份 */ }
  } catch (err) {
    try {
      if (backup) writeFileAtomic(spec.path, beforeText, fileMode(spec.path));
      else if (existsSync(spec.path)) unlinkSync(spec.path);
    } catch { /* 恢复失败仍报告备份路径 */ }
    return { status: 'failed', wrote: false, backup, message: `写入失败，已恢复原配置：${sanitizeMessage(err)}` };
  }
  return { status: 'written', wrote: true, backup };
}

// ---------- 列表 / 主流程 ----------

/** `--list`：支持的客户端 + 当前是否已配置（不写盘、不抛异常）。 */
export function listTargets({ home = os.homedir(), codexHome = null } = {}) {
  return resolveTargets({ home, codexHome }).map((spec) => {
    const inspect = spec.kind === 'toml' ? inspectToml(spec) : inspectJson(spec);
    return {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      path: spec.path,
      configured: inspect.configured,
      ...(spec.kind === 'cli' ? { cliCommand: cliCommand() } : {}),
    };
  });
}

/**
 * 执行接入（dry-run 或写入）。
 * @param {{home?:string, codexHome?:string|null, target?:string, dryRun?:boolean, yes?:boolean}} opts
 * @returns {{ok:boolean, mode:'dry-run'|'write', target:string, home:string, codexHome:string|null,
 *            mcpEntry:string, results:Array, errors:Array}}
 */
export function runInstall(opts = {}) {
  const home = path.resolve(opts.home ?? os.homedir());
  const codexHome = opts.codexHome ? path.resolve(opts.codexHome) : null;
  const dryRun = opts.dryRun !== undefined ? Boolean(opts.dryRun) : !opts.yes;
  const target = String(opts.target ?? '');
  const all = resolveTargets({ home, codexHome });
  const selected = selectTargets(all, target);

  const results = [];
  const errors = [];
  for (const spec of selected) {
    let r;
    try {
      r = spec.kind === 'toml' ? applyTomlTarget(spec, { dryRun }) : applyJsonTarget(spec, { dryRun });
    } catch (err) {
      r = { status: 'failed', wrote: false, message: `内部错误：${sanitizeMessage(err)}` };
    }
    const result = {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      path: spec.path,
      status: r.status,
      wrote: r.wrote === true,
      ...(r.backup ? { backup: r.backup } : {}),
      ...(r.message ? { message: r.message } : {}),
      ...(r.cliCommand ? { cliCommand: r.cliCommand } : {}),
    };
    results.push(result);
    if (r.status === 'failed') errors.push({ id: spec.id, message: r.message ?? '未知错误' });
  }
  return {
    ok: errors.length === 0,
    mode: dryRun ? 'dry-run' : 'write',
    target,
    home,
    codexHome,
    mcpEntry: MCP_ENTRY_PATH,
    results,
    errors,
  };
}

// ---------- 参数解析 ----------

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.exitCode = 2; }
}

export const USAGE = `用法：
  node mcp-install.mjs --print
  node mcp-install.mjs --list
  node mcp-install.mjs --target <${TARGET_IDS.join('|')}|all> [--yes] [--json]
                        [--dry-run] [--home DIR] [--codex-home DIR]

  --print         输出单行 JSON 配置（供菜单栏/脚本复制）
  --list          输出 JSON 数组（支持的客户端与当前是否已配置）
  --target        要接入的客户端；all = 全部
  --yes           真正写入（默认 dry-run，只打印计划）
  --dry-run       显式 dry-run（优先于 --yes）
  --json          只输出 JSON 一行（默认：人读摘要 + 末尾一行 JSON）
  --home DIR      覆盖用户目录（测试/隔离用）
  --codex-home DIR 覆盖 Codex 配置目录（默认 <home>/.codex）
  -h, --help      显示帮助`;

/** 解析 argv；非法参数/目标抛 UsageError（退出码 2）。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    mode: 'install',
    target: null,
    yes: false,
    dryRun: undefined,
    explicitDryRun: false,
    json: false,
    home: null,
    codexHome: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const next = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`缺少参数值: ${key}`);
      return String(v);
    };
    switch (key) {
      case '--print': out.mode = 'print'; break;
      case '--list': out.mode = 'list'; break;
      case '--target': out.target = next(); break;
      case '--yes': out.yes = true; break;
      case '--dry-run': out.explicitDryRun = true; out.dryRun = true; break;
      case '--json': out.json = true; break;
      case '--home': out.home = path.resolve(next()); break;
      case '--codex-home': out.codexHome = path.resolve(next()); break;
      case '--help': case '-h': out.help = true; break;
      default: throw new UsageError(`未知参数: ${arg}`);
    }
  }
  if (out.mode === 'install') {
    if (!out.target) throw new UsageError('缺少 --target（可选：' + [...TARGET_IDS, 'all'].join('|') + '）');
    if (!out.explicitDryRun && out.yes) out.dryRun = false;
  }
  return out;
}

// ---------- 输出 ----------

function sanitizeMessage(err) {
  const msg = String(err?.message ?? err ?? '');
  // 只保留错误类别信息，避免把配置内容（解析错误可能带片段）泄漏到 stdout/stderr。
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

const STATUS_TEXT = {
  planned: '计划写入',
  written: '已写入',
  'already-configured': '已配置（无需改动）',
  'skipped-client-missing': '跳过（客户端目录不存在）',
  'cli-only': '仅输出 CLI 命令（未写文件）',
  failed: '失败',
};

/** 人读摘要（不含任何配置内容，只有路径/状态）。 */
export function formatHuman(report) {
  const lines = [];
  lines.push(`Chronicle AI 工具接入（${report.mode === 'dry-run' ? 'dry-run：只打印计划，未写任何文件；加 --yes 才写入' : '写入模式'}）`);
  lines.push(`MCP 入口：${report.mcpEntry}`);
  lines.push('');
  for (const r of report.results) {
    const status = STATUS_TEXT[r.status] ?? r.status;
    const backup = r.backup ? `（备份：${r.backup}）` : '';
    const message = r.message ? `，${r.message}` : '';
    lines.push(`- ${r.id.padEnd(15)} [${r.kind.padEnd(4)}] ${r.path}`);
    lines.push(`  → ${status}${backup}${message}`);
    if (r.cliCommand) lines.push(`  → CLI：${r.cliCommand}`);
  }
  if (report.errors.length) {
    lines.push('');
    lines.push(`有 ${report.errors.length} 个目标失败（退出码 1）。`);
  } else if (report.mode === 'dry-run') {
    lines.push('');
    lines.push('确认无误后加 --yes 执行写入。');
  }
  return lines.join('\n');
}

/** 完整输出：默认人读 + 末尾一行 JSON；--json 只输出 JSON 一行。 */
export function formatOutput(report, { json = false } = {}) {
  const payload = JSON.stringify(report);
  if (json) return payload;
  return `${formatHuman(report)}\n\n${payload}`;
}

// ---------- CLI ----------

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`错误：${err.message}`);
      console.error(USAGE);
      return 2;
    }
    throw err;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.mode === 'print') {
    // 契约：stdout 必须是**单行 JSON**，不附加任何其它内容。
    process.stdout.write(`${JSON.stringify(printPayload())}\n`);
    return 0;
  }
  if (args.mode === 'list') {
    const home = path.resolve(args.home ?? os.homedir());
    const codexHome = args.codexHome ? path.resolve(args.codexHome) : null;
    process.stdout.write(`${JSON.stringify(listTargets({ home, codexHome }))}\n`);
    return 0;
  }

  let report;
  try {
    report = runInstall({
      home: args.home ?? os.homedir(),
      codexHome: args.codexHome,
      target: args.target,
      dryRun: args.dryRun,
      yes: args.yes,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`错误：${err.message}`);
      console.error(USAGE);
      return 2;
    }
    console.error(`错误：${sanitizeMessage(err)}`);
    return 1;
  }
  console.log(formatOutput(report, { json: args.json }));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[mcp-install] 失败: ${sanitizeMessage(err)}`);
      process.exit(1);
    });
}
