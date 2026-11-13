// test/team.test.mjs — 团队/交接包导出与导入（P4）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObject, createInsight, listObjects } from '../shared/work-ledger.mjs';
import { buildTeamPack, importTeamPack } from '../shared/team.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-team-'));
const NOW = new Date('2026-11-12T12:00:00.000Z');

describe('团队/交接包', () => {
  test('导出项目包：只含活动对象与洞察，handoff 可读', () => {
    const home = tmpHome();
    try {
      const goal = createObject(home, { type: 'goal', state: 'active', title: '让 Chronicle 可交接', next_action: '写协议' }, { now: NOW.getTime() });
      const project = createObject(home, { type: 'project', state: 'active', title: '团队记忆', goal_id: goal.id, next_action: '导出交接包' }, { now: NOW.getTime() });
      createObject(home, { type: 'task', state: 'doing', title: '写导出接口', project_id: project.id, next_action: '补测试' }, { now: NOW.getTime() });
      createObject(home, { type: 'task', state: 'done', title: '已完成', project_id: project.id }, { now: NOW.getTime() });
      createInsight(home, { claim: '交接包比口述可靠', evidence: ['test/team.test.mjs'], project_id: project.id }, { now: NOW.getTime() });
      createObject(home, { type: 'project', state: 'active', title: '别的项目' }, { now: NOW.getTime() });
      const pack = buildTeamPack(home, { projectId: project.id, now: NOW });
      assert.equal(pack.kind, 'chronicle-team-pack');
      assert.equal(pack.version, 1);
      assert.ok(pack.objects.every((o) => o.id === project.id || o.project_id === project.id));
      assert.ok(pack.insights.length === 1);
      assert.match(pack.handoff, /# 工作交接包/);
      assert.match(pack.handoff, /写导出接口/);
      assert.equal(pack.stats.objects, 3); // project + doing task + done task
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('导入：新 id、引用重映射、重复导入跳过', () => {
    const src = tmpHome();
    const dst = tmpHome();
    try {
      const project = createObject(src, { type: 'project', state: 'active', title: '交接项目', next_action: '继续' }, { now: NOW.getTime() });
      const task = createObject(src, { type: 'task', state: 'doing', title: '接手任务', project_id: project.id, next_action: '做' }, { now: NOW.getTime() });
      createInsight(src, { claim: '可复用结论', evidence: ['a.md'], project_id: project.id }, { now: NOW.getTime() });
      const pack = buildTeamPack(src, { projectId: project.id, now: NOW });

      const first = importTeamPack(dst, pack, { now: NOW });
      assert.equal(first.imported, 3);
      assert.equal(first.skipped.length, 0);
      const imported = listObjects(dst, { includeArchived: true });
      const importedTask = imported.find((o) => o.title === '接手任务');
      const importedProject = imported.find((o) => o.title === '交接项目');
      assert.ok(importedTask.id !== task.id);
      assert.equal(importedTask.project_id, importedProject.id, '项目引用应指向新 id');
      assert.equal(importedTask.state, 'doing');
      assert.deepEqual(importedTask.meta.imported_from.id, task.id);
      assert.equal(imported.find((o) => o.type === 'insight').evidence[0], 'a.md');

      const second = importTeamPack(dst, pack, { now: NOW });
      assert.equal(second.imported, 0);
      assert.equal(second.skipped.length, 3);
      assert.ok(second.skipped.every((s) => s.reason === '已导入过'));
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  test('坏包直接拒绝', () => {
    const home = tmpHome();
    try {
      assert.throws(() => importTeamPack(home, {}), /不是有效的/);
      assert.throws(() => importTeamPack(home, { kind: 'chronicle-team-pack', version: 2 }), /不是有效的/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
