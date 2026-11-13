// test/insights-api.test.mjs — Z2：洞察 API（GET /api/insights、GET /api/insights/:file、POST /api/insights/generate）
//
// 覆盖：
//   ① 列表：目录缺失 → []；frontmatter 解析（range/title/generatedAt/sourceDigest/bytes）；
//      坏文件/无 frontmatter/symlink 跳过；generatedAt 倒序
//   ② 详情：...frontmatter + markdown（正文）；非法文件名/穿越/不存在 404；symlink 400
//   ③ 生成：注入 fake（不发真实 LLM/网络）；成功 200；NO_SUMMARIES → 409 code；
//      失败/抛错 → 500 且不落半成品；生成器缺失（注入 null）→ 501；range/force 校验
//   ④ 写接口安全：缺 Content-Type 415、非法 Origin 403
//   ⑤ 只读：GET 列表/详情前后文件树不变

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpApp } from '../daemon.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-insights-'));

function stubDaemon() {
  return {
    proc: () => null,
    binary: '/stub/chronicle-daemon',
    async request() { return { running: false, paused: false, currentSegment: null, config: {} }; },
  };
}

async function startHttp(home, { generator } = {}) {
  const server = createHttpApp({ daemon: stubDaemon(), home, insightGenerator: generator });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchJson = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const post = async (p, body, headers = { 'Content-Type': 'application/json' }) => {
    const r = await fetch(base + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { base, fetchJson, post, close: () => new Promise((resolve) => server.close(resolve)) };
}

function writeInsight(home, file, frontmatter = {}, body = '') {
  const dir = path.join(home, 'insights');
  mkdirSync(dir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---');
  writeFileSync(path.join(dir, file), `${lines.join('\n')}\n\n${body}`);
}

function snapshotTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, r);
      else out.push(`${r}|${st.size}`);
    }
  };
  walk(root, '');
  return out;
}

describe('GET /api/insights', () => {
  test('目录缺失 → 空数组；不创建目录；坏文件/symlink 跳过；generatedAt 倒序', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const before = readdirSync(home).sort();
      const empty = await h.fetchJson('/api/insights');
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body, { ok: true, insights: [] });
      assert.deepEqual(readdirSync(home).sort(), before, '只读接口不得创建 insights/');

      writeInsight(home, 'insight-day-2026-11-10.md', {
        range: 'day', title: '11-10 洞察', generatedAt: '2026-11-10T02:00:00.000Z', sourceDigest: 'abc123',
      }, '## 洞察\n- 昨天');
      writeInsight(home, 'insight-week-2026-11-11.md', {
        range: 'week', title: '11-11 周洞察', generatedAt: '2026-11-11T02:00:00.000Z',
      }, '## 洞察\n- 今天');
      writeFileSync(path.join(home, 'insights', 'bad.md'), 'no frontmatter');
      // symlink 应被跳过（不读外部内容）
      const outside = path.join(home, 'outside.md');
      writeFileSync(outside, '---\nrange: "day"\ntitle: "外部"\n---\nSECRET');
      symlinkSync(outside, path.join(home, 'insights', 'link.md'));

      const r = await h.fetchJson('/api/insights');
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.insights.map((i) => i.file), [
        'insight-week-2026-11-11.md', 'insight-day-2026-11-10.md',
      ]);
      const first = r.body.insights[0];
      assert.deepEqual(Object.keys(first).sort(), ['bytes', 'file', 'generatedAt', 'range', 'title']);
      assert.equal(first.range, 'week');
      assert.equal(first.title, '11-11 周洞察');
      assert.equal(first.generatedAt, '2026-11-11T02:00:00.000Z');
      assert.ok(Number.isInteger(first.bytes) && first.bytes > 0);
      const second = r.body.insights[1];
      assert.equal(second.sourceDigest, 'abc123');
      assert.ok(!JSON.stringify(r.body).includes('SECRET'), 'symlink 内容不得泄露');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('GET /api/insights/:file', () => {
  test('返回 frontmatter + markdown 正文；不存在/穿越/非法名 404；symlink 400', async () => {
    const home = tmpHome();
    try {
      writeInsight(home, 'insight-day-2026-11-11.md', {
        range: 'day', title: '今日洞察', generatedAt: '2026-11-11T02:00:00.000Z', sourceDigest: 'digest-1',
      }, '## 洞察\n\n- 今天在调试记忆视图');
      const outside = path.join(home, 'outside.md');
      writeFileSync(outside, '---\nrange: "day"\ntitle: "外部"\n---\nSECRET');
      symlinkSync(outside, path.join(home, 'insights', 'link.md'));

      const h = await startHttp(home);
      try {
        const ok = await h.fetchJson('/api/insights/insight-day-2026-11-11.md');
        assert.equal(ok.status, 200);
        assert.equal(ok.body.ok, true);
        assert.equal(ok.body.insight.file, 'insight-day-2026-11-11.md');
        assert.equal(ok.body.insight.range, 'day');
        assert.equal(ok.body.insight.title, '今日洞察');
        assert.equal(ok.body.insight.sourceDigest, 'digest-1');
        assert.match(ok.body.insight.markdown, /## 洞察\n\n- 今天在调试记忆视图/);
        assert.equal(Object.hasOwn(ok.body.insight, 'body'), false, '不应同时暴露原始 body 字段');

        for (const p of [
          '/api/insights/no-such.md',
          '/api/insights/..%2Fconfig.json',
          '/api/insights/README',
          '/api/insights/%2e%2e%2Fevil.md',
        ]) {
          const r = await h.fetchJson(p);
          assert.equal(r.status, 404, `${p} 应 404`);
        }
        const link = await h.fetchJson('/api/insights/link.md');
        assert.equal(link.status, 400);
        assert.equal(link.body.code, 'SYMLINK_REJECTED');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('只读：列表/详情请求前后文件树一致', async () => {
    const home = tmpHome();
    try {
      writeInsight(home, 'insight-day-a.md', { range: 'day', title: 'A', generatedAt: '2026-11-11T01:00:00.000Z' }, 'body');
      const h = await startHttp(home);
      try {
        const before = snapshotTree(home);
        await h.fetchJson('/api/insights');
        await h.fetchJson('/api/insights/insight-day-a.md');
        assert.deepEqual(snapshotTree(home), before, '洞察读接口不得写文件');
        assert.ok(!snapshotTree(home).some((e) => /index.*\.(db|sqlite)/i.test(e)));
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('POST /api/insights/generate', () => {
  test('成功：注入 fake → 200 + insight；参数 range/force 透传', async () => {
    const home = tmpHome();
    const calls = [];
    const h = await startHttp(home, {
      generator: async (h0, opts) => {
        calls.push({ home: h0, opts });
        return { ok: true, insight: { file: 'insight-week-x.md', range: opts.range, title: '周洞察', generatedAt: '2026-11-11T06:00:00.000Z' } };
      },
    });
    try {
      const r = await h.post('/api/insights/generate', { range: 'week', force: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.insight.range, 'week');
      assert.deepEqual(calls[0].opts, { range: 'week', force: true });
      assert.equal(calls[0].home, home);
      // 缺省 range=week（与 shared/insights.mjs generateInsight 默认一致）
      await h.post('/api/insights/generate', {});
      assert.deepEqual(calls[1].opts, { range: 'week', force: false });
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Z1 generateInsight 形态（{ok,file,...}）→ 读回结构化 insight；skipped 透传', async () => {
    const home = tmpHome();
    writeInsight(home, 'day-20261111.md', {
      range: 'day', title: '今日洞察', generatedAt: '2026-11-11T06:00:00.000Z', sourceDigest: 'digest-z1',
    }, '## 洞察\n- 来自 Z1');
    const h = await startHttp(home, {
      generator: async () => ({ ok: true, file: path.join(home, 'insights', 'day-20261111.md'), sourceDigest: 'digest-z1', summaries: 3 }),
    });
    try {
      const r = await h.post('/api/insights/generate', { range: 'day' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.insight.file, 'day-20261111.md');
      assert.equal(r.body.insight.title, '今日洞察');
      assert.equal(r.body.insight.sourceDigest, 'digest-z1');
      assert.match(r.body.insight.markdown, /来自 Z1/);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
    const home2 = tmpHome();
    const h2 = await startHttp(home2, { generator: async () => ({ ok: true, file: '/x/day-20261111.md', skipped: 'unchanged' }) });
    try {
      const r = await h2.post('/api/insights/generate', { range: 'day' });
      assert.equal(r.status, 200);
      assert.equal(r.body.skipped, 'unchanged');
    } finally {
      await h2.close();
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test('NO_SUMMARIES → 409 + 明确 code；不落半成品', async () => {
    const home = tmpHome();
    const h = await startHttp(home, {
      generator: async () => ({ ok: false, code: 'NO_SUMMARIES', error: '最近没有可用的摘要' }),
    });
    try {
      const r = await h.post('/api/insights/generate', { range: 'day' });
      assert.equal(r.status, 409);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.code, 'NO_SUMMARIES');
      assert.match(r.body.error, /没有可用的摘要/);
      assert.equal(existsSync(path.join(home, 'insights')), false, '失败不得创建 insights/');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('生成器失败/抛错 → 500 结构化；生成器缺失 → 501；均不落半成品', async () => {
    const home = tmpHome();
    try {
      for (const generator of [
        async () => ({ ok: false, error: '模型超时' }),
        async () => undefined,
        async () => { throw new Error('boom'); },
      ]) {
        const h = await startHttp(home, { generator });
        try {
          const r = await h.post('/api/insights/generate', { range: 'day' });
          assert.equal(r.status, 500);
          assert.equal(r.body.ok, false);
          assert.equal(r.body.code, 'INSIGHT_GENERATION_FAILED');
          assert.equal(existsSync(path.join(home, 'insights')), false, '失败不得写文件');
        } finally { await h.close(); }
      }
      const unavailable = await startHttp(home, { generator: null });
      try {
        const r = await unavailable.post('/api/insights/generate', { range: 'day' });
        assert.equal(r.status, 501);
        assert.equal(r.body.code, 'INSIGHT_GENERATOR_UNAVAILABLE');
      } finally { await unavailable.close(); }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('输入校验：非法 range/force/body → 400；写接口安全：缺 CT 415、非法 Origin 403', async () => {
    const home = tmpHome();
    const calls = [];
    const h = await startHttp(home, {
      generator: async (h0, opts) => { calls.push(opts); return { ok: true, insight: { file: 'x.md' } }; },
    });
    try {
      for (const [body, pattern] of [
        [{ range: 'month' }, /range/],
        [{ range: 'day', force: 'yes' }, /force/],
        [[], /请求体须为 JSON 对象/],
      ]) {
        const r = await h.post('/api/insights/generate', body);
        assert.equal(r.status, 400, `${JSON.stringify(body)} 应 400`);
        assert.equal(r.body.code, 'INVALID_INPUT');
        assert.match(String(r.body.error), pattern);
      }
      assert.equal(calls.length, 0);
      const noCt = await h.post('/api/insights/generate', { range: 'day' }, {});
      assert.equal(noCt.status, 415);
      const badOrigin = await h.post('/api/insights/generate', { range: 'day' }, {
        'Content-Type': 'application/json', Origin: 'https://evil.example',
      });
      assert.equal(badOrigin.status, 403);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
