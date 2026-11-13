// test/agent-registry.test.mjs — Agent 注册 / 权限 / 信任（P2 v0）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentsPath, loadAgentRegistry, registerAgent, listAgents, grantPermission, revokeGrant,
  checkPermission, recordAgentOutcome,
} from '../shared/agent-registry.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-agents-'));

describe('Agent 注册表', () => {
  test('注册/列表/默认 L0；重名自动加后缀；文件 0600', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Claude Code', kind: 'coding-agent' });
      assert.equal(a.default_level, 'L0');
      assert.equal(a.id, 'claude-code');
      const b = registerAgent(home, { name: 'Claude Code' });
      assert.equal(b.id, 'claude-code-2');
      assert.equal(listAgents(home).length, 2);
      assert.equal((statSync(agentsPath(home)).mode & 0o777).toString(8), '600');
      assert.equal(loadAgentRegistry(home).agents.length, 2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('权限阶梯与 grant', () => {
  test('默认等级：L0 允许，L1 拒绝', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Reader', default_level: 'L0' });
      assert.equal(checkPermission(home, a.id, { level: 'L0' }).allowed, true);
      assert.equal(checkPermission(home, a.id, { level: 'L1' }).allowed, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('临时 grant：scope/过期/撤销', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Writer', default_level: 'L1' });
      const g = grantPermission(home, a.id, { level: 'L2', scopes: ['project:hulala'], expires_at: new Date(Date.now() + 3600_000).toISOString() });
      assert.equal(checkPermission(home, a.id, { level: 'L2', scope: 'project:hulala' }).allowed, true);
      assert.equal(checkPermission(home, a.id, { level: 'L2', scope: 'project:other' }).allowed, false);
      assert.equal(checkPermission(home, a.id, { level: 'L3', scope: 'project:hulala' }).allowed, false);
      const expired = grantPermission(home, a.id, { level: 'L2', scopes: ['*'], expires_at: new Date(Date.now() - 1000).toISOString() });
      assert.equal(checkPermission(home, a.id, { level: 'L2', scope: 'project:other' }).allowed, false, '过期 grant 不生效');
      revokeGrant(home, a.id, g.id);
      revokeGrant(home, a.id, expired.id);
      assert.equal(checkPermission(home, a.id, { level: 'L2', scope: 'project:hulala' }).allowed, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('信任计数：success/corrections/incidents', () => {
    const home = tmpHome();
    try {
      const a = registerAgent(home, { name: 'Worker' });
      const updated = recordAgentOutcome(home, a.id, { success: 3, corrections: 1, incidents: 1 });
      assert.deepEqual(updated.trust, { success: 3, corrections: 1, incidents: 1 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
