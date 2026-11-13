// test/work-ledger.test.mjs — 工作对象 / 洞察 / 闭环账本（P1 v0）
//
// 覆盖：对象创建/校验/状态机、硬上限、归档、sweep 超时、异常检测、
// 复盘队列、从摘要 next_actions 播种、洞察生命周期/预算、坏文件容错。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORK_CAPS, MAX_INBOX_TASKS, loadWorkLedger, saveWorkLedger, workLedgerPath,
  createObject, updateObject, archiveObject, getObject, listObjects, listInsights,
  computeExceptions, sweepLedger, reviewQueue, seedFromSummaries,
  createInsight, validateInsight, applyInsight, retireInsight, generateCandidateInsights, workStats, buildContextPack,
} from '../shared/work-ledger.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-work-'));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function mkSummary(home, name, actions, { segment = iso(now), body = '## 总览\n- 测试摘要' } = {}) {
  const dir = path.join(home, 'summaries');
  mkdirSync(dir, { recursive: true });
  const text = [
    '---',
    `title: "${name}"`,
    `segment: "${segment}"`,
    'type: "10min"',
    `next_actions: ${JSON.stringify(actions)}`,
    '---',
    '',
    body,
  ].join('\n');
  writeFileSync(path.join(dir, name), text);
}

describe('工作账本：对象与存储', () => {
  test('创建 Task：默认 inbox、原子写、0600、可读回', () => {
    const home = tmpHome();
    try {
      const obj = createObject(home, { type: 'task', title: '核对 PDF 图片', next_action: '打开图片清单' });
      assert.equal(obj.type, 'task');
      assert.equal(obj.state, 'inbox');
      assert.equal(obj.next_action, '打开图片清单');
      const file = workLedgerPath(home);
      assert.ok(statSync(file).isFile());
      assert.equal((statSync(file).mode & 0o777).toString(8), '600');
      const loaded = loadWorkLedger(home);
      assert.equal(loaded.objects.length, 1);
      assert.equal(loaded.objects[0].title, '核对 PDF 图片');
      assert.equal(getObject(home, obj.id).id, obj.id);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('校验：类型/标题/状态；默认状态按类型', () => {
    const home = tmpHome();
    try {
      assert.throws(() => createObject(home, { type: 'nope', title: 'x' }), /未知工作对象类型/);
      assert.throws(() => createObject(home, { type: 'task', title: '   ' }), /缺少 title/);
      const p = createObject(home, { type: 'project', title: 'Hulala' });
      assert.equal(p.state, 'proposed');
      const c = createObject(home, { type: 'commitment', title: '周五发 PDF' });
      assert.equal(c.state, 'made');
      assert.throws(() => updateObject(home, p.id, { state: 'weird' }), /不支持状态/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('更新/归档：状态、下一步、默认列表过滤', () => {
    const home = tmpHome();
    try {
      const obj = createObject(home, { type: 'task', title: 'T' });
      const updated = updateObject(home, obj.id, { state: 'doing', next_action: '动手', review_at: iso(now + 86400_000) });
      assert.equal(updated.state, 'doing');
      assert.equal(updated.next_action, '动手');
      assert.ok(updated.review_at);
      assert.equal(listObjects(home).length, 1);
      archiveObject(home, obj.id, 'done');
      assert.equal(listObjects(home).length, 0);
      assert.equal(listObjects(home, { includeArchived: true }).length, 1);
      assert.equal(listObjects(home, { includeArchived: true })[0].archive_reason, 'done');
      assert.throws(() => updateObject(home, 'missing', { state: 'doing' }), /不存在/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('坏账本 JSON 回落到空账本', () => {
    const home = tmpHome();
    try {
      writeFileSync(workLedgerPath(home), '{broken');
      assert.deepEqual(loadWorkLedger(home).objects, []);
      assert.deepEqual(listObjects(home), []);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('硬上限：防止无限扩张', () => {
  test(`活跃 Project ≤ ${WORK_CAPS.project}；归档后可再建`, () => {
    const home = tmpHome();
    try {
      const ids = [];
      for (let i = 0; i < WORK_CAPS.project; i += 1) {
        ids.push(createObject(home, { type: 'project', title: `P${i}`, state: 'active' }).id);
      }
      assert.throws(() => createObject(home, { type: 'project', title: 'P-over', state: 'active' }), /上限/);
      archiveObject(home, ids[0], 'merged');
      const p = createObject(home, { type: 'project', title: 'P-new', state: 'active' });
      assert.equal(p.state, 'active');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test(`活跃 Goal ≤ ${WORK_CAPS.goal}`, () => {
    const home = tmpHome();
    try {
      for (let i = 0; i < WORK_CAPS.goal; i += 1) createObject(home, { type: 'goal', title: `G${i}`, state: 'active' });
      assert.throws(() => createObject(home, { type: 'goal', title: 'G-over', state: 'active' }), /上限/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('Sweep：每个对象都有出口', () => {
  test('24h Action 过期、7 天无主 Task 归档、14 天 Project 标 blocked', () => {
    const home = tmpHome();
    try {
      const action = createObject(home, { type: 'action', title: '一次点击' });
      updateObject(home, action.id, { next_action: '' }, { now: now - 25 * 3600_000 });
      const task = createObject(home, { type: 'task', title: '无主任务' });
      updateObject(home, task.id, { next_action: '' }, { now: now - 8 * 86400_000 });
      const project = createObject(home, { type: 'project', title: '停滞项目', state: 'active' });
      updateObject(home, project.id, { next_action: '继续' }, { now: now - 15 * 86400_000 });
      const r = sweepLedger(home, { now });
      assert.ok(r.changes.some((c) => c.id === action.id && c.action === 'expire-action'));
      assert.ok(r.changes.some((c) => c.id === task.id && c.action === 'archive-orphan'));
      assert.ok(r.changes.some((c) => c.id === project.id && c.action === 'mark-project-blocked'));
      assert.equal(getObject(home, task.id).archived_at != null, true);
      assert.equal(getObject(home, project.id).state, 'blocked');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('异常检测与复盘', () => {
  test('broken promise / no next action / review due / insight stale', () => {
    const home = tmpHome();
    try {
      const commitment = createObject(home, { type: 'commitment', title: '周五发 PDF', state: 'due', due_at: iso(now - 86400_000) });
      const task = createObject(home, { type: 'task', title: '进行中无下一步', state: 'doing' });
      const decision = createObject(home, { type: 'decision', title: '选方案', state: 'review_due', review_at: iso(now - 3600_000) });
      const insight = createObject(home, { type: 'insight', title: '旧洞察', evidence: ['a.md'] });
      updateObject(home, insight.id, {}, { now: now - 31 * 86400_000 });
      const exc = computeExceptions(home, { now });
      const kinds = new Set(exc.map((e) => `${e.kind}:${e.object_id}`));
      assert.ok(kinds.has(`broken-promise:${commitment.id}`));
      assert.ok(kinds.has(`no-next-action:${task.id}`));
      assert.ok(kinds.has(`review-due:${decision.id}`));
      assert.ok(kinds.has(`insight-stale:${insight.id}`));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('复盘 today：优先项 ≤3，due 与异常存在', () => {
    const home = tmpHome();
    try {
      createObject(home, { type: 'project', title: 'P1', state: 'active', next_action: '推进' });
      createObject(home, { type: 'task', title: 'T1', state: 'doing', next_action: '做', due_at: iso(now - 3600_000) });
      createObject(home, { type: 'commitment', title: '承诺', state: 'due', due_at: iso(now - 86400_000) });
      const r = reviewQueue(home, { cadence: 'today', now });
      assert.equal(r.cadence, 'today');
      assert.ok(r.priorities.length <= 3);
      assert.ok(r.due.length >= 1);
      assert.ok(r.exceptions.length >= 1);
      const week = reviewQueue(home, { cadence: 'week', now });
      assert.equal(week.cadence, 'week');
      assert.ok(week.counts.projects >= 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('从摘要播种 inbox Task', () => {
  test('next_actions → Task；重复/相似标题跳过；maxCreate 生效', () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-a.md', [
        { action: '核对 245 个商品页图片', reason: '客户反馈图片丢失' },
        { action: '重启 MCP 服务后复测', reason: '上次失败是未重启' },
      ]);
      mkSummary(home, '10min-b.md', [
        { action: '核对 245 个商品页图片', reason: '重复' },
        { action: '整理交接包', reason: '周五交接' },
      ]);
      const r1 = seedFromSummaries(home, { sinceHours: 0, maxCreate: 10, now });
      assert.equal(r1.created.length, 3);
      assert.ok(r1.skipped.some((s) => s.reason === 'similar-title' || s.reason === 'already-seeded'));
      assert.equal(listObjects(home, { type: 'task' }).length, 3);
      const r2 = seedFromSummaries(home, { sinceHours: 0, maxCreate: 10, now });
      assert.equal(r2.created.length, 0);
      const r3 = seedFromSummaries(home, { sinceHours: 0, maxCreate: 1, now });
      assert.equal(r3.created.length, 0, '都已被去重');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('摘要正文启发式：承诺/决策/异常候选', () => {
  test('识别承诺/决策/异常；候选标记；否定句不误报', () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-h.md', [], {
        body: '## 总览\n- 我明天发你 PDF。\n- 决定采用 A 方案。\n- 上传失败，报错 500。\n- 未观察到失败，稍后复核。',
      });
      const r = seedFromSummaries(home, { sinceHours: 0, maxCreate: 10, now });
      assert.equal(r.created.length, 3);
      const types = r.created.map((o) => o.type).sort();
      assert.deepEqual(types, ['commitment', 'decision', 'incident']);
      assert.ok(r.created.every((o) => o.meta.candidate === true));
      assert.ok(r.created.every((o) => o.source === 'summary-heuristic'));
      const commitment = r.created.find((o) => o.type === 'commitment');
      assert.equal(commitment.state, 'made');
      assert.match(commitment.title, /明天发你 PDF/);
      const incident = r.created.find((o) => o.type === 'incident');
      assert.equal(incident.state, 'detected');
      const decision = r.created.find((o) => o.type === 'decision');
      assert.equal(decision.state, 'proposed');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('Context Pack：交接/新 agent 的上下文包', () => {
  test('按项目收集对象/洞察/open loops/证据；无匹配报错', () => {
    const home = tmpHome();
    try {
      const proj = createObject(home, { type: 'project', title: 'Hulala 归档', state: 'active', next_action: '推进' });
      createObject(home, { type: 'task', title: '核对图片', state: 'doing', project_id: proj.id, next_action: '打开清单', evidence: ['10min-a.md'] });
      const ins = createInsight(home, { claim: '图片校验总被低估', evidence: ['10min-a.md'], confidence: 0.7 });
      validateInsight(home, ins.id);
      const pack = buildContextPack(home, { projectId: proj.id });
      assert.equal(pack.kind, 'work-pack');
      assert.ok(pack.objects.length >= 2);
      assert.ok(pack.insights.some((i) => i.claim === '图片校验总被低估'));
      assert.ok(pack.open_loops.some((o) => o.title === '核对图片'));
      assert.ok(pack.evidence.includes('10min-a.md'));
      assert.throws(() => buildContextPack(home, { objectIds: ['missing'] }), /没有匹配/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('结果指标：workStats', () => {
  test('任务/承诺闭环率、洞察验证/应用率、Inbox/无主率', () => {
    const home = tmpHome();
    try {
      createObject(home, { type: 'task', title: '完成', state: 'done', evidence: ['a.md'] });
      createObject(home, { type: 'task', title: '放弃', state: 'dropped' });
      createObject(home, { type: 'task', title: '进行中', state: 'doing', next_action: '做' });
      createObject(home, { type: 'commitment', title: '兑现', state: 'fulfilled' });
      const i1 = createInsight(home, { claim: '洞察 A', evidence: ['a.md'] });
      createInsight(home, { claim: '洞察 B', evidence: ['b.md'] });
      validateInsight(home, i1.id);
      applyInsight(home, i1.id, { appliedTo: 'task:done' });
      const st = workStats(home, { now });
      assert.equal(st.total, 6);
      assert.equal(st.inbox, 0);
      assert.equal(st.taskClosureRate, 0.667);
      assert.equal(st.commitmentClosureRate, 1);
      assert.equal(st.insights.candidate, 1);
      assert.equal(st.insights.validated, 0);
      assert.equal(st.insights.applied, 1);
      assert.equal(st.insights.validationRate, 0.5);
      assert.equal(st.insights.applicationRate, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('Inbox 上限：防止无限堆积', () => {
  test(`inbox Task 达到 ${MAX_INBOX_TASKS} 时停止 seed，并报 inbox-overflow`, () => {
    const home = tmpHome();
    try {
      for (let i = 0; i < MAX_INBOX_TASKS; i += 1) {
        createObject(home, { type: 'task', title: `T${i}`, state: 'inbox' });
      }
      mkSummary(home, '10min-full.md', [{ action: '新任务', reason: '测试' }]);
      const r = seedFromSummaries(home, { sinceHours: 0, maxCreate: 5, now });
      assert.equal(r.created.length, 0);
      assert.ok(r.skipped.some((s) => s.reason === 'inbox-full'));
      const exc = computeExceptions(home, { now });
      assert.ok(exc.some((e) => e.kind === 'inbox-overflow'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('洞察生命周期与预算', () => {
  test('必须有 evidence；confidence 归一；validate/refute/apply/retire', () => {
    const home = tmpHome();
    try {
      assert.throws(() => createInsight(home, { claim: '无证据' }), /必须有 evidence/);
      const ins = createInsight(home, {
        claim: 'PDF 图片校验总被低估', evidence: ['10min-a.md'], confidence: 1.5,
        suggested_action: '先跑图片清单再估时',
      });
      assert.equal(ins.state, 'candidate');
      assert.equal(ins.meta.insight.confidence, 1);
      const v = validateInsight(home, ins.id, { note: '已复核' });
      assert.equal(v.state, 'validated');
      const a = applyInsight(home, ins.id, { appliedTo: 'task:verify' });
      assert.equal(a.state, 'applied');
      const t = retireInsight(home, ins.id, '已过时');
      assert.equal(t.state, 'retired');
      assert.equal(listInsights(home, { status: 'retired' }).length, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('候选洞察：≥3 个相似任务才生成；重复运行不重复', () => {
    const home = tmpHome();
    try {
      for (const title of ['核对 PDF 图片清单', '核对 PDF 图片清单页', '核对 PDF 图片清单文件']) {
        createObject(home, { type: 'task', title, state: 'done', evidence: ['a.md'] });
      }
      const r1 = generateCandidateInsights(home, { minSupport: 3, maxCreate: 3 });
      assert.equal(r1.created.length, 1);
      assert.equal(r1.created[0].state, 'candidate');
      assert.ok(r1.created[0].evidence.length >= 3);
      assert.match(r1.created[0].title, /重复任务/);
      const r2 = generateCandidateInsights(home, { minSupport: 3, maxCreate: 3 });
      assert.equal(r2.created.length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
    const home2 = tmpHome();
    try {
      createObject(home2, { type: 'task', title: '单独任务 A' });
      createObject(home2, { type: 'task', title: '单独任务 A 副本' });
      const r = generateCandidateInsights(home2, { minSupport: 3, maxCreate: 3 });
      assert.equal(r.created.length, 0);
    } finally { rmSync(home2, { recursive: true, force: true }); }
  });

  test(`活跃 Insight ≤ ${WORK_CAPS.insight}`, () => {
    const home = tmpHome();
    try {
      const ids = [];
      for (let i = 0; i < WORK_CAPS.insight; i += 1) {
        ids.push(createInsight(home, { claim: `洞察 ${i}`, evidence: ['e.md'] }).id);
      }
      assert.throws(() => createInsight(home, { claim: '溢出', evidence: ['e.md'] }), /上限/);
      const validated = validateInsight(home, ids[0]);
      assert.equal(validated.state, 'validated');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
