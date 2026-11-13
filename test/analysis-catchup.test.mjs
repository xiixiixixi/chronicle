// test/analysis-catchup.test.mjs — 断网后的分析补跑

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeAnalysisStatus, enqueueInsightRequest, loadAnalysisState, runAnalysisCatchUp,
} from '../shared/analysis-catchup.mjs';
import { summarizeBacklog } from '../summarize.mjs';

const SEP = '2026-11-12T10-00-00.000Z';
const NOW = new Date('2026-11-13T09:00:00.000Z');
const noSleep = async () => {};

function tmpHome() { return mkdtempSync(path.join(os.tmpdir(), 'chronicle-catchup-')); }

function seedSegment(home) {
  const dir = path.join(home, 'segments', SEP);
  mkdirSync(dir, { recursive: true });
  const events = [
    { ts: '2026-11-12T10:00:02.000Z', type: 'app-switch', data: { bundleId: 'com.apple.Terminal', appName: 'Terminal', pid: 1 } },
    { ts: '2026-11-12T10:01:02.000Z', type: 'click', data: { bundleId: 'com.apple.Terminal', appName: 'Terminal', windowTitle: 'zsh', target: { role: 'AXButton', title: '运行' } } },
  ];
  writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    segmentStart: '2026-11-12T10:00:00.000Z', segmentEnd: '2026-11-12T10:10:00.000Z', eventCount: events.length,
  }));
}

function writeConfig(home) {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    enabled: true,
    summarizer: {
      enabled: true, provider: 'openai-compatible', baseUrl: 'https://llm.example/v1',
      model: 'test-model', apiKeyEnv: 'TEST_KEY', timeoutMs: 1000, maxChars: 30000, maxTokens: 2000,
    },
  }));
}

const BOTH_JSON = JSON.stringify({
  title: '补跑摘要',
  description: '断网恢复后补跑',
  body: '## 总览\n- 补跑完成',
  memory_summary_markdown: '## User Profile\n\n补跑测试。\n\n## Ongoing Tasks\n\n- 补跑分析',
  memory_sections: [{ title: '分析补跑', task_group: 'Chronicle', date: '2026-11-12', outcome: 'done', evidence: '补跑测试' }],
});

function onlineFetch(calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: BOTH_JSON } }] }),
      text: async () => '',
    };
  };
}

function offlineFetch() {
  return async () => { const e = new Error('fetch failed'); e.code = 'ENOTFOUND'; throw e; };
}

describe('分析补跑', () => {
  test('盘点：缺 10min/6h 摘要；状态含总数、启用与离线标记', () => {
    const home = tmpHome();
    try {
      seedSegment(home);
      writeConfig(home);
      const backlog = summarizeBacklog(home, { now: NOW });
      assert.equal(backlog.counts.summaries10, 1);
      assert.equal(backlog.counts.summaries6h, 0, '没有 10min 摘要时先不算 6h 桶');
      const status = computeAnalysisStatus(home, { now: NOW });
      assert.equal(status.enabled, true);
      assert.equal(status.pending.summaries10, 1);
      assert.ok(status.total >= 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('断网：停止继续打模型、记录退避；恢复后强制补跑补齐摘要与记忆', async () => {
    const home = tmpHome();
    try {
      seedSegment(home);
      writeConfig(home);
      const offline = await runAnalysisCatchUp(home, {
        reason: 'test-offline', now: NOW, env: { TEST_KEY: 'k' },
        fetchImpl: offlineFetch(), sleep: noSleep,
      });
      assert.equal(offline.offline, true);
      assert.ok(offline.next_retry_at);
      const state1 = loadAnalysisState(home);
      assert.equal(state1.consecutive_failures, 1);
      assert.equal(state1.last_error_code, 'LLM_NETWORK');
      const status1 = computeAnalysisStatus(home, { now: NOW });
      assert.equal(status1.offline, true);

      // 退避期内不重复打模型
      const skipped = await runAnalysisCatchUp(home, {
        reason: 'test-backoff', now: NOW, env: { TEST_KEY: 'k' }, fetchImpl: onlineFetch(), sleep: noSleep,
      });
      assert.equal(skipped.skipped, 'backoff');

      const calls = [];
      const recovered = await runAnalysisCatchUp(home, {
        reason: 'test-online', force: true, now: NOW, env: { TEST_KEY: 'k' },
        fetchImpl: onlineFetch(calls), sleep: noSleep,
      });
      assert.equal(recovered.offline, false);
      assert.equal(recovered.summarized10, 1);
      assert.equal(recovered.summarized6h, 1);
      assert.ok(calls.length >= 3, '10min + 6h + 记忆合并都应调用模型');
      const files = readdirSync(path.join(home, 'summaries'));
      assert.ok(files.includes(`10min-${SEP}.md`));
      assert.ok(files.some((n) => n.startsWith('6h-')));
      assert.ok(existsSync(path.join(home, 'MEMORY.md')));
      const status2 = computeAnalysisStatus(home, { now: NOW });
      assert.equal(status2.total, 0);
      assert.equal(status2.offline, false);
      assert.equal(status2.next_retry_at, null);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('洞察请求可排队，状态里可见', () => {
    const home = tmpHome();
    try {
      writeConfig(home);
      const q = enqueueInsightRequest(home, { range: 'week', force: true, error: 'fetch failed', code: 'LLM_NETWORK' });
      assert.equal(q.range, 'week');
      const status = computeAnalysisStatus(home, { now: NOW });
      assert.equal(status.pending.insights, 1);
      assert.equal(status.queue[0].range, 'week');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
