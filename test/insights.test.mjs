// test/insights.test.mjs — 周期洞察生成（Z1）
//
// 覆盖：范围收集（day/week/6h/排序）、提醒词规则、输出归一化、渲染 frontmatter、
// generateInsight 成功（原子写 0600 / 目录 0700 / 幂等 / force / sourceDigest 变化）、
// NO_SUMMARIES / SUMMARIZER_DISABLED / BAD_RANGE、坏输出有界重试、空内容不死循环、
// listInsights/readInsight 防路径穿越、零第三方产品依赖。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INSIGHT_RANGES, insightsDir, localDateKey, rangeWindow, listSummariesForRange,
  collectEvidenceNextActions, buildInsightPrompt, normalizeInsightOutput, renderInsightMarkdown,
  insightSourceDigest, generateInsight, listInsights, readInsight, SAFE_INSIGHT_NAME,
} from '../shared/insights.mjs';
import { buildFrontmatter } from '../summarize.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-ins-'));

function pad(n) { return String(n).padStart(2, '0'); }
/** 生成某天的 Swift 段名。 */
function segName(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}.000Z`;
}

/** 落一份摘要（frontmatter 值为 JSON，与产品格式一致）。 */
function mkSummary(home, { title = '任务线', kind = '10min', segment, body = '## 在做什么\n- 推进任务', nextActions = null, description = '' } = {}) {
  const dir = path.join(home, 'summaries');
  mkdirSync(dir, { recursive: true });
  const name = `${kind}-${segment}.md`;
  const meta = {
    title, ...(description ? { description } : {}), applications: ['a.b'], segment,
    ...(kind === '6h' ? { segments: [segment] } : {}), type: kind, model: 'm', promptVersion: '7', sourceDigest: 'x',
    ...(nextActions ? { next_actions: nextActions } : {}),
  };
  writeFileSync(path.join(dir, name), `${buildFrontmatter(meta)}\n\n${body}\n`);
  return { name, file: path.join(dir, name) };
}

function writeSummarizerConfig(home, summarizer = { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }) {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabled: true, summarizer }));
}

function mockLLM(responses = []) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)] ?? { content: '' };
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => ({ choices: [{ message: { content: next.content ?? '' } }], ...(next.usage ? { usage: next.usage } : {}) }),
      text: async () => next.text ?? '',
    };
  };
  return { calls, impl };
}

const VALID_INSIGHT = JSON.stringify({
  title: '本周推进项目调研与记忆层',
  summary: '本周主要在调研 X-Force 项目用途并推进 Chronicle 摘要/记忆层。',
  sections: [
    { heading: '完成', bullets: ['完成摘要 v6/v7 与技能建议字段'] },
    { heading: '卡点', bullets: ['Harness 子智能体长时间未返回'] },
    { heading: '反复出现的问题', bullets: ['等待长任务时缺少最终状态确认'] },
    { heading: '时间分布', bullets: ['上午集中在调研，下午集中在代码实现'] },
  ],
  next_actions: [{ action: '检查 Harness 任务最终状态并记录结论', reason: '多个摘要显示子智能体仍在运行、未观察到返回' }],
});
const NO_SLEEP = async () => {};

describe('范围收集', () => {
  test('rangeWindow / localDateKey：本地自然日与最近 7 天', () => {
    const now = new Date(2026, 10, 11, 15, 30, 0);
    const day = rangeWindow('day', now);
    assert.equal(day.start.getDate(), 11);
    assert.equal(day.start.getHours(), 0);
    const week = rangeWindow('week', now);
    assert.equal(week.start.getDate(), 5, '最近 7 天含今天 → 从 6 天前 00:00 开始');
    assert.equal(week.start.getHours(), 0);
    assert.equal(localDateKey(now), '20261111');
    assert.equal(localDateKey('bad'), '00000000');
    assert.deepEqual(INSIGHT_RANGES, ['day', 'week']);
  });

  test('listSummariesForRange：按本地日/最近 7 天过滤、含 6h、升序、忽略坏文件', () => {
    const home = tmpHome();
    try {
      const now = new Date();
      now.setHours(23, 59, 0, 0); // 固定到当天结束，避免测试在 10:00 前运行被 end=now 过滤
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
      const yesterday = new Date(today.getTime() - 86400_000);
      const old = new Date(today.getTime() - 10 * 86400_000);
      mkSummary(home, { title: '今天A', segment: segName(today) });
      mkSummary(home, { title: '今天B', kind: '6h', segment: segName(new Date(today.getTime() + 3600_000)) });
      mkSummary(home, { title: '昨天', segment: segName(yesterday) });
      mkSummary(home, { title: '十天前', segment: segName(old) });
      writeFileSync(path.join(home, 'summaries', '_deadletter.log'), 'x\n');
      writeFileSync(path.join(home, 'summaries', 'broken.tmp-1.md'), 'x');
      const day = listSummariesForRange(home, { range: 'day', now });
      assert.deepEqual(day.map((x) => x.title).sort(), ['今天A', '今天B'].sort());
      const week = listSummariesForRange(home, { range: 'week', now });
      assert.equal(week.length, 3, `week 应含今天/昨天，排除十天前（实际 ${week.map((x) => x.title)}）`);
      assert.equal(week[0].title, '昨天', '按时间升序');
      assert.equal(listSummariesForRange(home, { range: 'month', now }).length, 0, '非法 range → []');
      // 摘要字段收集
      const a = week.find((x) => x.title === '今天A');
      assert.match(a.body, /## 在做什么/);
      assert.equal(a.type, '10min');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('collectEvidenceNextActions：去重、最多 10 条、带来源标题', () => {
    const list = [
      { title: 'A', next_actions: [{ action: '做 X', reason: 'r1' }, { action: '做 Y', reason: 'r2' }] },
      { title: 'B', next_actions: [{ action: '做 X', reason: 'dup' }, { action: '做 Z', reason: 'r3' }] },
    ];
    const out = collectEvidenceNextActions(list);
    assert.deepEqual(out.map((x) => x.action), ['做 X', '做 Y', '做 Z']);
    assert.equal(out[0].from, 'A');
    const many = [{ title: 'C', next_actions: Array.from({ length: 15 }, (_, i) => ({ action: `动作${i}`, reason: 'r' })) }];
    assert.equal(collectEvidenceNextActions(many).length, 10);
  });
});

describe('提示词与输出归一化', () => {
  test('buildInsightPrompt：中文规则覆盖任务线/完成/卡点/反复/时间分布/证据/不泛泛；含记忆与摘要证据', () => {
    const { system, user } = buildInsightPrompt({
      range: 'week',
      summaries: [{ type: '10min', title: '摘要标题甲', description: '描述甲', body: '正文甲', at: new Date() }],
      memoryMarkdown: '## Ongoing Tasks\n- 推进调研',
      nextActions: [{ action: '继续调研', reason: '摘要证据' }],
    });
    for (const token of ['只依据', '任务线', '完成', '卡点', '反复出现的问题', '时间分布', '有证据支持', '不要写泛泛', '不要复述密钥', '只输出 JSON']) {
      assert.ok(system.includes(token) || user.includes(token), `缺少规则/字段: ${token}`);
    }
    assert.match(user, /## 长期记忆摘要/);
    assert.match(user, /推进调研/);
    assert.match(user, /摘要标题甲/);
    assert.match(user, /正文甲/);
    assert.match(user, /## 摘要中已有的下一步建议/);
    assert.match(user, /继续调研/);
    assert.equal(/codex/i.test(`${system}\n${user}`), false, '提示词不得出现第三方产品定制字样');
  });

  test('normalizeInsightOutput：合法输出归一化；坏输出抛错；sections/next_actions 有界', () => {
    const parsed = normalizeInsightOutput(`<think>先想</think>\n\`\`\`json\n${VALID_INSIGHT}\n\`\`\``, { range: 'week' });
    assert.equal(parsed.title, '本周推进项目调研与记忆层');
    assert.equal(parsed.sections.length, 4);
    assert.equal(parsed.next_actions.length, 1);
    assert.equal(parsed.next_actions[0].action, '检查 Harness 任务最终状态并记录结论');
    // 脏数据：坏 bullet、空 heading 丢弃；next_actions 非数组→[]
    const dirty = normalizeInsightOutput(JSON.stringify({
      title: '', summary: 's',
      sections: [{ heading: '', bullets: ['x'] }, { heading: 'H', bullets: ['ok', 3, ''] }, { heading: 'H2', bullets: [] }],
      next_actions: 'nope',
    }), { range: 'week' });
    assert.equal(dirty.sections.length, 1);
    assert.deepEqual(dirty.sections[0].bullets, ['ok']);
    assert.deepEqual(dirty.next_actions, []);
    assert.ok(dirty.title.includes('本周') || dirty.title.includes('洞察'), '空标题应兜底');
    assert.throws(() => normalizeInsightOutput('不是 JSON'), /不是可解析的 JSON/);
    assert.throws(() => normalizeInsightOutput('{}'), /缺少 summary 与 sections/);
    // 最多 3 条下一步（normalizeNextActions 约束）
    const many = normalizeInsightOutput(JSON.stringify({ summary: 's', next_actions: Array.from({ length: 6 }, (_, i) => ({ action: `a${i}`, reason: 'r' })) }));
    assert.equal(many.next_actions.length, 3);
  });

  test('renderInsightMarkdown / insightSourceDigest：frontmatter + 正文 + 证据；指纹随输入变化', () => {
    const md = renderInsightMarkdown(
      { title: 'T', summary: 'S', sections: [{ heading: '完成', bullets: ['b1'] }], nextActions: [{ action: 'A', reason: 'R' }] },
      { range: 'week', generatedAt: '2026-11-11T00:00:00.000Z', model: 'm', usage: { total_tokens: 1 }, sourceDigest: 'dig', summaryFiles: ['10min-a.md'] },
    );
    assert.match(md, /^---\ntitle: "T"\nrange: "week"/);
    assert.match(md, /generatedAt: "2026-11-11T00:00:00.000Z"/);
    assert.match(md, /model: "m"/);
    assert.match(md, /sourceDigest: "dig"/);
    assert.match(md, /## 总览\nS/);
    assert.match(md, /## 完成\n- b1/);
    assert.match(md, /## 下一步\n- A（依据：R）/);
    assert.match(md, /## 证据\n- 10min-a\.md/);
    const base = [{ filename: 'a.md', mtimeMs: 1, bytes: 2 }];
    const d1 = insightSourceDigest({ range: 'week', summaries: base, memoryMarkdown: 'm1' });
    const d2 = insightSourceDigest({ range: 'week', summaries: base, memoryMarkdown: 'm2' });
    const d3 = insightSourceDigest({ range: 'day', summaries: base, memoryMarkdown: 'm1' });
    assert.notEqual(d1, d2);
    assert.notEqual(d1, d3);
  });
});

describe('generateInsight', () => {
  test('成功：写 <home>/insights/<range>-<YYYYMMDD>.md（0600/0700、frontmatter、证据）；幂等；force 重写', async () => {
    const home = tmpHome();
    try {
      writeSummarizerConfig(home);
      const now = new Date();
      now.setHours(23, 59, 0, 0);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30, 0);
      mkSummary(home, { title: '任务线甲', segment: segName(today), nextActions: [{ action: '检查任务状态', reason: '摘要说仍在运行' }] });
      mkSummary(home, { title: '任务线乙', kind: '6h', segment: segName(new Date(today.getTime() + 7200_000)) });
      writeFileSync(path.join(home, 'memory_summary.md'), '## Ongoing Tasks\n- 推进调研\n');
      const llm = mockLLM([{ content: VALID_INSIGHT, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }]);
      const r = await generateInsight(home, { range: 'week', cfg: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }, env: { K: 'k' }, fetchImpl: llm.impl, sleep: NO_SLEEP, now });
      assert.equal(r.ok, true, r.error);
      assert.ok(r.file.startsWith(insightsDir(home)));
      assert.equal(r.title, '本周推进项目调研与记忆层');
      assert.equal(r.sections, 4);
      assert.deepEqual(r.next_actions.map((a) => a.action), ['检查 Harness 任务最终状态并记录结论']);
      assert.equal(r.summaries, 2);
      const st = statSync(r.file);
      assert.equal((st.mode & 0o777).toString(8), '600', '文件必须 0600');
      assert.equal((statSync(insightsDir(home)).mode & 0o777).toString(8), '700', '目录必须 0700');
      const md = readFileSync(r.file, 'utf8');
      assert.match(md, /^---\ntitle: "本周推进项目调研与记忆层"\nrange: "week"/);
      assert.match(md, /generatedAt: /);
      assert.match(md, /sourceDigest: "/);
      assert.match(md, /usage: \{"prompt_tokens":10/);
      assert.match(md, /## 总览/);
      assert.match(md, /## 完成/);
      assert.match(md, /## 下一步/);
      assert.match(md, /## 证据/);
      // 提示词包含记忆与摘要证据
      const promptText = llm.calls[0].body.messages.map((m) => m.content).join('\n');
      assert.match(promptText, /推进调研/);
      assert.match(promptText, /任务线甲/);
      assert.match(promptText, /只依据/);
      // 幂等：同输入再跑 → unchanged，不再调模型
      const r2 = await generateInsight(home, { range: 'week', cfg: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }, env: { K: 'k' }, fetchImpl: llm.impl, sleep: NO_SLEEP, now });
      assert.equal(r2.skipped, 'unchanged');
      assert.equal(llm.calls.length, 1);
      // force → 重写
      const r3 = await generateInsight(home, { range: 'week', force: true, cfg: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }, env: { K: 'k' }, fetchImpl: llm.impl, sleep: NO_SLEEP, now });
      assert.equal(r3.ok, true);
      assert.equal(llm.calls.length, 2);
      // 数据变化（新增摘要）→ sourceDigest 变，自动重算
      mkSummary(home, { title: '任务线丙', segment: segName(new Date(today.getTime() + 3600_000)) });
      const r4 = await generateInsight(home, { range: 'week', cfg: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }, env: { K: 'k' }, fetchImpl: llm.impl, sleep: NO_SLEEP, now });
      assert.equal(r4.ok, true);
      assert.notEqual(r4.sourceDigest, r.sourceDigest);
      assert.equal(llm.calls.length, 3);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('NO_SUMMARIES / SUMMARIZER_DISABLED / BAD_RANGE：不调模型、不写文件', async () => {
    const home = tmpHome();
    try {
      const cfg = { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' };
      const llm = mockLLM([{ content: VALID_INSIGHT }]);
      // 无摘要（配置有效）
      const r1 = await generateInsight(home, { range: 'week', cfg, env: { K: 'k' }, fetchImpl: llm.impl });
      assert.equal(r1.ok, false);
      assert.equal(r1.code, 'NO_SUMMARIES');
      assert.equal(llm.calls.length, 0);
      // 未启用
      const r2 = await generateInsight(home, { range: 'week', cfg: { enabled: false, provider: 'none' }, env: { K: 'k' }, fetchImpl: llm.impl });
      assert.equal(r2.code, 'SUMMARIZER_DISABLED');
      // 非法 range
      const r3 = await generateInsight(home, { range: 'month', cfg, env: { K: 'k' }, fetchImpl: llm.impl });
      assert.equal(r3.code, 'BAD_RANGE');
      assert.equal(llm.calls.length, 0);
      // 无 key
      const now = new Date();
      mkSummary(home, { title: 'T', segment: segName(new Date(now.getTime() - 3600_000)) });
      const r4 = await generateInsight(home, { range: 'day', cfg, env: {}, fetchImpl: llm.impl });
      assert.equal(r4.code, 'NO_API_KEY');
      assert.equal(llm.calls.length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('坏输出：解析失败重试 1 次后返回 BAD_OUTPUT（有界，不写文件）', async () => {
    const home = tmpHome();
    try {
      writeSummarizerConfig(home);
      mkSummary(home, { title: 'T', segment: segName(new Date()) });
      const llm = mockLLM([{ content: '这不是 JSON' }]);
      const r = await generateInsight(home, { range: 'week', cfg: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }, env: { K: 'k' }, fetchImpl: llm.impl, sleep: NO_SLEEP });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'BAD_OUTPUT');
      assert.equal(llm.calls.length, 2, 'JSON 解析失败只重试 1 次，不循环');
      assert.equal(listInsights(home).length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('空 content：有界重试后返回 LLM_EMPTY，不死循环', async () => {
    const home = tmpHome();
    try {
      writeSummarizerConfig(home);
      mkSummary(home, { title: 'T', segment: segName(new Date()) });
      const llm = mockLLM([{ content: '' }]); // 永远空
      const r = await generateInsight(home, { range: 'week', cfg: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://l.example/v1', model: 'm', apiKeyEnv: 'K' }, env: { K: 'k' }, fetchImpl: llm.impl, sleep: NO_SLEEP });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'LLM_EMPTY');
      assert.ok(llm.calls.length <= 8, `调用次数应有界（实际 ${llm.calls.length}）`);
      assert.equal(listInsights(home).length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('listInsights / readInsight 防穿越', () => {
  test('list 只认白名单文件名；read 拒绝 ../、绝对路径、非白名单；合法文件可读', () => {
    const home = tmpHome();
    try {
      const dir = insightsDir(home);
      mkdirSync(dir, { recursive: true });
      const name = `week-${localDateKey(new Date())}.md`;
      const body = `${buildFrontmatter({ title: '周洞察', range: 'week', generatedAt: 'x', model: 'm', sourceDigest: 'abc' })}\n\n## 总览\n内容\n`;
      writeFileSync(path.join(dir, name), body);
      writeFileSync(path.join(dir, 'not-allowed.md'), body);
      writeFileSync(path.join(home, 'config.json'), '{}');
      const list = listInsights(home);
      assert.equal(list.length, 1);
      assert.equal(list[0].filename, name);
      assert.equal(list[0].range, 'week');
      assert.equal(list[0].title, '周洞察');
      assert.match(readInsight(home, name), /## 总览/);
      for (const bad of ['../config.json', '../secrets.json', '/etc/passwd', 'week-../../x.md', 'not-allowed.md', 'day-99.md', '', null, 'week-99999999.md']) {
        assert.equal(readInsight(home, bad), null, `必须拒绝: ${bad}`);
      }
      assert.equal(SAFE_INSIGHT_NAME.test('week-20261111.md'), true);
      assert.equal(SAFE_INSIGHT_NAME.test('week-2026.md'), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('模块零第三方产品依赖：源码不读取任何外部产品目录/品牌', () => {
    const src = readFileSync(new URL('../shared/insights.mjs', import.meta.url), 'utf8');
    assert.equal(/\.codex/i.test(src), false, '不得读取第三方产品目录');
    assert.equal(/openai\.com|chatgpt/i.test(src), false, '不得绑定特定厂商 endpoint');
    assert.match(src, /openai-compatible|callLLM/, '复用现有 OpenAI 兼容调用');
  });
});
