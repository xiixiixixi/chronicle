// test/memory.test.mjs — 记忆层（S1）
//
// 覆盖：memory 三件套读写/原子性/容错、最近摘要收集与指纹去重、
// consolidation prompt 规则、输出解析、MEMORY.md 去重合并、memory_summary 截断、
// consolidateMemory 成功/失败/dryRun/pending、memoryContextForPrompt、提示词注入。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MEMORY_SUMMARY_MAX_BYTES, memoryPaths, loadMemory, saveMemory,
  listRecentSummaries, summaryFingerprint, findUnconsumedSummaries,
  renderRecentSummaries, memoryContextForPrompt,
  buildConsolidationPrompt, parseConsolidationOutput, renderMemorySection,
  mergeMemorySections, clampMemorySummary, consolidateMemory,
  parseMemoryDocument, searchMemoryGroups, mergeDuplicateGroups, renderMemoryDocument,
} from '../shared/memory.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-mem-'));

/** 落一份假摘要（10min/6h），返回文件名。 */
function mkSummary(home, name, { title = '摘要', type = '10min', segment = '', body = '## 活动摘要\n- 做了一些事', promptVersion = '5', extra = '' } = {}) {
  const dir = path.join(home, 'summaries');
  mkdirSync(dir, { recursive: true });
  const fm = ['---', `title: ${JSON.stringify(title)}`, `type: ${JSON.stringify(type)}`, `segment: ${JSON.stringify(segment)}`, `promptVersion: ${JSON.stringify(promptVersion)}`, ...(extra ? [extra] : []), '---'].join('\n');
  const file = path.join(dir, name);
  writeFileSync(file, `${fm}\n\n${body}\n`);
  return file;
}

const CONSOLIDATION_JSON = JSON.stringify({
  memory_summary_markdown: '## User Profile\n\n用户在做 Chronicle 记忆层。\n\n## User preferences\n\n- 要任务线不要点击流水。\n\n## Ongoing Tasks\n\n- 记忆层实现中。\n\n## General Tips\n\n- 先看证据再写结论。',
  memory_sections: [
    {
      title: '推进 Chronicle 记忆层（S1）', task_group: 'Chronicle 摘要升级', date: '2026-11-11',
      outcome: 'partial', evidence: '10min-2026-11-11T01-40-01.627Z.md 09:40 窗口「DeepSeek Harness」',
      preferences: ['要任务线，不要点击/切换流水'], learnings: ['先 consolidate 记忆再写摘要'],
    },
  ],
});

function mockLLM(responses) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next.throw) throw new Error(next.throw);
    return { content: next.content ?? '', usage: next.usage ?? { total_tokens: 1 } };
  };
  return { calls, impl };
}

// ---------- 读写与容错 ----------

describe('记忆文件读写', () => {
  test('空 home：路径在根目录、内容为空、pending 默认值', () => {
    const home = tmpHome();
    try {
      const paths = memoryPaths(home);
      assert.equal(paths.summary, path.join(home, 'memory_summary.md'));
      assert.equal(paths.memory, path.join(home, 'MEMORY.md'));
      assert.equal(paths.pending, path.join(home, 'memory_pending.json'));
      const mem = loadMemory(home);
      assert.equal(mem.summary, '');
      assert.equal(mem.memoryMd, '');
      assert.deepEqual(mem.pending, { version: 2, consumed: [], lastConsolidatedAt: null });
      assert.equal(mem.hasSummary, false);
      assert.equal(mem.hasMemory, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('saveMemory → loadMemory 往返；原子写（无 .tmp 残留、权限 0600）', () => {
    const home = tmpHome();
    try {
      saveMemory(home, { summary: '# 记忆\n- 进行中：X\n', memoryMd: '## 任务 A\n- outcome: partial\n', pending: { consumed: ['abc', 'abc', 'def'], lastConsolidatedAt: '2026-11-11T00:00:00.000Z' } });
      const mem = loadMemory(home);
      assert.match(mem.summary, /进行中：X/);
      assert.match(mem.memoryMd, /任务 A/);
      assert.deepEqual(mem.pending.consumed, ['abc', 'def'], 'pending 指纹去重');
      assert.equal(mem.pending.lastConsolidatedAt, '2026-11-11T00:00:00.000Z');
      const leftovers = [];
      for (const f of ['memory_summary.md', 'MEMORY.md', 'memory_pending.json']) {
        const p = path.join(home, f);
        assert.ok(statSync(p).isFile());
        assert.equal((statSync(p).mode & 0o777).toString(8), '600');
      }
      for (const name of ['memory_summary.md', 'MEMORY.md', 'memory_pending.json']) {
        if (name.includes('.tmp-')) leftovers.push(name);
      }
      assert.deepEqual(leftovers, []);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('容错：坏 pending JSON / 坏 frontmatter 不抛异常', () => {
    const home = tmpHome();
    try {
      writeFileSync(path.join(home, 'memory_pending.json'), '{not json');
      const mem = loadMemory(home);
      assert.deepEqual(mem.pending.consumed, []);
      // 摘要 frontmatter 半坏（没有结尾 ---）
      mkdirSync(path.join(home, 'summaries'), { recursive: true });
      writeFileSync(path.join(home, 'summaries', '10min-broken.md'), '---\ntitle: "半坏"\n没有结束线\n\n正文');
      const list = listRecentSummaries(home, { sinceHours: 0 });
      assert.equal(list.length, 1);
      assert.match(list[0].title, /半坏/);
      assert.match(list[0].body, /正文/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- 摘要收集与指纹 ----------

describe('最近摘要与消费指纹', () => {
  test('按时间倒序、类型过滤、limit 与 sinceHours', () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-2026-11-11T01-40-01.627Z.md', { title: '任务线 A', segment: '2026-11-11T01-40-01.627Z', body: '## 在做什么\n- 推进 A' });
      mkSummary(home, '10min-2026-11-11T00-10-00.000Z.md', { title: '任务线 B', segment: '2026-11-11T00-10-00.000Z', body: '## 在做什么\n- 推进 B' });
      mkSummary(home, '6h-2026-11-10T18.md', { title: '六小时', type: '6h', segment: '2026-11-10T18:00:00.000Z', body: '## 做了什么\n- 汇总' });
      const all = listRecentSummaries(home, { limit: 10, sinceHours: 0 });
      assert.equal(all.length, 3);
      assert.equal(all[0].title, '任务线 A', '按 segment 时间倒序');
      assert.equal(all[2].type, '6h');
      const only10 = listRecentSummaries(home, { limit: 10, sinceHours: 0, kinds: ['10min'] });
      assert.equal(only10.length, 2);
      const limited = listRecentSummaries(home, { limit: 1, sinceHours: 0 });
      assert.equal(limited.length, 1);
      // sinceHours：老 mtime 的摘要被过滤
      const future = Date.now() + 1000 * 3600;
      assert.equal(listRecentSummaries(home, { limit: 10, sinceHours: 2, now: future }).length, 3);
      assert.equal(listRecentSummaries(home, { limit: 10, sinceHours: 1, now: Date.now() + 48 * 3600_000 }).length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('findUnconsumedSummaries：已消费指纹被过滤', () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-a.md', { title: 'A', segment: '2026-11-11T01-00-00.000Z' });
      mkSummary(home, '10min-b.md', { title: 'B', segment: '2026-11-11T01-10-00.000Z' });
      const all = listRecentSummaries(home, { sinceHours: 0 });
      const fp = summaryFingerprint(all[0]);
      saveMemory(home, { pending: { consumed: [fp], lastConsolidatedAt: null } });
      const unconsumed = findUnconsumedSummaries(home, { sinceHours: 0 });
      assert.equal(unconsumed.length, all.length - 1);
      assert.equal(unconsumed.some((x) => summaryFingerprint(x) === fp), false);
      // 指纹稳定；mtime 变化后指纹变化
      assert.equal(summaryFingerprint(all[0]), fp);
      const changed = { ...all[0], mtimeMs: all[0].mtimeMs + 5000 };
      assert.notEqual(summaryFingerprint(changed), fp);
      // limit=1 且最新一条已消费：仍应看到下一条未消费摘要（不能被 limit 提前截断）
      const next = findUnconsumedSummaries(home, { sinceHours: 0, limit: 1 });
      assert.equal(next.length, 1);
      assert.notEqual(summaryFingerprint(next[0]), fp);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('renderRecentSummaries：标题 + 要点，受字符预算约束', () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-a.md', { title: '推进记忆层', segment: '2026-11-11T01-00-00.000Z', body: '## 在做什么\n- 实现 memory.mjs 与 consolidation\n- 跑测试' });
      const list = listRecentSummaries(home, { sinceHours: 0 });
      const text = renderRecentSummaries(list, { maxChars: 400 });
      assert.match(text, /推进记忆层/);
      assert.match(text, /实现 memory\.mjs/);
      assert.ok(text.length <= 400);
      assert.equal(renderRecentSummaries([], {}), '');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- consolidation prompt / 解析 ----------

describe('consolidation prompt 与输出解析', () => {
  test('prompt 含规则、旧记忆、证据摘要与输出 schema', () => {
    const { system, user } = buildConsolidationPrompt({
      memorySummary: '# 旧画像\n- 进行中：发布 npm 包',
      memoryMd: '## 任务 X\n- outcome: partial',
      summaries: [{ filename: '10min-2026-11-11T01-40-01.627Z.md', type: '10min', segment: '2026-11-11T01-40-01.627Z', promptVersion: '5', body: '## 在做什么\n- 卡在支付' }],
    });
    for (const token of ['任务弧', '证据', '摘要文件名', '不要保留', '只输出 JSON', 'memory_summary_markdown']) {
      assert.ok(system.includes(token) || user.includes(token), `缺少规则/字段: ${token}`);
    }
    assert.match(user, /旧画像/);
    assert.match(user, /任务 X/);
    assert.match(user, /现有任务组索引/);
    assert.match(user, /10min-2026-11-11T01-40-01\.627Z\.md/);
    assert.match(user, /卡在支付/);
    const empty = buildConsolidationPrompt({});
    assert.match(empty.user, /（空）/);
    assert.match(empty.user, /（无）/);
  });

  test('parseConsolidationOutput：容忍围栏/思考段，归一化字段', () => {
    const raw = '```json\n<think>先想想</think>\n' + JSON.stringify({ memory_summary_markdown: '# 摘要\n- x', memory_sections: [{ title: 'T1', outcome: 'weird', preferences: ['p', 3], learnings: ['l'] }] }) + '\n```';
    const parsed = parseConsolidationOutput(raw);
    assert.match(parsed.summaryMarkdown, /# 摘要/);
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0].outcome, 'unknown');
    assert.equal(parsed.sections[0].task_group, 'T1', '缺 task_group 时回落到标题');
    assert.deepEqual(parsed.sections[0].preferences, ['p']);
    assert.deepEqual(parsed.sections[0].keywords, []);
    assert.throws(() => parseConsolidationOutput('这不是 JSON'), /不是可解析的 JSON/);
    assert.throws(() => parseConsolidationOutput('{}'), /缺少/);
    // 最多保留 8 条
    const many = parseConsolidationOutput(JSON.stringify({ memory_sections: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}` })) }));
    assert.equal(many.sections.length, 8);
  });

  test('renderMemorySection / mergeMemorySections：任务组渲染 + 同一任务线更新而非重复追加', () => {
    const section = {
      title: '推进 S1', task_group: 'Chronicle', scope: '在 Chronicle 仓库工作时',
      applies_to: 'cwd=/Users/x/chronicle', date: '2026-11-11', outcome: 'partial',
      evidence: '10min-a.md', keywords: ['记忆层', 'consolidation'], references: ['10min-a.md'],
      preferences: ['要任务线'], learnings: ['先看证据'], failures: ['摘要太大 → 分批'],
    };
    const rendered = renderMemorySection(section);
    for (const token of ['# Task Group: Chronicle', 'scope: 在 Chronicle', 'applies_to: cwd=',
      '## Task 1: 推进 S1, partial', 'keywords: 记忆层、consolidation', 'references: 10min-a.md',
      'preferences: 要任务线', 'learnings: 先看证据', 'failures: 摘要太大']) {
      assert.ok(rendered.includes(token), token);
    }
    const first = mergeMemorySections('', [section]);
    assert.equal(first.added, 1);
    assert.equal(first.updated, 0);
    assert.match(first.memoryMd, /# Task Group: Chronicle/);
    const next = {
      ...section, title: '推进 Chronicle 记忆层 S1', outcome: 'success', date: '2026-11-12',
      evidence: '10min-b.md', keywords: ['任务组'], references: ['10min-b.md'], learnings: ['先看证据', '更新即合并'],
    };
    const second = mergeMemorySections(first.memoryMd, [next]);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 1);
    assert.equal((second.memoryMd.match(/## Task /g) || []).length, 1, '同一组同一任务线只保留一条');
    assert.match(second.memoryMd, /推进 Chronicle 记忆层 S1, success/);
    assert.match(second.memoryMd, /keywords: 记忆层、consolidation、任务组/);
    assert.match(second.memoryMd, /references: 10min-a\.md；10min-b\.md/);
    const third = mergeMemorySections(second.memoryMd, [{ ...section, title: '另一个任务', task_group: 'Other' }]);
    assert.equal(third.added, 1);
    assert.equal((third.memoryMd.match(/# Task Group:/g) || []).length, 2);
  });

  test('v1 扁平 MEMORY.md：按 task_group 迁移为 v2 任务组，同组快照合并', () => {
    const v1 = [
      '## Hulala 客服知识库批量 PDF 归档与核验',
      '- task_group: Hulala 客服知识库建设',
      '- date: 2026-11-11',
      '- outcome: partial',
      '- evidence: 10min-a.md',
      '- preferences: 要抽样验收',
      '- learnings: 目录存在不等于完成',
      '',
      '## Hulala 客服知识库归档、图片完整性与最终验收',
      '- task_group: Hulala 客服知识库建设',
      '- date: 2026-11-11',
      '- outcome: partial',
      '- evidence: 10min-b.md',
      '- learnings: 图片需要单独验收',
      '',
      '## Fin 流程编排原型文件定位',
      '- task_group: 内部资料与原型定位',
      '- outcome: blocked',
    ].join('\n');
    assert.equal(mergeMemorySections(v1, []).memoryMd, v1, '无新节时不动旧文件');
    const parsed = parseMemoryDocument(v1);
    assert.deepEqual(parsed.map((g) => g.title), ['Hulala 客服知识库建设', '内部资料与原型定位']);
    assert.equal(parsed[0].tasks.length, 1, '同组 v1 快照合并为一条任务');
    assert.match(parsed[0].tasks[0].title, /归档、图片完整性与最终验收$/, '采用最新标题');
    assert.match(parsed[0].tasks[0].learnings.join('；'), /图片需要单独验收/);
    const rerendered = mergeMemorySections(v1, [{ title: 'X', task_group: '新组', outcome: 'unknown' }]).memoryMd;
    assert.match(rerendered, /# Task Group: Hulala 客服知识库建设/);
    assert.match(rerendered, /## Task 1: Hulala 客服知识库归档、图片完整性与最终验收, partial/);
    assert.match(rerendered, /# Task Group: 新组/);
  });

  test('mergeDuplicateGroups：组名漂移但任务标题一致时合并', () => {
    const task = (evidence, keyword, learning) => ({
      title: 'Claude Code 接入 DeepSeek', outcome: 'blocked', date: '2026-11-11', evidence,
      keywords: [keyword], references: [evidence], preferences: [], learnings: [learning], failures: [], lines: [],
    });
    const md = renderMemoryDocument([
      { title: 'Claude Code / DeepSeek 配置', scope: '', appliesTo: '', fields: [], tasks: [task('a.md', 'DeepSeek', '需要模型映射')] },
      { title: 'Claude Code 接入 DeepSeek', scope: '', appliesTo: '', fields: [], tasks: [task('b.md', 'settings.json', '升级后要写 settings')] },
    ]);
    const groups = parseMemoryDocument(md);
    assert.equal(groups.length, 2);
    const merged = mergeDuplicateGroups(groups);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].tasks.length, 1);
    assert.match(merged[0].tasks[0].learnings.join('；'), /模型映射/);
    assert.match(merged[0].tasks[0].learnings.join('；'), /settings/);
  });

  test('searchMemoryGroups：按关键词命中任务组/任务字段', () => {
    const md = renderMemorySection({
      title: 'Hulala 归档', task_group: 'Hulala 客服知识库建设',
      keywords: ['PDF', '图片清单'], preferences: ['抽样验收'], learnings: ['目录存在不等于完成'],
    });
    const hits = searchMemoryGroups(md, '图片清单');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].group.title, 'Hulala 客服知识库建设');
    assert.equal(searchMemoryGroups(md, '不存在的词').length, 0);
    assert.equal(searchMemoryGroups(md, '').length, 1);
  });

  test('clampMemorySummary：按字节截断、保留 UTF-8、不超上限', () => {
    assert.equal(clampMemorySummary('短文本'), '短文本\n');
    const long = '## User Profile\n\n' + '中文内容'.repeat(1500);
    const clamped = clampMemorySummary(long);
    assert.ok(Buffer.byteLength(clamped, 'utf8') <= MEMORY_SUMMARY_MAX_BYTES + 8, `bytes=${Buffer.byteLength(clamped, 'utf8')}`);
    assert.match(clamped, /超长已截断/);
    assert.doesNotMatch(clamped, /\uFFFD/, '不能切坏 UTF-8');
  });
});

// ---------- consolidateMemory ----------

describe('consolidateMemory', () => {
  test('成功：写三件套、消费指纹、二次运行不再调用模型', async () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-2026-11-11T01-40-01.627Z.md', { title: '推进记忆层', segment: '2026-11-11T01-40-01.627Z', body: '## 在做什么\n- 卡在 consolidation' });
      const llm = mockLLM([{ content: CONSOLIDATION_JSON }]);
      const r = await consolidateMemory(home, { llm: llm.impl, now: new Date('2026-11-11T02:00:00Z') });
      assert.equal(r.ok, true);
      assert.equal(r.consumed, 1);
      assert.equal(r.added, 1);
      assert.equal(llm.calls.length, 1);
      assert.match(llm.calls[0].system, /记忆合并器/);
      assert.match(llm.calls[0].prompt, /10min-2026-11-11T01-40-01\.627Z\.md/);
      const mem = loadMemory(home);
      assert.match(mem.summary, /## User Profile/);
      assert.match(mem.summary, /## What's in Memory/);
      assert.match(mem.summary, /Chronicle 摘要升级：推进 Chronicle 记忆层（S1）/);
      assert.match(mem.memoryMd, /# Task Group: Chronicle 摘要升级/);
      assert.match(mem.memoryMd, /## Task 1: 推进 Chronicle 记忆层（S1）, partial/);
      assert.equal(mem.pending.consumed.length, 1);
      assert.equal(mem.pending.lastConsolidatedAt, '2026-11-11T02:00:00.000Z');
      // 幂等：没有新摘要 → 不再调用模型
      const r2 = await consolidateMemory(home, { llm: llm.impl, now: new Date('2026-11-11T03:00:00Z') });
      assert.equal(r2.skipped, 'no-new-summaries');
      assert.equal(llm.calls.length, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('模型失败 / 输出不可解析 → ok:false 且不改动记忆文件', async () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-a.md', { title: 'A', segment: '2026-11-11T01-00-00.000Z' });
      const failLlm = mockLLM([{ throw: 'network down' }]);
      const r1 = await consolidateMemory(home, { llm: failLlm.impl });
      assert.equal(r1.ok, false);
      assert.equal(r1.skipped, 'llm-error');
      const badLlm = mockLLM([{ content: '不是 JSON' }]);
      const r2 = await consolidateMemory(home, { llm: badLlm.impl });
      assert.equal(r2.ok, false);
      assert.equal(r2.skipped, 'bad-output');
      const mem = loadMemory(home);
      assert.equal(mem.summary, '');
      assert.equal(mem.memoryMd, '');
      assert.equal(mem.pending.consumed.length, 0);
      // 未注入 llm
      const r3 = await consolidateMemory(home, {});
      assert.equal(r3.skipped, 'llm-missing');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('dryRun：不写文件、返回将新增数量', async () => {
    const home = tmpHome();
    try {
      mkSummary(home, '10min-a.md', { title: 'A', segment: '2026-11-11T01-00-00.000Z' });
      const llm = mockLLM([{ content: CONSOLIDATION_JSON }]);
      const r = await consolidateMemory(home, { llm: llm.impl, dryRun: true });
      assert.equal(r.ok, true);
      assert.equal(r.dryRun, true);
      assert.equal(r.consumed, 1);
      assert.equal(r.wouldAdd, 1);
      const mem = loadMemory(home);
      assert.equal(mem.summary, '');
      assert.equal(mem.memoryMd, '');
      assert.equal(mem.pending.consumed.length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// ---------- 摘要 prompt 注入 ----------

describe('memoryContextForPrompt', () => {
  test('空记忆 → 明确「无历史记忆」', () => {
    const home = tmpHome();
    try {
      assert.match(memoryContextForPrompt(home), /无历史记忆/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('有记忆 + 最近摘要 → 两段内容、受 maxChars 约束、可排除最近摘要', () => {
    const home = tmpHome();
    try {
      saveMemory(home, { summary: '## User Profile\n\n用户在做 Chronicle 记忆层。\n\n## Ongoing Tasks\n\n- 摘要 v5' });
      mkSummary(home, '10min-a.md', { title: '推进 v5', segment: '2026-11-11T01-00-00.000Z', body: '## 在做什么\n- 写记忆层' });
      const ctx = memoryContextForPrompt(home, { maxChars: 500 });
      assert.match(ctx, /长期记忆摘要/);
      assert.match(ctx, /Chronicle 记忆层/);
      assert.match(ctx, /最近摘要/);
      assert.match(ctx, /推进 v5/);
      assert.ok(ctx.length <= 500, `len=${ctx.length}`);
      const noRecent = memoryContextForPrompt(home, { recentLimit: 0 });
      assert.match(noRecent, /长期记忆摘要/);
      assert.equal(noRecent.includes('最近摘要'), false, 'recentLimit=0 时不带最近摘要（避免与摘要 prompt 的独立小节重复）');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
