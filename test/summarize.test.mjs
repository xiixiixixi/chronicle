// test/summarize.test.mjs — 批次 2 摘要器测试
//
// 覆盖：
//   ① 配置归一化（未配置 / provider none → 零副作用）
//   ② 10min 摘要：mock LLM（注入 fetch）→ 文件落盘（frontmatter + body）、请求形状
//      （url / Bearer key / model / 提示词含事件与事实性约束）
//   ③ 幂等（已摘要不再调用 LLM）；--segment 强制重生成路径（force）
//   ④ 降级：LLM 返回非 JSON → 裸文本当 body、标题兜底；HTTP 错误 → 跳过不抛；
//      apiKey 环境变量缺失 → 跳过
//   ⑤ 6h 合并：同桶两段 → 桶结束后生成 6h 摘要（prompt 含两份 body）；未结束不生成；幂等
//   ⑥ 纯逻辑：compactEvents 格式与截断、parseLLMOutput、frontmatter 往返、bucketInfo 边界

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSummarizerConfig, summarizerActive,
  compactEvents, build10MinPrompt, build6hPrompt,
  callLLM, parseLLMOutput, buildFrontmatter, parseSummaryFile,
  listSummaries, readSummary, bucketInfo, summarizeSegment, summarizePending,
} from '../summarize.mjs';
import { listSegments } from '../shared/segments.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-sum-'));

/** 直接在 <home>/segments/<name>/ 落一个已关闭的段。 */
function mkSeg(home, name, events, { closed = true, startIso = '2026-10-19T01:00:00.000Z' } = {}) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const meta = { segmentStart: startIso, eventCount: events.length };
  if (closed) meta.segmentEnd = '2026-10-19T01:10:00.000Z';
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
  return dir;
}

const EV_TERMINAL = [
  { ts: '2026-10-19T01:00:02.000Z', type: 'app-switch', data: { bundleId: 'com.apple.Terminal', appName: 'Terminal', pid: 1 } },
  { ts: '2026-10-19T01:01:02.000Z', type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: 'daemon — zsh' } },
];
const EV_CHROME = [
  { ts: '2026-10-19T03:00:02.000Z', type: 'app-switch', data: { bundleId: 'com.google.Chrome', appName: 'Chrome', pid: 2 } },
  { ts: '2026-10-19T03:02:02.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://github.com/x/y' } },
];

function writeSummarizerConfig(home, summarizer) {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabled: true, blocklist: [], summarizer }));
}

/** mock fetch：记录调用，按序返回预设响应。 */
function mockLLM(responses = []) {
  const calls = [];
  const impl = async (url, init) => {
    const i = calls.length;
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses[Math.min(i, responses.length - 1)] ?? { content: '' };
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => ({ choices: [{ message: { content: next.content ?? '' } }] }),
      text: async () => next.text ?? '',
    };
  };
  return { calls, impl };
}

const LLM_JSON = JSON.stringify({ title: '10:00-10:10 编码', body: '## 活动摘要\n- 在终端写代码' });
const NOW_AFTER_BUCKET = () => new Date('2026-10-19T07:30:00Z'); // 桶 00-06Z 已结束
const NOW_INSIDE_BUCKET = () => new Date('2026-10-19T05:00:00Z'); // 桶 00-06Z 未结束（只测 10min）

// ---------- ① 配置 ----------

describe('摘要器配置', () => {
  test('未配置 summarizer → provider none、不活跃、pending 零副作用', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      const cfg = loadSummarizerConfig(home);
      assert.equal(cfg.provider, 'none');
      assert.equal(cfg.enabled, false);
      assert.equal(summarizerActive(cfg), false);
      const llm = mockLLM([{ content: LLM_JSON }]);
      const r = await summarizePending(home, { env: {}, fetchImpl: llm.impl, now: NOW_AFTER_BUCKET });
      assert.deepEqual(r, { checked: 0, summarized10: 0, summarized6h: 0, skipped: [] });
      assert.equal(llm.calls.length, 0);
      assert.equal(existsSync(path.join(home, 'summaries')), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('provider "none" 显式配置 → 同样零副作用', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'none' });
      const llm = mockLLM();
      const r = await summarizePending(home, { env: {}, fetchImpl: llm.impl });
      assert.equal(llm.calls.length, 0);
      assert.equal(r.summarized10, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('未知 provider → 记入 skipped，不调用 LLM', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'weird' });
      const llm = mockLLM();
      const r = await summarizePending(home, { env: {}, fetchImpl: llm.impl });
      assert.equal(llm.calls.length, 0);
      assert.ok(r.skipped.some((s) => s.includes('unsupported-provider')));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ② 10min 摘要 ----------

describe('10min 摘要生成', () => {
  test('生成：frontmatter + body 落盘；请求形状（url/Bearer/model/提示词）正确', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, {
        enabled: true, provider: 'openai-compatible',
        baseUrl: 'https://llm.example.com/v1/', model: 'test-model', apiKeyEnv: 'K',
      });
      const llm = mockLLM([{ content: LLM_JSON }]);
      const r = await summarizePending(home, { env: { K: 'secret-key' }, fetchImpl: llm.impl, now: NOW_INSIDE_BUCKET });
      assert.equal(r.summarized10, 1);

      assert.equal(llm.calls.length, 1);
      assert.equal(llm.calls[0].url, 'https://llm.example.com/v1/chat/completions');
      assert.equal(llm.calls[0].headers.authorization, 'Bearer secret-key');
      assert.equal(llm.calls[0].body.model, 'test-model');
      const prompt = llm.calls[0].body.messages.map((m) => m.content).join('\n');
      assert.match(prompt, /com\.apple\.Terminal/);
      assert.match(prompt, /daemon — zsh/);
      assert.match(prompt, /不推测/);          // 事实性约束进提示词
      assert.match(prompt, /敏感值/);          // 不复述敏感值

      const file = path.join(home, 'summaries', '10min-2026-10-19T01-00-00.000Z.md');
      assert.ok(existsSync(file));
      const md = readFileSync(file, 'utf8');
      assert.match(md, /^---\ntitle: "10:00-10:10 编码"\napplications: \["com\.apple\.Terminal"\]\nsegment: "2026-10-19T01-00-00\.000Z"\ntype: "10min"\n---\n\n## 活动摘要\n- 在终端写代码\n$/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('幂等：已摘要的段不再调用 LLM；force=true 重生成', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'm', apiKeyEnv: 'K' });
      const llm = mockLLM([{ content: LLM_JSON }]);
      await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl, now: NOW_INSIDE_BUCKET });
      const r2 = await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl, now: NOW_INSIDE_BUCKET });
      assert.equal(r2.summarized10, 0);
      assert.equal(llm.calls.length, 1); // 只有第一次

      const seg = listSegments(home)[0];
      const r3 = await summarizeSegment(home, seg, {
        cfg: loadSummarizerConfig(home), env: { K: 'k' }, fetchImpl: llm.impl, force: true,
      });
      assert.ok(r3.file && !r3.skipped);
      assert.equal(llm.calls.length, 2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ④ 降级路径 ----------

describe('LLM 降级', () => {
  test('返回非 JSON → 裸文本当 body，标题用兜底（时间范围 + 应用名）', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' });
      const llm = mockLLM([{ content: '就是一段裸文本摘要' }]);
      const r = await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl });
      assert.equal(r.summarized10, 1);
      const md = readFileSync(path.join(home, 'summaries', '10min-2026-10-19T01-00-00.000Z.md'), 'utf8');
      assert.match(md, /就是一段裸文本摘要/);
      const title = /^title: "(.*)"$/m.exec(md)[1];
      assert.match(title, /^\d{2}:\d{2}-\d{2}:\d{2} Terminal$/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('HTTP 500 → 跳过不抛、不写半成品文件', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' });
      const llm = mockLLM([{ ok: false, status: 500, text: 'boom' }]);
      const r = await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl });
      assert.equal(r.summarized10, 0);
      assert.ok(r.skipped.some((s) => s.includes('LLM_HTTP')));
      assert.equal(existsSync(path.join(home, 'summaries')), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('apiKeyEnv 指向的环境变量缺失 → 跳过（NO_API_KEY），不发请求', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'MISSING_KEY' });
      const llm = mockLLM();
      const r = await summarizePending(home, { env: {}, fetchImpl: llm.impl });
      assert.equal(llm.calls.length, 0);
      assert.ok(r.skipped.some((s) => s.includes('NO_API_KEY')));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ⑤ 6h 合并 ----------

describe('6h 合并', () => {
  test('同桶两段 → 桶结束后合并生成（prompt 含两份 body）；幂等', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);   // 桶 00-06Z
      mkSeg(home, '2026-10-19T03-00-00.000Z', EV_CHROME);     // 同桶
      writeSummarizerConfig(home, { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' });
      const llm = mockLLM([{ content: LLM_JSON }]);
      const r = await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl, now: NOW_AFTER_BUCKET });
      assert.equal(r.summarized10, 2);
      assert.equal(r.summarized6h, 1);
      assert.equal(llm.calls.length, 3); // 2×10min + 1×6h

      const mergePrompt = llm.calls[2].body.messages.map((m) => m.content).join('\n');
      assert.match(mergePrompt, /## 活动摘要/);     // 含 10min 正文
      assert.match(mergePrompt, /300 词/);          // 6h 长度约束

      const file = path.join(home, 'summaries', '6h-2026-10-19T00.md');
      assert.ok(existsSync(file));
      const md = readFileSync(file, 'utf8');
      assert.match(md, /type: "6h"/);
      assert.match(md, /segment: "2026-10-19T00:00:00\.000Z"/);
      assert.match(md, /segments: \["2026-10-19T01-00-00\.000Z","2026-10-19T03-00-00\.000Z"\]/);
      assert.match(md, /applications: \["com\.google\.Chrome","com\.apple\.Terminal"\]/);

      // 幂等：再跑一遍不再调用
      const r2 = await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl, now: NOW_AFTER_BUCKET });
      assert.equal(r2.summarized10, 0);
      assert.equal(r2.summarized6h, 0);
      assert.equal(llm.calls.length, 3);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('桶未结束 → 不生成 6h 摘要', async () => {
    const home = tmpHome();
    try {
      mkSeg(home, '2026-10-19T01-00-00.000Z', EV_TERMINAL);
      writeSummarizerConfig(home, { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' });
      const llm = mockLLM([{ content: LLM_JSON }]);
      const stillInside = () => new Date('2026-10-19T05:00:00Z'); // 桶 00-06Z 未结束
      const r = await summarizePending(home, { env: { K: 'k' }, fetchImpl: llm.impl, now: stillInside });
      assert.equal(r.summarized10, 1);
      assert.equal(r.summarized6h, 0);
      assert.equal(llm.calls.length, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- ⑥ 纯逻辑 ----------

describe('纯逻辑', () => {
  test('compactEvents：四类事件各成一行（HH:MM 开头），超长截断', () => {
    const events = [
      { ts: '2026-10-19T01:00:02.000Z', type: 'app-switch', data: { bundleId: 'a.b', appName: 'B' } },
      { ts: '2026-10-19T01:01:02.000Z', type: 'window-change', data: { bundleId: 'a.b', windowTitle: 'W' } },
      { ts: '2026-10-19T01:02:02.000Z', type: 'url-change', data: { bundleId: 'a.b', url: 'https://x.example/' } },
      { ts: '2026-10-19T01:03:02.000Z', type: 'focus-change', data: { bundleId: 'a.b', role: 'AXButton', title: 'OK' } },
      { ts: '2026-10-19T01:04:02.000Z', type: 'mystery', data: { k: 1 } },
    ];
    const lines = compactEvents(events);
    assert.equal(lines.length, 5);
    for (const line of lines) assert.match(line, /^\d{2}:\d{2} /);
    assert.match(lines[0], /切换应用 → B/);
    assert.match(lines[1], /窗口标题 → a\.b "W"/);
    assert.match(lines[2], /网址 → a\.b https:\/\/x\.example\//);
    assert.match(lines[3], /焦点元素 → a\.b AXButton "OK"/);

    const many = Array.from({ length: 12 }, (_, i) => ({ ts: '2026-10-19T01:00:02.000Z', type: 'app-switch', data: { bundleId: `a${i}` } }));
    const cut = compactEvents(many, { maxLines: 5 });
    assert.equal(cut.length, 6); // 5 + 截断说明
    assert.match(cut[5], /另有 7 条事件已省略/);
  });

  test('parseLLMOutput：裸 JSON / 围栏 JSON / 裸文本', () => {
    assert.deepEqual(parseLLMOutput('{"title":"T","body":"B"}'), { title: 'T', body: 'B' });
    assert.deepEqual(parseLLMOutput('```json\n{"title":"T","body":"B"}\n```'), { title: 'T', body: 'B' });
    assert.deepEqual(parseLLMOutput('前缀 {"title":"T","body":"B"} 后缀'), { title: 'T', body: 'B' });
    assert.deepEqual(parseLLMOutput('就是一段话'), { title: '', body: '就是一段话' });
    assert.deepEqual(parseLLMOutput('{"broken": '), { title: '', body: '{"broken":' }); // trim 后落为裸文本
  });

  test('frontmatter 往返（build → parse）', () => {
    const fm = buildFrontmatter({ title: '含"引号"的标题', applications: ['a.b', 'c.d'], segment: '2026-10-19T01-00-00.000Z', type: '10min' });
    const parsed = parseSummaryFile(`${fm}\n\n## 活动摘要\n- x\n`);
    assert.equal(parsed.title, '含"引号"的标题');
    assert.deepEqual(parsed.applications, ['a.b', 'c.d']);
    assert.equal(parsed.segment, '2026-10-19T01-00-00.000Z');
    assert.equal(parsed.type, '10min');
    assert.equal(parsed.body, '## 活动摘要\n- x\n');
  });

  test('bucketInfo：UTC 6h 对齐边界', () => {
    assert.equal(bucketInfo(new Date('2026-10-19T05:59:59Z')).key, '2026-10-19T00');
    assert.equal(bucketInfo(new Date('2026-10-19T06:00:00Z')).key, '2026-10-19T06');
    assert.equal(bucketInfo(new Date('2026-10-19T23:59:59Z')).key, '2026-10-19T18');
    assert.equal(bucketInfo(new Date('2026-10-19T00:00:00Z')).end.toISOString(), '2026-10-19T06:00:00.000Z');
    assert.equal(bucketInfo('not-a-date'), null);
  });

  test('build10MinPrompt / build6hPrompt：长度约束与内容', () => {
    assert.match(build10MinPrompt(['10:00 x']), /500 词/);
    assert.match(build6hPrompt([{ title: 'T', body: 'B' }]), /### T\nB/);
    assert.match(build6hPrompt([{ title: 'T', body: 'B' }]), /300 词/);
  });

  test('listSummaries / readSummary：非法文件名拒绝', async () => {
    const home = tmpHome();
    try {
      mkdirSync(path.join(home, 'summaries'), { recursive: true });
      writeFileSync(path.join(home, 'summaries', '10min-x.md'), '---\ntitle: "T"\ntype: "10min"\nsegment: "2026-10-19T01-00-00.000Z"\n---\n\nB');
      const list = listSummaries(home);
      assert.equal(list.length, 1);
      assert.equal(list[0].title, 'T');
      assert.equal(readSummary(home, '10min-x.md').includes('B'), true);
      assert.equal(readSummary(home, '../config.json'), null);   // 路径穿越
      assert.equal(readSummary(home, 'no-such.md'), null);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('callLLM：网络异常包装为 LLM_NETWORK', async () => {
    await assert.rejects(
      () => callLLM({ cfg: { baseUrl: 'https://l.example/v1', model: 'm', timeoutMs: 500 }, prompt: 'p', fetchImpl: async () => { throw new Error('conn refused'); } }),
      (e) => e.code === 'LLM_NETWORK',
    );
  });
});
