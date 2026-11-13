// test/agent-executor.test.mjs — Agent 动作执行 / 审计 / 回滚（P2 v0）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAgent, grantPermission } from '../shared/agent-registry.mjs';
import { createObject, createInsight, getObject } from '../shared/work-ledger.mjs';
import { executeAgentAction, undoAgentAction } from '../shared/agent-executor.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-agent-exec-'));

describe('Agent 执行器：权限 → 动作 → 审计 → 回滚', () => {
  test('L1 默认拒绝 L2 动作', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Worker', default_level: 'L1' });
      const task = createObject(home, { type: 'task', title: 'T', next_action: '做' });
      assert.throws(() => executeAgentAction(home, a.id, 'set_state', { objectId: task.id, state: 'doing' }), /权限不足/);
      assert.equal(getObject(home, task.id).state, 'inbox');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('授权 L2 后执行 set_state，undo 恢复', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Worker', default_level: 'L0' });
      const task = createObject(home, { type: 'task', title: 'T', next_action: '做' });
      grantPermission(home, a.id, { level: 'L2', scopes: [`object:${task.id}`] });
      const r = executeAgentAction(home, a.id, 'set_state', { objectId: task.id, state: 'doing', next_action: '开始' });
      assert.equal(r.result.state, 'doing');
      assert.equal(getObject(home, task.id).state, 'doing');
      assert.equal(r.audit.action, 'agent.set_state');
      assert.equal(r.audit.detail.reversible, true);
      const undo = undoAgentAction(home, r.audit.id);
      assert.equal(undo.restored.state, 'inbox');
      assert.equal(getObject(home, task.id).state, 'inbox');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('archive / create_task / insight 验证均可回滚', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Worker', default_level: 'L2' });
      const task = createObject(home, { type: 'task', title: '归档我' });
      const archived = executeAgentAction(home, a.id, 'archive', { objectId: task.id, reason: 'test' });
      assert.ok(getObject(home, task.id).archived_at);
      undoAgentAction(home, archived.audit.id);
      assert.equal(getObject(home, task.id).archived_at, null);

      const created = executeAgentAction(home, a.id, 'create_task', { title: 'Agent 新建任务', next_action: '做' });
      assert.equal(created.result.type, 'task');
      assert.ok(getObject(home, created.result.id));
      undoAgentAction(home, created.audit.id);
      assert.ok(getObject(home, created.result.id).archived_at);

      const ins = createInsight(home, { claim: '洞察', evidence: ['a.md'] });
      const validated = executeAgentAction(home, a.id, 'validate_insight', { objectId: ins.id });
      assert.equal(validated.result.state, 'validated');
      undoAgentAction(home, validated.audit.id);
      assert.equal(getObject(home, ins.id).state, 'candidate');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
