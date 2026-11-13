// shared/team.mjs — 团队/交接包（P4 v0）
//
// 目标：让一个人的工作对象可以被另一个人（或另一个 agent）接手。
//   · 导出只含工作对象与洞察，不含原始事件、输入文本、审计明细；
//   · 导入生成新对象，保留标题/状态/下一步/证据引用，并记录来源，重复导入自动跳过；
//   · handoff 是一段可读 Markdown：目标、项目、待办、承诺、异常。
//
// 这是“共享包”的最小闭环，不是实时协作/权限系统。

import { chronicleHome } from './segments.mjs';
import {
  loadWorkLedger, createObject, getObject, WorkLedgerError,
} from './work-ledger.mjs';

const DAY_MS = 86_400_000;
const MAX_PACK_OBJECTS = 200;

function cleanStr(value, max = 400) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoOrNull(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function sanitize(obj) {
  return {
    id: obj.id,
    type: obj.type,
    state: obj.state,
    title: cleanStr(obj.title, 200),
    next_action: cleanStr(obj.next_action, 500),
    project_id: obj.project_id || null,
    goal_id: obj.goal_id || null,
    due_at: isoOrNull(obj.due_at),
    review_at: isoOrNull(obj.review_at),
    evidence: Array.isArray(obj.evidence) ? obj.evidence.map((x) => cleanStr(x, 300)).filter(Boolean).slice(0, 20) : [],
    source: cleanStr(obj.source || 'manual', 60),
    created_at: isoOrNull(obj.created_at),
    updated_at: isoOrNull(obj.updated_at),
    meta: obj.type === 'insight' && obj.meta?.insight ? { insight: obj.meta.insight } : {},
  };
}

function handoffMarkdown(objects, projectId = '') {
  const byType = (type) => objects.filter((o) => o.type === type && !['archived', 'retired', 'dropped'].includes(o.state));
  const lines = [];
  lines.push(`# 工作交接包${projectId ? ` · ${projectId}` : ''}`);
  lines.push('');
  const goals = byType('goal');
  if (goals.length) {
    lines.push('## 目标');
    for (const g of goals) lines.push(`- [${g.state}] ${g.title}${g.next_action ? ` → ${g.next_action}` : ''}`);
    lines.push('');
  }
  const projects = byType('project');
  if (projects.length) {
    lines.push('## 项目');
    for (const p of projects) lines.push(`- [${p.state}] ${p.title}${p.next_action ? ` → ${p.next_action}` : ''}${p.review_at ? `（复盘 ${p.review_at.slice(0, 10)}）` : ''}`);
    lines.push('');
  }
  const tasks = objects.filter((o) => o.type === 'task' && !['done', 'dropped', 'archived'].includes(o.state));
  if (tasks.length) {
    lines.push('## 待办');
    for (const t of tasks.slice(0, 30)) lines.push(`- [${t.state}] ${t.title}${t.next_action ? ` → ${t.next_action}` : ''}${t.due_at ? `（截止 ${t.due_at.slice(0, 10)}）` : ''}`);
    if (tasks.length > 30) lines.push(`- …另有 ${tasks.length - 30} 条`);
    lines.push('');
  }
  const commitments = objects.filter((o) => o.type === 'commitment' && !['fulfilled', 'renegotiated', 'archived'].includes(o.state));
  if (commitments.length) {
    lines.push('## 承诺');
    for (const c of commitments) lines.push(`- [${c.state}] ${c.title}${c.due_at ? `（${c.due_at.slice(0, 10)}）` : ''}`);
    lines.push('');
  }
  const incidents = objects.filter((o) => o.type === 'incident' && !['resolved', 'prevented', 'archived'].includes(o.state));
  if (incidents.length) {
    lines.push('## 未解决异常');
    for (const i of incidents) lines.push(`- [${i.state}] ${i.title}${i.next_action ? ` → ${i.next_action}` : ''}`);
    lines.push('');
  }
  const decisions = objects.filter((o) => o.type === 'decision' && !['archived'].includes(o.state));
  if (decisions.length) {
    lines.push('## 决策');
    for (const d of decisions) lines.push(`- [${d.state}] ${d.title}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('由 Chronicle 导出。只含工作对象与证据引用，不含原始事件、输入文本或审计明细。');
  return lines.join('\n');
}

/**
 * 导出团队/交接包。
 * @param {string} home
 * @param {{projectId?: string, days?: number, now?: Date, includeInsights?: boolean}} opts
 * @returns {{version:number, kind:string, generated_at:string, project_id:string, horizon_days:number, objects:Array, insights:Array, handoff:string, stats:object}}
 */
export function buildTeamPack(home = chronicleHome(), { projectId = '', days = 30, now = new Date(), includeInsights = true } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const cutoff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - Math.max(1, Math.min(365, Number(days) || 30)) * DAY_MS;
  const data = loadWorkLedger(home);
  const wanted = (o) => {
    if (o.archived_at) return false;
    const updated = Date.parse(o.updated_at || o.created_at || '');
    if (Number.isFinite(updated) && updated < cutoff) return false;
    if (!projectId) return true;
    return o.id === projectId || o.project_id === projectId;
  };
  const all = data.objects.filter(wanted);
  const objects = all.filter((o) => o.type !== 'insight').slice(0, MAX_PACK_OBJECTS).map(sanitize);
  const insights = includeInsights
    ? all.filter((o) => o.type === 'insight' && o.state !== 'retired').slice(0, 50).map(sanitize)
    : [];
  return {
    version: 1,
    kind: 'chronicle-team-pack',
    generated_at: new Date().toISOString(),
    project_id: cleanStr(projectId, 120),
    horizon_days: Math.max(1, Math.min(365, Number(days) || 30)),
    objects,
    insights,
    handoff: handoffMarkdown([...objects, ...insights], projectId),
    stats: { objects: objects.length, insights: insights.length, truncated: all.length > objects.length + insights.length },
  };
}

/**
 * 导入团队包。重复导入按 (pack.generated_at, 原对象 id) 跳过。
 * @returns {{imported:number, skipped:Array<{id:string,reason:string}>, mapping:object}}
 */
export function importTeamPack(home = chronicleHome(), pack = {}, { now = new Date() } = {}) {
  if (!pack || pack.kind !== 'chronicle-team-pack' || pack.version !== 1) {
    throw new WorkLedgerError('不是有效的 Chronicle 团队包（kind/version 不匹配）', 'BAD_PACK');
  }
  const sourceObjects = [
    ...(Array.isArray(pack.objects) ? pack.objects : []),
    ...(Array.isArray(pack.insights) ? pack.insights : []),
  ];
  if (sourceObjects.length > MAX_PACK_OBJECTS + 50) {
    throw new WorkLedgerError('团队包对象过多', 'BAD_PACK');
  }
  const generatedAt = cleanStr(pack.generated_at, 60);
  const data = loadWorkLedger(home);
  const existing = new Set(
    data.objects
      .filter((o) => o.meta && o.meta.imported_from && o.meta.imported_from.pack_at === generatedAt)
      .map((o) => o.meta.imported_from.id),
  );

  const mapping = {};
  const skipped = [];
  let imported = 0;
  const order = ['goal', 'area', 'project', 'decision', 'commitment', 'incident', 'task', 'action', 'insight'];
  const sorted = sourceObjects.slice().sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

  for (const src of sorted) {
    if (!src || typeof src.id !== 'string' || typeof src.title !== 'string' || typeof src.type !== 'string') {
      skipped.push({ id: String(src && src.id || '?'), reason: '字段不完整' });
      continue;
    }
    if (existing.has(src.id)) {
      skipped.push({ id: src.id, reason: '已导入过' });
      continue;
    }
    try {
      const evidence = Array.isArray(src.evidence) ? src.evidence : [];
      const created = createObject(home, {
        type: src.type,
        state: src.state,
        title: src.title,
        next_action: src.next_action,
        project_id: src.project_id ? (mapping[src.project_id] || (getObject(home, src.project_id) ? src.project_id : null)) : null,
        goal_id: src.goal_id ? (mapping[src.goal_id] || (getObject(home, src.goal_id) ? src.goal_id : null)) : null,
        due_at: src.due_at,
        review_at: src.review_at,
        evidence: src.type === 'insight' && !evidence.length ? [`team-pack:${src.id}`] : evidence,
        source: 'team',
        meta: {
          ...(src.type === 'insight' && src.meta ? src.meta : {}),
          imported_from: { pack_at: generatedAt, id: src.id },
        },
      }, { now: now instanceof Date ? now.getTime() : Number(now) || Date.now() });
      mapping[src.id] = created.id;
      imported += 1;
    } catch (err) {
      skipped.push({ id: src.id, reason: err && err.code ? `${err.code}: ${err.message}` : String(err && err.message || err) });
    }
  }
  return { imported, skipped, mapping };
}
