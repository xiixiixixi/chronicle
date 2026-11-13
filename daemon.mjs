#!/usr/bin/env node
// daemon.mjs — Node 端守护管理：拉起/停止 Swift 采集守护 + 本地 HTTP 服务
//
// 职责：
//   ① 子进程管理：spawn Swift 守护（行协议：一行 JSON 请求 / 一行 JSON 响应，按 id 配对），
//      **看护子进程**：非预期退出按 1/2/4/8/16/30s 指数退避自动重启（稳定 60s 后重置），
//      --stop / SIGTERM / SIGINT 正常退出不重启；status 暴露 restarts / lastExit
//   ② 单实例锁：<home>/daemon.lock = {pid, startedAt, exe}；陈旧锁（pid 不在 / cmdline 不是本仓库
//      daemon.mjs）自动覆盖；重复启动直接退出码 0 并打印「已在运行 (pid)」
//   ③ 日志：<home>/logs/daemon-YYYYMMDD.log，捕获 Swift stderr；10MB 按大小轮转、共保留 7 份
//      只记计数/状态/错误；URL 一律脱敏，绝不主动记标题等事件内容
//   ④ HTTP 服务（默认 127.0.0.1:3777）：
//        GET    /                        → 时间线 UI（web/index.html + app.js + style.css）
//        GET    /api/status              → 守护状态（running/paused/config/... + restarts/lastExit）
//        GET    /api/segments?limit=&before= → 段列表分页（items/hasMore/nextBefore；兼容旧 segments 字段）
//        GET    /api/segment/:ts/events  → 该段事件（?withSuppressed=1 附带抑制记录；段名严格校验）
//        GET    /api/summaries?date=&q=&limit= → 摘要列表（含 frontmatter 元信息 + startMs/spanMs；
//                                          date=本地日按时间窗重叠过滤，q=标题/描述/正文子串，limit≤500）
//        GET    /api/summaries/:file     → 单个摘要全文
//        GET    /api/search?q=&limit=&offset=&from=&to= → 跨段搜索（分页；兼容旧参数/字段）
//        GET    /api/overview?date=      → 单日聚合（topApps/ruler + segments 列表 + activity 亲手操作时长/5 分钟桶）
//        GET    /api/days                → 有记录的本地日列表（新→旧；段数/事件数，只读元信息）
//        GET    /api/app-icon?bundleId=|app= → 应用真实图标 128×128 PNG（磁盘缓存 7 天；跨站请求 403）
//        GET    /api/model/config        → 模型配置脱敏视图 + presets 预设清单
//        GET    /api/integrations        → AI 工具接入信息（每个工具带 iconApp 供 /api/app-icon?app=）
//        GET    /api/config              → 读隐私配置
//        PUT    /api/config              → 写隐私配置（校验规则形状；采集在跑则热重启生效）
//        DELETE /api/history             → 清空全部段落与摘要（config/Helper.app 不动）
//        POST   /api/pause  {durationSec?} → 暂停
//        POST   /api/resume              → 恢复
//      写方法（PUT/POST/DELETE）校验 Host/Origin/Content-Type（本地 CSRF 边界）；GET 保持宽松
//   ⑤ 摘要调度：启动 5s 后 + 每 10 分钟调 summarize.mjs 的 summarizePending
//      （10min/6h 两级 LLM 摘要，config.json 的 summarizer 段控制；未启用时零副作用）；
//      外部命令钩子 CHRONICLE_SUMMARIZE_CMD 保留（批次 1 逃生口）
//   ⑥ pidfile：<home>/daemon.pid；SIGTERM/SIGINT → 转发 stop 给守护 → 等待退出
//
// 命令行：node daemon.mjs [--port 3777] [--start|--stop|--status] [--home DIR] [--service]
//   默认动作 = --start（前台常驻：守护 + HTTP 一起跑）
//   --service 同 --start（launchd 开机自启用，行为一致，仅日志标注来源）
//   --stop   停止已在跑的实例（读 pidfile/lock → 校验进程归属 → SIGTERM）
//   --status 查询已在跑的实例（打 HTTP /api/status）
//   --maintain [--dry-run] [--retention-days N]  只跑一次维护（保留策略→压缩→索引）并打印 JSON 报告
//   维护调度：正常启动 5s 后跑一次、此后每 6h（CHRONICLE_MAINTENANCE_MS 可覆盖周期）
//   retentionDays=0（默认）时保留策略关闭，绝不自动删数据
//
// 产品红线：不截屏、不录音。本文件只搬运结构化事件与元数据。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { contentSettings, validatePrivacyConfig } from './shared/privacy.mjs';
import * as segmentsModule from './shared/segments.mjs';
import { INPUT_EVENT_TYPES, chronicleHome, listSegments, parseSegmentTs, readSegmentEvents, searchEvents } from './shared/segments.mjs';
import { listSummaries, parseSummaryFile, readDeadLetters, readSummary, summarizePending, summarizeSegment } from './summarize.mjs';
import {
  MODEL_PRESETS, loadModelConfig, normalizeModelConfig, redactConfig, resolveApiKey, saveModelConfig, testModelConfig,
} from './shared/model-config.mjs';
import { createAppIconService, parseAppIconQuery } from './shared/app-icons.mjs';
import { normalizeMaintenanceConfig } from './shared/retention.mjs';
import { runMaintenance, summarizeMaintenanceReport } from './shared/maintenance.mjs';
import { appendAudit, listAudit } from './shared/audit.mjs';
import { buildCoverage } from './shared/coverage.mjs';
import { buildTeamPack, importTeamPack } from './shared/team.mjs';
import { runAnalysisCatchUp, computeAnalysisStatus, analysisCatchUpRunning, enqueueInsightRequest, isTransientAnalysisError } from './shared/analysis-catchup.mjs';
import {
  listAgents, registerAgent, grantPermission, revokeGrant, checkPermission, recordAgentOutcome,
} from './shared/agent-registry.mjs';
import { executeAgentAction, undoAgentAction } from './shared/agent-executor.mjs';
import {
  listObjects, computeExceptions, reviewQueue, listInsights as listWorkInsights, workStats as workLedgerStats,
  createObject as createWorkObject, updateObject as updateWorkObject, archiveObject as archiveWorkObject,
  createInsight as createWorkInsight, validateInsight as validateWorkInsight,
  applyInsight as applyWorkInsight, retireInsight as retireWorkInsight, buildContextPack,
} from './shared/work-ledger.mjs';

// 段/事件读取层已抽到 shared/segments.mjs（summarize 与 MCP 共用）；此处再导出保持旧 import 兼容
export { chronicleHome, listSegments, readSegmentEvents } from './shared/segments.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_PORT = 3777;
export const REQUEST_TIMEOUT_MS = 15_000;

// ---------- 可靠性常量 ----------

/** 本仓库 daemon.mjs 的绝对路径（锁与 pid 归属校验的标识）。 */
export const DAEMON_SCRIPT = path.join(REPO_ROOT, 'daemon.mjs');
export const LOCK_FILENAME = 'daemon.lock';
export const PID_FILENAME = 'daemon.pid';
/** 崩溃重启退避序列（封顶 30s）。 */
export const RESTART_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
/** 稳定运行超过该时长后重置退避。 */
export const RESTART_STABLE_MS = 60_000;
/** 日志单文件上限与保留份数（当前文件 + 轮转副本共 7 份）。 */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 7;
/** 段目录名严格格式（与 shared/segments.mjs 的 parseSegmentTs 一致）。 */
export const SEGMENT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;
/** 维护周期：启动 5s 后跑一次，此后每 6 小时一次（可用 CHRONICLE_MAINTENANCE_MS 覆盖周期便于测试）。 */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAINTENANCE_FIRST_DELAY_MS = 5000;

/** 维护周期：CHRONICLE_MAINTENANCE_MS（正整数毫秒）> 默认 6h。 */
export function maintenanceIntervalFromEnv(env = process.env) {
  const raw = Number.parseInt(env?.CHRONICLE_MAINTENANCE_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : MAINTENANCE_INTERVAL_MS;
}

/** 责任进程解绑 shim：让 Helper 以自己的 TCC 身份运行（用户给 Chronicle Helper 的授权才会生效）。
 *  路径可用 CHRONICLE_SPAWN_SHIM 覆盖；未安装时返回 null（退回直接 spawn）。 */
export function spawnShimPath(home = chronicleHome(), env = process.env) {
  if (env && typeof env.CHRONICLE_SPAWN_SHIM === 'string' && env.CHRONICLE_SPAWN_SHIM.length) return env.CHRONICLE_SPAWN_SHIM;
  const p = path.join(home, 'chronicle-spawn');
  return existsSync(p) ? p : null;
}

/** 守护二进制：优先 .app 内的安装位（TCC 权限主体），回退仓库编译产物。 */
export function daemonBinaryPath(home = chronicleHome(), env = process.env) {
  if (env.CHRONICLE_DAEMON_BIN && env.CHRONICLE_DAEMON_BIN.length) return env.CHRONICLE_DAEMON_BIN;
  const appBin = path.join(home, 'Chronicle Helper.app', 'Contents', 'MacOS', 'chronicle-daemon');
  if (existsSync(appBin)) return appBin;
  return path.join(REPO_ROOT, 'host', 'chronicle-daemon');
}

// ---------- 进程身份（pid 复用安全的归属校验） ----------

/** 读某进程的命令行（macOS/Linux `ps -o command=`）；不可读返回 null。 */
export function processCmdline(pid, { runner = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = runner('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
    if (r && r.status === 0) return String(r.stdout ?? '').trim();
  } catch { /* ps 不可用 */ }
  return null;
}

/** 进程是否存活（EPERM 视为存活：存在但无权限发信号）。 */
export function isPidAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

/** cmdline 是否像本仓库 daemon.mjs（绝对路径优先；相对启动时要求同时含仓库目录名）。 */
export function daemonCmdlineMatches(cmdline, { marker = DAEMON_SCRIPT, repoName = path.basename(REPO_ROOT) } = {}) {
  const cmd = String(cmdline ?? '');
  if (!cmd) return false;
  if (cmd.includes(marker)) return true;
  return cmd.includes('daemon.mjs') && repoName.length > 0 && cmd.includes(repoName);
}

/** pid 是否确属本仓库 daemon.mjs（防 pid 复用误杀）。 */
export function isOurDaemonPid(pid, { cmdlineOf = processCmdline, isAlive = isPidAlive, marker = DAEMON_SCRIPT } = {}) {
  if (!isAlive(pid)) return false;
  return daemonCmdlineMatches(cmdlineOf(pid), { marker });
}

// ---------- 单实例锁 ----------

export function lockPath(home) { return path.join(home, LOCK_FILENAME); }
export function pidfilePath(home) { return path.join(home, PID_FILENAME); }

export function readInstanceLock(home) {
  try {
    const raw = JSON.parse(readFileSync(lockPath(home), 'utf8'));
    if (raw && Number.isInteger(raw.pid) && raw.pid > 0) return raw;
  } catch { /* 无锁/坏锁 = 没有锁 */ }
  return null;
}

export function writeInstanceLock(home, lock) {
  mkdirSync(home, { recursive: true });
  const tmp = `${lockPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock)}\n`);
  renameSync(tmp, lockPath(home));
}

/** 仅当锁属于 pid（默认当前进程）时才删除，避免误删他人的锁。 */
export function releaseInstanceLock(home, { pid = process.pid } = {}) {
  const cur = readInstanceLock(home);
  if (!cur) return false;
  if (pid !== undefined && cur.pid !== pid) return false;
  try { unlinkSync(lockPath(home)); return true; } catch { return false; }
}

/**
 * 获取单实例锁。
 * 陈旧判定：pid 不存活，或存活但 cmdline 不属于本仓库 daemon.mjs。
 * @returns {{acquired: boolean, lock: object|null, stale: boolean}}
 */
export function acquireInstanceLock(home, {
  pid = process.pid,
  exe = process.argv[1] ? path.resolve(process.argv[1]) : DAEMON_SCRIPT,
  startedAt = new Date().toISOString(),
  port = null,
  isAlive = isPidAlive,
  cmdlineOf = processCmdline,
  marker = DAEMON_SCRIPT,
} = {}) {
  const existing = readInstanceLock(home);
  if (existing) {
    const alive = isAlive(existing.pid);
    const sameProcess = existing.pid === pid;
    // 兼容 launchd/相对路径启动：锁里记录的可执行路径命中本仓库 daemon.mjs 也算自己人
    const ours = alive && (
      daemonCmdlineMatches(cmdlineOf(existing.pid), { marker })
      || (existing.exe && path.resolve(String(existing.exe)) === marker)
    );
    if (alive && (sameProcess || ours)) return { acquired: false, lock: existing, stale: false };
  }
  const lock = { pid, startedAt, exe, port };
  writeInstanceLock(home, lock);
  return { acquired: true, lock, stale: Boolean(existing) };
}

/** 读管理进程 pid：pidfile 优先，回退锁文件（--stop / uninstall 用）。 */
export function readManagerPid(home) {
  const pid = readPidFile(home);
  if (pid) return pid;
  const lock = readInstanceLock(home);
  return lock ? lock.pid : null;
}

/**
 * 停止已在运行的管理进程（只在归属校验通过时发信号）。
 * @returns {{stopped:boolean, reason:string, pid?:number, cmdline?:string}}
 */
export function stopManager(home, {
  pid = readManagerPid(home),
  isAlive = isPidAlive,
  cmdlineOf = processCmdline,
  kill = process.kill,
  marker = DAEMON_SCRIPT,
} = {}) {
  if (!pid) return { stopped: false, reason: 'no-pidfile' };
  if (!isAlive(pid)) { clearPidFile(home); return { stopped: false, reason: 'not-running', pid }; }
  const cmdline = cmdlineOf(pid);
  if (!daemonCmdlineMatches(cmdline, { marker })) {
    return { stopped: false, reason: 'pid-not-ours', pid, cmdline: cmdline ?? null };
  }
  try { kill(pid, 'SIGTERM'); } catch (err) { return { stopped: false, reason: 'kill-failed', pid, error: err.message }; }
  return { stopped: true, pid };
}

/**
 * 轮询等待进程退出。
 * @returns {Promise<boolean>} true=已退出
 */
export async function waitForExit(pid, {
  timeoutMs = 5000,
  intervalMs = 100,
  isAlive = isPidAlive,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  if (!isAlive(pid)) return true;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (!isAlive(pid)) return true;
  }
  return !isAlive(pid);
}

// ---------- 日志（大小轮转；只记计数/状态/错误） ----------

export function logsDir(home) { return path.join(home, 'logs'); }

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地日期戳 YYYYMMDD（日志文件名用本地时间，便于用户查看）。 */
export function logDateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

export function logFileFor(home, date = new Date()) {
  return path.join(logsDir(home), `daemon-${logDateStamp(date)}.log`);
}

/** 日志行脱敏：URL 一律替换、换行压平、长度截断（防 Swift stderr 夹带内容）。 */
export function redactLogLine(line) {
  return String(line ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .slice(0, 2000);
}

const LOG_NAME_RE = /^daemon-(\d{8})\.log(?:\.(\d+))?$/;

/**
 * 创建轮转日志器。默认单文件 10MB、同一天保留 7 份（当前 + 6 个轮转副本），
 * 并清理超过保守天数的旧日期文件。
 * @param {{home:string, maxBytes?:number, keep?:number, now?:()=>Date, file?:string}} opts
 */
export function createLogger({ home, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, now = () => new Date(), file = null } = {}) {
  const dir = logsDir(home);
  mkdirSync(dir, { recursive: true });
  const totalKeep = Math.max(1, keep);
  let currentDate = logDateStamp(now());
  let current = file ?? logFileFor(home, now());

  function listLogs() {
    try { return readdirSync(dir).filter((n) => LOG_NAME_RE.test(n)); } catch { return []; }
  }

  /** 清理旧日期：只保留最近 totalKeep 个日期（当前日期即使还没落盘也计入）。 */
  function pruneOldDays() {
    const byDate = new Map();
    for (const name of listLogs()) {
      const m = LOG_NAME_RE.exec(name);
      if (!m) continue;
      if (!byDate.has(m[1])) byDate.set(m[1], []);
      byDate.get(m[1]).push(name);
    }
    if (!byDate.has(currentDate)) byDate.set(currentDate, []);
    const dates = [...byDate.keys()].sort().reverse();
    for (const day of dates.slice(totalKeep)) {
      for (const name of byDate.get(day)) { try { rmSync(path.join(dir, name), { force: true }); } catch { /* 忽略 */ } }
    }
  }

  /** 超过大小上限则轮转；返回是否发生轮转。 */
  function rotateIfNeeded() {
    let st;
    try { st = statSync(current); } catch { return false; }
    if (st.size < maxBytes) return false;
    if (totalKeep <= 1) { try { writeFileSync(current, ''); } catch { /* 忽略 */ } return true; }
    for (let i = totalKeep - 1; i >= 1; i -= 1) {
      const from = i === 1 ? current : `${current}.${i - 1}`;
      const to = `${current}.${i}`;
      if (existsSync(from)) {
        try { rmSync(to, { force: true }); renameSync(from, to); } catch { /* 忽略轮转失败 */ }
      }
    }
    return true;
  }

  function switchDayIfNeeded() {
    if (file) return;
    const stamp = logDateStamp(now());
    if (stamp === currentDate) return;
    currentDate = stamp;
    current = logFileFor(home, now());
    pruneOldDays();
  }

  function write(level, message) {
    try {
      switchDayIfNeeded();
      rotateIfNeeded();
      appendFileSync(current, `${now().toISOString()} ${String(level).toUpperCase().padEnd(5)} ${redactLogLine(message)}\n`);
    } catch { /* 日志失败绝不影响主流程 */ }
  }

  pruneOldDays();
  return {
    home,
    write,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    file: () => current,
    rotate: rotateIfNeeded,
    prune: pruneOldDays,
    close: () => { /* 无句柄需释放（每行 appendFileSync） */ },
  };
}

// ---------- 维护调度（保留策略 → 压缩 → 索引刷新） ----------

/** 读 config.json（复用现成读取路径；读不到按安全默认：retentionDays=0 → 维护 no-op）。 */
function maintenanceConfigFromHome(home) {
  return readConfigFile(home) ?? {};
}

/**
 * 启动后（默认 5s）跑一次维护，此后按 intervalMs（默认 6h，CHRONICLE_MAINTENANCE_MS 可覆盖）周期运行。
 * 所有错误都被吞掉并记日志（维护失败不能拖垮守护；默认 retentionDays=0 → 不删数据）。
 * 返回句柄供测试/关闭：{ stop(), runOnce(), last(), invocations(), intervalMs, firstDelayMs }
 * @param {{home:string, log?:Function, config?:object|null, firstDelayMs?:number, intervalMs?:number,
 *          dryRun?:boolean, now?:number|Date|null, run?:Function, firstDelay?:boolean}} opts
 */
export function scheduleMaintenance({
  home,
  log = () => {},
  config = null,
  firstDelayMs = MAINTENANCE_FIRST_DELAY_MS,
  intervalMs = maintenanceIntervalFromEnv(),
  dryRun = false,
  now = null,
  run = null,
  firstDelay = true,
} = {}) {
  let stopped = false;
  let lastReport = null;
  const invocations = [];
  const runner = typeof run === 'function' ? run : async () => {
    const cfg = config ?? maintenanceConfigFromHome(home);
    return runMaintenance(home, cfg, { now: now ?? Date.now(), dryRun, log });
  };
  const exec = async (reason) => {
    if (stopped) return null;
    try {
      const report = await runner();
      lastReport = report;
      invocations.push({ reason, at: Date.now() });
      // runMaintenance 自己已通过 log 记录单行摘要；只在注入的 run 返回非标准报告时补一条
      if (report && typeof report === 'object') {
        if (typeof report.summary !== 'string') log(`[maintenance] ${summarizeMaintenanceReport(report)}`);
      } else log(`[maintenance] ${reason} 完成`);
      return report;
    } catch (err) {
      log(`[maintenance] ${reason} 运行失败（已忽略）: ${err.message}`);
      return null;
    }
  };
  const firstTimer = firstDelay ? setTimeout(() => { exec('startup'); }, firstDelayMs) : null;
  if (firstTimer && typeof firstTimer.unref === 'function') firstTimer.unref();
  const intervalTimer = setInterval(() => { exec('interval'); }, intervalMs);
  if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
  return {
    intervalMs,
    firstDelayMs,
    stop: () => {
      stopped = true;
      if (firstTimer) clearTimeout(firstTimer);
      clearInterval(intervalTimer);
    },
    runOnce: () => exec('manual'),
    last: () => lastReport,
    invocations: () => invocations.slice(),
  };
}

// ---------- pidfile ----------

export function readPidFile(home) {
  try {
    const pid = Number.parseInt(readFileSync(pidfilePath(home), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export function writePidFile(home, pid = process.pid) {
  mkdirSync(home, { recursive: true });
  writeFileSync(pidfilePath(home), String(pid));
}

export function clearPidFile(home) { try { unlinkSync(pidfilePath(home)); } catch { /* 无 pidfile */ } }

// ---------- Swift 守护客户端（行协议，按 id 配对） ----------

export class DaemonError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * 创建守护控制端：懒起进程、按 id 配对响应、**非预期死亡指数退避自动重启**。
 * @param {{binary?:string, home?:string, env?:object, timeoutMs?:number, args?:string[],
 *          restart?:boolean, restartDelays?:number[], restartStableMs?:number,
 *          log?:(line:string)=>void, stderr?:(line:string)=>void}} opts
 */
export function createDaemon(opts = {}) {
  const home = opts.home ?? chronicleHome(opts.env ?? process.env);
  const binary = opts.binary ?? daemonBinaryPath(home, opts.env ?? process.env);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onStderr = typeof opts.stderr === 'function' ? opts.stderr : null;
  const watchdog = {
    enabled: opts.restart !== false,
    delays: Array.isArray(opts.restartDelays) && opts.restartDelays.length ? opts.restartDelays : RESTART_DELAYS_MS,
    stableMs: Number.isInteger(opts.restartStableMs) ? opts.restartStableMs : RESTART_STABLE_MS,
  };
  let child = null;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  let stopping = false;
  let restarts = 0;
  let lastExit = null;
  let attempt = 0;
  let spawnedAt = 0;
  let restartTimer = null;
  // 采集意图：崩溃重启后要按这个状态自动恢复采集（用户视角「崩溃了还在记」）
  const acquisition = { started: false, paused: false, startParams: {} };
  let restoring = null;

  function failAll(reason) {
    for (const rec of pending.values()) {
      clearTimeout(rec.timer);
      rec.reject(new DaemonError(reason, 'DAEMON_DEAD'));
    }
    pending.clear();
  }

  function clearRestartTimer() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }

  /** 只在命令成功响应后更新采集意图（失败不改变）。 */
  function updateAcquisitionFromCmd(cmd, params = {}) {
    if (cmd === 'start') {
      acquisition.started = true;
      acquisition.paused = false;
      acquisition.startParams = params && typeof params === 'object' ? { ...params } : {};
    } else if (cmd === 'stop') {
      acquisition.started = false;
      acquisition.paused = false;
      acquisition.startParams = {};
    } else if (cmd === 'pause') {
      acquisition.paused = true;
    } else if (cmd === 'resume') {
      acquisition.paused = false;
    }
  }

  /** 直接向指定子进程发命令（不触发懒拉起，供看护恢复采集用）。 */
  function sendToChild(proc, cmd, params = {}, cmdTimeoutMs = 3000) {
    return new Promise((resolveP, rejectP) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectP(new DaemonError(`守护响应超时（${cmdTimeoutMs}ms，cmd=${cmd}）`, 'DAEMON_TIMEOUT'));
      }, cmdTimeoutMs);
      pending.set(id, { resolve: resolveP, reject: rejectP, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`, (err) => {
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
  }

  /**
   * 崩溃/懒拉起后恢复采集：重放 start（崩前若 paused 再补 pause）。
   * 失败重试 3 次（200ms 间隔）并写日志；绝不抛到调用方。
   */
  async function restoreAcquisition(proc) {
    if (stopping || !acquisition.started) return;
    if (proc !== child) return;
    if (restoring) return restoring;
    restoring = (async () => {
      for (let i = 0; i < 3; i += 1) {
        if (proc !== child || stopping) return;
        try {
          try {
            await sendToChild(proc, 'start', acquisition.startParams);
          } catch (err) {
            if (err && err.code === 'ALREADY_RUNNING') { /* 已由其他路径拉起 */ } else throw err;
          }
          if (acquisition.paused) await sendToChild(proc, 'pause', {});
          log('[watchdog] 采集已自动恢复');
          return;
        } catch (err) {
          if (proc !== child || stopping) return;
          log(`[watchdog] 自动恢复采集失败（第 ${i + 1}/3 次）：${err.message}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      log('[watchdog] 自动恢复采集放弃（连续 3 次失败），请检查守护状态');
    })();
    try { await restoring; } finally { restoring = null; }
  }

  function scheduleRestart(reason) {
    if (stopping || !watchdog.enabled || restartTimer) return;
    const delay = watchdog.delays[Math.min(attempt, watchdog.delays.length - 1)];
    attempt += 1;
    log(`[watchdog] 守护退出（${reason}），${delay}ms 后重启（第 ${attempt} 次）`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopping) return;
      try {
        const proc = spawnDaemon({ restart: true });
        if (proc) {
          restarts += 1;
          log(`[watchdog] 守护已重启（累计 ${restarts} 次）`);
        }
      } catch (err) {
        log(`[watchdog] 重启失败: ${err.message}`);
        scheduleRestart('spawn-failed');
      }
    }, delay);
    // 不因看护定时器阻止进程退出（HTTP 服务/测试会维持事件循环）
    if (typeof restartTimer.unref === 'function') restartTimer.unref();
  }

  function onChildExit(proc, code, signal) {
    if (child !== proc) return;
    child = null;
    const uptimeMs = spawnedAt ? Date.now() - spawnedAt : 0;
    lastExit = {
      code: Number.isInteger(code) ? code : null,
      signal: signal ?? null,
      at: new Date().toISOString(),
      uptimeMs,
      expected: stopping,
    };
    failAll(`chronicle-daemon exited unexpectedly (${binary})`);
    log(`[daemon] 守护退出 code=${code} signal=${signal} uptime=${uptimeMs}ms`);
    if (uptimeMs >= watchdog.stableMs) attempt = 0; // 稳定过 → 退避重置
    if (!stopping) scheduleRestart(`exit ${code ?? signal ?? 'unknown'}`);
  }

  function attach(proc) {
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
        if (msg.ok === true) {
          if (rec.trackIntent) updateAcquisitionFromCmd(rec.cmd, rec.params);
          rec.resolve(msg);
        } else rec.reject(new DaemonError(msg.error ?? 'daemon error', msg.code));
      }
    });
    if (proc.stderr) {
      let ebuf = '';
      proc.stderr.on('data', (chunk) => {
        ebuf += chunk.toString('utf8');
        let nl;
        while ((nl = ebuf.indexOf('\n')) >= 0) {
          const line = ebuf.slice(0, nl).replace(/\r$/, '');
          ebuf = ebuf.slice(nl + 1);
          if (line.trim() && onStderr) onStderr(line);
        }
        if (ebuf.length > 8192) { if (onStderr) onStderr(ebuf); ebuf = ''; }
      });
      proc.stderr.on('error', () => { /* 忽略 stderr 流错误 */ });
    }
    proc.on('exit', (code, signal) => onChildExit(proc, code, signal));
    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      lastExit = { code: null, signal: null, at: new Date().toISOString(), uptimeMs: 0, expected: stopping, error: err.message };
      failAll(`chronicle-daemon 启动失败: ${err.message}`);
      log(`[daemon] 启动失败: ${err.message}`);
      if (!stopping) scheduleRestart('spawn-error');
    });
  }

  function spawnDaemon({ restart = false, restore = true } = {}) {
    if (stopping) return null;
    if (child) return child;
    // 先确认二进制存在：缺失时懒拉起直接抛错且不动 pending 重启计数（避免计数多 1）
    if (!existsSync(binary)) {
      const err = new DaemonError(`守护二进制不存在: ${binary}（先跑 npm run setup 编译）`, 'NO_BINARY');
      if (!restart) throw err;
      log(`[watchdog] ${err.message}`);
      scheduleRestart('no-binary');
      return null;
    }
    let countedRestart = restart;
    if (!restart && restartTimer) {
      // 懒拉起（/api/status 等）时有待定的看护重启：不要静默吞掉，如实计数
      clearRestartTimer();
      restarts += 1;
      countedRestart = true;
      log(`[watchdog] 按需请求触发拉起（计入第 ${restarts} 次重启）`);
    }
    const args = opts.args ?? [];
    const shim = spawnShimPath(home, opts.env ?? process.env);
    const proc = shim
      ? spawn(shim, [binary, ...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(opts.env ?? {}), CHRONICLE_HOME: home },
        })
      : spawn(binary, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(opts.env ?? {}), CHRONICLE_HOME: home },
        });
    child = proc;
    spawnedAt = Date.now();
    attach(proc);
    // 进程复活不等于在记录：崩前在采集就自动恢复（崩前若暂停则保持暂停）
    if (restore && countedRestart) void restoreAcquisition(proc);
    return proc;
  }

  return {
    binary,
    home,
    /** 当前守护子进程（测试用；可能为 null）。 */
    proc: () => child,
    /** 看护统计（/api/status 与测试用）。 */
    stats: () => ({
      restarts,
      lastExit,
      spawnedAt: spawnedAt || null,
      restartPending: restartTimer !== null,
      restartAttempts: attempt,
      binary,
      home,
    }),
    /** 发一行请求，等对应 id 的响应；opts.timeoutMs 可为慢命令单次放宽。 */
    request(cmd, params = {}, opts = {}) {
      if (stopping) return Promise.reject(new DaemonError('守护已停止', 'DAEMON_STOPPED'));
      // 显式 start 自己会拉起，交给调用方；其他命令懒拉起时顺便恢复崩前采集
      if (!child) spawnDaemon({ restore: cmd !== 'start' });
      const id = nextId++;
      const callTimeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : timeoutMs;
      return new Promise((resolveP, rejectP) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectP(new DaemonError(`守护响应超时（${callTimeout}ms，cmd=${cmd}）`, 'DAEMON_TIMEOUT'));
        }, callTimeout);
        pending.set(id, { resolve: resolveP, reject: rejectP, timer, cmd, params, trackIntent: true });
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
    /** 结束守护进程（正常停止：不触发看护重启）；在途请求立即报 DAEMON_DEAD。 */
    stop() {
      stopping = true;
      clearRestartTimer();
      acquisition.started = false;
      acquisition.paused = false;
      acquisition.startParams = {};
      if (child) {
        const proc = child;
        child = null;
        lastExit = { code: null, signal: 'SIGTERM', at: new Date().toISOString(), uptimeMs: spawnedAt ? Date.now() - spawnedAt : 0, expected: true };
        try { proc.stdin.end(); } catch { /* 已退出 */ }
        try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
      }
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

// ---------- HTTP 服务 ----------

/** web/ 下允许静态返回的文件（白名单，杜绝路径穿越）。 */
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_SEGMENT_LIMIT = 20;
const MAX_SEGMENT_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 500;

// ---------- X2：摘要补充字段 / 技能 / 已观察应用与网站 ----------

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_NAME_MAX = 80;
const SKILL_DESCRIPTION_MAX = 2000;
const OBSERVED_SEGMENT_LIMIT = 20;
const OBSERVED_RESULT_LIMIT = 200;
const SUMMARY_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** 技能名 → 安全 slug：ASCII 小写连字符；纯中文/无 ASCII 时 skill-<sha1前8>。 */
export function slugifySkillName(name) {
  const raw = String(name ?? '').trim();
  const ascii = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (ascii) return ascii;
  return `skill-${createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
}

/** suggestion 容错归一化：只接受 {type:'skill', name, description}。 */
export function normalizeSkillSuggestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'skill') return null;
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  return {
    type: 'skill',
    name: value.name.trim(),
    description: typeof value.description === 'string' ? value.description : '',
  };
}

/** Z1 摘要 v7 next_actions → 稳定 [{action,reason}]（最多 3；坏数据 → []）。 */
export function normalizeNextActions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, 3)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.action !== 'string' || !item.action.trim()) continue;
    out.push({ action: item.action.trim(), reason: typeof item.reason === 'string' ? item.reason : '' });
  }
  return out;
}

/** 给 /api/summaries 的每条摘要补 description/suggestion/nextActions（坏文件容错 → null/[]）。 */
export function enrichSummaryList(home, summaries) {
  return (Array.isArray(summaries) ? summaries : []).map((item) => {
    let meta = null;
    try {
      const text = readSummary(home, item.filename);
      if (text !== null) meta = parseSummaryFile(text);
    } catch { meta = null; }
    return {
      ...item,
      description: typeof meta?.description === 'string' ? meta.description : null,
      suggestion: normalizeSkillSuggestion(meta?.suggestion),
      nextActions: normalizeNextActions(meta?.next_actions ?? meta?.nextActions),
    };
  });
}

/** 列出 <home>/skills/<slug>/SKILL.md（目录缺失 → []；非法 slug/坏文件跳过）。 */
export function listSkills(home = chronicleHome()) {
  const root = path.join(home, 'skills');
  if (!existsSync(root)) return [];
  let names;
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const slug of names) {
    if (!SKILL_SLUG_RE.test(slug)) continue;
    const dir = path.join(root, slug);
    try { if (lstatSync(dir).isSymbolicLink()) continue; } catch { continue; }
    const file = path.join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    let st;
    try { st = lstatSync(file); } catch { continue; }
    if (!st.isFile()) continue; // 符号链接/目录一律不列
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let meta = {};
    try { meta = parseSummaryFile(text); } catch { meta = {}; }
    out.push({
      slug,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : slug,
      description: typeof meta.description === 'string' ? meta.description : '',
      path: file,
      createdAt: typeof meta.createdAt === 'string' && meta.createdAt ? meta.createdAt : new Date(st.mtimeMs).toISOString(),
      bytes: st.size,
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.slug.localeCompare(b.slug));
}

// ---------- Z2：技能库 CRUD ----------

export const SKILL_MARKDOWN_MAX_BYTES = 64 * 1024;
const INSIGHT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function skillsRootPath(home) { return path.join(home, 'skills'); }

/**
 * 安全解析技能目录：slug 白名单 + 拒绝 symlink + realpath 父目录必须是 skills/。
 * @returns {{ok:true,dir:string,file:string}|{ok:false,status:number,error:string,code?:string}}
 */
export function resolveSkillDir(home, slug) {
  if (typeof slug !== 'string' || !SKILL_SLUG_RE.test(slug)) {
    return { ok: false, status: 404, error: '技能不存在' };
  }
  const root = skillsRootPath(home);
  const dir = path.join(root, slug);
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink()) return { ok: false, status: 400, error: 'skills 目录不得为符号链接', code: 'SYMLINK_REJECTED' };
    if (!rootStat.isDirectory()) return { ok: false, status: 404, error: '技能不存在' };
  } catch { return { ok: false, status: 404, error: '技能不存在' }; }
  let dirStat;
  try { dirStat = lstatSync(dir); } catch { return { ok: false, status: 404, error: '技能不存在' }; }
  if (dirStat.isSymbolicLink()) return { ok: false, status: 400, error: '拒绝访问符号链接', code: 'SYMLINK_REJECTED' };
  if (!dirStat.isDirectory()) return { ok: false, status: 404, error: '技能不存在' };
  try {
    const rootReal = realpathSync(root);
    const dirReal = realpathSync(dir);
    if (path.dirname(dirReal) !== rootReal) return { ok: false, status: 400, error: '路径越界', code: 'PATH_ESCAPE' };
  } catch { return { ok: false, status: 404, error: '技能不存在' }; }
  return { ok: true, dir, file: path.join(dir, 'SKILL.md') };
}

/** 读单个技能详情（含 SKILL.md 原文 markdown）；slug 非法/不存在 → status 404，symlink → 400。 */
export function readSkillDetail(home, slug) {
  const resolved = resolveSkillDir(home, slug);
  if (!resolved.ok) return resolved;
  let st;
  try { st = lstatSync(resolved.file); } catch { return { ok: false, status: 404, error: '技能不存在' }; }
  if (st.isSymbolicLink()) return { ok: false, status: 400, error: '拒绝访问符号链接', code: 'SYMLINK_REJECTED' };
  if (!st.isFile()) return { ok: false, status: 404, error: '技能不存在' };
  let markdown;
  try { markdown = readFileSync(resolved.file, 'utf8'); } catch { return { ok: false, status: 404, error: '技能不存在' }; }
  let meta = {};
  try { meta = parseSummaryFile(markdown); } catch { meta = {}; }
  return {
    ok: true,
    skill: {
      slug,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : slug,
      description: typeof meta.description === 'string' ? meta.description : '',
      path: resolved.file,
      createdAt: typeof meta.createdAt === 'string' && meta.createdAt ? meta.createdAt : new Date(st.mtimeMs).toISOString(),
      bytes: st.size,
      markdown,
    },
  };
}

/** 拆分技能 markdown 的 frontmatter（无 frontmatter → null）。 */
function splitFrontmatterMarkdown(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(String(markdown ?? ''));
  if (!m) return null;
  return { lines: m[1].split(/\r?\n/), body: m[2] };
}

function setFrontmatterField(lines, key, value) {
  const encoded = JSON.stringify(value);
  const re = new RegExp(`^${key}\\s*:`);
  let found = false;
  const next = lines.map((line) => {
    if (!found && re.test(line)) { found = true; return `${key}: ${encoded}`; }
    return line;
  });
  if (!found) next.push(`${key}: ${encoded}`);
  return next;
}

/** 行级更新 frontmatter 指定字段（保留未知字段与正文原样）。 */
export function updateSkillMarkdownFields(markdown, fields = {}) {
  const parts = splitFrontmatterMarkdown(markdown);
  if (!parts) return null;
  let lines = parts.lines;
  if (typeof fields.name === 'string') lines = setFrontmatterField(lines, 'name', fields.name);
  if (typeof fields.description === 'string') lines = setFrontmatterField(lines, 'description', fields.description);
  return `---\n${lines.join('\n')}\n---\n${parts.body}`;
}

/** 校验 PUT /api/skills/:slug 入参（未知字段忽略；至少一个可更新字段）。 */
export function validateSkillUpdateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体须为 JSON 对象' };
  const out = {};
  let provided = 0;
  if (body.markdown !== undefined) {
    if (typeof body.markdown !== 'string' || !body.markdown.trim()) return { ok: false, error: 'markdown 不能为空' };
    if (Buffer.byteLength(body.markdown, 'utf8') > SKILL_MARKDOWN_MAX_BYTES) {
      return { ok: false, error: `markdown 不能超过 ${Math.floor(SKILL_MARKDOWN_MAX_BYTES / 1024)}KB` };
    }
    out.markdown = body.markdown;
    provided += 1;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { ok: false, error: 'name 不能为空' };
    if (body.name.trim().length > SKILL_NAME_MAX) return { ok: false, error: `name 不能超过 ${SKILL_NAME_MAX} 字符` };
    out.name = body.name.trim();
    provided += 1;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { ok: false, error: 'description 须为字符串' };
    if (body.description.length > SKILL_DESCRIPTION_MAX) return { ok: false, error: `description 不能超过 ${SKILL_DESCRIPTION_MAX} 字符` };
    out.description = body.description;
    provided += 1;
  }
  if (provided === 0) return { ok: false, error: '至少提供 markdown/name/description 之一' };
  return { ok: true, ...out };
}

/** 原子写 0600（同目录临时文件 → rename；失败清理临时文件）。 */
function writeFileAtomic0600(file, contents) {
  const tmp = path.join(path.dirname(file), `.SKILL.md.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已清理 */ }
    throw error;
  }
}

// ---------- Z2：洞察（insights）只读列表/读取 + 生成器加载 ----------

function insightsDir(home) { return path.join(home, 'insights'); }

/** 列出 <home>/insights/*.md（目录缺失 → []；坏文件/无 frontmatter/symlink 跳过；generatedAt 倒序）。 */
export function listInsights(home = chronicleHome()) {
  const dir = insightsDir(home);
  if (!existsSync(dir)) return [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!INSIGHT_FILENAME_RE.test(name)) continue;
    const file = path.join(dir, name);
    let st;
    try { st = lstatSync(file); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!/^---\r?\n/.test(text)) continue; // 坏文件：无 frontmatter 跳过
    let meta = {};
    try { meta = parseSummaryFile(text); } catch { continue; }
    const generatedAt = typeof meta.generatedAt === 'string' && meta.generatedAt
      ? meta.generatedAt : new Date(st.mtimeMs).toISOString();
    out.push({
      file: name,
      range: typeof meta.range === 'string' ? meta.range : null,
      title: typeof meta.title === 'string' && meta.title ? meta.title : name,
      generatedAt,
      bytes: st.size,
      ...(typeof meta.sourceDigest === 'string' && meta.sourceDigest ? { sourceDigest: meta.sourceDigest } : {}),
    });
  }
  return out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)) || a.file.localeCompare(b.file));
}

/** 读单个洞察（文件名白名单 + symlink 拒绝；404/400 明确）。 */
export function readInsight(home, file) {
  const name = String(file ?? '');
  if (!INSIGHT_FILENAME_RE.test(name) || name.includes('..')) return { ok: false, status: 404, error: '洞察不存在' };
  const dir = insightsDir(home);
  const full = path.join(dir, name);
  let st;
  try { st = lstatSync(full); } catch { return { ok: false, status: 404, error: '洞察不存在' }; }
  if (st.isSymbolicLink()) return { ok: false, status: 400, error: '拒绝访问符号链接', code: 'SYMLINK_REJECTED' };
  if (!st.isFile()) return { ok: false, status: 404, error: '洞察不存在' };
  let text;
  try { text = readFileSync(full, 'utf8'); } catch { return { ok: false, status: 404, error: '洞察不存在' }; }
  let meta = {};
  try { meta = parseSummaryFile(text); } catch { meta = {}; }
  if (!/^---\r?\n/.test(text)) return { ok: false, status: 404, error: '洞察不存在' };
  const { body, ...frontmatter } = meta;
  return { ok: true, insight: { file: name, ...frontmatter, markdown: body ?? '' } };
}

/** 动态加载 shared/insights.mjs 的 generateInsight（Z1 未就绪 → null）。 */
async function loadInsightGenerator() {
  try {
    const mod = await import('./shared/insights.mjs');
    return typeof mod.generateInsight === 'function' ? mod.generateInsight : null;
  } catch { return null; }
}

function eventTsInfo(event) {
  if (Number.isInteger(event?.tsMs)) return { ms: event.tsMs, iso: new Date(event.tsMs).toISOString() };
  const t = Date.parse(event?.ts);
  if (Number.isFinite(t)) return { ms: t, iso: new Date(t).toISOString() };
  return null;
}

/**
 * GET /api/observed：最近 20 段里的应用与网站（只读、不建索引）。
 * @returns {{apps:Array<{bundleId,appName,eventCount,lastTs}>, domains:Array<{domain,eventCount,lastTs}>}}
 */
export function buildObserved(home = chronicleHome(), { limit = OBSERVED_SEGMENT_LIMIT } = {}) {
  const apps = new Map();
  const domains = new Map();
  const segs = listSegments(home).slice(0, Math.max(0, limit));
  for (const seg of segs) {
    const data = readSegmentEvents(home, seg.segment);
    if (!data || !Array.isArray(data.events)) continue;
    for (const event of data.events) {
      const type = event?.type;
      if (type !== 'app-switch' && type !== 'window-change' && type !== 'url-change') continue;
      const payload = event.data && typeof event.data === 'object' ? event.data : {};
      const ts = eventTsInfo(event);
      const bundleId = typeof payload.bundleId === 'string' ? payload.bundleId : '';
      if (bundleId) {
        const rec = apps.get(bundleId) ?? { bundleId, appName: '', eventCount: 0, lastTs: null, _ms: -1 };
        rec.eventCount += 1;
        if (typeof payload.appName === 'string' && payload.appName) rec.appName = payload.appName;
        if (ts && ts.ms >= rec._ms) { rec._ms = ts.ms; rec.lastTs = ts.iso; }
        apps.set(bundleId, rec);
      }
      if (type === 'url-change' && typeof payload.url === 'string' && payload.url) {
        let domain = '';
        try { domain = new URL(payload.url).hostname.toLowerCase(); } catch { domain = ''; }
        if (domain) {
          const rec = domains.get(domain) ?? { domain, eventCount: 0, lastTs: null, _ms: -1 };
          rec.eventCount += 1;
          if (ts && ts.ms >= rec._ms) { rec._ms = ts.ms; rec.lastTs = ts.iso; }
          domains.set(domain, rec);
        }
      }
    }
  }
  const byCount = (a, b) => b.eventCount - a.eventCount
    || String(b.lastTs).localeCompare(String(a.lastTs));
  const appList = [...apps.values()]
    .map(({ _ms, ...rest }) => ({ ...rest, appName: rest.appName || rest.bundleId }))
    .sort((a, b) => byCount(a, b) || a.bundleId.localeCompare(b.bundleId))
    .slice(0, OBSERVED_RESULT_LIMIT);
  const domainList = [...domains.values()]
    .map(({ _ms, ...rest }) => rest)
    .sort((a, b) => byCount(a, b) || a.domain.localeCompare(b.domain))
    .slice(0, OBSERVED_RESULT_LIMIT);
  return { apps: appList, domains: domainList };
}

/** 校验创建技能入参；file → 摘要 frontmatter.segment 作为证据；两者冲突报错。 */
export function validateSkillCreateInput(body, home = chronicleHome()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体须为 JSON 对象' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!name) return { ok: false, error: 'name 不能为空' };
  if (name.length > SKILL_NAME_MAX) return { ok: false, error: `name 不能超过 ${SKILL_NAME_MAX} 字符` };
  if (!description) return { ok: false, error: 'description 不能为空' };
  if (description.length > SKILL_DESCRIPTION_MAX) return { ok: false, error: `description 不能超过 ${SKILL_DESCRIPTION_MAX} 字符` };
  let sourceSegment = null;
  if (typeof body.sourceSegment === 'string' && body.sourceSegment.trim()) {
    sourceSegment = body.sourceSegment.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceSegment) || sourceSegment.includes('..')) {
      return { ok: false, error: 'sourceSegment 非法' };
    }
  }
  if (typeof body.file === 'string' && body.file.trim()) {
    const file = body.file.trim();
    if (!SUMMARY_FILENAME_RE.test(file) || file.includes('..')) return { ok: false, error: 'file 非法' };
    let parsed = null;
    try {
      const text = readSummary(home, file);
      if (text !== null) parsed = parseSummaryFile(text);
    } catch { parsed = null; }
    if (!parsed) return { ok: false, error: `摘要不存在或不可读: ${file}` };
    const fileSegment = typeof parsed.segment === 'string' ? parsed.segment : '';
    if (!fileSegment) return { ok: false, error: `摘要缺少 segment，无法作为技能证据: ${file}` };
    if (sourceSegment && sourceSegment !== fileSegment) return { ok: false, error: 'file 与 sourceSegment 冲突' };
    sourceSegment = fileSegment;
  }
  return { ok: true, name, description, sourceSegment };
}

/** 动态加载 summarize.mjs 的 generateSkillDraft（X1 未就绪 → null）。 */
async function loadSkillDraftGenerator() {
  try {
    const mod = await import('./summarize.mjs');
    return typeof mod.generateSkillDraft === 'function' ? mod.generateSkillDraft : null;
  } catch { return null; }
}

// ---------- 长期记忆（U2）：GET /api/memory 只读聚合 ----------

/** memory_summary.md / MEMORY.md 单文件读取上限（响应体保护）。 */
export const MEMORY_MARKDOWN_MAX_BYTES = 200 * 1024;
/** 最近摘要条数。 */
export const MEMORY_RECENT_LIMIT = 12;

const SEGMENT_NAME_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/;

/** 段目录名（UTC 紧凑）或 ISO 段名 → epoch ms；解析失败 null。 */
function segmentTsMs(segment) {
  if (typeof segment !== 'string' || !segment) return null;
  const m = SEGMENT_NAME_TS_RE.exec(segment);
  if (m) {
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
    return Number.isFinite(ms) ? ms : null;
  }
  const t = Date.parse(segment);
  return Number.isFinite(t) ? t : null;
}

function isoFromMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 读 markdown 文件（缺失/不可读 → null；超过上限只读前 200KB）。 */
function readCappedMarkdown(file, maxBytes = MEMORY_MARKDOWN_MAX_BYTES) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const buf = readFileSync(file);
    const text = (buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf).toString('utf8');
    return { text, mtimeMs: st.mtimeMs, truncated: buf.length > maxBytes };
  } catch { return null; }
}

/**
 * 最近 12 份 summaries/*.md（新→旧）。坏文件容错（缺 frontmatter 用文件名/空字段兜底）。
 * ts：优先 segment 解析（UTC），否则文件 mtime；file 仅 basename（固定目录，无路径穿越）。
 */
function readRecentMemorySummaries(home, limit = MEMORY_RECENT_LIMIT) {
  const dir = path.join(home, 'summaries');
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue; // _deadletter.log / 临时文件跳过
    const file = path.join(dir, name);
    let text = null;
    let mtimeMs = null;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    try { mtimeMs = statSync(file).mtimeMs; } catch { /* 忽略 */ }
    let parsed = {};
    try { parsed = parseSummaryFile(text); } catch { parsed = {}; }
    const segment = typeof parsed.segment === 'string' ? parsed.segment : '';
    const tsMs = segmentTsMs(segment) ?? (Number.isFinite(mtimeMs) ? mtimeMs : null);
    const type = typeof parsed.type === 'string' && parsed.type ? parsed.type : (name.startsWith('6h-') ? '6h' : '10min');
    items.push({
      file: name,
      type,
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : (segment || name),
      description: typeof parsed.description === 'string' ? parsed.description : '',
      segment,
      applications: Array.isArray(parsed.applications) ? parsed.applications.filter((x) => typeof x === 'string') : [],
      ts: isoFromMs(tsMs),
      _sortMs: Number.isFinite(tsMs) ? tsMs : 0,
    });
  }
  items.sort((a, b) => b._sortMs - a._sortMs || a.file.localeCompare(b.file));
  return items.slice(0, Math.max(0, limit)).map(({ _sortMs, ...rest }) => rest);
}

/**
 * GET /api/memory 的纯读取聚合（只读：不建索引、不写文件）。
 * 缺失文件 → 空串 + false；memoryMarkdown/summaryMarkdown 均截 200KB。
 */
export function buildMemoryPayload(home = chronicleHome()) {
  const summary = readCappedMarkdown(path.join(home, 'memory_summary.md'));
  const memory = readCappedMarkdown(path.join(home, 'MEMORY.md'));
  const recentSummaries = readRecentMemorySummaries(home);
  const stamps = [summary?.mtimeMs, memory?.mtimeMs,
    ...recentSummaries.map((r) => Date.parse(r.ts ?? ''))].filter((x) => Number.isFinite(x));
  const updatedAt = stamps.length ? isoFromMs(Math.max(...stamps)) : null;
  return {
    ok: true,
    memory: {
      summaryMarkdown: summary?.text ?? '',
      memoryMarkdown: memory?.text ?? '',
      updatedAt,
      hasSummary: Boolean(summary),
      hasMemory: Boolean(memory),
    },
    recentSummaries,
  };
}

/**
 * GET /api/work 的纯读取聚合：工作对象 + 异常 + 复盘 + 洞察。
 * 只读；不建文件、不改状态。
 */
export function buildWorkPayload(home = chronicleHome(), { cadence = 'today', type, state, query = '', projectId = '', limit = 50, status } = {}) {
  const safeCadence = ['today', 'week', 'month'].includes(cadence) ? cadence : 'today';
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return {
    ok: true,
    objects: listObjects(home, { type, state, query, project_id: projectId || undefined, limit: safeLimit }),
    exceptions: computeExceptions(home),
    review: reviewQueue(home, { cadence: safeCadence }),
    insights: listWorkInsights(home, { status, query, limit: safeLimit }),
    stats: workLedgerStats(home),
  };
}

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

export function isValidSegmentName(name) { return SEGMENT_NAME_RE.test(String(name ?? '')); }

export function allowedHostsFor(port) { return new Set([`127.0.0.1:${port}`, `localhost:${port}`]); }
export function allowedOriginsFor(port) { return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]); }

/**
 * 本地写请求安全边界：Host 必须是回环地址；Origin 若存在必须同源。
 * @returns {null | {status:number, error:string}}
 */
export function validateWriteRequest(req, { port } = {}) {
  const host = String(req.headers?.host ?? '');
  if (!allowedHostsFor(port).has(host)) {
    return { status: 403, error: `Host 不被允许: ${host || '(缺失)'}` };
  }
  const origin = req.headers?.origin;
  if (origin !== undefined && String(origin).length > 0 && !allowedOriginsFor(port).has(String(origin))) {
    return { status: 403, error: `Origin 不被允许: ${origin}` };
  }
  return null;
}

/** 带 body 的写请求必须声明 application/json（本地 CSRF 边界；GET 不检查）。 */
export function bodyContentTypeError(req) {
  const len = Number.parseInt(req.headers?.['content-length'] ?? '0', 10);
  const hasBody = (Number.isInteger(len) && len > 0) || req.headers?.['transfer-encoding'] !== undefined;
  if (!hasBody) return null;
  const ct = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return { status: 415, error: 'Content-Type 必须为 application/json' };
  }
  return null;
}

/**
 * 段目录解析：严格段名 + realpath 必须落在 <home>/segments 内。
 * @returns {{status:number, error:string} | {real:string}}
 */
export function resolveSegmentDir(home, segment) {
  if (!isValidSegmentName(segment)) return { status: 400, error: '非法段名' };
  const root = path.join(home, 'segments');
  let rootReal;
  try { rootReal = realpathSync(root); } catch { return { status: 404, error: 'segment not found' }; }
  let real;
  try { real = realpathSync(path.join(root, String(segment))); } catch { return { status: 404, error: 'segment not found' }; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { status: 400, error: '非法段路径' };
  return { real };
}

function parseBoundedInt(raw, { def, min, max }) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return def;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/**
 * 段列表分页。优先用 shared/segments.mjs 的 listSegmentsPaged（C 的实现），
 * 不存在时回退本地实现（新→旧，before 为上一页最后一段的名字）。
 */
export function listSegmentsPage(home, { limit, before } = {}) {
  const cap = parseBoundedInt(limit, { def: DEFAULT_SEGMENT_LIMIT, min: 1, max: MAX_SEGMENT_LIMIT });
  const beforeStr = before === null || before === undefined || String(before).length === 0 ? null : String(before);
  if (typeof segmentsModule.listSegmentsPaged === 'function') {
    try {
      const r = segmentsModule.listSegmentsPaged(home, { limit: cap, before: beforeStr });
      if (r && Array.isArray(r.items)) {
        return {
          items: r.items,
          hasMore: Boolean(r.hasMore),
          nextBefore: r.nextBefore ?? null,
          total: Number.isInteger(r.total) ? r.total : r.items.length,
        };
      }
    } catch { /* 回退本地实现 */ }
  }
  const all = listSegments(home);
  const filtered = beforeStr ? all.filter((s) => String(s.segment) < beforeStr) : all;
  const items = filtered.slice(0, cap);
  const hasMore = filtered.length > cap;
  return { items, hasMore, nextBefore: hasMore && items.length ? items[items.length - 1].segment : null, total: filtered.length };
}

function eventInRange(event, from, to) {
  if (!from && !to) return true;
  const rawTs = event?.ts ?? event?.segmentStart;
  const t = rawTs ? new Date(rawTs).getTime() : Number.NaN;
  if (Number.isNaN(t)) return true; // 时间不可解析时不过滤，避免丢数据
  if (from && !Number.isNaN(new Date(String(from)).getTime()) && t < new Date(String(from)).getTime()) return false;
  if (to && !Number.isNaN(new Date(String(to)).getTime()) && t > new Date(String(to)).getTime()) return false;
  return true;
}

/**
 * 搜索分页回退实现（shared/segments.mjs 的 searchEventsPaged 不存在时用）。
 * 统一成 C 的契约形状 {items,total,hasMore,indexed}，便于上层归一化。
 */
export function searchEventsPage(home, { q, limit, offset, from, to } = {}) {
  const cap = parseBoundedInt(limit, { def: DEFAULT_SEARCH_LIMIT, min: 1, max: MAX_SEARCH_LIMIT });
  const off = parseBoundedInt(offset, { def: 0, min: 0, max: 100_000 });
  const raw = searchEvents(home, { q, limit: Math.min(off + cap, MAX_SEARCH_LIMIT) });
  let events = Array.isArray(raw.events) ? raw.events : [];
  if (from || to) events = events.filter((e) => eventInRange(e, from, to));
  const items = events.slice(off, off + cap);
  const hasMore = events.length > off + cap;
  return { items, total: Math.max(raw.count ?? events.length, off + items.length + (hasMore ? 1 : 0)), hasMore, indexed: false, offset: off };
}

// ---------- /api/overview：单日聚合（只读；不建索引、不写文件） ----------

/** ruler 上限与聚合粒度（超过 500 条时按 5 分钟桶聚合成合成项）。 */
export const OVERVIEW_RULER_MAX = 500;
export const OVERVIEW_RULER_BUCKET_MS = 5 * 60 * 1000;
/** 同应用相邻区间间隔 ≤ 2s 视作连续，可合并。 */
export const OVERVIEW_MERGE_GAP_MS = 2000;
/**
 * activity：输入类事件；最后一次输入后 5 分钟内算亲手操作；按本地零点对齐的 5 分钟桶聚合。
 * app-switch 不在集合里：只有前台真的换了应用才算输入（见 buildOverview）。
 */
export const OVERVIEW_IDLE_MS = 5 * 60 * 1000;
export const OVERVIEW_ACTIVITY_BUCKET_MS = 5 * 60 * 1000;
export const OVERVIEW_ACTIVITY_APPS_MAX = 12;

/** 本地时区 YYYY-MM-DD。 */
function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function badOverviewDate(message) {
  const err = new Error(message);
  err.code = 'BAD_DATE';
  return err;
}

/**
 * 解析 overview 的 date 参数（本地时区 YYYY-MM-DD；缺省=今天）。
 * @returns {{date:string, dayStartMs:number, dayEndMs:number}}
 */
export function parseOverviewDate(dateStr, nowMs = Date.now()) {
  let value = dateStr;
  if (value === null || value === undefined || String(value).trim() === '') {
    value = localDateKey(nowMs);
  }
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw badOverviewDate('date 须为 YYYY-MM-DD（本地时区）');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (!Number.isFinite(start.getTime()) || start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw badOverviewDate('date 不是有效的日历日期');
  }
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { date: s, dayStartMs: start.getTime(), dayEndMs: end.getTime() };
}

function overviewEventTsMs(event) {
  if (event && Number.isInteger(event.tsMs)) return event.tsMs;
  const t = Date.parse(event?.ts);
  return Number.isFinite(t) ? t : null;
}

function overviewSegmentStartMs(seg) {
  const raw = seg?.segmentStart;
  if (typeof raw === 'string' && raw.length) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  const d = parseSegmentTs(seg?.segment);
  return d ? d.getTime() : Number.NaN;
}

function overviewSegmentEndMs(seg, nowMs) {
  const raw = seg?.segmentEnd;
  if (typeof raw === 'string' && raw.length) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  if (seg?.open) return nowMs;
  const start = overviewSegmentStartMs(seg);
  return Number.isFinite(start) ? start : Number.NaN;
}

function readSegmentMetadata(home, segment) {
  try {
    const meta = JSON.parse(readFileSync(path.join(home, 'segments', String(segment), 'metadata.json'), 'utf8'));
    return meta && typeof meta === 'object' ? meta : null;
  } catch { return null; }
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * overview.activity：把驻留区间拆成 active（[start, activeEnd)）与仅可见（其余）两部分。
 * 桶内 seenMs = 观测总时长（含 active），activeMs ⊆ seenMs；桶代表应用 = active 最多者，无 active 时取 seen 最多者。
 */
function buildOverviewActivity(intervals, { dayStartMs, firstInputMs, lastInputMs }) {
  const bucketMs = OVERVIEW_ACTIVITY_BUCKET_MS;
  const slots = new Map(); // slotStart → Map(appKey → {bundleId, appName, activeMs, seenMs})
  const activeByApp = new Map();
  let activeMs = 0;
  const addToSlots = (iv, key, startMs, endMs, active) => {
    for (let b = dayStartMs + Math.floor((startMs - dayStartMs) / bucketMs) * bucketMs; b < endMs; b += bucketMs) {
      const part = Math.min(endMs, b + bucketMs) - Math.max(startMs, b);
      if (part <= 0) continue;
      let byApp = slots.get(b);
      if (!byApp) { byApp = new Map(); slots.set(b, byApp); }
      let rec = byApp.get(key);
      if (!rec) { rec = { bundleId: iv.bundleId, appName: iv.appName, activeMs: 0, seenMs: 0 }; byApp.set(key, rec); }
      rec.seenMs += part;
      if (active) rec.activeMs += part;
      if (!rec.appName && iv.appName) rec.appName = iv.appName;
    }
  };
  for (const iv of intervals) {
    const key = iv.bundleId || `name:${iv.appName}`;
    const activeEnd = Math.min(Math.max(iv.activeEndMs, iv.startMs), iv.endMs);
    if (activeEnd > iv.startMs) {
      const part = activeEnd - iv.startMs;
      activeMs += part;
      const rec = activeByApp.get(key) ?? { bundleId: iv.bundleId, appName: iv.appName, activeMs: 0 };
      rec.activeMs += part;
      if (!rec.appName && iv.appName) rec.appName = iv.appName;
      activeByApp.set(key, rec);
      addToSlots(iv, key, iv.startMs, activeEnd, true);
    }
    if (iv.endMs > activeEnd) addToSlots(iv, key, activeEnd, iv.endMs, false);
  }
  const buckets = [];
  for (const startMs of [...slots.keys()].sort((a, b) => a - b)) {
    let slotActive = 0;
    let slotSeen = 0;
    let bestActive = null;
    let bestSeen = null;
    for (const rec of slots.get(startMs).values()) {
      slotActive += rec.activeMs;
      slotSeen += rec.seenMs;
      if (!bestActive || rec.activeMs > bestActive.activeMs) bestActive = rec;
      if (!bestSeen || rec.seenMs > bestSeen.seenMs) bestSeen = rec;
    }
    if (slotSeen <= 0) continue;
    const lead = slotActive > 0 ? bestActive : bestSeen;
    buckets.push({ startMs, bundleId: lead.bundleId, appName: lead.appName, activeMs: slotActive, seenMs: slotSeen });
  }
  const apps = [...activeByApp.values()]
    .filter((rec) => rec.activeMs > 0)
    .sort((a, b) => b.activeMs - a.activeMs || String(a.bundleId).localeCompare(String(b.bundleId)))
    .slice(0, OVERVIEW_ACTIVITY_APPS_MAX)
    .map(({ bundleId, appName, activeMs: ms }) => ({ bundleId, appName, activeMs: ms }));
  return {
    bucketMs,
    idleMs: OVERVIEW_IDLE_MS,
    activeMs,
    firstActiveMs: firstInputMs,
    lastActiveMs: lastInputMs,
    apps,
    buckets,
  };
}

/** 摘要时间窗：10min=10 分钟，6h=6 小时，其它按 10 分钟。 */
export const SUMMARY_SPAN_MS = Object.freeze({ '10min': 10 * 60 * 1000, '6h': 6 * 60 * 60 * 1000 });
export const SUMMARIES_LIMIT_MAX = 500;

/** 摘要起点：frontmatter segment（段名或 ISO）；缺失时回退到文件名里的段名。 */
function summaryStartMs(item) {
  const fromSegment = segmentTsMs(item?.segment);
  if (fromSegment !== null) return fromSegment;
  const stem = String(item?.filename ?? '').replace(/^[^-]+-/, '').replace(/\.md$/, '');
  return SEGMENT_NAME_TS_RE.test(stem) ? segmentTsMs(stem) : null;
}

/**
 * GET /api/summaries：补 startMs/spanMs，可选按本地日（时间窗重叠）、关键词、条数过滤（保持新→旧）。
 * 坏 date 抛 code=BAD_DATE。
 */
export function buildSummariesPayload(home, { date = null, q = null, limit = null, now = Date.now() } = {}) {
  let summaries = enrichSummaryList(home, listSummaries(home)).map((item) => ({
    ...item,
    startMs: summaryStartMs(item),
    spanMs: SUMMARY_SPAN_MS[item.type] ?? SUMMARY_SPAN_MS['10min'],
  }));
  if (date !== null && date !== undefined && String(date).trim() !== '') {
    const { dayStartMs, dayEndMs } = parseOverviewDate(date, now);
    summaries = summaries.filter((s) => s.startMs !== null && s.startMs < dayEndMs && s.startMs + s.spanMs > dayStartMs);
  }
  const needle = String(q ?? '').trim().toLowerCase();
  if (needle) {
    summaries = summaries.filter((s) => [s.title, s.description, s.body]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)));
  }
  const max = parseBoundedInt(limit, { def: null, min: 1, max: SUMMARIES_LIMIT_MAX });
  if (max !== null) summaries = summaries.slice(0, max);
  return { ok: true, summaries };
}

/** GET /api/days：按段起点的本地日分组（只读元信息，不建索引），新→旧。 */
export function buildDays(home) {
  const byDate = new Map();
  for (const seg of listSegments(home)) {
    const startMs = overviewSegmentStartMs(seg);
    if (!Number.isFinite(startMs)) continue;
    const date = localDateKey(startMs);
    const rec = byDate.get(date) ?? { date, segments: 0, events: 0 };
    rec.segments += 1;
    rec.events += Number.isInteger(seg.eventCount) ? seg.eventCount : 0;
    byDate.set(date, rec);
  }
  return { ok: true, days: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)) };
}

/**
 * 读某天事件并聚合成 overview（只读：listSegments + readSegmentEvents，不建索引/不写文件）。
 * @param {string} home 数据根
 * @param {{date?:string|null, now?:number, status?:object|null}} opts
 *   status 可传 /api/status 等价对象 {running,paused,currentSegment}；缺省时用 config.enabled + 最近段 open 近似。
 */
export function buildOverview(home, { date = null, now = Date.now(), status = null } = {}) {
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const { date: dateStr, dayStartMs, dayEndMs } = parseOverviewDate(date, nowMs);

  const allSegments = listSegments(home); // metadata 已有缓存；只读元信息
  const selected = [];
  for (const seg of allSegments) {
    const start = overviewSegmentStartMs(seg);
    const end = overviewSegmentEndMs(seg, nowMs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < dayEndMs && end > dayStartMs) selected.push(seg);
  }

  // 事件：只读与当天相交的段（.gz 由 shared 层透明解压），按 tsMs 升序
  const events = [];
  const contributedSegments = new Set();
  let suppressed = 0;
  for (const seg of selected) {
    const meta = readSegmentMetadata(home, seg.segment);
    if (meta && Number.isInteger(meta.suppressedEventCount)) suppressed += meta.suppressedEventCount;
    const data = readSegmentEvents(home, seg.segment);
    if (!data || !Array.isArray(data.events)) continue;
    const open = seg.open === true || !seg.segmentEnd;
    const endIso = seg.segmentEnd ?? meta?.segmentEnd ?? null;
    const segEndMs = endIso ? Date.parse(endIso) : null;
    for (const ev of data.events) {
      const tsMs = overviewEventTsMs(ev);
      if (tsMs === null || tsMs < dayStartMs || tsMs >= dayEndMs) continue;
      events.push({ tsMs, event: ev, open, segEndMs: Number.isFinite(segEndMs) ? segEndMs : null });
      contributedSegments.add(seg.segment);
    }
  }
  events.sort((a, b) => a.tsMs - b.tsMs);

  // bundleId → 应用名（事件里 appName 只出现在 app-switch 上；用于给
  // window/url/focus 起始的区间补名，避免 TOP 应用/缎带出现空白名称）
  const appNameByBundle = new Map();
  for (const { event } of events) {
    const d = event?.data;
    if (!d || typeof d !== 'object') continue;
    if (typeof d.bundleId === 'string' && d.bundleId && typeof d.appName === 'string' && d.appName) {
      if (!appNameByBundle.has(d.bundleId)) appNameByBundle.set(d.bundleId, d.appName);
    }
  }
  const displayAppName = (bundleId, rawName) => rawName || appNameByBundle.get(bundleId) || bundleId || '';

  // 每条事件的驻留区间：到下一条事件为止，但**绝不越过所在段的结束时间**：
  //  - 已关闭段：截到 metadata.segmentEnd，避免把段与段之间的空档（下班/关机）虚报成某应用时长；
  //  - open 段：截到 min(dayEnd, now)；
  //  - 同段内正常取下一事件。
  const intervals = [];
  const dwellByApp = new Map();
  const totalEvents = events.length;
  // 亲手操作：最近一次输入事件（含当前事件本身）之后 idleMs 内的驻留算 active。
  // 采集守护每 10 分钟换段时会给当前前台应用补一条同 bundleId 的 app-switch，
  // 那不是人在操作；只有前台真的换了应用才算输入，否则无人值守的整夜都会被算成「亲手」。
  let firstInputMs = null;
  let lastInputMs = null;
  let frontBundle = null;
  for (let i = 0; i < totalEvents; i += 1) {
    const cur = events[i];
    const type = cur.event?.type;
    const evBundle = typeof cur.event?.data?.bundleId === 'string' ? cur.event.data.bundleId : '';
    const isInput = type === 'app-switch'
      ? frontBundle !== null && evBundle !== '' && evBundle !== frontBundle
      : INPUT_EVENT_TYPES.has(type);
    if (evBundle) frontBundle = evBundle;
    if (isInput) {
      if (firstInputMs === null) firstInputMs = cur.tsMs;
      lastInputMs = cur.tsMs;
    }
    let endMs;
    if (i + 1 < totalEvents) {
      endMs = Math.min(events[i + 1].tsMs, dayEndMs);
      if (cur.open) endMs = Math.min(endMs, nowMs);
      else if (cur.segEndMs !== null && cur.segEndMs !== undefined) endMs = Math.min(endMs, cur.segEndMs);
    } else {
      // 当天最后一条：open 段截到 now；已关闭段保持 0（不虚报收盘后的空档）
      endMs = cur.open ? Math.min(dayEndMs, nowMs) : cur.tsMs;
    }
    endMs = Math.max(cur.tsMs, endMs);
    const ms = Math.max(0, endMs - cur.tsMs);
    const data = cur.event?.data && typeof cur.event.data === 'object' ? cur.event.data : {};
    const bundleId = typeof data.bundleId === 'string' ? data.bundleId : '';
    const appName = displayAppName(bundleId, typeof data.appName === 'string' ? data.appName : '');
    const key = bundleId || `name:${appName}`;
    const rec = dwellByApp.get(key) ?? { bundleId, appName, ms: 0, eventCount: 0 };
    rec.ms += ms;
    rec.eventCount += 1;
    if (!rec.appName && appName) rec.appName = appName;
    dwellByApp.set(key, rec);
    if (ms > 0) {
      const activeEndMs = lastInputMs !== null && lastInputMs + OVERVIEW_IDLE_MS > cur.tsMs
        ? Math.min(endMs, lastInputMs + OVERVIEW_IDLE_MS)
        : cur.tsMs;
      intervals.push({ bundleId, appName, startMs: cur.tsMs, endMs, activeEndMs });
    }
  }

  // ruler：连续同 bundleId 且间隔 ≤2s 合并；超过 500 条 → 5 分钟桶聚合
  const merged = [];
  for (const iv of intervals) {
    const startMs = Math.max(iv.startMs, dayStartMs);
    const endMs = Math.min(iv.endMs, dayEndMs);
    if (endMs <= startMs) continue;
    const last = merged[merged.length - 1];
    if (last && last.bundleId === iv.bundleId && startMs - last.endMs <= OVERVIEW_MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, endMs);
      if (!last.appName && iv.appName) last.appName = iv.appName;
    } else {
      merged.push({ bundleId: iv.bundleId, appName: iv.appName, startMs, endMs });
    }
  }
  let ruler = merged;
  if (merged.length > OVERVIEW_RULER_MAX) {
    const buckets = new Map(); // bucketStart -> Map(bundleId -> {ms, appName})
    for (const iv of merged) {
      const firstBucket = Math.floor(Math.max(iv.startMs, dayStartMs) / OVERVIEW_RULER_BUCKET_MS) * OVERVIEW_RULER_BUCKET_MS;
      for (let b = firstBucket; b < iv.endMs; b += OVERVIEW_RULER_BUCKET_MS) {
        const overlap = Math.min(iv.endMs, b + OVERVIEW_RULER_BUCKET_MS) - Math.max(iv.startMs, b);
        if (overlap <= 0) continue;
        const byApp = buckets.get(b) ?? new Map();
        const rec = byApp.get(iv.bundleId) ?? { ms: 0, appName: iv.appName };
        rec.ms += overlap;
        if (!rec.appName && iv.appName) rec.appName = iv.appName;
        byApp.set(iv.bundleId, rec);
        buckets.set(b, byApp);
      }
    }
    ruler = [];
    for (const b of [...buckets.keys()].sort((a, c) => a - c)) {
      const byApp = buckets.get(b);
      let best = null;
      for (const [bundleId, rec] of byApp.entries()) {
        if (!best || rec.ms > best.ms) best = { bundleId, ...rec };
      }
      if (!best) continue;
      ruler.push({
        bundleId: best.bundleId,
        appName: best.appName,
        startMs: Math.max(b, dayStartMs),
        endMs: Math.min(b + OVERVIEW_RULER_BUCKET_MS, dayEndMs),
      });
    }
  }
  if (ruler.length > OVERVIEW_RULER_MAX) ruler = ruler.slice(0, OVERVIEW_RULER_MAX);

  // topApps：按 app 合并驻留时长，前 8；share 以当天总观测时长为分母（0..1，3 位小数）
  const totalObservedMs = [...dwellByApp.values()].reduce((sum, rec) => sum + rec.ms, 0);
  const topApps = [...dwellByApp.values()]
    .sort((a, b) => b.ms - a.ms || b.eventCount - a.eventCount || String(a.bundleId).localeCompare(String(b.bundleId)))
    .slice(0, 8)
    .map((rec) => ({
      bundleId: rec.bundleId,
      appName: rec.appName,
      ms: rec.ms,
      share: totalObservedMs > 0 ? round3(rec.ms / totalObservedMs) : 0,
      eventCount: rec.eventCount,
    }));

  const firstTs = totalEvents ? new Date(events[0].tsMs).toISOString() : null;
  const lastTs = totalEvents ? new Date(events[totalEvents - 1].tsMs).toISOString() : null;
  const spanMs = totalEvents ? events[totalEvents - 1].tsMs - events[0].tsMs : 0;

  // recording：有实时状态用实时；否则 config.enabled + 最近 open 段近似（标记 approximate）
  let recording;
  const approximate = !status;
  if (status && typeof status === 'object') {
    const current = status.currentSegment && typeof status.currentSegment === 'object' ? status.currentSegment : null;
    const state = status.paused === true ? 'paused' : (status.running === true ? 'running' : 'stopped');
    recording = { state };
    if (current && typeof current.startTs === 'string') {
      const t = Date.parse(current.startTs);
      if (Number.isFinite(t)) recording.sinceMs = t;
    }
    recording.currentSegment = current
      ? { startTs: current.startTs ?? null, eventCount: Number.isInteger(current.eventCount) ? current.eventCount : 0 }
      : null;
  } else {
    const cfg = readConfigFile(home) ?? {};
    const enabled = cfg.enabled !== false;
    const latestOpen = allSegments.find((seg) => seg.open) ?? null;
    const running = enabled && Boolean(latestOpen);
    recording = { state: running ? 'running' : 'stopped', currentSegment: null };
    if (latestOpen) {
      const startMs = overviewSegmentStartMs(latestOpen);
      if (Number.isFinite(startMs)) recording.sinceMs = startMs;
      recording.currentSegment = { startTs: latestOpen.segmentStart ?? null, eventCount: latestOpen.eventCount ?? 0 };
    }
  }

  return {
    ok: true,
    date: dateStr,
    approximate,
    recording,
    span: { firstTs, lastTs, spanMs, segmentCount: contributedSegments.size },
    counts: { events: totalEvents, suppressed, segments: selected.length },
    topApps,
    ruler,
    segments: selected
      .map((seg) => ({
        segment: seg.segment,
        startMs: overviewSegmentStartMs(seg),
        endMs: seg.open ? null : overviewSegmentEndMs(seg, nowMs),
        eventCount: Number.isInteger(seg.eventCount) ? seg.eventCount : 0,
        open: seg.open === true,
      }))
      .sort((a, b) => a.startMs - b.startMs || a.segment.localeCompare(b.segment)),
    activity: buildOverviewActivity(intervals, { dayStartMs, firstInputMs, lastInputMs }),
  };
}

export function createHttpApp({ daemon, home, webDir = path.join(REPO_ROOT, 'web'), log = () => {}, skillDraftGenerator = undefined, insightGenerator = undefined, appIconRenderer = undefined } = {}) {
  const appIcons = createAppIconService({ home, renderer: appIconRenderer, log });
  const server = createServer(async (req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, headers);
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const sendJson = (code, obj) => send(code, obj, { 'Content-Type': 'application/json; charset=utf-8' });
    const auditWork = (action, obj, extra = {}) => {
      try { appendAudit(home, { actor: 'user', action, target: obj?.id || '', detail: { type: obj?.type, title: obj?.title, ...extra } }); } catch { /* 审计失败不影响主流程 */ }
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    const port = server.address()?.port ?? 0;
    try {
      // 写方法的安全边界（GET 保持宽松）
      if (WRITE_METHODS.has(req.method)) {
        const bad = validateWriteRequest(req, { port });
        if (bad) { log(`拒绝写请求（${bad.status}）: ${req.method} ${url.pathname}`); return sendJson(bad.status, { ok: false, error: bad.error }); }
        const ctErr = bodyContentTypeError(req);
        if (ctErr) { log(`拒绝写请求（${ctErr.status}）: ${req.method} ${url.pathname}`); return sendJson(ctErr.status, { ok: false, error: ctErr.error }); }
      }
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
      // 权限：辅助功能授权状态 / 触发 macOS 标准授权框（请求后系统设置里会出现该 app）
      if (req.method === 'GET' && url.pathname === '/api/permissions') {
        let probe = null;
        try { probe = await daemon.request('probe'); } catch (err) { probe = { error: err.message }; }
        return sendJson(200, {
          ok: true,
          axGranted: probe?.axGranted === true,
          screenGranted: probe?.screenGranted === true,
          secureInput: probe?.secureInput === true,
          error: probe?.error,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/permissions/card') {
        const body = await readBody(req).catch(() => null);
        const durationSec = Number.parseInt(body?.durationSec, 10);
        const r = await daemon.request('show-permission-card', {
          kind: 'accessibility',
          ...(Number.isInteger(durationSec) ? { durationSec } : {}),
        }).catch((err) => ({ error: err.message }));
        return sendJson(200, { ok: true, shown: r?.shown !== false, error: r?.error });
      }
      if (req.method === 'POST' && url.pathname === '/api/permissions/request') {
        const r = await daemon.request('request-permissions').catch((err) => ({ error: err.message }));
        return sendJson(200, { ok: true, axGranted: r?.axGranted === true, error: r?.error });
      }
      if (req.method === 'POST' && url.pathname === '/api/permissions/screen') {
        const r = await daemon.request('request-screen-permissions').catch((err) => ({ error: err.message }));
        return sendJson(200, { ok: true, screenGranted: r?.screenGranted === true, error: r?.error });
      }
      // 按需 OCR：用户显式点击才触发；单窗口、像素只在内存，文字写入本机事件与审计。
      if (req.method === 'POST' && url.pathname === '/api/ocr') {
        let r;
        try { r = await daemon.request('ocr-window', {}, { timeoutMs: 60_000 }); }
        catch (err) { return sendJson(503, { ok: false, error: err.message, code: err.code || 'DAEMON_UNAVAILABLE' }); }
        if (!r || r.ok === false) {
          const code = r?.code || 'OCR_FAILED';
          const status = code === 'SCREEN_PERMISSION_DENIED' ? 403
            : ['NOT_RUNNING', 'CONTENT_DISABLED', 'SECURE_INPUT', 'APP_BLOCKED', 'INCOGNITO', 'PRIVACY_BLOCKED'].includes(code) ? 409
              : 422;
          return sendJson(status, { ok: false, error: r?.error || 'OCR 失败', code });
        }
        const ocr = r.ocr && typeof r.ocr === 'object' ? r.ocr : {};
        try {
          appendAudit(home, {
            actor: 'user', action: 'ocr.capture', target: String(ocr.bundleId || ''),
            detail: { app: ocr.appName, window: ocr.windowTitle, lines: ocr.lineCount, chars: String(ocr.text || '').length, stored: r.stored !== false },
          });
        } catch { /* 审计失败不影响返回 */ }
        return sendJson(200, { ok: true, ocr, stored: r.stored !== false });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const st = await daemon.request('status');
        const info = typeof daemon.stats === 'function' ? daemon.stats() : {};
        return sendJson(200, {
          ok: true,
          status: st,
          daemonBinary: daemon.binary,
          pid: daemon.proc()?.pid ?? null,
          managerPid: process.pid,
          restarts: info.restarts ?? 0,
          lastExit: info.lastExit ?? null,
          uptimeMs: info.spawnedAt ? Date.now() - info.spawnedAt : null,
        });
      }
      // 应用真实图标（新 UI）：只读；跨站 <img> 探测已装应用 → 403；Host 须为本地回环
      if (req.method === 'GET' && url.pathname === '/api/app-icon') {
        const host = String(req.headers.host ?? '');
        const site = req.headers['sec-fetch-site'];
        if (!allowedHostsFor(port).has(host) || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
          return sendJson(403, { ok: false, error: '仅允许本机同源请求' });
        }
        const parsed = parseAppIconQuery(url.searchParams);
        if (parsed.error) return sendJson(400, { ok: false, error: parsed.error });
        const icon = await appIcons.get(parsed.target);
        if (icon.status !== 200) return sendJson(404, { ok: false, error: 'app icon not found' });
        const png = readFileSync(icon.file);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(png);
        return;
      }
      // 有记录的本地日列表（新 UI 日期导航）：只读段元信息，不建索引
      if (req.method === 'GET' && url.pathname === '/api/days') {
        return sendJson(200, buildDays(home));
      }
      // 单日聚合（W2）：只读；不建索引、不写文件。默认今天（本地时区）。
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        let status = null;
        try {
          // 仅在采集子进程已存在时问状态，避免为只读查询拉起守护
          if (typeof daemon.proc === 'function' && daemon.proc()) status = await daemon.request('status');
        } catch { status = null; }
        try {
          const payload = buildOverview(home, { date: url.searchParams.get('date'), status });
          return sendJson(200, payload);
        } catch (err) {
          if (err && err.code === 'BAD_DATE') return sendJson(400, { ok: false, error: err.message });
          throw err;
        }
      }
      // AI 工具接入信息（M3）：只读、无副作用 —— 不读段文件、不建索引、不含任何隐私内容。
      // 供 Web「接入 AI 工具」面板（/#ai）与菜单栏使用；契约字段名固定，勿改。
      if (req.method === 'GET' && url.pathname === '/api/integrations') {
        const nodePath = process.execPath;
        const mcpEntry = path.join(REPO_ROOT, 'mcp-entry.mjs');
        const installerScript = path.join(REPO_ROOT, 'mcp-install.mjs');
        const userHome = os.homedir();
        // 双引号包裹（用于片段展示，含空格路径也安全）
        const dq = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        // shell 参数：安全字符直接给，其余双引号包裹并转义
        const shellArg = (value) => {
          const str = String(value);
          return /^[\w@%+=:,./-]+$/.test(str) ? str : `"${str.replace(/"/g, '\\"')}"`;
        };
        const shellCommand = (args) => args.map(shellArg).join(' ');
        // JSON 形态（mcpServers / servers），路径由 JSON.stringify 负责安全转义
        const jsonSnippet = (wrapperKey, { stdio = false } = {}) => JSON.stringify({
          [wrapperKey]: {
            chronicle: stdio
              ? { type: 'stdio', command: nodePath, args: [mcpEntry] }
              : { command: nodePath, args: [mcpEntry] },
          },
        }, null, 2);
        // TOML 形态：反斜杠与双引号转义
        const tomlValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const appSupport = path.join(userHome, 'Library', 'Application Support');
        return sendJson(200, {
          ok: true,
          repoRoot: REPO_ROOT,
          nodePath,
          mcpEntry,
          home: path.resolve(home),
          port,
          tools: [
            {
              id: 'claude-code',
              label: 'Claude Code',
              kind: 'cli',
              snippet: `claude mcp add chronicle -- ${dq(nodePath)} ${dq(mcpEntry)}`,
              note: '命令行接入：需要已安装该客户端 CLI；执行后立即可用（不写配置文件）。',
              iconApp: 'Claude',
            },
            {
              id: 'claude-desktop',
              label: 'Claude Desktop',
              kind: 'json',
              path: path.join(appSupport, 'Claude', 'claude_desktop_config.json'),
              snippet: jsonSnippet('mcpServers'),
              iconApp: 'Claude',
              note: '合并进 mcpServers 后重启该客户端。',
            },
            {
              id: 'cursor',
              label: 'Cursor',
              kind: 'json',
              path: path.join(userHome, '.cursor', 'mcp.json'),
              snippet: jsonSnippet('mcpServers'),
              iconApp: 'Cursor',
              note: '写入后在 MCP 设置里启用 chronicle。',
            },
            {
              id: 'codex',
              label: 'Codex',
              kind: 'toml',
              path: path.join(userHome, '.codex', 'config.toml'),
              snippet: `[mcp_servers.chronicle]\ncommand = "${tomlValue(nodePath)}"\nargs = ["${tomlValue(mcpEntry)}"]`,
              iconApp: 'Codex',
              note: '追加到配置文件末尾；已存在同名段则不要重复追加。',
            },
            {
              id: 'vscode',
              label: 'VS Code',
              kind: 'json',
              path: path.join(appSupport, 'Code', 'User', 'mcp.json'),
              snippet: jsonSnippet('servers', { stdio: true }),
              iconApp: 'Visual Studio Code',
              note: '该客户端使用 servers 字段，且需要 type: "stdio"。',
            },
          ],
          installer: {
            command: shellCommand([nodePath, installerScript, '--target', 'all', '--yes']),
            printCommand: shellCommand([nodePath, installerScript, '--print']),
          },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/segments') {
        const page = listSegmentsPage(home, {
          limit: url.searchParams.get('limit'),
          before: url.searchParams.get('before'),
        });
        // 向后兼容：旧字段 segments 保留（现在是当前页）；新增 items/hasMore/nextBefore
        return sendJson(200, {
          ok: true,
          segments: page.items,
          items: page.items,
          count: page.items.length,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
        });
      }
      if (req.method === 'GET' && /^\/api\/segment\/[^/]+\/events$/.test(url.pathname)) {
        let seg;
        try { seg = decodeURIComponent(url.pathname.split('/')[3]); } catch { return sendJson(400, { ok: false, error: '非法段名' }); }
        const resolved = resolveSegmentDir(home, seg);
        if (resolved.error) return sendJson(resolved.status, { ok: false, error: resolved.error });
        const data = readSegmentEvents(home, seg, { withSuppressed: url.searchParams.get('withSuppressed') === '1' });
        if (!data) return sendJson(404, { ok: false, error: 'segment not found' });
        return sendJson(200, { ok: true, ...data });
      }
      // U2 长期记忆视图：只读聚合（memory_summary.md / MEMORY.md / summaries/*.md）
      if (req.method === 'GET' && url.pathname === '/api/memory') {
        return sendJson(200, buildMemoryPayload(home));
      }
      // P0 采集覆盖：近 N 天每个应用的 AX 内容覆盖与盲区（只读）
      if (req.method === 'GET' && url.pathname === '/api/coverage') {
        const p = url.searchParams;
        try {
          return sendJson(200, buildCoverage(home, { days: p.get('days') || 7 }));
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
      }
      // P4 团队/交接包：导出工作对象与洞察（不含原始事件）
      if (req.method === 'GET' && url.pathname === '/api/team/pack') {
        const p = url.searchParams;
        try {
          const pack = buildTeamPack(home, {
            projectId: p.get('projectId') || p.get('project') || '',
            days: p.get('days') || 30,
          });
          return sendJson(200, { ok: true, pack });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/team/import') {
        try {
          const body = await readBody(req);
          const pack = body && body.pack ? body.pack : body;
          const result = importTeamPack(home, pack);
          appendAudit(home, {
            actor: 'user', action: 'team.import', target: pack && pack.generated_at ? String(pack.generated_at) : '',
            detail: { imported: result.imported, skipped: result.skipped.length },
          });
          return sendJson(200, { ok: true, ...result });
        } catch (err) {
          return sendJson(err.code === 'BAD_PACK' ? 400 : 500, { ok: false, error: err.message, code: err.code || 'IMPORT_FAILED' });
        }
      }
      // P1 工作账本：对象/异常/复盘/洞察（只读聚合）
      if (req.method === 'GET' && url.pathname === '/api/work') {
        const p = url.searchParams;
        try {
          return sendJson(200, buildWorkPayload(home, {
            cadence: p.get('cadence') || 'today',
            type: p.get('type') || undefined,
            state: p.get('state') || undefined,
            query: p.get('q') || p.get('query') || '',
            projectId: p.get('projectId') || p.get('project') || '',
            limit: p.get('limit') || 50,
            status: p.get('status') || undefined,
          }));
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/work/pack') {
        try {
          const p = url.searchParams;
          const pack = buildContextPack(home, {
            objectIds: (p.get('objectId') || p.get('object') || '').split(',').map((s) => s.trim()).filter(Boolean),
            projectId: p.get('projectId') || p.get('project') || '',
            limit: p.get('limit') || 100,
          });
          return sendJson(200, { ok: true, pack });
        } catch (err) {
          return sendJson(err.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const p = url.searchParams;
        try {
          return sendJson(200, { ok: true, events: listAudit(home, { date: p.get('date') || new Date(), limit: p.get('limit') || 200 }) });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        return sendJson(200, { ok: true, agents: listAgents(home) });
      }
      if (req.method === 'POST' && url.pathname === '/api/agents') {
        try {
          const body = await readBody(req);
          const agent = registerAgent(home, body);
          try { appendAudit(home, { actor: 'user', action: 'agent.register', target: agent.id, detail: { name: agent.name, level: agent.default_level } }); } catch { /* ignore */ }
          return sendJson(201, { ok: true, agent });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      const agentGrantMatch = /^\/api\/agents\/([^/]+)\/grants$/.exec(url.pathname);
      if (agentGrantMatch && req.method === 'POST') {
        try {
          const id = decodeURIComponent(agentGrantMatch[1]);
          const body = await readBody(req);
          const grant = grantPermission(home, id, body);
          try { appendAudit(home, { actor: 'user', action: 'agent.grant', target: id, detail: { level: grant.level, scopes: grant.scopes, expires_at: grant.expires_at } }); } catch { /* ignore */ }
          return sendJson(201, { ok: true, grant });
        } catch (err) {
          return sendJson(err.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      const agentGrantDeleteMatch = /^\/api\/agents\/([^/]+)\/grants\/([^/]+)$/.exec(url.pathname);
      if (agentGrantDeleteMatch && req.method === 'DELETE') {
        try {
          return sendJson(200, { ok: true, ...revokeGrant(home, decodeURIComponent(agentGrantDeleteMatch[1]), decodeURIComponent(agentGrantDeleteMatch[2])) });
        } catch (err) {
          return sendJson(err.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      const agentCheckMatch = /^\/api\/agents\/([^/]+)\/check$/.exec(url.pathname);
      if (agentCheckMatch && req.method === 'POST') {
        try {
          const body = await readBody(req);
          return sendJson(200, { ok: true, ...checkPermission(home, decodeURIComponent(agentCheckMatch[1]), body) });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      const agentActMatch = /^\/api\/agents\/([^/]+)\/act$/.exec(url.pathname);
      if (agentActMatch && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const r = executeAgentAction(home, decodeURIComponent(agentActMatch[1]), body.action, body.params || {},
            { now: body.now ? new Date(body.now) : new Date() });
          return sendJson(200, { ok: true, ...r });
        } catch (err) {
          const code = err.code || 'BAD_INPUT';
          const status = code === 'PERMISSION_DENIED' ? 403 : code === 'NOT_FOUND' || code === 'AGENT_NOT_FOUND' ? 404 : 400;
          return sendJson(status, { ok: false, error: err.message, code });
        }
      }
      const auditUndoMatch = /^\/api\/audit\/([^/]+)\/undo$/.exec(url.pathname);
      if (auditUndoMatch && req.method === 'POST') {
        try {
          const r = undoAgentAction(home, decodeURIComponent(auditUndoMatch[1]), { now: new Date() });
          return sendJson(200, { ok: true, ...r });
        } catch (err) {
          const code = err.code || 'BAD_INPUT';
          return sendJson(code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code });
        }
      }
      const agentOutcomeMatch = /^\/api\/agents\/([^/]+)\/outcome$/.exec(url.pathname);
      if (agentOutcomeMatch && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const agent = recordAgentOutcome(home, decodeURIComponent(agentOutcomeMatch[1]), body);
          return sendJson(200, { ok: true, agent });
        } catch (err) {
          return sendJson(err.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      // P1 工作账本：写入/更新/归档/洞察生命周期
      if (req.method === 'POST' && url.pathname === '/api/work/objects') {
        try {
          const body = await readBody(req);
          const obj = createWorkObject(home, body);
          auditWork('work.create', obj);
          return sendJson(201, { ok: true, object: obj });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/work/insights') {
        try {
          const body = await readBody(req);
          const obj = createWorkInsight(home, body);
          auditWork('insight.create', obj);
          return sendJson(201, { ok: true, object: obj });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      const workObjectMatch = /^\/api\/work\/objects\/([^/]+)$/.exec(url.pathname);
      if (workObjectMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        let id;
        try { id = decodeURIComponent(workObjectMatch[1]); } catch { return sendJson(400, { ok: false, error: '非法 id' }); }
        try {
          const body = req.method === 'PATCH' ? await readBody(req) : (await readBody(req).catch(() => ({})));
          const obj = req.method === 'PATCH' ? updateWorkObject(home, id, body) : archiveWorkObject(home, id, body?.reason || 'manual');
          auditWork(req.method === 'PATCH' ? 'work.update' : 'work.archive', obj, req.method === 'PATCH' ? { fields: Object.keys(body || {}) } : { reason: body?.reason || 'manual' });
          return sendJson(200, { ok: true, object: obj });
        } catch (err) {
          return sendJson(err.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      const workInsightMatch = /^\/api\/work\/insights\/([^/]+)\/(validate|refute|apply|retire)$/.exec(url.pathname);
      if (workInsightMatch && req.method === 'POST') {
        let id;
        try { id = decodeURIComponent(workInsightMatch[1]); } catch { return sendJson(400, { ok: false, error: '非法 id' }); }
        try {
          const body = (await readBody(req).catch(() => ({}))) || {};
          const action = workInsightMatch[2];
          const obj = action === 'validate' ? validateWorkInsight(home, id, { note: body.note })
            : action === 'refute' ? validateWorkInsight(home, id, { refute: true, note: body.note })
              : action === 'apply' ? applyWorkInsight(home, id, { appliedTo: body.appliedTo || body.to, note: body.note })
                : retireWorkInsight(home, id, body.reason || 'retired');
          auditWork('insight.' + action, obj);
          return sendJson(200, { ok: true, object: obj });
        } catch (err) {
          return sendJson(err.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: err.message, code: err.code || 'BAD_INPUT' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/summaries') {
        // X2：补 description / suggestion；新 UI：startMs/spanMs + ?date=&q=&limit= 过滤（新→旧）
        try {
          return sendJson(200, buildSummariesPayload(home, {
            date: url.searchParams.get('date'),
            q: url.searchParams.get('q'),
            limit: url.searchParams.get('limit'),
          }));
        } catch (err) {
          if (err && err.code === 'BAD_DATE') return sendJson(400, { ok: false, error: err.message });
          throw err;
        }
      }
      // X2 技能：只读列出 <home>/skills/<slug>/SKILL.md（目录缺失 → 空数组）
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        return sendJson(200, { ok: true, skills: listSkills(home) });
      }
      // X2 技能创建：POST（Host/Origin/Content-Type 已在上方统一校验）
      if (req.method === 'POST' && url.pathname === '/api/skills/create') {
        const body = await readBody(req);
        const input = validateSkillCreateInput(body, home);
        if (!input.ok) return sendJson(400, { ok: false, error: input.error, code: 'INVALID_INPUT' });
        const slug = slugifySkillName(input.name);
        const root = path.join(home, 'skills');
        const dir = path.join(root, slug);
        if (existsSync(dir)) {
          const existing = listSkills(home).find((item) => item.slug === slug) ?? { slug };
          return sendJson(409, { ok: false, error: '同名技能已存在', code: 'SKILL_EXISTS', existing });
        }
        let generator = skillDraftGenerator;
        if (generator === null) {
          return sendJson(501, { ok: false, error: '技能草稿生成器未就绪（summarize.generateSkillDraft 缺失）', code: 'SKILL_GENERATOR_UNAVAILABLE' });
        }
        if (typeof generator !== 'function') generator = await loadSkillDraftGenerator();
        if (typeof generator !== 'function') {
          return sendJson(501, { ok: false, error: '技能草稿生成器未就绪（summarize.generateSkillDraft 缺失）', code: 'SKILL_GENERATOR_UNAVAILABLE' });
        }
        let draft;
        try {
          draft = await generator(home, {
            name: input.name,
            description: input.description,
            sourceSegment: input.sourceSegment,
          });
        } catch (error) {
          return sendJson(500, { ok: false, error: `技能草稿生成失败: ${String(error?.message ?? error).slice(0, 200)}`, code: 'SKILL_GENERATION_FAILED' });
        }
        if (!draft || draft.ok !== true || typeof draft.markdown !== 'string' || !draft.markdown.trim()) {
          const detail = typeof draft?.error === 'string' && draft.error ? draft.error : '技能草稿生成失败（空结果）';
          return sendJson(500, { ok: false, error: detail, code: 'SKILL_GENERATION_FAILED' });
        }
        const file = path.join(dir, 'SKILL.md');
        try {
          mkdirSync(root, { recursive: true, mode: 0o700 });
          try { chmodSync(root, 0o700); } catch { /* 尽力 */ }
          try {
            mkdirSync(dir, { mode: 0o700 });
          } catch (error) {
            if (error?.code === 'EEXIST') return sendJson(409, { ok: false, error: '同名技能已存在', code: 'SKILL_EXISTS', existing: { slug } });
            throw error;
          }
          const tmp = path.join(dir, `.SKILL.md.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
          try {
            writeFileSync(tmp, draft.markdown, { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, file); // 原子替换目标文件（目录是新建的，无并发覆盖）
            chmodSync(file, 0o600);
          } catch (error) {
            try { unlinkSync(tmp); } catch { /* 已清理 */ }
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ }
            try { rmSync(root, { recursive: false, force: false }); } catch { /* 非空/已被并发使用则保留 */ }
            throw error;
          }
        } catch (error) {
          return sendJson(500, { ok: false, error: `技能写入失败: ${String(error?.message ?? error).slice(0, 200)}`, code: 'SKILL_WRITE_FAILED' });
        }
        const created = listSkills(home).find((item) => item.slug === slug) ?? {
          slug, name: input.name, description: input.description, path: file,
          createdAt: new Date().toISOString(), bytes: Buffer.byteLength(draft.markdown),
        };
        return sendJson(200, { ok: true, skill: created });
      }
      // Z2 技能详情 / 更新 / 删除（slug 白名单 + symlink/穿越拒绝；PUT/DELETE 已过写接口安全校验）
      if (url.pathname.startsWith('/api/skills/') && url.pathname !== '/api/skills/create') {
        let slug = '';
        try { slug = decodeURIComponent(url.pathname.slice('/api/skills/'.length)); } catch { slug = ''; }
        if (!slug || slug.includes('/') || slug.includes('\\')) return sendJson(404, { ok: false, error: '技能不存在' });
        if (req.method === 'GET') {
          const detail = readSkillDetail(home, slug);
          if (!detail.ok) return sendJson(detail.status, { ok: false, error: detail.error, ...(detail.code ? { code: detail.code } : {}) });
          return sendJson(200, { ok: true, skill: detail.skill });
        }
        if (req.method === 'PUT') {
          const existing = readSkillDetail(home, slug);
          if (!existing.ok) return sendJson(existing.status, { ok: false, error: existing.error, ...(existing.code ? { code: existing.code } : {}) });
          const body = await readBody(req);
          const input = validateSkillUpdateInput(body);
          if (!input.ok) return sendJson(400, { ok: false, error: input.error, code: 'INVALID_INPUT' });
          let markdown = input.markdown !== undefined ? input.markdown : existing.skill.markdown;
          if (!splitFrontmatterMarkdown(markdown)) {
            return sendJson(400, { ok: false, error: 'markdown 须包含 --- frontmatter ---', code: 'INVALID_FRONTMATTER' });
          }
          if (input.name !== undefined || input.description !== undefined) {
            const updated = updateSkillMarkdownFields(markdown, { name: input.name, description: input.description });
            if (updated === null) return sendJson(400, { ok: false, error: 'markdown 须包含 --- frontmatter ---', code: 'INVALID_FRONTMATTER' });
            markdown = updated;
          }
          try {
            writeFileAtomic0600(existing.skill.path, markdown);
          } catch (error) {
            return sendJson(500, { ok: false, error: `技能写入失败: ${String(error?.message ?? error).slice(0, 200)}`, code: 'SKILL_WRITE_FAILED' });
          }
          const after = readSkillDetail(home, slug);
          if (!after.ok) return sendJson(after.status, { ok: false, error: after.error });
          return sendJson(200, { ok: true, skill: after.skill });
        }
        if (req.method === 'DELETE') {
          const resolved = resolveSkillDir(home, slug);
          if (!resolved.ok) return sendJson(resolved.status, { ok: false, error: resolved.error, ...(resolved.code ? { code: resolved.code } : {}) });
          try {
            rmSync(resolved.dir, { recursive: true, force: false });
          } catch (error) {
            return sendJson(500, { ok: false, error: `技能删除失败: ${String(error?.message ?? error).slice(0, 200)}`, code: 'SKILL_DELETE_FAILED' });
          }
          return sendJson(200, { ok: true, deleted: slug });
        }
      }
      // Z2 洞察：只读列表（目录缺失 → []；坏文件跳过；generatedAt 倒序）
      if (req.method === 'GET' && url.pathname === '/api/insights') {
        return sendJson(200, { ok: true, insights: listInsights(home) });
      }
      // Z2 洞察生成：POST（写校验已统一执行；生成器可注入 fake；失败不落半成品由生成器契约保证）
      if (req.method === 'POST' && url.pathname === '/api/insights/generate') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(400, { ok: false, error: '请求体须为 JSON 对象', code: 'INVALID_INPUT' });
        }
        const range = body.range === undefined ? 'week' : body.range;
        if (range !== 'day' && range !== 'week') {
          return sendJson(400, { ok: false, error: 'range 须为 "day" 或 "week"', code: 'INVALID_INPUT' });
        }
        if (body.force !== undefined && typeof body.force !== 'boolean') {
          return sendJson(400, { ok: false, error: 'force 须为布尔值', code: 'INVALID_INPUT' });
        }
        let generator = insightGenerator;
        if (generator === null) {
          return sendJson(501, { ok: false, error: '洞察生成器未就绪（shared/insights.mjs 缺失 generateInsight）', code: 'INSIGHT_GENERATOR_UNAVAILABLE' });
        }
        if (typeof generator !== 'function') generator = await loadInsightGenerator();
        if (typeof generator !== 'function') {
          return sendJson(501, { ok: false, error: '洞察生成器未就绪（shared/insights.mjs 缺失 generateInsight）', code: 'INSIGHT_GENERATOR_UNAVAILABLE' });
        }
        let result;
        try {
          result = await generator(home, { range, force: body.force === true });
        } catch (error) {
          const code = error?.code || 'INSIGHT_GENERATION_FAILED';
          if (isTransientAnalysisError(code)) {
            const queued = enqueueInsightRequest(home, { range, force: body.force === true, error: String(error?.message ?? error), code });
            return sendJson(503, { ok: false, queued: true, code, error: '模型暂时不可用，已加入补跑队列', detail: String(error?.message ?? error).slice(0, 200), queue: queued });
          }
          return sendJson(500, { ok: false, error: `洞察生成失败: ${String(error?.message ?? error).slice(0, 200)}`, code });
        }
        if (result && result.ok === false && isTransientAnalysisError(result.code)) {
          const queued = enqueueInsightRequest(home, { range, force: body.force === true, error: result.error, code: result.code });
          return sendJson(503, { ok: false, queued: true, code: result.code, error: '模型暂时不可用，已加入补跑队列', detail: result.error, queue: queued });
        }
        if (result && result.ok === true) {
          // Z1 generateInsight 成功返回 {ok:true,file,sourceDigest,summaries,...}（file 可能是绝对路径）；
          // 统一读回 {file, ...frontmatter, markdown} 形态供 V1 渲染。
          let insight = result.insight && typeof result.insight === 'object' ? result.insight : null;
          const targetFile = typeof result.file === 'string' ? path.basename(result.file) : '';
          if (!insight && targetFile) {
            const detail = readInsight(home, targetFile);
            if (detail.ok) insight = detail.insight;
          }
          if (!insight && targetFile) {
            insight = { file: targetFile, range, title: '', generatedAt: new Date().toISOString() };
          }
          return sendJson(200, {
            ok: true,
            insight,
            ...(typeof result.skipped === 'string' ? { skipped: result.skipped } : {}),
          });
        }
        const code = typeof result?.code === 'string' ? result.code : 'INSIGHT_GENERATION_FAILED';
        const message = typeof result?.error === 'string' && result.error ? result.error : '洞察生成失败';
        if (code === 'NO_SUMMARIES') return sendJson(409, { ok: false, code: 'NO_SUMMARIES', error: message });
        if (code === 'INSIGHT_GENERATOR_UNAVAILABLE') return sendJson(501, { ok: false, code, error: message });
        return sendJson(500, { ok: false, code: 'INSIGHT_GENERATION_FAILED', error: message });
      }
      // Z2 洞察详情：GET /api/insights/:file（文件名白名单 + symlink/穿越拒绝）
      if (req.method === 'GET' && url.pathname.startsWith('/api/insights/')) {
        let file = '';
        try { file = decodeURIComponent(url.pathname.slice('/api/insights/'.length)); } catch { file = ''; }
        if (!file || file.includes('/') || file.includes('\\')) return sendJson(404, { ok: false, error: '洞察不存在' });
        const detail = readInsight(home, file);
        if (!detail.ok) return sendJson(detail.status, { ok: false, error: detail.error, ...(detail.code ? { code: detail.code } : {}) });
        return sendJson(200, { ok: true, insight: detail.insight });
      }
      // X2 权限选择：最近 20 段的应用/网站聚合（只读、不建索引）
      if (req.method === 'GET' && url.pathname === '/api/observed') {
        return sendJson(200, { ok: true, ...buildObserved(home, { limit: OBSERVED_SEGMENT_LIMIT }) });
      }
      if (req.method === 'GET' && /^\/api\/summaries\/[^/]+$/.test(url.pathname)) {
        let name;
        try { name = decodeURIComponent(url.pathname.split('/')[3]); } catch { return sendJson(404, { ok: false, error: 'summary not found' }); }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name) || name.includes('..')) {
          return sendJson(404, { ok: false, error: 'summary not found' });
        }
        // realpath 必须落在 <home>/summaries 内（防符号链接穿越）
        const summariesRoot = path.join(home, 'summaries');
        const file = path.join(summariesRoot, name);
        if (!existsSync(file)) return sendJson(404, { ok: false, error: 'summary not found' });
        try {
          const rootReal = realpathSync(summariesRoot);
          const real = realpathSync(file);
          if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return sendJson(404, { ok: false, error: 'summary not found' });
        } catch { return sendJson(404, { ok: false, error: 'summary not found' }); }
        const markdown = readSummary(home, name);
        if (markdown === null) return sendJson(404, { ok: false, error: 'summary not found' });
        return sendJson(200, { ok: true, filename: name, markdown });
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const q = url.searchParams.get('q');
        if (!q || !q.trim()) return sendJson(400, { ok: false, error: '缺少 q 参数' });
        const limitRaw = url.searchParams.get('limit');
        const offsetRaw = url.searchParams.get('offset');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const pagedRequested = offsetRaw !== null || from !== null || to !== null;
        // 旧行为优先：无分页参数且 C 的分页函数未就绪时，走原 searchEvents（响应字段完全不变）
        if (!pagedRequested && typeof segmentsModule.searchEventsPaged !== 'function') {
          const limit = parseBoundedInt(limitRaw, { def: DEFAULT_SEARCH_LIMIT, min: 1, max: MAX_SEARCH_LIMIT });
          return sendJson(200, { ok: true, ...searchEvents(home, { q, limit }) });
        }
        const limit = parseBoundedInt(limitRaw, { def: DEFAULT_SEARCH_LIMIT, min: 1, max: MAX_SEARCH_LIMIT });
        const offset = parseBoundedInt(offsetRaw, { def: 0, min: 0, max: 100_000 });
        let r;
        if (typeof segmentsModule.searchEventsPaged === 'function') {
          try {
            // C 的契约：searchEventsPaged(home, {query,limit,offset,from,to}) → {items,total,hasMore,indexed}
            r = await segmentsModule.searchEventsPaged(home, { query: q, limit, offset, from, to });
          } catch (err) {
            if (err?.code === 'BAD_RANGE') return sendJson(400, { ok: false, error: err.message });
            log(`searchEventsPaged 失败，回退本地分页: ${err.message}`);
            r = searchEventsPage(home, { q, limit, offset, from, to });
          }
        } else {
          r = searchEventsPage(home, { q, limit, offset, from, to });
        }
        const items = Array.isArray(r?.items) ? r.items : (Array.isArray(r?.events) ? r.events : []);
        const total = Number.isInteger(r?.total) ? r.total : items.length;
        const hasMore = Boolean(r?.hasMore);
        return sendJson(200, {
          ok: true,
          query: r?.query ?? q,
          count: items.length,             // 旧字段：本页条数
          capped: hasMore,                 // 旧字段：是否还有更多（截断）
          events: items,                   // 旧字段：事件数组
          offset: Number.isInteger(r?.offset) ? r.offset : offset,
          hasMore,
          nextOffset: hasMore ? (Number.isInteger(r?.offset) ? r.offset : offset) + items.length : null,
          total,
          indexed: typeof r?.indexed === 'boolean' ? r.indexed : undefined,
        });
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
      if (req.method === 'POST' && url.pathname === '/api/maintain') {
        // 手动触发一次维护（保留→压缩→索引）；body: {dryRun?:boolean}。
        // 只读演练默认 true 以外的语义与 CLI --maintain --dry-run 一致。
        const body = await readBody(req);
        const dryRun = body?.dryRun === true;
        const cfg = readConfigFile(home) ?? {};
        try {
          const report = await runMaintenance(home, cfg, { dryRun });
          return sendJson(200, { ok: true, dryRun, report });
        } catch (err) {
          return sendJson(500, { ok: false, error: `维护执行失败: ${err.message}` });
        }
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
        const prev = readConfigFile(home) ?? {};
        const merged = { ...prev, ...body }; // 保留未知键（如 summarizer）
        // R1 内容采集字段：旧 config 缺字段时补齐默认；已通过校验的数值原样写入（与 Swift 解码同边界）
        const content = contentSettings(merged);
        merged.includeContent = content.includeContent;
        merged.contentMaxChars = content.contentMaxChars;
        merged.diffMaxChars = content.diffMaxChars;
        merged.inputTextMaxChars = content.inputTextMaxChars;
        merged.selectionMaxChars = content.selectionMaxChars;
        // maintenance 段：不参与隐私校验（validatePrivacyConfig 只校验已知键），这里做形状归一化，
        // 非法天数回退默认并返回 maintenanceWarnings（真正执行时 runMaintenance 还会再归一化一次）
        const maintenanceWarnings = [];
        if (merged.maintenance !== undefined) {
          const norm = normalizeMaintenanceConfig(merged);
          maintenanceWarnings.push(...norm.warnings);
          const prevSection = merged.maintenance && typeof merged.maintenance === 'object' && !Array.isArray(merged.maintenance) ? merged.maintenance : {};
          merged.maintenance = { ...prevSection, retentionDays: norm.retentionDays, compressAfterDays: norm.compressAfterDays };
        }
        writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(merged, null, 2)}\n`);
        // 若采集在跑：重启观察让新规则立即生效（stop 关闭当前段，start 按新配置开新段）
        // 若此前 enabled:false（守护未启动）而现在打开：必须真正 start，否则会永远无人拉起（死锁修复）
        const enabling = prev.enabled === false && merged.enabled !== false;
        let applied = null;
        let applyError = null;
        try {
          const st = await daemon.request('status');
          if (st.running === true) {
            try { await daemon.request('stop'); await daemon.request('start'); applied = true; } catch (err) { applied = false; applyError = err.message; log(`规则热应用失败: ${err.message}`); }
          } else if (enabling) {
            try { await daemon.request('start'); applied = true; log('已按新配置启动采集（enabled: false → true）'); } catch (err) { applied = false; applyError = err.message; log(`启用后启动采集失败: ${err.message}`); }
          } else applied = false;
        } catch (err) { applied = null; applyError = err.message; /* 守护不可达：文件已写，下次启动生效 */ }
        return sendJson(200, { ok: true, config: merged, applied, ...(applyError ? { applyError } : {}), ...(maintenanceWarnings.length ? { maintenanceWarnings } : {}) });
      }
      // ---------- 模型配置 / 连接测试 / 立即分析（N1）：只新增，沿用写接口安全校验 ----------
      if (req.method === 'GET' && url.pathname === '/api/model/config') {
        // 只返回脱敏视图（hasKey/keySource），绝不回显 key
        return sendJson(200, {
          ok: true,
          config: redactConfig(home, loadModelConfig(home)),
          presets: Object.values(MODEL_PRESETS).map(({ id, label, baseUrl, model, models, keyOptional, note }) => ({
            id, label, baseUrl, model, models: [...models], keyOptional, note,
          })),
        });
      }
      if (req.method === 'PUT' && url.pathname === '/api/model/config') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(400, { ok: false, error: '请求体须为 JSON 对象' });
        }
        let saved;
        try {
          saved = saveModelConfig(home, body); // 带 key 时写入 secrets.json(0600)，不进 config.json
        } catch (err) {
          if (err?.code === 'INVALID_MODEL_CONFIG') {
            return sendJson(400, { ok: false, error: err.message, errors: Array.isArray(err.errors) ? err.errors : [err.message] });
          }
          throw err;
        }
        log('模型配置已更新（key 只在 secrets.json，不回显）');
        return sendJson(200, { ok: true, config: redactConfig(home, saved) });
      }
      if (req.method === 'POST' && url.pathname === '/api/model/test') {
        const body = await readBody(req);
        const patch = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const override = {};
        for (const field of ['enabled', 'preset', 'provider', 'baseUrl', 'model', 'apiKeyEnv', 'timeoutMs', 'maxChars', 'maxTokens', 'reasoningEffort']) {
          if (Object.prototype.hasOwnProperty.call(patch, field)) override[field] = patch[field];
        }
        const cfg = normalizeModelConfig({ ...loadModelConfig(home), ...override });
        const inlineKey = typeof patch.key === 'string' ? patch.key.trim() : '';
        const savedKey = resolveApiKey(home, cfg).key;
        const apiKey = inlineKey || savedKey;
        if (!apiKey && cfg.provider !== 'none') {
          return sendJson(200, {
            ok: true,
            test: { ok: false, latencyMs: 0, models: [], chatOk: false, modelsOk: false, error: '未配置 API Key（可先填入再测试，或保存后重试）' },
            keySaved: false,
            config: redactConfig(home, cfg),
          });
        }
        const test = await testModelConfig({ cfg, apiKey, timeoutMs: Math.min(cfg.timeoutMs || 15_000, 20_000) });
        // 可选：测试通过后把内联 key 持久化（同样只进 secrets.json）
        let keySaved = false;
        if (test.ok && inlineKey && patch.persistKey === true) {
          try { saveModelConfig(home, { key: inlineKey }); keySaved = true; } catch (err) { log(`保存模型 Key 失败: ${err.message}`); }
        }
        log(`模型连接测试：ok=${test.ok} models=${test.models.length} latencyMs=${test.latencyMs}`);
        return sendJson(200, { ok: true, test, keySaved, config: redactConfig(home, loadModelConfig(home)) });
      }
      // 分析补跑：断网/超时后，网络恢复自动补齐摘要/记忆/洞察
      if (req.method === 'GET' && url.pathname === '/api/analysis/status') {
        try {
          return sendJson(200, computeAnalysisStatus(home, { running: analysisCatchUpRunning(home) }));
        } catch (err) {
          return sendJson(500, { ok: false, error: err.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/analysis/retry') {
        try {
          const result = await runAnalysisCatchUp(home, { reason: 'manual', force: true, log: (m) => log(`[catchup] ${m}`) });
          appendAudit(home, {
            actor: 'user', action: 'analysis.catchup', target: '',
            detail: { reason: 'manual', offline: result.offline === true, before: result.before, remaining: result.remaining, error: result.error || '' },
          });
          return sendJson(200, { ok: true, result });
        } catch (err) {
          return sendJson(500, { ok: false, error: err.message, code: err.code || 'CATCHUP_FAILED' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/summarize/run') {
        const body = await readBody(req);
        const segment = body && typeof body === 'object' && typeof body.segment === 'string' && body.segment.trim()
          ? body.segment.trim()
          : null;
        const modelCfg = loadModelConfig(home);
        const startedAt = Date.now();
        if (modelCfg.enabled !== true || modelCfg.provider === 'none') {
          return sendJson(200, {
            ok: false,
            code: 'SUMMARIZER_DISABLED',
            error: '摘要器未启用（先在模型配置里启用并保存 Key）',
            config: redactConfig(home, modelCfg),
          });
        }
        let timer = null;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(new Error('摘要执行超时（120s）'), { code: 'SUMMARIZE_TIMEOUT' }));
          }, 120_000);
          timer.unref?.();
        });
        try {
          const task = (async () => {
            if (segment) {
              const seg = listSegments(home).find((s) => s.segment === segment);
              if (!seg) return { notFound: true };
              const r = await summarizeSegment(home, seg, { force: true, log: (m) => log(`[summarize] ${m}`) });
              return {
                checked: 1,
                summarized: r.file && !r.skipped ? 1 : 0,
                skipped: r.skipped && r.skipped !== 'already-summarized' ? [`${segment}: ${r.skipped}`] : [],
                segment: r.file ?? null,
                title: r.title ?? null,
              };
            }
            const r = await summarizePending(home, { log: (m) => log(`[summarize] ${m}`) });
            return {
              checked: r.checked,
              summarized: r.summarized10 + r.summarized6h,
              summarized10: r.summarized10,
              summarized6h: r.summarized6h,
              skipped: r.skipped,
            };
          })();
          const result = await Promise.race([task, deadline]);
          if (result.notFound) {
            return sendJson(404, { ok: false, code: 'SEGMENT_NOT_FOUND', error: 'segment not found' });
          }
          const deadletter = readDeadLetters(home).slice(-5);
          return sendJson(200, {
            ok: true,
            ...result,
            elapsedMs: Date.now() - startedAt,
            ...(deadletter.length ? { deadletter } : {}),
          });
        } catch (err) {
          log(`立即分析失败: ${err.message}`);
          return sendJson(500, {
            ok: false,
            code: err.code ?? 'SUMMARIZE_FAILED',
            error: err.message,
            elapsedMs: Date.now() - startedAt,
            deadletter: readDeadLetters(home).slice(-5),
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
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
      // 只记录方法 + 路径（绝不记录 query/标题/URL 内容）
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
  const out = { port: DEFAULT_PORT, action: 'start', home: null, service: false, dryRun: false, retentionDays: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--port') out.port = Number.parseInt(next(), 10);
    else if (a === '--home') out.home = path.resolve(next());
    else if (a === '--start') out.action = 'start';
    else if (a === '--stop') out.action = 'stop';
    else if (a === '--status') out.action = 'status';
    else if (a === '--maintain') out.action = 'maintain';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--retention-days') {
      const v = Number.parseInt(next(), 10);
      if (!Number.isInteger(v) || v < 0) throw new Error('--retention-days 须为非负整数');
      out.retentionDays = v;
    } else if (a === '--service') { out.service = true; out.action = 'start'; }
    else if (a === '--help' || a === '-h') {
      console.log('用法: node daemon.mjs [--port 3777] [--home DIR] [--start|--stop|--status|--maintain] [--service]');
      console.log('      node daemon.mjs --maintain [--dry-run] [--retention-days N]  # 只跑一次维护并打印 JSON 报告');
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

/**
 * 探测是否已有本实例在跑：锁里的 pid 存活 + 本机 HTTP /api/status 回报的 pid 与锁一致。
 * 这一步不依赖 ps 命令行（相对路径启动/launchd 都可靠），也天然防 pid 复用误杀。
 * @returns {Promise<null | {pid:number, port:number, status:object}>}
 */
export async function probeRunningInstance(home, { port = null, fetchStatusFn = fetchStatus } = {}) {
  const lock = readInstanceLock(home);
  if (!lock) return null;
  if (!isPidAlive(lock.pid)) return null;
  const ports = [];
  if (Number.isInteger(lock.port) && lock.port > 0) ports.push(lock.port);
  if (port !== null && !ports.includes(port)) ports.push(port);
  for (const p of ports) {
    const status = await fetchStatusFn(p);
    if (status && (status.managerPid === lock.pid || status.pid === lock.pid)) return { pid: lock.pid, port: p, status };
  }
  return null;
}

/**
 * 用 HTTP /api/status 自证 pid 归属（进程重复 pid 时的兜底校验）：
 * 我们的服务会回传 pid 字段，只有 pid 一致才认为是本实例。
 */
export async function probeManagerIdentity(home, pid, { fetchStatusFn = fetchStatus } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { verified: false };
  const lock = readInstanceLock(home);
  const ports = [];
  if (lock && Number.isInteger(lock.port) && lock.port > 0) ports.push(lock.port);
  if (!ports.includes(DEFAULT_PORT)) ports.push(DEFAULT_PORT);
  for (const p of ports) {
    const status = await fetchStatusFn(p);
    // managerPid 是守护管理器自身（本文件的进程）；pid 字段是 Swift 采集子进程
    if (status && (status.managerPid === pid || status.pid === pid)) return { verified: true, port: p };
  }
  return { verified: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = args.home ?? chronicleHome();

  // --maintain：只跑一次维护并打印 JSON 报告后退出（不启动 HTTP / 不拉采集）
  if (args.action === 'maintain') {
    const base = readConfigFile(home) ?? {};
    let cfg = base;
    if (args.retentionDays !== null) {
      const prev = base.maintenance && typeof base.maintenance === 'object' && !Array.isArray(base.maintenance) ? base.maintenance : {};
      cfg = { ...base, maintenance: { ...prev, retentionDays: args.retentionDays } };
    }
    // 维护自身的日志走 stderr，stdout 只保留纯 JSON 报告（便于脚本消费）
    const report = await runMaintenance(home, cfg, { dryRun: args.dryRun, log: (m) => console.error(m) });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (args.action === 'stop') {
    const r = stopManager(home);
    if (r.stopped) { console.log(`已发送停止信号给 pid ${r.pid}`); return 0; }
    if (r.reason === 'no-pidfile' || r.reason === 'not-running') {
      console.log('守护未在运行（无 pidfile 或进程已退出）');
      clearPidFile(home);
      return 0;
    }
    if (r.reason === 'pid-not-ours') {
      // ps 命令行可能因相对路径启动而不含绝对路径；用本机 HTTP /api/status 自证 pid 身份，
      // 通过才发信号（pid 复用时绝不会误杀无关进程）
      let ident = { verified: false };
      try { ident = await probeManagerIdentity(home, r.pid); } catch { /* 探测失败按拒绝处理 */ }
      if (ident.verified) {
        try {
          process.kill(r.pid, 'SIGTERM');
          console.log(`已发送停止信号给 pid ${r.pid}（HTTP 身份校验通过，port=${ident.port}）`);
          return 0;
        } catch (err) {
          console.error(`停止失败: 无法向 pid ${r.pid} 发送信号（${err.message}）`);
          return 1;
        }
      }
      console.error(`拒绝停止 pid ${r.pid}：命令行与 HTTP 身份均不属于本仓库 daemon.mjs（疑似 pid 复用）`);
      clearPidFile(home);
      return 1;
    }
    console.error(`停止失败: ${r.reason}${r.error ? ` (${r.error})` : ''}`);
    return 1;
  }

  if (args.action === 'status') {
    const st = await fetchStatus(args.port);
    if (!st) { console.log(JSON.stringify({ running: false, detail: `127.0.0.1:${args.port} 无响应` })); return 1; }
    console.log(JSON.stringify(st, null, 2));
    return 0;
  }

  // --start（默认 / --service）：守护 + HTTP 前台常驻
  mkdirSync(path.join(home, 'segments'), { recursive: true });
  mkdirSync(logsDir(home), { recursive: true });
  const logger = createLogger({ home });

  // ① 单实例锁（先用 HTTP /api/status 自证：相对路径启动时 ps 命令行不含绝对路径也不会误判）
  const runningInstance = await probeRunningInstance(home, { port: args.port });
  if (runningInstance) {
    console.log(`已在运行 (pid ${runningInstance.pid})`);
    logger.info(`重复启动被拒绝：已在运行 pid=${runningInstance.pid} port=${runningInstance.port}`);
    return 0;
  }
  const lock = acquireInstanceLock(home, { port: args.port });
  if (!lock.acquired) {
    console.log(`已在运行 (pid ${lock.lock.pid})`);
    logger.info(`重复启动被拒绝：已在运行 pid=${lock.lock.pid}`);
    return 0;
  }
  logger.info(`启动 pid=${process.pid} home=${home}${args.service ? ' (launchd 服务模式)' : ''}${lock.stale ? '（覆盖陈旧锁）' : ''}`);

  const daemon = createDaemon({
    home,
    log: (line) => logger.info(line),
    stderr: (line) => logger.error(line),
  });
  const server = createHttpApp({ daemon, home, log: (line) => logger.warn(line) });
  try {
    await new Promise((resolve, reject) => server.listen(args.port, '127.0.0.1', resolve).once('error', reject));
  } catch (err) {
    logger.error(`HTTP 端口 ${args.port} 监听失败: ${err.message}`);
    daemon.stop();
    releaseInstanceLock(home);
    return 1;
  }
  writePidFile(home, process.pid);
  console.log(`Chronicle 守护管理器已启动：HTTP 127.0.0.1:${args.port}（数据目录 ${home}）`);
  console.log(`采集守护二进制：${daemon.binary}`);

  // 启动即拉起守护并开始观察（守护异常退出由看护逻辑自动重启）
  let startError = null;
  try {
    const r = await daemon.request('start');
    logger.info(`采集已开始：${r.segmentsDir}`);
    console.log(`采集已开始：${r.segmentsDir}`);
  } catch (err) {
    startError = err;
    logger.error(`采集守护启动失败: ${err.code ?? ''} ${err.message}`);
    console.error(`采集守护启动失败: ${err.message}`);
    if (err.code === 'NO_BINARY') {
      console.error('（先跑 npm run setup；或确认 ~/.chronicle/Chronicle Helper.app 已安装）');
      server.close();
      clearPidFile(home);
      releaseInstanceLock(home);
      daemon.stop();
      return 1;
    }
    // enabled:false / 权限未授予等可恢复错误：HTTP 继续服务，修好配置后经 /api/config 或重试拉起
    console.error('（HTTP 继续服务；修正 config.json 的 enabled 或权限后会自动重试启动）');
  }

  // 摘要：启动 5s 后先扫一遍（补上一会话遗留的已关闭段），之后每 10 分钟一次
  //（摘要器未启用时零副作用；外部命令钩子 CHRONICLE_SUMMARIZE_CMD 仍每 60s 空转扫描）
  const analysisCatchUp = (reason) => runAnalysisCatchUp(home, {
    reason,
    log: (m) => { logger.info(`[catchup] ${m}`); console.log(`[catchup] ${m}`); },
  }).catch((err) => { logger.info(`[catchup] 失败: ${err.message}`); });
  // 每 5 分钟检查一次待补队列：无待补时零模型调用；断网时按退避重试。
  const builtinSummaryTimer = setInterval(() => { analysisCatchUp('scheduled'); }, 3 * 60_000);
  builtinSummaryTimer.unref();
  setTimeout(() => { analysisCatchUp('startup'); }, 5_000).unref();
  const summaryTimer = setInterval(() => { runSummaries(home, { log: (m) => { logger.info(`[summary] ${m}`); console.log(`[summary] ${m}`); } }).catch(() => {}); }, 60_000);
  summaryTimer.unref();

  // 维护：启动 5s 后跑一次（保留策略默认关闭，retentionDays=0 时是 no-op），此后每 6h 一次
  //（周期可用 CHRONICLE_MAINTENANCE_MS 覆盖，便于测试）
  const maintenance = scheduleMaintenance({
    home,
    log: (m) => { logger.info(m); console.log(m); },
  });
  logger.info(`维护调度已启动：首跑 ${maintenance.firstDelayMs}ms 后，周期 ${maintenance.intervalMs}ms`);

  // 启动失败（如 enabled:false）时周期性重试，配置修好后无需手动重启
  let startRetryTimer = null;
  if (startError) {
    startRetryTimer = setInterval(async () => {
      try {
        const r = await daemon.request('start');
        logger.info(`采集重试启动成功：${r.segmentsDir}`);
        clearInterval(startRetryTimer);
        startRetryTimer = null;
      } catch { /* 下次再试 */ }
    }, 30_000);
    startRetryTimer.unref();
  }

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${sig}，停止采集并退出…`);
    logger.info(`收到 ${sig}，正常退出（不重启采集守护）`);
    try { const r = await daemon.request('stop'); console.log(`stats: ${JSON.stringify(r.stats)}`); logger.info(`停止统计: ${JSON.stringify(r.stats)}`); } catch { /* 守护已死 */ }
    daemon.stop(); // 正常停止：看护不重启
    maintenance.stop();
    clearInterval(summaryTimer);
    clearInterval(builtinSummaryTimer);
    if (startRetryTimer) clearInterval(startRetryTimer);
    server.close();
    clearPidFile(home);
    releaseInstanceLock(home);
    logger.info('已退出');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return new Promise(() => {}); // 常驻
}

// 直接执行时才跑 CLI（测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[daemon] 失败: ${e.message}`); process.exit(1); });
}
