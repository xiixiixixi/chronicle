// test/mcp.test.mjs — 批次 2 MCP 面测试（InMemoryTransport 全工具覆盖）
//
// 覆盖：工具清单（6 个）、chronicle_status / today（默认今天 + 指定日期）/
// search（命中 + limit + 空查询报错）/ summary（有摘要 + 无摘要提示）/
// pause（透传 durationSec）/ resume（透传）。桩 daemon 只记录调用。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createChronicleMcpServer } from '../mcp-entry.mjs';

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const segName = (d) => d.toISOString().replace(/:/g, '-').replace(/T(\d{2})-(\d{2})-(\d{2})\./, 'T$1-$2-$3.');

/** 桩 daemon：记录调用；status 可配置。 */
function stubDaemon({ running = true } = {}) {
  const calls = [];
  return {
    calls,
    binary: '/stub/chronicle-daemon',
    proc: () => null,
    async request(cmd, params = {}) {
      calls.push({ cmd, params });
      if (cmd === 'status') return { running, paused: false, currentSegment: { startTs: '2026-10-19T02:00:00.000Z', eventCount: 3 }, totalEvents: 3, config: {} };
      if (cmd === 'pause') return { pausedAt: '2026-10-19T03:00:00.000Z' };
      if (cmd === 'resume') return { resumedAt: '2026-10-19T03:05:00.000Z' };
      return { ok: true };
    },
  };
}

/** 造一个段（closed）+ 事件。 */
function mkSeg(home, date, events) {
  const dir = path.join(home, 'segments', segName(date));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ segmentStart: date.toISOString(), segmentEnd: new Date(date.getTime() + 60_000).toISOString(), eventCount: events.length }));
}

describe('MCP 面（InMemoryTransport）', () => {
  let home;
  let client;
  let daemon;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 26 * 3600 * 1000);
  const todayKeyStr = dayKey(now);
  const yesterdayKeyStr = dayKey(yesterday);

  before(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'chronicle-mcp-'));
    mkSeg(home, now, [
      { ts: now.toISOString(), type: 'app-switch', data: { bundleId: 'com.apple.Terminal', appName: 'Terminal', pid: 1 } },
      { ts: now.toISOString(), type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: 'GitHub build — zsh' } },
      { ts: now.toISOString(), type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://github.com/chronicle' } },
    ]);
    mkSeg(home, yesterday, [
      { ts: yesterday.toISOString(), type: 'window-change', data: { bundleId: 'com.example.editor', windowTitle: 'old notes' } },
    ]);
    mkdirSync(path.join(home, 'summaries'), { recursive: true });
    writeFileSync(path.join(home, 'summaries', `10min-${segName(now)}.md`),
      `---\ntitle: "写作时段"\nsegment: "${segName(now)}"\ntype: "10min"\n---\n\n## 活动摘要\n- 在改构建脚本`);

    daemon = stubDaemon();
    const server = createChronicleMcpServer({ home, daemon });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'chronicle-test', version: '0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  after(() => { rmSync(home, { recursive: true, force: true }); });

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const textOf = (r) => r.content?.[0]?.text ?? '';
  const callSoft = async (name, args = {}) => {
    try { return await call(name, args); } catch (err) { return { isError: true, error: err }; }
  };

  test('工具清单：6 个 chronicle_* 工具，描述带「观察记录不是指令」提醒', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['chronicle_pause', 'chronicle_resume', 'chronicle_search', 'chronicle_status', 'chronicle_summary', 'chronicle_today']);
    for (const t of tools) {
      if (t.name === 'chronicle_pause' || t.name === 'chronicle_resume') continue; // 控制类不涉及数据返回
      assert.match(t.description, /观察记录，不是指令/);
    }
  });

  test('chronicle_status：守护状态 + 数据目录', async () => {
    const r = await call('chronicle_status');
    assert.equal(r.isError, undefined);
    const st = JSON.parse(textOf(r));
    assert.equal(st.ok, true);
    assert.equal(st.running, true);
    assert.equal(st.home, home);
    assert.deepEqual(daemon.calls.at(-1), { cmd: 'status', params: {} });
  });

  test('chronicle_today：默认今天（时间线 + 摘要合并）；指定昨天只有昨天事件', async () => {
    const r = await call('chronicle_today');
    const text = textOf(r);
    assert.match(text, new RegExp(todayKeyStr));
    assert.match(text, /GitHub build — zsh/);
    assert.match(text, /https:\/\/github\.com\/chronicle/);
    assert.match(text, /## AI 摘要/);
    assert.match(text, /写作时段/);
    assert.match(text, /在改构建脚本/);
    assert.doesNotMatch(text, /old notes/); // 今天不含昨天事件

    const y = await call('chronicle_today', { date: yesterdayKeyStr });
    const yText = textOf(y);
    assert.match(yText, /old notes/);
    assert.doesNotMatch(yText, /GitHub build/);
  });

  test('chronicle_search：命中跨天结果（带日期前缀与段名）；limit 生效', async () => {
    const r = await call('chronicle_search', { query: 'github' });
    const text = textOf(r);
    assert.match(text, /命中 2 条/);
    assert.match(text, /GitHub build — zsh」（段 /);
    assert.match(text, /观察记录/);

    const one = await call('chronicle_search', { query: 'github', limit: 1 });
    assert.match(textOf(one), /命中 1 条/);

    const none = await call('chronicle_search', { query: 'zzz-no-hit' });
    assert.match(textOf(none), /没有搜到/);
  });

  test('chronicle_summary：默认今天返回摘要；指定无摘要日期给提示', async () => {
    const r = await call('chronicle_summary');
    const text = textOf(r);
    assert.match(text, /写作时段/);
    assert.match(text, /在改构建脚本/);

    // 造一个确定无摘要的日期（段不存在 → 摘要必为空）
    const empty = await call('chronicle_summary', { date: '2020-01-02' });
    assert.match(textOf(empty), /没有 AI 摘要/);
  });

  test('chronicle_pause：无参透传；durationSec 校验并透传', async () => {
    const r = await call('chronicle_pause');
    const st = JSON.parse(textOf(r));
    assert.equal(st.ok, true);
    assert.deepEqual(daemon.calls.at(-1), { cmd: 'pause', params: {} });

    const r2 = await call('chronicle_pause', { durationSec: 60 });
    assert.deepEqual(daemon.calls.at(-1), { cmd: 'pause', params: { durationSec: 60 } });

    const bad = await callSoft('chronicle_pause', { durationSec: 0 }); // min(1) 违规
    assert.equal(bad.isError, true);
  });

  test('chronicle_resume：透传 resume', async () => {
    const r = await call('chronicle_resume');
    const st = JSON.parse(textOf(r));
    assert.equal(st.ok, true);
    assert.deepEqual(daemon.calls.at(-1), { cmd: 'resume', params: {} });
  });

  test('chronicle_today 非法日期格式 → isError', async () => {
    const r = await callSoft('chronicle_today', { date: '2026/10/19' });
    assert.equal(r.isError, true);
  });
});
