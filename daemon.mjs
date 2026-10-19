#!/usr/bin/env node
// daemon.mjs — Node 端守护管理：拉起/停止 Swift 采集守护 + 本地 HTTP 服务
//
// 职责：
//   ① 子进程管理：spawn Swift 守护（行协议：一行 JSON 请求 / 一行 JSON 响应，按 id 配对），
//      进程死亡自动重启（下次请求时拉起新实例）
//   ② HTTP 服务（默认 127.0.0.1:3777）：
//        GET    /                        → 时间线 UI（web/index.html + app.js + style.css）
//        GET    /api/status              → 守护状态（running/paused/config/...）
//        GET    /api/segments            → 段列表（读 <home>/segments/*/metadata.json）
//        GET    /api/segment/:ts/events  → 该段事件（?withSuppressed=1 附带抑制记录）
//        GET    /api/summaries           → 摘要列表（含 frontmatter 元信息）
//        GET    /api/summaries/:file     → 单个摘要全文
//        GET    /api/search?q=&limit=    → 跨段搜索事件
//        GET    /api/config              → 读隐私配置
//        PUT    /api/config              → 写隐私配置（校验规则形状；采集在跑则热重启生效）
//        DELETE /api/history             → 清空全部段落与摘要（config/Helper.app 不动）
//        POST   /api/pause  {durationSec?} → 暂停
//        POST   /api/resume              → 恢复
//   ③ 摘要调度：启动 5s 后 + 每 10 分钟调 summarize.mjs 的 summarizePending
//      （10min/6h 两级 LLM 摘要，config.json 的 summarizer 段控制；未启用时零副作用）；
//      外部命令钩子 CHRONICLE_SUMMARIZE_CMD 保留（批次 1 逃生口）
//   ④ pidfile：<home>/daemon.pid；SIGTERM/SIGINT → 转发 stop 给守护 → 等待退出
//
// 命令行：node daemon.mjs [--port 3777] [--start|--stop|--status] [--home DIR]
//   默认动作 = --start（前台常驻：守护 + HTTP 一起跑）
//   --stop   停止已在跑的实例（读 pidfile → SIGTERM）
//   --status 查询已在跑的实例（打 HTTP /api/status）
//
// 产品红线：不截屏、不录音。本文件只搬运结构化事件与元数据。

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validatePrivacyConfig } from './shared/privacy.mjs';
import { chronicleHome, listSegments, readSegmentEvents, searchEvents } from './shared/segments.mjs';
import { listSummaries, readSummary, summarizePending } from './summarize.mjs';

// 段/事件读取层已抽到 shared/segments.mjs（summarize 与 MCP 共用）；此处再导出保持旧 import 兼容
export { chronicleHome, listSegments, readSegmentEvents } from './shared/segments.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_PORT = 3777;
export const REQUEST_TIMEOUT_MS = 15_000;

/** 守护二进制：优先 .app 内的安装位（TCC 权限主体），回退仓库编译产物。 */
export function daemonBinaryPath(home = chronicleHome(), env = process.env) {
  if (env.CHRONICLE_DAEMON_BIN && env.CHRONICLE_DAEMON_BIN.length) return env.CHRONICLE_DAEMON_BIN;
  const appBin = path.join(home, 'Chronicle Helper.app', 'Contents', 'MacOS', 'chronicle-daemon');
  if (existsSync(appBin)) return appBin;
  return path.join(REPO_ROOT, 'host', 'chronicle-daemon');
}

// ---------- Swift 守护客户端（行协议，按 id 配对） ----------

export class DaemonError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * 创建守护控制端：懒起进程、按 id 配对响应、死亡自动重启。
 * @param {{binary?: string, home?: string, env?: object, timeoutMs?: number}} opts
 */
export function createDaemon(opts = {}) {
  const binary = opts.binary ?? daemonBinaryPath(opts.home ?? chronicleHome(), opts.env ?? process.env);
  const home = opts.home ?? chronicleHome(opts.env ?? process.env);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let child = null;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}

  function failAll(reason) {
    for (const rec of pending.values()) {
      clearTimeout(rec.timer);
      rec.reject(new DaemonError(reason, 'DAEMON_DEAD'));
    }
    pending.clear();
  }

  function spawnDaemon() {
    if (!existsSync(binary)) {
      throw new DaemonError(`守护二进制不存在: ${binary}（先跑 npm run setup 编译）`, 'NO_BINARY');
    }
    const proc = spawn(binary, opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ...(opts.env ?? {}), CHRONICLE_HOME: home },
    });
    child = proc;
    proc.stdin?.on('error', () => { /* EPIPE：守护已死，在途请求由 exit 兜底 */ });
    let buf = '';
    proc.stdout?.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // 坏行丢弃（协议要求单行 JSON）
        if (!Number.isInteger(msg.id)) continue; // 无 id 的通知行忽略
        const rec = pending.get(msg.id);
        if (!rec) continue;
        pending.delete(msg.id);
        clearTimeout(rec.timer);
        if (msg.ok === true) rec.resolve(msg);
        else rec.reject(new DaemonError(msg.error ?? 'daemon error', msg.code));
      }
    });
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      failAll(`chronicle-daemon exited unexpectedly (${binary})`);
    });
    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      failAll(`chronicle-daemon 启动失败: ${err.message}`);
    });
  }

  return {
    binary,
    home,
    /** 当前守护子进程（测试用；可能为 null）。 */
    proc: () => child,
    /** 发一行请求，等对应 id 的响应。 */
    request(cmd, params = {}) {
      if (!child) spawnDaemon();
      const id = nextId++;
      return new Promise((resolveP, rejectP) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectP(new DaemonError(`守护响应超时（${timeoutMs}ms，cmd=${cmd}）`, 'DAEMON_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { resolve: resolveP, reject: rejectP, timer });
        try {
          child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`, (err) => {
            if (err) {
              pending.delete(id);
              clearTimeout(timer);
              rejectP(new DaemonError(`写入守护失败: ${err.message}`, 'DAEMON_DEAD'));
            }
          });
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          rejectP(new DaemonError(`写入守护失败: ${err.message}`, 'DAEMON_DEAD'));
        }
      });
    },
    /** 结束守护进程；在途请求立即报 DAEMON_DEAD。 */
    stop() {
      if (!child) return;
      const proc = child;
      child = null;
      try { proc.stdin.end(); } catch { /* 已退出 */ }
      try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
      failAll('daemon stopped by caller');
    },
  };
}

// ---------- 摘要钩子 ----------

/**
 * 外部摘要命令钩子（批次 1 遗留的可选逃生口）。
 * 配置 CHRONICLE_SUMMARIZE_CMD="<命令>" 时对已关闭且无 summary.json 标记的段
 * 以段路径为参数调用；内置 LLM 摘要器见 summarize.mjs（summarizePending）。
 * 未配置时静默返回（无副作用）。
 * @returns {Promise<{checked: number, summarized: number, skipped: string[]}>}
 */
export async function runSummaries(home = chronicleHome(), { env = process.env, log = () => {}, runner = spawnSync } = {}) {
  const cmd = env.CHRONICLE_SUMMARIZE_CMD;
  const segments = listSegments(home).filter((s) => !s.open && s.eventCount > 0);
  const result = { checked: segments.length, summarized: 0, skipped: [] };
  if (!cmd) return result;
  for (const seg of segments) {
    const marker = path.join(seg.path, 'summary.json');
    if (existsSync(marker)) continue;
    const r = runner(cmd, [seg.path], { encoding: 'utf8', timeout: 120_000 });
    if (r.status === 0) {
      writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }));
      result.summarized += 1;
      log(`摘要完成: ${seg.segment}`);
    } else {
      result.skipped.push(seg.segment);
      log(`摘要失败（跳过）: ${seg.segment} exit=${r.status}`);
    }
  }
  return result;
}

// ---------- pidfile ----------

function pidfilePath(home) { return path.join(home, 'daemon.pid'); }

function readPid(home) {
  try {
    const pid = Number.parseInt(readFileSync(pidfilePath(home), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}

function writePid(home, pid) {
  mkdirSync(home, { recursive: true });
  writeFileSync(pidfilePath(home), String(pid));
}

function clearPid(home) { try { unlinkSync(pidfilePath(home)); } catch { /* 无 pidfile */ } }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------- HTTP 服务 ----------

/** web/ 下允许静态返回的文件（白名单，杜绝路径穿越）。 */
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function readConfigFile(home) {
  try { return JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return null; }
}

/** 清空历史：删除 segments/ 与 summaries/ 下的全部条目（目录保留，config 与 Helper.app 不动）。 */
export function clearHistory(home) {
  const counts = { removedSegments: 0, removedSummaries: 0 };
  for (const [dir, key] of [['segments', 'removedSegments'], ['summaries', 'removedSummaries']]) {
    const root = path.join(home, dir);
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root)) {
      rmSync(path.join(root, name), { recursive: true, force: true });
      counts[key] += 1;
    }
  }
  return counts;
}

export function createHttpApp({ daemon, home, webDir = path.join(REPO_ROOT, 'web'), log = () => {} } = {}) {
  const server = createServer(async (req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, headers);
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const sendJson = (code, obj) => send(code, obj, { 'Content-Type': 'application/json; charset=utf-8' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      // 静态资源（时间线 UI；仅白名单文件）
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [name, type] = STATIC_FILES[url.pathname];
        const file = path.join(webDir, name);
        if (!existsSync(file)) return send(404, `web/${name} 缺失`);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const st = await daemon.request('status');
        return sendJson(200, { ok: true, status: st, daemonBinary: daemon.binary, pid: daemon.proc()?.pid ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/api/segments') {
        return sendJson(200, { ok: true, segments: listSegments(home) });
      }
      if (req.method === 'GET' && /^\/api\/segment\/[^/]+\/events$/.test(url.pathname)) {
        const seg = decodeURIComponent(url.pathname.split('/')[3]);
        const data = readSegmentEvents(home, seg, { withSuppressed: url.searchParams.get('withSuppressed') === '1' });
        if (!data) return sendJson(404, { ok: false, error: 'segment not found' });
        return sendJson(200, { ok: true, ...data });
      }
      if (req.method === 'GET' && url.pathname === '/api/summaries') {
        return sendJson(200, { ok: true, summaries: listSummaries(home) });
      }
      if (req.method === 'GET' && /^\/api\/summaries\/[^/]+$/.test(url.pathname)) {
        const name = decodeURIComponent(url.pathname.split('/')[3]);
        const markdown = readSummary(home, name);
        if (markdown === null) return sendJson(404, { ok: false, error: 'summary not found' });
        return sendJson(200, { ok: true, filename: name, markdown });
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const q = url.searchParams.get('q');
        if (!q || !q.trim()) return sendJson(400, { ok: false, error: '缺少 q 参数' });
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
        return sendJson(200, { ok: true, ...searchEvents(home, { q, limit: Number.isInteger(limit) ? limit : 100 }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/pause') {
        const body = await readBody(req);
        const durationSec = Number.parseInt(body?.durationSec, 10);
        const r = await daemon.request('pause', Number.isInteger(durationSec) ? { durationSec } : {});
        return sendJson(200, { ok: true, ...r });
      }
      if (req.method === 'POST' && url.pathname === '/api/resume') {
        const r = await daemon.request('resume');
        return sendJson(200, { ok: true, ...r });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const cfg = readConfigFile(home);
        if (!cfg) return sendJson(404, { ok: false, error: 'config.json 不存在（先跑 npm run setup）' });
        return sendJson(200, { ok: true, config: cfg });
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(400, { ok: false, error: '请求体须为 JSON 对象' });
        }
        const errors = validatePrivacyConfig(body);
        if (errors.length) return sendJson(400, { ok: false, errors });
        const merged = { ...(readConfigFile(home) ?? {}), ...body }; // 保留未知键（如 summarizer）
        writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(merged, null, 2)}\n`);
        // 若采集在跑：重启观察让新规则立即生效（stop 关闭当前段，start 按新配置开新段）
        let applied = null;
        try {
          const st = await daemon.request('status');
          if (st.running === true) {
            try { await daemon.request('stop'); await daemon.request('start'); applied = true; } catch (err) { applied = false; log(`规则热应用失败: ${err.message}`); }
          } else applied = false;
        } catch { applied = null; /* 守护不可达：文件已写，下次启动生效 */ }
        return sendJson(200, { ok: true, config: merged, applied });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/history') {
        // 清空前先停采集（避免守护句柄写已删除目录），清空后重新拉起
        let wasRunning = false;
        try { wasRunning = (await daemon.request('status')).running === true; } catch { /* 守护不可达就只清文件 */ }
        if (wasRunning) { try { await daemon.request('stop'); } catch { /* 忽略 */ } }
        const counts = clearHistory(home);
        let restarted = false;
        if (wasRunning) { try { await daemon.request('start'); restarted = true; } catch (err) { log(`清空后重启采集失败: ${err.message}`); } }
        return sendJson(200, { ok: true, ...counts, restarted });
      }
      return sendJson(404, { ok: false, error: 'not found' });
    } catch (err) {
      log(`HTTP ${req.method} ${url.pathname} 失败: ${err.message}`);
      return sendJson(503, { ok: false, error: err.message, code: err.code ?? null });
    }
  });
  return server;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, action: 'start', home: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--port') out.port = Number.parseInt(next(), 10);
    else if (a === '--home') out.home = path.resolve(next());
    else if (a === '--start') out.action = 'start';
    else if (a === '--stop') out.action = 'stop';
    else if (a === '--status') out.action = 'status';
    else if (a === '--help' || a === '-h') {
      console.log('用法: node daemon.mjs [--port 3777] [--home DIR] [--start|--stop|--status]');
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

function fetchStatus(port) {
  // Node 18+ 自带 fetch；老环境或无响应都返回 null
  if (!globalThis.fetch) return Promise.resolve(null);
  return globalThis.fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = args.home ?? chronicleHome();

  if (args.action === 'stop') {
    const pid = readPid(home);
    if (!pidAlive(pid)) { console.log('守护未在运行（无 pidfile 或进程已退出）'); clearPid(home); return 0; }
    process.kill(pid, 'SIGTERM');
    console.log(`已发送停止信号给 pid ${pid}`);
    return 0;
  }

  if (args.action === 'status') {
    const st = await fetchStatus(args.port);
    if (!st) { console.log(JSON.stringify({ running: false, detail: `127.0.0.1:${args.port} 无响应` })); return 1; }
    console.log(JSON.stringify(st, null, 2));
    return 0;
  }

  // --start（默认）：守护 + HTTP 前台常驻
  mkdirSync(path.join(home, 'segments'), { recursive: true });
  const daemon = createDaemon({ home });
  const server = createHttpApp({ daemon, home });
  await new Promise((resolve, reject) => server.listen(args.port, '127.0.0.1', resolve).once('error', reject));
  writePid(home, process.pid);
  console.log(`Chronicle 守护管理器已启动：HTTP 127.0.0.1:${args.port}（数据目录 ${home}）`);
  console.log(`采集守护二进制：${daemon.binary}`);

  // 启动即拉起守护并开始观察（守护进程死了会自动重启，下次请求时）
  try {
    const r = await daemon.request('start');
    console.log(`采集已开始：${r.segmentsDir}`);
  } catch (err) {
    console.error(`采集守护启动失败: ${err.message}`);
    console.error('（先跑 npm run setup；或确认 ~/.chronicle/Chronicle Helper.app 已安装）');
    server.close();
    clearPid(home);
    return 1;
  }

  // 摘要：启动 5s 后先扫一遍（补上一会话遗留的已关闭段），之后每 10 分钟一次
  //（摘要器未启用时零副作用；外部命令钩子 CHRONICLE_SUMMARIZE_CMD 仍每 60s 空转扫描）
  const builtinSummaryTimer = setInterval(() => {
    summarizePending(home, { env: process.env, log: (m) => console.log(`[summary] ${m}`) }).catch(() => {});
  }, 10 * 60_000);
  builtinSummaryTimer.unref();
  setTimeout(() => {
    summarizePending(home, { env: process.env, log: (m) => console.log(`[summary] ${m}`) }).catch(() => {});
  }, 5_000).unref();
  const summaryTimer = setInterval(() => { runSummaries(home, { log: (m) => console.log(`[summary] ${m}`) }).catch(() => {}); }, 60_000);
  summaryTimer.unref();

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${sig}，停止采集并退出…`);
    try { const r = await daemon.request('stop'); console.log(`stats: ${JSON.stringify(r.stats)}`); } catch { /* 守护已死 */ }
    daemon.stop();
    clearInterval(summaryTimer);
    server.close();
    clearPid(home);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 守护意外死亡（stdin 断开等）时如实报告；HTTP /api/status 会给出 DAEMON_DEAD
  daemon.proc()?.on?.('exit', () => { if (!shuttingDown) console.error('（警告）采集守护进程已退出；下次 API 请求将自动重启它'); });
  return new Promise(() => {}); // 常驻
}

// 直接执行时才跑 CLI（测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[daemon] 失败: ${e.message}`); process.exit(1); });
}
