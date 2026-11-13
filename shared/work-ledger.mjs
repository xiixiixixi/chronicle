// shared/work-ledger.mjs — 工作对象 / 洞察 / 闭环账本（P1 后端 v0）
//
// 设计依据：docs/product-blueprint.md 第 14 章。
//   · 工作对象不是“线程”：Task/Project/Goal/Area/Commitment/Decision/Insight/Incident 生命周期不同。
//   · 线程只是视图；本模块先存对象，不强行归线程。
//   · 每个对象必须有类型、状态、下一步/复盘日期，或归档；无主对象会被 sweep 归档。
//   · 洞察是一级对象：claim + evidence + confidence + expiry + status（candidate→validated/refuted→applied→retired）。
//   · 硬上限：活跃 Project ≤7、Goal ≤3、Insight ≤20（可配置常量），防止无限扩张。
//
// 存储：<home>/work-ledger.json（原子写 0600）。所有函数容错：坏文件回落到空账本。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chronicleHome } from './segments.mjs';
import { listRecentSummaries, titleSimilarity } from './memory.mjs';

export const WORK_LEDGER_VERSION = 1;

export const WORK_TYPES = Object.freeze([
  'action', 'task', 'project', 'goal', 'area', 'commitment', 'decision', 'insight', 'incident',
]);

export const STATE_MACHINES = Object.freeze({
  action: ['captured', 'attached', 'expired'],
  task: ['inbox', 'clarified', 'doing', 'done', 'dropped', 'archived'],
  project: ['proposed', 'active', 'blocked', 'done', 'abandoned', 'archived'],
  goal: ['set', 'active', 'achieved', 'missed', 'revised', 'archived'],
  area: ['active', 'reviewed', 'archived'],
  commitment: ['made', 'due', 'followed_up', 'fulfilled', 'broken', 'renegotiated', 'archived'],
  decision: ['proposed', 'decided', 'review_due', 'confirmed', 'revised', 'archived'],
  insight: ['candidate', 'validated', 'refuted', 'applied', 'retired'],
  incident: ['detected', 'triaged', 'mitigating', 'resolved', 'prevented', 'archived'],
});

export const DEFAULT_STATE = Object.freeze({
  action: 'captured', task: 'inbox', project: 'proposed', goal: 'set', area: 'active',
  commitment: 'made', decision: 'proposed', insight: 'candidate', incident: 'detected',
});

export const WORK_CAPS = Object.freeze({ project: 7, goal: 3, insight: 20 });
export const MAX_INBOX_TASKS = 30;

const TERMINAL_STATES = new Set([
  'done', 'dropped', 'abandoned', 'achieved', 'missed', 'fulfilled', 'broken',
  'refuted', 'applied', 'retired', 'resolved', 'prevented', 'expired', 'archived',
]);

const ACTIVE_PROJECT_STATES = new Set(['proposed', 'active', 'blocked']);
const ACTIVE_GOAL_STATES = new Set(['set', 'active', 'revised']);
const ACTIVE_INSIGHT_STATES = new Set(['candidate', 'validated', 'applied']);

const ORPHAN_DAYS = 7;
const STUCK_PROJECT_DAYS = 14;
const INSIGHT_STALE_DAYS = 30;
const ACTION_EXPIRE_HOURS = 24;

export class WorkLedgerError extends Error {
  constructor(message, code = 'WORK_LEDGER_ERROR') {
    super(message);
    this.name = 'WorkLedgerError';
    this.code = code;
  }
}

export function workLedgerPath(home = chronicleHome()) {
  return path.join(home, 'work-ledger.json');
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}

/** 把日期字符串/Date/时间戳统一成 ISO；非法值返回 null（不能退化成“现在”）。 */
function toIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function emptyLedger() {
  return { version: WORK_LEDGER_VERSION, objects: [] };
}

function normalizeLedger(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects)) return emptyLedger();
  return {
    version: Number.isInteger(raw.version) ? raw.version : WORK_LEDGER_VERSION,
    objects: raw.objects.filter((o) => o && typeof o === 'object' && typeof o.id === 'string' && typeof o.type === 'string'),
  };
}

/** 读账本；缺文件/坏 JSON/坏结构都回落到空账本，不抛异常。 */
export function loadWorkLedger(home = chronicleHome()) {
  const file = workLedgerPath(home);
  if (!existsSync(file)) return emptyLedger();
  try {
    return normalizeLedger(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyLedger();
  }
}

/** 原子写账本（0600）。 */
export function saveWorkLedger(home = chronicleHome(), ledger = emptyLedger()) {
  const file = workLedgerPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const text = `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

function objectId(now = Date.now()) {
  return `obj_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanStr(value, max = 400) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, max = 20) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  return [...new Set(list.map((x) => cleanStr(x, 300)).filter(Boolean))].slice(0, max);
}

function normalizeType(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!WORK_TYPES.includes(t)) {
    throw new WorkLedgerError(`未知工作对象类型: ${type}（可用: ${WORK_TYPES.join(' / ')}）`, 'BAD_TYPE');
  }
  return t;
}

function normalizeState(type, state) {
  const machine = STATE_MACHINES[type];
  const s = cleanStr(state || DEFAULT_STATE[type], 40).toLowerCase();
  if (!machine.includes(s)) {
    throw new WorkLedgerError(`类型 ${type} 不支持状态 ${s}（可用: ${machine.join(' / ')}）`, 'BAD_STATE');
  }
  return s;
}

function normalizeInsight(meta, title, evidence, now) {
  const raw = meta && typeof meta.insight === 'object' && meta.insight ? meta.insight : {};
  const confidence = Number(raw.confidence);
  return {
    claim: cleanStr(raw.claim || title, 500),
    scope: raw.scope && typeof raw.scope === 'object' ? raw.scope : cleanStr(raw.scope, 300),
    counter_evidence: cleanList(raw.counter_evidence, 20),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    sample_size: Number.isInteger(raw.sample_size) ? raw.sample_size : evidence.length,
    first_seen: toIso(raw.first_seen) || iso(now),
    last_seen: toIso(raw.last_seen) || iso(now),
    expiry: toIso(raw.expiry) || iso(nowMs(now) + 90 * 86400_000),
    suggested_action: cleanStr(raw.suggested_action, 500),
    related_object_ids: cleanList(raw.related_object_ids, 20),
    validated_at: raw.validated_at || null,
    validation_note: cleanStr(raw.validation_note, 500),
    applied_at: raw.applied_at || null,
    applied_to: cleanStr(raw.applied_to, 300),
    retired_reason: cleanStr(raw.retired_reason, 300),
  };
}

function normalizeObject(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new WorkLedgerError('对象必须是 JSON 对象', 'BAD_INPUT');
  const type = normalizeType(input.type);
  const title = cleanStr(input.title, 200);
  if (!title) throw new WorkLedgerError('对象缺少 title', 'BAD_TITLE');
  const state = normalizeState(type, input.state);
  const evidence = cleanList(input.evidence, 30);
  const meta = input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta) ? { ...input.meta } : {};
  if (type === 'insight') meta.insight = normalizeInsight(meta, title, evidence, now);
  return {
    id: typeof input.id === 'string' && input.id ? input.id : objectId(nowMs(now)),
    type,
    title,
    state,
    owner: cleanStr(input.owner || 'me', 80),
    project_id: cleanStr(input.project_id, 120) || null,
    goal_id: cleanStr(input.goal_id, 120) || null,
    next_action: cleanStr(input.next_action, 500),
    due_at: input.due_at ? toIso(input.due_at) : null,
    review_at: input.review_at ? toIso(input.review_at) : null,
    evidence,
    source: cleanStr(input.source || 'manual', 60),
    source_key: cleanStr(input.source_key, 300),
    created_at: toIso(input.created_at) || iso(now),
    updated_at: iso(now),
    archived_at: null,
    archive_reason: '',
    meta,
  };
}

function isActiveObject(obj) {
  if (obj.archived_at) return false;
  if (obj.type === 'project') return ACTIVE_PROJECT_STATES.has(obj.state);
  if (obj.type === 'goal') return ACTIVE_GOAL_STATES.has(obj.state);
  if (obj.type === 'insight') return ACTIVE_INSIGHT_STATES.has(obj.state);
  return !TERMINAL_STATES.has(obj.state);
}

function capCount(ledger, type, excludeId = null) {
  return ledger.objects.filter((o) => o.type === type && o.id !== excludeId && isActiveObject(o)).length;
}

function assertCap(ledger, type, state, excludeId = null) {
  const cap = WORK_CAPS[type];
  if (!cap) return;
  const active = type === 'project' ? ACTIVE_PROJECT_STATES.has(state)
    : type === 'goal' ? ACTIVE_GOAL_STATES.has(state)
      : ACTIVE_INSIGHT_STATES.has(state);
  if (!active) return;
  if (capCount(ledger, type, excludeId) >= cap) {
    throw new WorkLedgerError(`活跃 ${type} 已达上限 ${cap}；请合并/归档/排队后再新建`, 'CAP_EXCEEDED');
  }
}

/** 创建对象；活跃 Project/Goal/Insight 受硬上限约束。 */
export function createObject(home = chronicleHome(), input = {}, { now = Date.now(), ledger = null } = {}) {
  const data = ledger || loadWorkLedger(home);
  const obj = normalizeObject(input, now);
  assertCap(data, obj.type, obj.state);
  data.objects.push(obj);
  saveWorkLedger(home, data);
  return obj;
}

/** 更新对象；状态必须在类型状态机内。 */
export function updateObject(home = chronicleHome(), id, patch = {}, { now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const idx = data.objects.findIndex((o) => o.id === id);
  if (idx < 0) throw new WorkLedgerError(`对象不存在: ${id}`, 'NOT_FOUND');
  const old = data.objects[idx];
  const nextType = patch.type ? normalizeType(patch.type) : old.type;
  const nextState = patch.state ? normalizeState(nextType, patch.state) : old.state;
  if (nextState !== old.state && nextType === old.type) {
    const machine = STATE_MACHINES[nextType];
    if (!machine.includes(nextState)) throw new WorkLedgerError(`不允许的状态: ${nextState}`, 'BAD_STATE');
  }
  if (nextState !== old.state) assertCap(data, nextType, nextState, old.id);
  const merged = {
    ...old,
    ...patch,
    id: old.id,
    type: nextType,
    state: nextState,
    created_at: old.created_at,
    updated_at: iso(now),
  };
  if (merged.title == null || !cleanStr(merged.title, 200)) throw new WorkLedgerError('title 不能为空', 'BAD_TITLE');
  merged.title = cleanStr(merged.title, 200);
  merged.next_action = cleanStr(merged.next_action, 500);
  merged.due_at = merged.due_at ? toIso(merged.due_at) : null;
  merged.review_at = merged.review_at ? toIso(merged.review_at) : null;
  merged.evidence = cleanList(merged.evidence, 30);
  merged.meta = merged.meta && typeof merged.meta === 'object' && !Array.isArray(merged.meta) ? merged.meta : {};
  if (merged.type === 'insight') merged.meta.insight = normalizeInsight(merged.meta, merged.title, merged.evidence, now);
  data.objects[idx] = merged;
  saveWorkLedger(home, data);
  return merged;
}

/** 归档对象；Insight 用 retired，其余用 archived（若状态机不支持则只写 archived_at）。 */
export function archiveObject(home = chronicleHome(), id, reason = '', { now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const idx = data.objects.findIndex((o) => o.id === id);
  if (idx < 0) throw new WorkLedgerError(`对象不存在: ${id}`, 'NOT_FOUND');
  const obj = data.objects[idx];
  const target = obj.type === 'insight' ? 'retired' : 'archived';
  if (STATE_MACHINES[obj.type].includes(target)) obj.state = target;
  obj.archived_at = iso(now);
  obj.archive_reason = cleanStr(reason, 300);
  obj.updated_at = iso(now);
  data.objects[idx] = obj;
  saveWorkLedger(home, data);
  return obj;
}

export function getObject(home = chronicleHome(), id) {
  return loadWorkLedger(home).objects.find((o) => o.id === id) || null;
}

/** 列出对象；默认不含已归档。 */
export function listObjects(home = chronicleHome(), { type, state, query, project_id, goal_id, limit = 50, includeArchived = false } = {}) {
  const q = cleanStr(query, 200).toLowerCase();
  return loadWorkLedger(home).objects
    .filter((o) => (includeArchived || !o.archived_at))
    .filter((o) => (type ? o.type === normalizeType(type) : true))
    .filter((o) => (state ? o.state === state : true))
    .filter((o) => (project_id ? o.project_id === project_id : true))
    .filter((o) => (goal_id ? o.goal_id === goal_id : true))
    .filter((o) => (q ? [o.title, o.next_action, o.source, o.archive_reason, ...(o.evidence || [])].join('\n').toLowerCase().includes(q) : true))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, Math.max(1, limit));
}

export function listInsights(home = chronicleHome(), { status, query, limit = 50 } = {}) {
  return listObjects(home, { type: 'insight', state: status, query, limit, includeArchived: Boolean(status) })
    .map((o) => ({ ...o.meta.insight, id: o.id, state: o.state, evidence: o.evidence, updated_at: o.updated_at }));
}

function daysBetween(isoText, now) {
  const t = Date.parse(isoText || '');
  if (!Number.isFinite(t)) return 0;
  return (nowMs(now) - t) / 86400_000;
}

function hoursBetween(isoText, now) {
  return daysBetween(isoText, now) * 24;
}

/**
 * 计算异常/需要关注的对象；只读，不改账本。
 * severity: critical > warn > info。
 */
export function computeExceptions(home = chronicleHome(), { now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const out = [];
  const push = (obj, kind, severity, message, extra = {}) => {
    out.push({
      id: `exc_${obj.id}_${kind}`,
      object_id: obj.id,
      type: obj.type,
      state: obj.state,
      title: obj.title,
      kind,
      severity,
      message,
      ...extra,
    });
  };
  for (const obj of data.objects) {
    if (obj.archived_at) continue;
    const age = daysBetween(obj.updated_at, now);
    if (obj.type === 'action' && obj.state === 'captured' && hoursBetween(obj.updated_at, now) > ACTION_EXPIRE_HOURS) {
      push(obj, 'action-expired', 'info', '动作超过 24 小时未附着，可归档');
    }
    if (['task', 'action'].includes(obj.type) && ['inbox', 'captured', 'clarified'].includes(obj.state)
      && !obj.next_action && !obj.project_id && age > ORPHAN_DAYS) {
      push(obj, 'orphan', 'warn', `超过 ${ORPHAN_DAYS} 天无下一步/关联，建议归档`);
    }
    if (obj.type === 'project' && ['proposed', 'active'].includes(obj.state) && age > STUCK_PROJECT_DAYS) {
      push(obj, 'stuck-project', 'warn', `项目 ${STUCK_PROJECT_DAYS} 天无进展，建议标 blocked 或复盘`, { age_days: Math.floor(age) });
    }
    if (['task', 'project'].includes(obj.type) && ['clarified', 'doing', 'active', 'blocked'].includes(obj.state) && !obj.next_action) {
      push(obj, 'no-next-action', 'warn', '进行中但没有下一步动作');
    }
    if (obj.type === 'commitment' && ['made', 'due', 'followed_up'].includes(obj.state)
      && obj.due_at && Date.parse(obj.due_at) < nowMs(now)) {
      push(obj, 'broken-promise', 'warn', '承诺已到期，未观察到兑现证据', { due_at: obj.due_at });
    }
    if (obj.review_at && Date.parse(obj.review_at) <= nowMs(now)) {
      push(obj, 'review-due', 'warn', '到了复盘时间', { review_at: obj.review_at });
    }
    if (obj.type === 'insight') {
      const ins = obj.meta?.insight || {};
      if (obj.state === 'candidate' && age > INSIGHT_STALE_DAYS) {
        push(obj, 'insight-stale', 'info', `洞察候选超过 ${INSIGHT_STALE_DAYS} 天未验证，建议降级/归档`);
      }
      if (ins.expiry && Date.parse(ins.expiry) - nowMs(now) < 7 * 86400_000) {
        push(obj, 'insight-expiring', 'info', '洞察即将过期，请复核', { expiry: ins.expiry });
      }
    }
    if (['task', 'project'].includes(obj.type) && ['done', 'dropped', 'abandoned'].includes(obj.state)
      && (!obj.evidence || obj.evidence.length === 0)) {
      push(obj, 'missing-evidence', 'info', '标记完成但没有证据');
    }
  }
  const inboxTasks = data.objects.filter((o) => !o.archived_at && o.type === 'task' && o.state === 'inbox').length;
  if (inboxTasks >= MAX_INBOX_TASKS) out.push({
    id: 'exc_cap_inbox', object_id: null, type: 'task', state: 'inbox', title: 'Inbox 上限',
    kind: 'inbox-overflow', severity: 'warn', message: `Inbox 已有 ${inboxTasks}/${MAX_INBOX_TASKS} 个任务，请先 triage/归档`,
  });
  for (const [type, cap] of Object.entries(WORK_CAPS)) {
    const n = capCount(data, type);
    if (n >= cap) out.push({
      id: `exc_cap_${type}`, object_id: null, type, state: '', title: `${type} 上限`,
      kind: 'cap-warning', severity: 'warn', message: `活跃 ${type} 已达 ${n}/${cap}，请合并/归档/排队`,
    });
  }
  const rank = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

/** 应用超时规则：Action 过期、7 天无主对象归档、14 天项目标 blocked。返回变更列表。 */
export function sweepLedger(home = chronicleHome(), { now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const changes = [];
  for (const obj of data.objects) {
    if (obj.archived_at) continue;
    const age = daysBetween(obj.updated_at, now);
    if (obj.type === 'action' && obj.state === 'captured' && hoursBetween(obj.updated_at, now) > ACTION_EXPIRE_HOURS) {
      obj.state = 'expired'; obj.updated_at = iso(now); changes.push({ id: obj.id, action: 'expire-action' });
      continue;
    }
    if (['task', 'action'].includes(obj.type) && ['inbox', 'captured', 'clarified'].includes(obj.state)
      && !obj.next_action && !obj.project_id && age > ORPHAN_DAYS) {
      obj.state = obj.type === 'action' ? 'expired' : 'archived';
      obj.archived_at = iso(now); obj.archive_reason = `orphan-${ORPHAN_DAYS}d`;
      obj.updated_at = iso(now); changes.push({ id: obj.id, action: 'archive-orphan' });
      continue;
    }
    if (obj.type === 'project' && obj.state === 'active' && age > STUCK_PROJECT_DAYS) {
      obj.state = 'blocked'; obj.updated_at = iso(now);
      changes.push({ id: obj.id, action: 'mark-project-blocked' });
    }
  }
  if (changes.length) saveWorkLedger(home, data);
  return { changes, ledger: data };
}

function priorityScore(obj, now) {
  let score = 0;
  if (obj.due_at) {
    const dt = Date.parse(obj.due_at);
    if (Number.isFinite(dt)) score += dt <= nowMs(now) ? 100 : Math.max(0, 30 - (dt - nowMs(now)) / 86400_000);
  }
  if (obj.state === 'blocked') score += 20;
  if (obj.state === 'doing' || obj.state === 'active') score += 10;
  return score;
}

/** 复盘队列：today/week/month。只读。 */
export function reviewQueue(home = chronicleHome(), { cadence = 'today', now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const exceptions = computeExceptions(home, { now });
  const active = data.objects.filter((o) => !o.archived_at && isActiveObject(o));
  const due = active.filter((o) => o.due_at && Date.parse(o.due_at) <= nowMs(now) + (cadence === 'today' ? 86400_000 : 7 * 86400_000));
  const priorities = active
    .filter((o) => ['task', 'project', 'commitment', 'decision', 'incident'].includes(o.type))
    .sort((a, b) => priorityScore(b, now) - priorityScore(a, now))
    .slice(0, cadence === 'today' ? 3 : 10);
  const insights = active.filter((o) => o.type === 'insight')
    .map((o) => ({ id: o.id, claim: o.meta?.insight?.claim || o.title, state: o.state, confidence: o.meta?.insight?.confidence ?? 0.5, expiry: o.meta?.insight?.expiry }));
  const projects = active.filter((o) => o.type === 'project');
  const goals = active.filter((o) => o.type === 'goal');
  const areas = active.filter((o) => o.type === 'area');
  return {
    cadence,
    generated_at: iso(now),
    counts: {
      active: active.length, projects: projects.length, goals: goals.length, areas: areas.length,
      insights: insights.length, exceptions: exceptions.length,
    },
    priorities,
    due,
    exceptions: cadence === 'today' ? exceptions.filter((e) => e.severity !== 'info').slice(0, 10) : exceptions.slice(0, 30),
    insights: cadence === 'today' ? insights.filter((i) => i.state === 'validated').slice(0, 3) : insights,
  };
}

/**
 * 生成 Context Pack：给交接/新 agent 的可携带上下文包。
 * 以对象/项目为根，收集同项目/同目标对象、相关洞察、open loops、证据。
 */
export function buildContextPack(home = chronicleHome(), { objectIds = [], projectId = '', limit = 100, now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const ids = new Set((Array.isArray(objectIds) ? objectIds : [objectIds]).filter(Boolean));
  const roots = data.objects.filter((o) => !o.archived_at && (ids.has(o.id) || (projectId && (o.id === projectId || o.project_id === projectId))));
  if (!roots.length) throw new WorkLedgerError('没有匹配的对象/项目，无法生成 Context Pack', 'NOT_FOUND');
  const projectIds = new Set(roots.map((o) => o.project_id).filter(Boolean));
  const goalIds = new Set(roots.map((o) => o.goal_id).filter(Boolean));
  const related = data.objects.filter((o) => !o.archived_at && (
    roots.some((r) => r.id === o.id)
    || (o.project_id && projectIds.has(o.project_id))
    || (o.goal_id && goalIds.has(o.goal_id))
    || (o.type === 'insight' && (o.meta?.insight?.related_object_ids || []).some((id) => ids.has(id)))
  )).slice(0, Math.max(1, limit));
  const insights = data.objects.filter((o) => !o.archived_at && o.type === 'insight' && (
    ['validated', 'applied'].includes(o.state) || roots.some((r) => (r.meta?.insight?.related_object_ids || []).includes(o.id))
  )).map((o) => ({
    id: o.id, claim: o.meta?.insight?.claim || o.title, state: o.state,
    confidence: o.meta?.insight?.confidence ?? 0.5, evidence: o.evidence || [],
  }));
  const openLoops = related.filter((o) => o.next_action || o.state === 'blocked' || o.type === 'commitment')
    .map((o) => ({ id: o.id, type: o.type, state: o.state, title: o.title, next_action: o.next_action || '' }));
  const evidence = [...new Set(related.flatMap((o) => o.evidence || []))].slice(0, 100);
  return {
    version: 1,
    kind: 'work-pack',
    generated_at: iso(now),
    roots: roots.map((o) => o.id),
    objects: related,
    insights,
    open_loops: openLoops,
    evidence,
    permissions: { read: ['agents'], act: [] },
  };
}

/** 结果指标：对象数、闭环率、洞察验证/应用率、Inbox、异常。只读。 */
export function workStats(home = chronicleHome(), { now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const all = data.objects;
  const active = all.filter((o) => !o.archived_at);
  const archived = all.length - active.length;
  const byType = {};
  const byState = {};
  for (const o of all) {
    byType[o.type] = (byType[o.type] || 0) + 1;
    byState[o.state] = (byState[o.state] || 0) + 1;
  }
  const tasks = active.filter((o) => o.type === 'task');
  const taskClosed = tasks.filter((o) => ['done', 'dropped'].includes(o.state)).length;
  const commitments = active.filter((o) => o.type === 'commitment');
  const commitmentClosed = commitments.filter((o) => ['fulfilled', 'broken', 'renegotiated'].includes(o.state)).length;
  const insights = all.filter((o) => o.type === 'insight');
  const insightState = (st) => insights.filter((o) => o.state === st).length;
  const validatedish = insightState('validated') + insightState('applied');
  const validationBase = validatedish + insightState('refuted') + insightState('candidate');
  const exceptions = computeExceptions(home, { now });
  const orphan = exceptions.filter((e) => e.kind === 'orphan').length;
  const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
  return {
    generated_at: iso(now),
    total: all.length,
    active: active.length,
    archived,
    inbox: active.filter((o) => o.type === 'task' && o.state === 'inbox').length,
    byType,
    byState,
    taskClosureRate: rate(taskClosed, tasks.length),
    commitmentClosureRate: rate(commitmentClosed, commitments.length),
    insights: {
      candidate: insightState('candidate'),
      validated: insightState('validated'),
      refuted: insightState('refuted'),
      applied: insightState('applied'),
      retired: insightState('retired'),
      validationRate: rate(validatedish, validationBase),
      applicationRate: rate(insightState('applied'), validatedish),
    },
    orphanRate: rate(orphan, active.length),
    exceptions: {
      total: exceptions.length,
      critical: exceptions.filter((e) => e.severity === 'critical').length,
      warn: exceptions.filter((e) => e.severity === 'warn').length,
      info: exceptions.filter((e) => e.severity === 'info').length,
    },
  };
}

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function extractNextActions(text) {
  const m = /^next_actions:\s*(.+)$/m.exec(String(text ?? ''));
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 去掉 frontmatter，只留正文。 */
function summaryBody(text) {
  const s = String(text ?? '');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

function summarySentences(text) {
  return summaryBody(text)
    .split(/[。！？!?；;\n]+/)
    .map((x) => x.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((x) => x.length >= 6 && x.length <= 220);
}

const HEURISTIC_RULES = [
  {
    type: 'commitment',
    state: 'made',
    re: /(答应|承诺|说好|我明天|我今天|我周[一二三四五六日天]|周五前|稍后发|明天发|发你|回复你|给你发|安排给)/,
  },
  {
    type: 'decision',
    state: 'proposed',
    re: /(决定|确定采用|选择采用|改为|换成|拍板|最终选)/,
  },
  {
    type: 'incident',
    state: 'detected',
    re: /(失败|报错|错误|阻塞|卡住|超时|中断|aborted|error|failed)/i,
  },
];

/** 从摘要正文提取候选对象（承诺/决策/异常）；只做保守候选，仍需用户 triage。 */
function extractHeuristicCandidates(text) {
  const out = [];
  const sentences = summarySentences(text);
  for (const rule of HEURISTIC_RULES) {
    for (const sentence of sentences) {
      if (!rule.re.test(sentence)) continue;
      if (rule.type === 'incident' && /(未观察到|未见|没有|尚未|无|不)/.test(sentence)) continue;
      out.push({ type: rule.type, state: rule.state, title: sentence.slice(0, 180), sentence });
      break; // 每个摘要每类最多 1 条
    }
  }
  return out;
}

/**
 * 从最近 10min/6h 摘要的 next_actions 生成 inbox Task 候选。
 * 只生成 Task，不自动升格 Project/Goal；由用户 triage。
 */
export function seedFromSummaries(home = chronicleHome(), { sinceHours = 48, limit = 24, maxCreate = 10, now = Date.now() } = {}) {
  const data = loadWorkLedger(home);
  const inboxTasks = data.objects.filter((o) => !o.archived_at && o.type === 'task' && o.state === 'inbox').length;
  if (inboxTasks >= MAX_INBOX_TASKS) {
    return { created: [], skipped: [{ title: '', reason: 'inbox-full' }] };
  }
  const existingKeys = new Set(data.objects.map((o) => o.source_key).filter(Boolean));
  const existingTitles = data.objects.filter((o) => !o.archived_at && ['task', 'action'].includes(o.type)).map((o) => o.title);
  const created = [];
  const skipped = [];
  const summaries = listRecentSummaries(home, { limit, sinceHours, now });
  for (const item of summaries) {
    let text = '';
    try { text = readFileSync(item.filePath, 'utf8'); } catch { continue; }
    for (const action of extractNextActions(text)) {
      if (created.length >= maxCreate) break;
      const title = cleanStr(action?.action || action, 200);
      if (!title) continue;
      const sourceKey = `summary:${item.filename}:${hashText(title)}`;
      if (existingKeys.has(sourceKey)) { skipped.push({ title, reason: 'already-seeded' }); continue; }
      if (existingTitles.some((t) => titleSimilarity(t, title) >= 0.82)) {
        skipped.push({ title, reason: 'similar-title' }); continue;
      }
      const obj = createObject(home, {
        type: 'task', state: 'inbox', title, next_action: title,
        evidence: [item.filename], source: 'summary', source_key: sourceKey,
        meta: { reason: cleanStr(action?.reason, 500), summary_segment: item.segment || '' },
      }, { now, ledger: data });
      created.push(obj);
      existingKeys.add(sourceKey);
      existingTitles.push(title);
    }
    // 之后从正文提取承诺/决策/异常候选（保守；每类每摘要最多 1 条）
    for (const cand of extractHeuristicCandidates(text)) {
      if (created.length >= maxCreate) break;
      const title = cleanStr(cand.title, 200);
      if (!title) continue;
      const sourceKey = `heuristic:${cand.type}:${item.filename}:${hashText(title)}`;
      if (existingKeys.has(sourceKey)) { skipped.push({ title, reason: 'already-seeded' }); continue; }
      if (existingTitles.some((t) => titleSimilarity(t, title) >= 0.82)) {
        skipped.push({ title, reason: 'similar-title' }); continue;
      }
      const obj = createObject(home, {
        type: cand.type, state: cand.state, title, next_action: '',
        evidence: [item.filename], source: 'summary-heuristic', source_key: sourceKey,
        meta: { candidate: true, summary_segment: item.segment || '', heuristic_sentence: cand.sentence },
      }, { now, ledger: data });
      created.push(obj);
      existingKeys.add(sourceKey);
      existingTitles.push(title);
    }
    if (created.length >= maxCreate) break;
  }
  return { created, skipped };
}

/**
 * 保守的候选洞察生成器（v0 启发式）：
 * 只从“重复出现的相似任务”生成 opportunity 候选；≥minSupport 次才生成，
 * 最多 maxCreate 条；同一聚类不会重复生成。所有候选仍需用户 validate。
 */
export function generateCandidateInsights(home = chronicleHome(), { now = Date.now(), minSupport = 3, maxCreate = 3, similarity = 0.75 } = {}) {
  const data = loadWorkLedger(home);
  const tasks = data.objects.filter((o) => !o.archived_at && ['task', 'action'].includes(o.type)
    && daysBetween(o.updated_at, now) <= 90);
  const clusters = [];
  for (const task of tasks) {
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      const score = titleSimilarity(c.title, task.title);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    if (best && bestScore >= similarity) best.items.push(task);
    else clusters.push({ title: task.title, items: [task] });
  }
  const existing = data.objects.filter((o) => o.type === 'insight');
  const existingKeys = new Set(existing.map((o) => o.source_key).filter(Boolean));
  const created = [];
  const skipped = [];
  for (const c of clusters.sort((a, b) => b.items.length - a.items.length)) {
    if (created.length >= maxCreate) break;
    if (c.items.length < Math.max(2, minSupport)) continue;
    const key = `heuristic:repeat:${hashText(c.title.toLowerCase().replace(/\s+/g, ''))}`;
    if (existingKeys.has(key)) { skipped.push({ title: c.title, reason: 'already-generated' }); continue; }
    const claim = `重复任务「${c.title}」出现 ${c.items.length} 次，可能值得变成技能/自动化`;
    if (existing.some((o) => titleSimilarity(o.title, claim) >= 0.8)) {
      skipped.push({ title: c.title, reason: 'similar-insight' }); continue;
    }
    const projectIds = [...new Set(c.items.map((o) => o.project_id).filter(Boolean))];
    try {
      const insight = createInsight(home, {
        claim,
        evidence: c.items.map((o) => o.id).slice(0, 20),
        confidence: Math.min(0.85, 0.4 + 0.1 * c.items.length),
        sample_size: c.items.length,
        scope: projectIds.length === 1 ? { project: projectIds[0] } : {},
        suggested_action: `把「${c.title}」整理成技能或自动化，并在下一次重复时验证`,
        source: 'heuristic',
        source_key: key,
      }, { now });
      created.push(insight);
      existingKeys.add(key);
    } catch (err) {
      skipped.push({ title: c.title, reason: err.code === 'CAP_EXCEEDED' ? 'insight-budget' : String(err.message || err) });
      break;
    }
  }
  return { created, skipped, clusters: clusters.length };
}

export function createInsight(home = chronicleHome(), input = {}, { now = Date.now() } = {}) {
  const evidence = cleanList(input.evidence, 30);
  if (!evidence.length) throw new WorkLedgerError('洞察必须有 evidence（摘要/文件/对象）', 'NO_EVIDENCE');
  return createObject(home, {
    ...input,
    type: 'insight',
    state: input.state || 'candidate',
    title: cleanStr(input.claim || input.title, 500),
    meta: { ...(input.meta || {}), insight: { ...(input.meta?.insight || {}), ...input } },
  }, { now });
}

export function validateInsight(home = chronicleHome(), id, { refute = false, note = '', now = Date.now() } = {}) {
  const obj = getObject(home, id);
  if (!obj || obj.type !== 'insight') throw new WorkLedgerError(`洞察不存在: ${id}`, 'NOT_FOUND');
  const insight = { ...(obj.meta?.insight || {}), validated_at: iso(now), validation_note: cleanStr(note, 500) };
  return updateObject(home, id, { state: refute ? 'refuted' : 'validated', meta: { ...obj.meta, insight } }, { now });
}

export function applyInsight(home = chronicleHome(), id, { appliedTo = '', note = '', now = Date.now() } = {}) {
  const obj = getObject(home, id);
  if (!obj || obj.type !== 'insight') throw new WorkLedgerError(`洞察不存在: ${id}`, 'NOT_FOUND');
  const insight = { ...(obj.meta?.insight || {}), applied_at: iso(now), applied_to: cleanStr(appliedTo, 300), validation_note: cleanStr(note || obj.meta?.insight?.validation_note, 500) };
  return updateObject(home, id, { state: 'applied', meta: { ...obj.meta, insight } }, { now });
}

export function retireInsight(home = chronicleHome(), id, reason = '', { now = Date.now() } = {}) {
  return archiveObject(home, id, reason || 'retired', { now });
}
