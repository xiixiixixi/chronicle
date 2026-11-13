// test/skills-api.test.mjs — X2：技能 API（GET /api/skills + POST /api/skills/create）
//
// 覆盖：
//   ① 列表：目录缺失 → []；合法 SKILL.md 解析 frontmatter；非法 slug/无 SKILL.md/坏文件跳过或容错
//   ② 创建：注入 fake 生成器（不碰真实 LLM/网络）；中文名 → 安全 slug；目录 0700/文件 0600；
//      写入内容 = 生成器 markdown；返回 {ok,skill}
//   ③ 校验：name/description 空/超长、file/sourceSegment 非法/冲突、file 不存在 → 400
//   ④ 重复同名 → 409 + existing；生成器缺失/失败/抛错 → 501/500 且不落半成品
//   ⑤ 写接口安全：缺 Content-Type → 415；只读 GET 不写文件；路径不会穿越（slug 固定根目录内）
//
// 生成器注入：createHttpApp({skillDraftGenerator})（null = 强制“未就绪”501；undefined = 动态 import 真实现）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpApp, validateSkillUpdateInput } from '../daemon.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-skills-'));

function stubDaemon() {
  return {
    proc: () => null,
    binary: '/stub/chronicle-daemon',
    async request() { return { running: false, paused: false, currentSegment: null, config: {} }; },
  };
}

async function startHttp(home, { generator } = {}) {
  const server = createHttpApp({ daemon: stubDaemon(), home, skillDraftGenerator: generator });
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

function fakeMarkdown(opts) {
  return [
    '---',
    `name: ${JSON.stringify(opts.name)}`,
    `description: ${JSON.stringify(opts.description)}`,
    'createdAt: "2026-11-11T05:00:00.000Z"',
    '---',
    '',
    `# ${opts.name}`,
    '',
    '## 触发场景',
    `- ${opts.description}`,
    '',
  ].join('\n');
}

function fakeGenerator(calls = []) {
  return async (home, opts) => {
    calls.push({ home, opts });
    return { ok: true, markdown: fakeMarkdown(opts) };
  };
}

function readSkillsDir(home) {
  const root = path.join(home, 'skills');
  if (!existsSync(root)) return null;
  return root;
}

describe('GET /api/skills', () => {
  test('目录缺失 → 空数组 200；不创建目录', async () => {
    const home = tmpHome();
    const h = await startHttp(home);
    try {
      const before = readdirSync(home).sort();
      const r = await h.fetchJson('/api/skills');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, skills: [] });
      assert.deepEqual(readdirSync(home).sort(), before, '只读接口不得创建 skills/');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('列出合法 SKILL.md；非法 slug/无文件/坏 frontmatter 容错，按 createdAt 新→旧', async () => {
    const home = tmpHome();
    try {
      const root = path.join(home, 'skills');
      const write = (slug, name, description, createdAt, extra = '') => {
        mkdirSync(path.join(root, slug), { recursive: true });
        writeFileSync(path.join(root, slug, 'SKILL.md'), [
          '---',
          `name: ${JSON.stringify(name)}`,
          `description: ${JSON.stringify(description)}`,
          `createdAt: ${JSON.stringify(createdAt)}`,
          '---', '', `# ${name}`, extra,
        ].join('\n'));
      };
      write('daily-standup', '每日站会', '汇总每日进展', '2026-11-10T02:00:00.000Z');
      write('screenshot-triage', '截图整理', '归档截图', '2026-11-11T02:00:00.000Z');
      // 非法 slug / 无 SKILL.md / 坏文件
      mkdirSync(path.join(root, 'Bad_Slug'), { recursive: true });
      writeFileSync(path.join(root, 'Bad_Slug', 'SKILL.md'), '---\nname: bad\n---\n');
      mkdirSync(path.join(root, 'no-file'), { recursive: true });
      mkdirSync(path.join(root, 'broken'), { recursive: true });
      writeFileSync(path.join(root, 'broken', 'SKILL.md'), 'not frontmatter at all');

      const h = await startHttp(home);
      try {
        const r = await h.fetchJson('/api/skills');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.deepEqual(r.body.skills.map((s) => s.slug), ['broken', 'screenshot-triage', 'daily-standup']);
        const top = r.body.skills[1];
        assert.equal(top.name, '截图整理');
        assert.equal(top.description, '归档截图');
        assert.equal(top.createdAt, '2026-11-11T02:00:00.000Z');
        assert.ok(Number.isInteger(top.bytes) && top.bytes > 0);
        assert.ok(top.path.startsWith(path.join(home, 'skills')));
        assert.ok(top.path.endsWith(path.join('screenshot-triage', 'SKILL.md')));
        // 坏文件：退回 slug 作 name，description 空，createdAt 用 mtime ISO
        const broken = r.body.skills[0];
        assert.equal(broken.slug, 'broken');
        assert.equal(broken.name, 'broken');
        assert.equal(broken.description, '');
        assert.ok(Number.isFinite(Date.parse(broken.createdAt)));
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('POST /api/skills/create', () => {
  test('成功：fake 生成器 → 原子写入 0600/0700；中文名 slug 安全且在 skills/ 内', async () => {
    const home = tmpHome();
    const calls = [];
    const h = await startHttp(home, { generator: fakeGenerator(calls) });
    try {
      const r = await h.post('/api/skills/create', {
        name: '截图整理', description: '把每天的截图归档到项目目录', sourceSegment: '2026-11-11T02-00-00.000Z',
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      const skill = r.body.skill;
      assert.match(skill.slug, /^[a-z0-9][a-z0-9-]{0,63}$/);
      assert.notEqual(skill.slug, '截图整理');
      assert.equal(skill.name, '截图整理');
      assert.equal(skill.description, '把每天的截图归档到项目目录');
      assert.equal(skill.createdAt, '2026-11-11T05:00:00.000Z');
      assert.ok(skill.path.startsWith(path.join(home, 'skills')));
      assert.ok(existsSync(skill.path));
      assert.equal(readFileSync(skill.path, 'utf8').includes('# 截图整理'), true);
      assert.equal(statSync(skill.path).mode & 0o777, 0o600, 'SKILL.md 必须 0600');
      assert.equal(statSync(path.dirname(skill.path)).mode & 0o777, 0o700, '技能目录必须 0700');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].opts, {
        name: '截图整理', description: '把每天的截图归档到项目目录', sourceSegment: '2026-11-11T02-00-00.000Z',
      });
      // 列表能读到刚创建的技能
      const list = await h.fetchJson('/api/skills');
      assert.equal(list.body.skills.length, 1);
      assert.equal(list.body.skills[0].slug, skill.slug);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ASCII 名 → 小写连字符 slug；file 指向摘要时从 frontmatter 取 segment 传给生成器', async () => {
    const home = tmpHome();
    mkdirSync(path.join(home, 'summaries'), { recursive: true });
    writeFileSync(path.join(home, 'summaries', '10min-2026-11-11T02-00-00.000Z.md'),
      '---\ntitle: "t"\nsegment: "2026-11-11T02-00-00.000Z"\n---\nbody');
    const calls = [];
    const h = await startHttp(home, { generator: fakeGenerator(calls) });
    try {
      const r = await h.post('/api/skills/create', {
        name: 'Daily Standup Helper', description: '汇总每日进展', file: '10min-2026-11-11T02-00-00.000Z.md',
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.skill.slug, 'daily-standup-helper');
      assert.equal(calls[0].opts.sourceSegment, '2026-11-11T02-00-00.000Z');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('重复同名 → 409 SKILL_EXISTS + existing（旧文件不被覆盖）', async () => {
    const home = tmpHome();
    const h = await startHttp(home, { generator: fakeGenerator() });
    try {
      const first = await h.post('/api/skills/create', { name: 'Weekly Review', description: '周回顾' });
      assert.equal(first.status, 200);
      const before = readFileSync(first.body.skill.path, 'utf8');
      const second = await h.post('/api/skills/create', { name: 'Weekly Review', description: '另一个描述' });
      assert.equal(second.status, 409);
      assert.equal(second.body.ok, false);
      assert.equal(second.body.code, 'SKILL_EXISTS');
      assert.equal(second.body.existing.slug, 'weekly-review');
      assert.equal(readFileSync(first.body.skill.path, 'utf8'), before, '重复创建不得覆盖旧技能');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('输入校验：空/超长/非法 file/sourceSegment/冲突 → 400 且不写文件', async () => {
    const home = tmpHome();
    mkdirSync(path.join(home, 'summaries'), { recursive: true });
    writeFileSync(path.join(home, 'summaries', '10min-good.md'),
      '---\ntitle: "t"\nsegment: "2026-11-11T02-00-00.000Z"\n---\n');
    writeFileSync(path.join(home, 'summaries', '10min-noseg.md'), '---\ntitle: "no segment"\n---\n');
    const calls = [];
    const h = await startHttp(home, { generator: fakeGenerator(calls) });
    const badBodies = [
      [{}, /name 不能为空/],
      [{ name: 'x' }, /description 不能为空/],
      [{ name: 'x'.repeat(81), description: 'd' }, /name 不能超过 80/],
      [{ name: 'x', description: 'd'.repeat(2001) }, /description 不能超过 2000/],
      [{ name: 'x', description: 'd', file: '../secret.md' }, /file 非法/],
      [{ name: 'x', description: 'd', file: 'no-such.md' }, /摘要不存在/],
      [{ name: 'x', description: 'd', file: '10min-noseg.md' }, /缺少 segment/],
      [{ name: 'x', description: 'd', sourceSegment: '../evil' }, /sourceSegment 非法/],
      [{ name: 'x', description: 'd', file: '10min-good.md', sourceSegment: '2026-11-11T03-00-00.000Z' }, /冲突/],
      [[], /请求体须为 JSON 对象/],
    ];
    try {
      for (const [body, pattern] of badBodies) {
        const r = await h.post('/api/skills/create', body);
        assert.equal(r.status, 400, `${JSON.stringify(body)} 应 400`);
        assert.equal(r.body.ok, false);
        assert.match(String(r.body.error), pattern);
      }
      assert.equal(calls.length, 0, '校验失败不得调用生成器');
      assert.equal(existsSync(path.join(home, 'skills')), false, '校验失败不得创建 skills/');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('生成器未就绪（注入 null）→ 501；生成器失败/抛错 → 500，均不落半成品', async () => {
    const home = tmpHome();
    const failed = [];
    try {
      const unavailable = await startHttp(home, { generator: null });
      try {
        const r = await unavailable.post('/api/skills/create', { name: 'x', description: 'd' });
        assert.equal(r.status, 501);
        assert.equal(r.body.code, 'SKILL_GENERATOR_UNAVAILABLE');
        assert.equal(existsSync(path.join(home, 'skills')), false);
      } finally { await unavailable.close(); }

      for (const generator of [
        async () => ({ ok: false, error: '模型不可用' }),
        async () => ({ ok: true, markdown: '   ' }),
        async () => { throw new Error('boom'); },
      ]) {
        const h = await startHttp(home, { generator });
        try {
          const r = await h.post('/api/skills/create', { name: '技能 A', description: '描述 A' });
          assert.equal(r.status, 500);
          assert.equal(r.body.ok, false);
          assert.equal(r.body.code, 'SKILL_GENERATION_FAILED');
          assert.equal(existsSync(path.join(home, 'skills')), false, '失败不得留下半成品目录/根目录');
          failed.push(r.status);
        } finally { await h.close(); }
      }
      assert.equal(failed.length, 3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('写入失败（skills 路径被文件占用）→ 500 SKILL_WRITE_FAILED，不崩溃', async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, 'skills'), 'not a directory');
    const h = await startHttp(home, { generator: fakeGenerator() });
    try {
      const r = await h.post('/api/skills/create', { name: 'Write Fail', description: 'd' });
      assert.equal(r.status, 500);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.code, 'SKILL_WRITE_FAILED');
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('写接口安全：缺 Content-Type → 415；非法 Origin → 403', async () => {
    const home = tmpHome();
    const h = await startHttp(home, { generator: fakeGenerator() });
    try {
      const noCt = await h.post('/api/skills/create', { name: 'x', description: 'd' }, {});
      assert.equal(noCt.status, 415);
      const badOrigin = await h.post('/api/skills/create', { name: 'x', description: 'd' }, {
        'Content-Type': 'application/json', Origin: 'https://evil.example',
      });
      assert.equal(badOrigin.status, 403);
      assert.equal(existsSync(path.join(home, 'skills')), false);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('slug 固定落在 <home>/skills/ 内（目录名不可穿越）', async () => {
    const home = tmpHome();
    const h = await startHttp(home, { generator: fakeGenerator() });
    try {
      const r = await h.post('/api/skills/create', { name: '../../etc/passwd', description: 'd' });
      assert.equal(r.status, 200);
      const real = r.body.skill.path;
      assert.ok(real.startsWith(path.join(home, 'skills') + path.sep), `必须落在 skills/ 内: ${real}`);
      assert.ok(!real.includes('..'));
      const rootEntries = readdirSync(path.join(home, 'skills'));
      assert.equal(rootEntries.length, 1);
      assert.match(rootEntries[0], /^[a-z0-9][a-z0-9-]{0,63}$/);
    } finally {
      await h.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- Z2：技能库 CRUD（GET/PUT/DELETE /api/skills/:slug） ----------

function writeSkillFile(home, slug, { name, description, createdAt = '2026-11-11T02:00:00.000Z', extraLines = [], body = '' } = {}) {
  const dir = path.join(home, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `name: ${JSON.stringify(name ?? slug)}`,
    `description: ${JSON.stringify(description ?? '')}`,
    `createdAt: ${JSON.stringify(createdAt)}`,
    ...extraLines,
    '---',
  ];
  writeFileSync(path.join(dir, 'SKILL.md'), `${lines.join('\n')}\n\n${body}`);
  return path.join(dir, 'SKILL.md');
}

describe('GET /api/skills/:slug', () => {
  test('返回详情含 SKILL.md 原文 markdown；不存在/非法 slug 404', async () => {
    const home = tmpHome();
    try {
      const file = writeSkillFile(home, 'screenshot-triage', {
        name: '截图整理',
        description: '把截图归档到项目目录',
        extraLines: ['source: "inbox"'],
        body: '# 截图整理\n\n## 触发场景\n- 收到截图\n',
      });
      const markdown = readFileSync(file, 'utf8');
      const h = await startHttp(home);
      try {
        const r = await h.fetchJson('/api/skills/screenshot-triage');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        const skill = r.body.skill;
        assert.equal(skill.slug, 'screenshot-triage');
        assert.equal(skill.name, '截图整理');
        assert.equal(skill.description, '把截图归档到项目目录');
        assert.equal(skill.markdown, markdown, 'markdown 必须是 SKILL.md 原文');
        assert.equal(skill.createdAt, '2026-11-11T02:00:00.000Z');
        assert.equal(skill.bytes, statSync(file).size);
        assert.equal(skill.path, file);

        for (const slug of ['no-such-skill', 'Bad_Slug', '..%2Fconfig.json']) {
          const miss = await h.fetchJson(`/api/skills/${slug}`);
          assert.equal(miss.status, 404, `${slug} 应 404`);
        }
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('PUT /api/skills/:slug', () => {
  test('更新 name/description：保留未知 frontmatter 字段与正文、原子写 0600', async () => {
    const home = tmpHome();
    try {
      const file = writeSkillFile(home, 'weekly-review', {
        name: '周回顾',
        description: '旧描述',
        extraLines: ['customField: "keep-me"', 'source: "inbox"'],
        body: '# 正文\n\n- 保留这一行\n',
      });
      const h = await startHttp(home);
      try {
        const r = await fetch(`${h.base}/api/skills/weekly-review`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '每周回顾', description: '新描述' }),
        });
        const body = await r.json();
        assert.equal(r.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.skill.name, '每周回顾');
        assert.equal(body.skill.description, '新描述');
        const text = readFileSync(file, 'utf8');
        assert.match(text, /^---\n/);
        assert.match(text, /name: "每周回顾"/);
        assert.match(text, /description: "新描述"/);
        assert.match(text, /customField: "keep-me"/, '未知 frontmatter 字段必须保留');
        assert.match(text, /source: "inbox"/);
        assert.match(text, /# 正文\n\n- 保留这一行/);
        assert.equal(statSync(file).mode & 0o777, 0o600, 'SKILL.md 必须 0600');
        const after = await fetch(`${h.base}/api/skills/weekly-review`).then((x) => x.json());
        assert.equal(after.skill.name, '每周回顾');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('更新 markdown：替换正文/新增字段；无 frontmatter → 400；未知字段忽略；404', async () => {
    const home = tmpHome();
    try {
      writeSkillFile(home, 'daily-standup', { name: '每日站会', description: '旧' });
      const h = await startHttp(home);
      try {
        const newMarkdown = '---\nname: "每日站会"\ndescription: "新描述"\nextra: "keep"\n---\n\n# 新正文\n';
        const ok = await fetch(`${h.base}/api/skills/daily-standup`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: newMarkdown, unknownField: 'ignored' }),
        });
        assert.equal(ok.status, 200);
        const okBody = await ok.json();
        assert.equal(okBody.skill.markdown, newMarkdown);
        assert.match(okBody.skill.markdown, /# 新正文/);

        const badFm = await fetch(`${h.base}/api/skills/daily-standup`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: 'no frontmatter' }),
        });
        assert.equal(badFm.status, 400);
        assert.equal((await badFm.json()).code, 'INVALID_FRONTMATTER');

        const missing = await fetch(`${h.base}/api/skills/no-such`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'x' }),
        });
        assert.equal(missing.status, 404);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('非法输入 400：空 body/空 name/超长 markdown；写失败（目录只读）500 且不破坏原文件', async () => {
    const home = tmpHome();
    try {
      const file = writeSkillFile(home, 'readonly-skill', { name: '只读技能', description: 'd', body: 'old' });
      const original = readFileSync(file, 'utf8');
      const h = await startHttp(home);
      try {
        const put = (body) => fetch(`${h.base}/api/skills/readonly-skill`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, body: await r.json() }));
        for (const [body, pattern] of [
          [{}, /至少提供/],
          [{ name: '' }, /name 不能为空/],
          [[], /请求体须为 JSON 对象/],
        ]) {
          const r = await put(body);
          assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} 应 400`);
          assert.match(String(r.body.error), pattern);
        }
        // 超长 markdown 由校验函数拒绝（HTTP body 读取上限 64KB，超大请求会在更早被断开）
        const tooLong = validateSkillUpdateInput({ markdown: `---\nname: "x"\n---\n${'A'.repeat(65 * 1024)}` });
        assert.equal(tooLong.ok, false);
        assert.match(String(tooLong.error), /markdown 不能超过/);
        // 目录只读 → 写失败；原文件内容保持不变
        chmodSync(path.dirname(file), 0o500);
        try {
          const r = await put({ name: '改名失败' });
          assert.equal(r.status, 500);
          assert.equal(r.body.code, 'SKILL_WRITE_FAILED');
          assert.equal(readFileSync(file, 'utf8'), original, '写失败不得破坏原文件');
        } finally {
          chmodSync(path.dirname(file), 0o700);
        }
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/skills/:slug', () => {
  test('删除成功（仅技能目录）；再次删除/不存在 404', async () => {
    const home = tmpHome();
    try {
      writeSkillFile(home, 'delete-me', { name: '待删除', description: 'd' });
      writeSkillFile(home, 'keep-me', { name: '保留', description: 'd' });
      const h = await startHttp(home);
      try {
        const r = await fetch(`${h.base}/api/skills/delete-me`, { method: 'DELETE' });
        const body = await r.json();
        assert.equal(r.status, 200);
        assert.deepEqual(body, { ok: true, deleted: 'delete-me' });
        assert.equal(existsSync(path.join(home, 'skills', 'delete-me')), false);
        assert.equal(existsSync(path.join(home, 'skills', 'keep-me', 'SKILL.md')), true, '不得误删其它技能');
        const again = await fetch(`${h.base}/api/skills/delete-me`, { method: 'DELETE' });
        assert.equal(again.status, 404);
        const invalid = await fetch(`${h.base}/api/skills/..%2Fconfig.json`, { method: 'DELETE' });
        assert.equal(invalid.status, 404);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('symlink 拒绝：GET/PUT/DELETE 均 400 SYMLINK_REJECTED，且不触碰外部目录', async () => {
    const home = tmpHome();
    try {
      const outside = path.join(home, 'outside-skill');
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: "外部"\ndescription: "外部"\n---\nSECRET');
      mkdirSync(path.join(home, 'skills'), { recursive: true });
      symlinkSync(outside, path.join(home, 'skills', 'link-skill'));
      const h = await startHttp(home);
      try {
        const get = await fetch(`${h.base}/api/skills/link-skill`);
        assert.equal(get.status, 400);
        assert.equal((await get.json()).code, 'SYMLINK_REJECTED');
        const put = await fetch(`${h.base}/api/skills/link-skill`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'hack' }),
        });
        assert.equal(put.status, 400);
        assert.equal((await put.json()).code, 'SYMLINK_REJECTED');
        const del = await fetch(`${h.base}/api/skills/link-skill`, { method: 'DELETE' });
        assert.equal(del.status, 400);
        assert.equal((await del.json()).code, 'SYMLINK_REJECTED');
        assert.equal(existsSync(path.join(outside, 'SKILL.md')), true, '外部目录内容不得被删除/修改');
        assert.match(readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), /SECRET/);
        const list = await h.fetchJson('/api/skills');
        assert.equal(list.body.skills.length, 0, 'symlink 技能不得出现在列表');
      } finally {
        await h.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
