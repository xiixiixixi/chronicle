// shared/analysis-catchup.mjs — 断网/离线后的分析补跑（v0）
//
// 解决的问题：模型调用失败（断网、超时）时，摘要/记忆/洞察不应永久缺失。
//   · 盘点待补：缺 10min 摘要的段、缺/过期 6h 摘要的桶、未合并进记忆的摘要、排队中的洞察；
//   · 后台补跑：网络恢复后按 摘要 → 记忆 → 洞察 顺序补齐；
//   · 退避：连续失败按 1/2/5/10/15 分钟重试，避免断网时每 10 分钟白打模型；
//   · 状态：<home>/analysis-state.json（原子写 0600），给 Web/MCP/菜单栏读取。
//
// 所有分析产物本身仍然幂等（已有摘要/洞察按 sourceDigest 跳过），补跑不会重复写入。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chronicleHome } from './segments.mjs';
import {
  summarizeBacklog, summarizePending, consolidatePendingMemory,
  isNetworkFailure, loadSummarizerConfig, summarizerActive,
} from '../summarize.mjs';
import { countUnconsumedSummaries } from './memory.mjs';
import { generateInsight } from './insights.mjs';

export const ANALYSIS_STATE_VERSION = 1;
const BACKOFF_MINUTES = [1, 2, 5, 10, 15];
const MAX_QUEUED_INSIGHTS = 4;
const MAX_INSIGHT_ATTEMPTS = 5;

export function analysisStatePath(home = chronicleHome()) {
  return path.join(home, 'analysis-state.json');
}

function emptyState() {
  return {
    version: ANALYSIS_STATE_VERSION,
    last_run_at: null,
    last_success_at: null,
    last_error: '',
    last_error_code: '',
    consecutive_failures: 0,
    next_retry_at: null,
    pending_insights: [],
    last_result: null,
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  return {
    ...emptyState(),
    ...raw,
    pending_insights: Array.isArray(raw.pending_insights)
      ? raw.pending_insights.filter((x) => x && (x.range === 'day' || x.range === 'week')).slice(0, MAX_QUEUED_INSIGHTS)
      : [],
  };
}

export function loadAnalysisState(home = chronicleHome()) {
  const file = analysisStatePath(home);
  if (!existsSync(file)) return emptyState();
  try { return normalizeState(JSON.parse(readFileSync(file, 'utf8'))); } catch { return emptyState(); }
}

export function saveAnalysisState(home = chronicleHome(), state = emptyState()) {
  const file = analysisStatePath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function nextBackoffMs(consecutiveFailures) {
  const idx = Math.max(0, Math.min(BACKOFF_MINUTES.length - 1, consecutiveFailures - 1));
  return BACKOFF_MINUTES[idx] * 60_000;
}

/** 盘点当前待补项（纯读取，不调模型）。 */
export function pendingAnalysisCounts(home = chronicleHome(), { now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const summary = summarizeBacklog(home, { now: nowDate });
  const state = loadAnalysisState(home);
  return {
    summaries10: summary.counts.summaries10,
    summaries6h: summary.counts.summaries6h,
    memory: countUnconsumedSummaries(home, { sinceHours: 24 * 365, now: nowDate.getTime() }),
    insights: state.pending_insights.length,
    pending10: summary.pending10,
    pending6h: summary.pending6h,
  };
}

/** 待补状态：给 /api/analysis/status、Web 提示与 MCP 状态用。 */
export function computeAnalysisStatus(home = chronicleHome(), { now = new Date(), running = false } = {}) {
  const pending = pendingAnalysisCounts(home, { now });
  const state = loadAnalysisState(home);
  const cfg = loadSummarizerConfig(home);
  const enabled = Boolean(cfg.enabled && cfg.provider !== 'none' && summarizerActive(cfg));
  const total = pending.summaries10 + pending.summaries6h + pending.memory + pending.insights;
  return {
    ok: true,
    enabled,
    running: Boolean(running),
    offline: Boolean(state.consecutive_failures > 0 && isNetworkFailure(state.last_error_code)),
    pending: {
      summaries10: pending.summaries10,
      summaries6h: pending.summaries6h,
      memory: pending.memory,
      insights: pending.insights,
    },
    total,
    last_run_at: state.last_run_at,
    last_success_at: state.last_success_at,
    last_error: state.last_error,
    last_error_code: state.last_error_code,
    consecutive_failures: state.consecutive_failures,
    next_retry_at: state.next_retry_at,
    queue: state.pending_insights.map((x) => ({ range: x.range, attempts: x.attempts, last_error: x.last_error || '' })),
  };
}

/** 网络失败时把一次洞察请求排队，等补跑。 */
export function enqueueInsightRequest(home = chronicleHome(), { range = 'week', force = false, error = '', code = '' } = {}) {
  if (range !== 'day' && range !== 'week') return null;
  const state = loadAnalysisState(home);
  const existing = state.pending_insights.find((x) => x.range === range);
  if (existing) {
    existing.force = existing.force || force === true;
    existing.last_error = String(error || existing.last_error || '').slice(0, 300);
    existing.updated_at = new Date().toISOString();
  } else {
    if (state.pending_insights.length >= MAX_QUEUED_INSIGHTS) {
      state.pending_insights.shift();
    }
    state.pending_insights.push({
      range,
      force: force === true,
      created_at: new Date().toISOString(),
      attempts: 0,
      last_error: String(error || '').slice(0, 300),
      last_error_code: String(code || '').slice(0, 80),
    });
  }
  saveAnalysisState(home, state);
  return state.pending_insights.find((x) => x.range === range) || null;
}

/** 可自动重试的错误：断网/超时。配置错误（无 key、401）不在这里。 */
export function isTransientAnalysisError(code) {
  return isNetworkFailure(code);
}

const inFlight = new Map();

/**
 * 补跑一轮：摘要 → 记忆 → 洞察。并发调用会复用同一个 Promise。
 * @returns {Promise<object>}
 */
export function runAnalysisCatchUp(home = chronicleHome(), {
  reason = 'scheduled', force = false, now = null, env = process.env,
  fetchImpl, sleep, log = () => {}, maxDurationMs = 45_000,
} = {}) {
  const key = String(home);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const injectedNow = now != null;
    const nowDate = injectedNow ? (now instanceof Date ? now : new Date(now)) : new Date();
    const nowMsValue = nowMs(nowDate);
    const state = loadAnalysisState(home);
    if (!force && state.next_retry_at && Date.parse(state.next_retry_at) > nowMsValue) {
      return { ok: true, skipped: 'backoff', next_retry_at: state.next_retry_at, reason };
    }
    const cfg = loadSummarizerConfig(home);
    if (!cfg.enabled || cfg.provider === 'none' || !summarizerActive(cfg)) {
      return { ok: false, skipped: 'summarizer-disabled', reason, pending: pendingAnalysisCounts(home, { now: nowDate }) };
    }

    const before = pendingAnalysisCounts(home, { now: nowDate });
    if (before.summaries10 + before.summaries6h + before.memory + before.insights === 0) {
      state.last_run_at = nowDate.toISOString();
      state.last_success_at = nowDate.toISOString();
      state.last_error = '';
      state.last_error_code = '';
      state.consecutive_failures = 0;
      state.next_retry_at = null;
      state.last_result = { reason, total: 0 };
      saveAnalysisState(home, state);
      return { ok: true, reason, before, after: before, remaining: 0, next_retry_at: null };
    }

    let offline = false;
    let offlineCode = '';
    let offlineError = '';
    const errors = [];
    const summary = await summarizePending(home, {
      env, fetchImpl, sleep, log, maxDurationMs, consolidate: false,
    });
    if (summary.offline) {
      offline = true;
      offlineCode = 'LLM_NETWORK';
      offlineError = summary.offlineError || '网络不可用';
      errors.push(offlineError);
    }

    let consolidated = null;
    let memoryConsumed = 0;
    if (!offline) {
      // 记忆合并按批（默认 12 条/次）：积压多时一轮最多补 3 批，避免一次请求太久。
      for (let batch = 0; batch < 3 && !offline; batch += 1) {
        const memPending = countUnconsumedSummaries(home, { sinceHours: 24 * 365, now: nowDate.getTime() });
        if (memPending <= 0) break;
        try {
          consolidated = await consolidatePendingMemory(home, { cfg, env, fetchImpl, log, now: nowDate });
          if (consolidated && consolidated.ok === false) {
            const code = consolidated.code || (isNetworkFailure(consolidated.skipped) ? 'LLM_NETWORK' : '');
            if (isNetworkFailure(code)) {
              offline = true;
              offlineCode = code;
              offlineError = consolidated.error || '网络不可用';
              errors.push(offlineError);
            } else {
              errors.push(`${consolidated.skipped || 'memory'}: ${consolidated.error || ''}`.trim());
            }
            break;
          }
          memoryConsumed += Number(consolidated?.consumed || 0);
          if (!consolidated || !consolidated.consumed) break;
        } catch (err) {
          const code = err?.code || '';
          if (isNetworkFailure(code)) {
            offline = true;
            offlineCode = code;
            offlineError = String(err?.message ?? err);
          }
          errors.push(String(err?.message ?? err));
          break;
        }
      }
    }

    let insightsDone = 0;
    if (!offline && state.pending_insights.length) {
      const remainingQueue = [];
      for (const item of state.pending_insights) {
        if (offline) { remainingQueue.push(item); continue; }
        try {
          const r = await generateInsight(home, {
            range: item.range, force: item.force === true, env, fetchImpl, sleep, log, now: nowDate,
          });
          if (r && r.ok) {
            insightsDone += 1;
            continue;
          }
          const code = r?.code || 'INSIGHT_ERROR';
          const message = r?.error || code;
          if (isTransientAnalysisError(code)) {
            offline = true;
            offlineCode = code;
            offlineError = message;
            errors.push(message);
            item.last_error = String(message).slice(0, 300);
            item.last_error_code = code;
            item.updated_at = nowDate.toISOString();
            remainingQueue.push(item);
          } else {
            item.attempts = Number(item.attempts || 0) + 1;
            item.last_error = String(message).slice(0, 300);
            item.last_error_code = code;
            item.updated_at = nowDate.toISOString();
            if (item.attempts < MAX_INSIGHT_ATTEMPTS) remainingQueue.push(item);
            else errors.push(`洞察放弃（${code}）: ${message}`);
          }
        } catch (err) {
          const code = err?.code || 'INSIGHT_ERROR';
          const message = String(err?.message ?? err);
          if (isTransientAnalysisError(code)) {
            offline = true;
            offlineCode = code;
            offlineError = message;
            remainingQueue.push(item);
          } else {
            item.attempts = Number(item.attempts || 0) + 1;
            item.last_error = message.slice(0, 300);
            item.last_error_code = code;
            if (item.attempts < MAX_INSIGHT_ATTEMPTS) remainingQueue.push(item);
          }
          errors.push(message);
        }
      }
      state.pending_insights = remainingQueue;
    }

    const after = pendingAnalysisCounts(home, { now: nowDate });
    const remaining = after.summaries10 + after.summaries6h + after.memory + after.insights;
    const finishDate = injectedNow ? nowDate : new Date();
    const finishMs = finishDate.getTime();
    state.last_run_at = finishDate.toISOString();
    state.last_result = {
      reason,
      summarized10: summary.summarized10,
      summarized6h: summary.summarized6h,
      consolidated: memoryConsumed,
      insights: insightsDone,
      before: before.summaries10 + before.summaries6h + before.memory + before.insights,
      remaining,
    };
    if (offline) {
      state.consecutive_failures = Number(state.consecutive_failures || 0) + 1;
      state.last_error = offlineError || '网络不可用';
      state.last_error_code = offlineCode || 'LLM_NETWORK';
      state.next_retry_at = isoAt(finishMs + nextBackoffMs(state.consecutive_failures));
    } else {
      state.consecutive_failures = 0;
      state.last_success_at = finishDate.toISOString();
      state.last_error = errors[0] || '';
      state.last_error_code = errors.length ? 'ANALYSIS_PARTIAL' : '';
      // 仍有剩余（预算用尽/历史积压）→ 1 分钟后继续；否则完全空闲。
      state.next_retry_at = remaining > 0 ? isoAt(finishMs + 60_000) : null;
    }
    saveAnalysisState(home, state);
    return {
      ok: !offline,
      reason,
      offline,
      error: offlineError || undefined,
      summarized10: summary.summarized10,
      summarized6h: summary.summarized6h,
      consolidated: memoryConsumed,
      insights: insightsDone,
      before,
      after,
      remaining,
      next_retry_at: state.next_retry_at,
      errors,
    };
  })().finally(() => { inFlight.delete(key); });
  inFlight.set(key, task);
  return task;
}

export function analysisCatchUpRunning(home = chronicleHome()) {
  return inFlight.has(String(home));
}
