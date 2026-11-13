// test/web.test.mjs — 时间线 Web UI：离线红线 + 纯函数（vm 加载 app.js，无 DOM、无第三方依赖）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve('.');
const html = readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const js = readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const css = readFileSync(path.join(ROOT, 'web/style.css'), 'utf8');

function loadUi() {
  const sandbox = { console, URL, URLSearchParams, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInContext(js, vm.createContext(sandbox), { filename: 'web/app.js' });
  assert.ok(sandbox.ChronicleUI, 'app.js 应在无 DOM 时导出纯函数');
  return sandbox.ChronicleUI;
}
const T = loadUi();
const plain = (v) => JSON.parse(JSON.stringify(v));
const MIN = 60 * 1000;

describe('离线可用', () => {
  test('不引用任何外部资源', () => {
    assert.equal(/https?:\/\//.test(html.replace(/href="data:[^"]*"/g, '').replace(/xmlns="[^"]*"/g, '')), false);
    assert.equal(/url\(\s*["']?https?:/i.test(css), false);
    assert.equal(/(fonts\.googleapis|unpkg|jsdelivr|cdnjs)/i.test(html + css + js), false);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
    assert.match(html, /<script src="\/app\.js"( defer)?><\/script>/);
  });
});

describe('摘要正文渲染不执行注入的 HTML', () => {
  test('mdToHtml / inlineMd / highlight 都转义', () => {
    const evil = '<img src=x onerror=alert(1)> **粗** `<b>`';
    for (const out of [T.mdToHtml(evil), T.inlineMd(evil), T.highlight(evil, 'img')]) {
      assert.equal(out.includes('<img'), false, out);
      assert.equal(out.includes('<b>'), false, out);
    }
    assert.match(T.inlineMd('**粗**'), /<strong>粗<\/strong>/);
  });
});

describe('记忆里的任务行', () => {
  test('「名称（partial）：说明」：名称是标题，说明是正文', () => {
    const t = plain(T.parseTaskLine('Chronicle 前端改造（partial）：需取得 `diff` 和测试回执'));
    assert.equal(t.title, 'Chronicle 前端改造');
    assert.equal(t.desc, '需取得 `diff` 和测试回执');
    assert.equal(t.group, '');
    assert.deepEqual(t.status, { text: '进行中', tone: 'amber' });
  });

  test('「分组：任务（blocked） [标签]」：前半是分组', () => {
    const t = plain(T.parseTaskLine('X-Force 项目调研：模型选择与配置调研（blocked） [MCP、配置]'));
    assert.equal(t.group, 'X-Force 项目调研');
    assert.equal(t.title, '模型选择与配置调研');
    assert.deepEqual(t.status, { text: '卡住了', tone: 'rose' });
    assert.deepEqual(t.tags, ['MCP', '配置']);
  });

  test('网址里的冒号不当分隔符', () => {
    assert.equal(T.parseTaskLine('打开 https://a.example/b 看看').title, '打开 https://a.example/b 看看');
  });
});

describe('一句话讲清这一天', () => {
  test('亲手操作与「屏幕在变但没人动手」分开说', () => {
    const t0 = new Date(2026, 10, 12, 9, 0).getTime();
    const buckets = [
      { startMs: t0, bundleId: 'com.a', activeMs: 5 * MIN, seenMs: 5 * MIN },
      ...Array.from({ length: 12 }, (_, i) => ({ startMs: t0 + (i + 1) * 5 * MIN, bundleId: 'com.b', activeMs: 0, seenMs: 5 * MIN })),
    ];
    const story = T.describeDay({
      activity: { activeMs: 5 * MIN, firstActiveMs: t0, lastActiveMs: t0, apps: [{ bundleId: 'com.a', appName: 'A', activeMs: 5 * MIN }], buckets },
      topApps: [],
      isToday: false,
    });
    assert.equal(story.activeMs, 5 * MIN);
    assert.equal(story.passiveMs, 60 * MIN);
    assert.ok(story.tokens.some((x) => x && x.app === 'com.a'));
    assert.ok(story.aside.length > 0, '一小时没人动手应单独说明');
  });

  test('排队文案只按 10 分钟摘要数「段」', () => {
    assert.match(T.backlogText({ total: 351, pending: { summaries10: 0, memory: 343, summaries6h: 8 } }), /整理好了/);
    assert.match(T.backlogText({ total: 3, pending: { summaries10: 2, memory: 1 } }), /2 段/);
    assert.match(T.backlogText({ total: 0, pending: {} }), /整理完/);
  });
});

describe('章节：6 小时窗口（UTC 对齐，与摘要器一致）', () => {
  test('摘要挂在段上；连续未整理的段合成一条；open 段是「正在记录」', () => {
    const dayStart = Date.UTC(2026, 10, 12, 0, 0);
    const dayEnd = dayStart + 24 * 60 * MIN;
    const at = (h, m = 0) => dayStart + (h * 60 + m) * MIN;
    const seg = (start, end, name) => ({ segment: name, startMs: start, endMs: end, eventCount: 3, open: end === null });
    const chapters = plain(T.buildChapters({
      dayStart, dayEnd, nowMs: at(13, 5),
      segments: [seg(at(1), at(1, 10), 's1'), seg(at(1, 10), at(1, 20), 's2'), seg(at(7), at(7, 10), 's3'), seg(at(13), null, 's4')],
      summaries: [
        { type: '10min', segment: 's3', filename: '10min-s3.md', title: '写代码', startMs: at(7), spanMs: 10 * MIN },
        { type: '6h', filename: '6h-x.md', title: '上午', startMs: at(6), spanMs: 360 * MIN },
      ],
      buckets: [], bucketMs: 5 * MIN,
    }));
    assert.deepEqual(chapters.map((c) => c.startMs), [at(0), at(6), at(12)]);
    assert.deepEqual(chapters[0].items.map((i) => [i.kind, i.segments]), [['raw', ['s1', 's2']]]);
    assert.equal(chapters[1].summary.filename, '6h-x.md');
    assert.deepEqual(chapters[1].items.map((i) => [i.kind, i.summary.filename]), [['summary', '10min-s3.md']]);
    assert.equal(chapters[2].items[0].kind, 'live');
  });
});

describe('搜索结果', () => {
  const ev = (type, data, ts) => ({ type, data, ts, segment: 'x' });
  test('只因前台应用名命中的窗口清单不出现；真的切到该应用算；重复只留一条', () => {
    const hits = plain(T.eventHits([
      ev('visible-windows', { appName: '微信', bundleId: 'com.wx', windows: [{ title: 'ZCode' }] }, '2026-11-13T05:02:00Z'),
      ev('app-switch', { appName: '微信', bundleId: 'com.wx' }, '2026-11-13T05:01:00Z'),
      ev('text-input', { appName: 'Notes', bundleId: 'com.n', text: '回复微信消息' }, '2026-11-13T05:00:00Z'),
      ev('text-input', { appName: 'Notes', bundleId: 'com.n', text: '回复微信消息' }, '2026-11-13T04:59:00Z'),
    ], '微信'));
    assert.deepEqual(hits.map((h) => h.e.type), ['app-switch', 'text-input']);
  });
});

describe('链接', () => {
  test('日期、打开的时刻、设置分区往返不丢', () => {
    const today = '2026-11-13';
    for (const url of ['/', '/?date=2026-11-12&open=s%3A10min-a.md', '/?view=memory', '/?view=settings#privacy']) {
      const u = new URL(url, 'http://127.0.0.1');
      assert.equal(T.routeUrl(T.parseRoute(u), today), url);
    }
    assert.equal(T.parseRoute(new URL('http://127.0.0.1/?date=2026-02-31')).date, '', '无效日期回到今天');
  });
});

describe('接下来：从记忆里的在推进的事来，不需要手动勾选', () => {
  test('拆出下一步；做完了的、没有下一步的不出现', () => {
    const md = [
      '## Ongoing Tasks',
      '- **jsy 客服复验（partial）**：第二轮 36 题对了 15 题。下一步：把错题标出来存回报告',
      '- **Claude Code 接 DeepSeek（blocked）**：一直报 HTTP 400。下一步：换成 deepseek-chat 再试',
      '- **重做时间线页面（success）**：已上线。下一步：无',
      '- **WPS 证书（partial）**：普通 PDF 能打开',
      '## General Tips',
      '- 下一步：这不是一件事',
    ].join('\n');
    const things = T.ongoingFrom(md);
    assert.equal(things.length, 4);
    assert.equal(things[0].desc, '第二轮 36 题对了 15 题');
    assert.equal(things[0].next, '把错题标出来存回报告');
    const next = T.nextThings(things);
    assert.deepEqual([...next.map((t) => t.next)], ['把错题标出来存回报告', '换成 deepseek-chat 再试']);
    assert.equal(next[1].status.text, '卡住了');
  });
});
