// shared/agent-executor.mjs — Agent 动作执行器（P2 后端 v0）
//
// 目标：让权限/审计/回滚真正落到动作上，而不是只有静态检查。
//   · 每个动作先 checkPermission（L2 批准执行）；
//   · 执行前后各留一份对象快照，写入审计；
//   · 可逆动作支持 undo（恢复到 before 快照）；
//   · 不执行 shell/外部命令；只操作工作账本对象与洞察。
//
// 未来真正的 CUA/agent 运行时可以调用 executeAgentAction；本模块只做账本动作。

import { appendAudit, listAudit } from './audit.mjs';
import { checkPermission, getAgent } from './agent-registry.mjs';
import {
  loadWorkLedger, saveWorkLedger, getObject,
  createObject, updateObject, archiveObject,
  validateInsight, applyInsight, retireInsight,
} from './work-ledger.mjs';
import { chronicleHome } from './segments.mjs';

export const AGENT_ACTIONS = Object.freeze([
  'set_state', 'set_next_action', 'archive', 'create_task',
  'validate_insight', 'apply_insight', 'retire_insight',
]);

const REQUIRED_LEVEL = 'L2';

function clone(obj) {
  return obj == null ? null : JSON.parse(JSON.stringify(obj));
}

function objectScopes(obj) {
  if (!obj) return ['object:*'];
  const scopes = [`object:${obj.id}`];
  if (obj.project_id) scopes.push(`project:${obj.project_id}`);
  if (obj.goal_id) scopes.push(`goal:${obj.goal_id}`);
  return scopes;
}

function findPermission(home, agentId, obj, now) {
  for (const scope of objectScopes(obj)) {
    const r = checkPermission(home, agentId, { level: REQUIRED_LEVEL, scope, objectId: obj?.id, now });
    if (r.allowed) return r;
  }
  return checkPermission(home, agentId, { level: REQUIRED_LEVEL, scope: objectScopes(obj)[0], objectId: obj?.id, now });
}

function auditAction(home, { agentId, action, target, before, after, params, permission, reversible = true, now }) {
  return appendAudit(home, {
    actor: agentId,
    action: `agent.${action}`,
    target,
    detail: {
      before, after, params: params || {}, reversible,
      permission: permission ? { level: permission.level, reason: permission.reason } : null,
    },
  }, { now });
}

/**
 * 执行一个 agent 账本动作。
 * @returns {{ok:true, action:string, result:object, audit:object}}
 * @throws {Error} code=AGENT_NOT_FOUND | PERMISSION_DENIED | BAD_ACTION | NOT_FOUND
 */
export function executeAgentAction(home = chronicleHome(), agentId, action, params = {}, { now = new Date() } = {}) {
  const agent = getAgent(home, agentId);
  if (!agent) throw Object.assign(new Error(`Agent 不存在: ${agentId}`), { code: 'AGENT_NOT_FOUND' });
  const act = String(action || '');
  if (!AGENT_ACTIONS.includes(act)) throw Object.assign(new Error(`不支持的动作: ${act}`), { code: 'BAD_ACTION' });

  const objectId = params.objectId || params.id || '';
  let obj = objectId ? getObject(home, objectId) : null;
  if (objectId && !obj) throw Object.assign(new Error(`对象不存在: ${objectId}`), { code: 'NOT_FOUND' });
  if (!objectId && act !== 'create_task') throw Object.assign(new Error(`${act} 需要 objectId`), { code: 'BAD_ACTION' });

  const permission = findPermission(home, agentId, obj, now);
  if (!permission.allowed) {
    appendAudit(home, {
      actor: agentId, action: 'agent.denied', target: objectId,
      detail: { action: act, params, permission: { level: permission.level, reason: permission.reason } },
    }, { now });
    throw Object.assign(new Error(`权限不足：需要 ${REQUIRED_LEVEL}，当前 ${permission.level}（${permission.reason}）`), { code: 'PERMISSION_DENIED' });
  }

  const before = clone(obj);
  let result;
  let target = objectId;
  if (act === 'set_state') {
    result = updateObject(home, objectId, { state: params.state, next_action: params.next_action }, { now: now.getTime() });
  } else if (act === 'set_next_action') {
    result = updateObject(home, objectId, { next_action: params.next_action }, { now: now.getTime() });
  } else if (act === 'archive') {
    result = archiveObject(home, objectId, params.reason || 'agent', { now: now.getTime() });
  } else if (act === 'create_task') {
    result = createObject(home, {
      type: 'task', state: 'inbox',
      title: params.title,
      next_action: params.next_action || params.title,
      project_id: params.project_id,
      goal_id: params.goal_id,
      evidence: params.evidence,
      source: `agent:${agentId}`,
      meta: { agent: agentId, created_by_agent: true },
    }, { now: now.getTime() });
    target = result.id;
  } else if (act === 'validate_insight') {
    result = validateInsight(home, objectId, { refute: Boolean(params.refute), note: params.note, now: now.getTime() });
  } else if (act === 'apply_insight') {
    result = applyInsight(home, objectId, { appliedTo: params.appliedTo || '', note: params.note, now: now.getTime() });
  } else if (act === 'retire_insight') {
    result = retireInsight(home, objectId, params.reason || 'agent', { now: now.getTime() });
  } else {
    throw Object.assign(new Error(`不支持的动作: ${act}`), { code: 'BAD_ACTION' });
  }

  const audit = auditAction(home, {
    agentId, action: act, target, before, after: clone(result), params, permission, now,
  });
  return { ok: true, action: act, result, audit };
}

function findAudit(home, id, now = new Date()) {
  const days = 7;
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now.getTime() - i * 86400_000);
    const hit = listAudit(home, { date: d, limit: 10_000 }).find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}

/** 撤销一个 agent 动作：把对象恢复到审计里的 before 快照。 */
export function undoAgentAction(home = chronicleHome(), auditId, { now = new Date() } = {}) {
  const entry = findAudit(home, auditId, now);
  if (!entry) throw Object.assign(new Error(`审计不存在: ${auditId}`), { code: 'NOT_FOUND' });
  if (!entry.detail || entry.detail.reversible !== true) throw Object.assign(new Error('该动作不可撤销'), { code: 'NOT_REVERSIBLE' });
  const before = entry.detail.before;
  const after = entry.detail.after;
  const targetId = entry.target || after?.id || before?.id;
  if (!targetId) throw Object.assign(new Error('审计缺少目标对象'), { code: 'BAD_AUDIT' });
  const data = loadWorkLedger(home);
  const idx = data.objects.findIndex((o) => o.id === targetId);
  if (!before) {
    // create 的撤销：归档创建出来的对象（不物理删除）
    if (idx >= 0) {
      data.objects[idx].archived_at = now.toISOString();
      data.objects[idx].archive_reason = `undo-create:${auditId}`;
      data.objects[idx].updated_at = now.toISOString();
      saveWorkLedger(home, data);
    }
  } else if (idx >= 0) {
    data.objects[idx] = { ...before, updated_at: now.toISOString() };
    saveWorkLedger(home, data);
  } else {
    data.objects.push({ ...before, updated_at: now.toISOString() });
    saveWorkLedger(home, data);
  }
  const undo = appendAudit(home, {
    actor: entry.actor || 'user', action: 'agent.undo', target: targetId,
    detail: { undoOf: auditId, action: entry.action },
  }, { now });
  return { ok: true, restored: before || null, audit: undo, undoOf: auditId };
}
