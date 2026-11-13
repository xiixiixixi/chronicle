// test/compression.test.mjs — 任务 F：旧段 gzip 透明压缩
//
// 覆盖（对应任务书的安全红线与兼容要求）：
//   ① 只压已关闭且足够旧的段：open 段 / too-new 段不动
//   ② 压缩后：原文件消失、`.gz` 存在、gunzip 内容与原文件逐字节一致（sha256）
//   ③ 读者透明：readSegmentEvents（events 与 withSuppressed）、listSegments 的 eventCount
//      （含 metadata 缺 eventCount 的兜底计数）、readSegmentDataText/stampSegmentDataFile
//   ④ 索引透明：压缩前后 searchEventsPaged / indexStats 结果一致（指纹变化触发重建）
//   ⑤ dryRun 零写入；二次运行幂等 no-op；两文件并存时校验一致才删原件
//   ⑥ 失败安全：坏 .gz / 不一致 .gz / 写 tmp 失败 / 符号链接 → 保留原文件 + 记 error
//   ⑦ 日志不泄露内容（fixture 里埋哨兵字符串）；metadata.json 永不压缩
//
// 不依赖网络与第三方包；不触碰 test/fixtures 下他人文件。

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  COMPRESSIBLE_FILES, DEFAULT_AFTER_DAYS, compressOldSegments, isSegmentCompressed,
  readSegmentDataText, resolveSegmentDataFile, stampSegmentDataFile,
} from '../shared/compression.mjs';
import { clearSegmentCache, listSegments, readSegmentEvents } from '../shared/segments.mjs';
import { closeIndex, ensureIndex, indexStats, resetIndex, searchEventsPaged } from '../shared/index.mjs';
import { segmentSourceDigest } from '../summarize.mjs';

const DAY = 86_400_000;
const SECRET_SENTINEL = 'SECRET_SENTINEL_DO_NOT_LOG';
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-zip-'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 已关闭 / open 段的元信息。 */
function meta({ startIso, closed = true, eventCount = null } = {}) {
  const m = { segmentStart: startIso };
  if (closed) m.segmentEnd = new Date(Date.parse(startIso) + 10 * 60_000).toISOString();
  if (eventCount !== null) m.eventCount = eventCount;
  return m;
}

/**
 * 造段：<home>/segments/<name>/{events.jsonl,suppressed.jsonl,metadata.json}
 * @returns {{dir:string, events:Array, suppressed:Array}}
 */
function mkSeg(home, name, { events = [], suppressed = [], closed = true, eventCount = null, startIso = null } = {}) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  const iso = startIso ?? name.replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/,
    '$1-$2-$3T$4:$5:$6.$7Z',
  );
  if (events.length) writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  else writeFileSync(path.join(dir, 'events.jsonl'), '');
  if (suppressed.length) writeFileSync(path.join(dir, 'suppressed.jsonl'), `${suppressed.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta({ startIso: iso, closed, eventCount })));
  return { dir, events, suppressed };
}

/** 一个「够旧」的段（30 天前）。 */
const OLD_NAME = '2026-09-01T02-00-00.000Z';
const OLD_START = '2026-09-01T02:00:00.000Z';

function sampleEvents() {
  return [
    { ts: '2026-09-01T02:00:05.000Z', type: 'app-switch', data: { bundleId: 'com.apple.Terminal', appName: 'Terminal' } },
    { ts: '2026-09-01T02:03:00.000Z', type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: `build — ${SECRET_SENTINEL}` } },
    { ts: '2026-09-01T02:05:00.000Z', type: 'url-change', data: { bundleId: 'com.google.Chrome', url: 'https://example.test/a?b=1' } },
  ];
}

function sampleSuppressed() {
  return [
    { ts: '2026-09-01T02:01:00.000Z', type: 'sample', scope: 'app' },
    { ts: '2026-09-01T02:02:00.000Z', type: 'sample', scope: 'url' },
  ];
}

/** 目录快照（名→大小），用于验证 dryRun 零写入。 */
function snapshot(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const rel = `${prefix}${name}`;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, `${rel}/`);
      else out[rel] = `${st.size}:${Math.round(st.mtimeMs * 1000)}`;
    }
  };
  walk(dir, '');
  return out;
}

const homes = [];
function newHome() {
  const h = tmpHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  closeIndex();
  clearSegmentCache();
  // 恢复可能被测试改成只读的目录权限后再删
  for (const h of homes.splice(0)) {
    try {
      for (const name of readdirSync(path.join(h, 'segments')) ?? []) {
        try { chmodSync(path.join(h, 'segments', name), 0o700); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
    rmSync(h, { recursive: true, force: true });
  }
});

// ---------- ① 只压「已关闭 + 够旧」 ----------

describe('压缩范围：只压已关闭且足够旧的段', () => {
  test('closed+old 段被压缩；open 段与 too-new 段完全不动', () => {
    const home = newHome();
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const old = mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const openName = '2026-09-02T02-00-00.000Z';
    const open = mkSeg(home, openName, { events: sampleEvents(), closed: false });
    const newName = '2026-09-30T02-00-00.000Z'; // 1 天前（默认 7 天阈值内）
    const fresh = mkSeg(home, newName, { events: sampleEvents() });

    const r = compressOldSegments(home, { now });
    assert.equal(r.dryRun, false);
    assert.equal(r.cutoffIso, new Date(now - DEFAULT_AFTER_DAYS * DAY).toISOString());
    assert.equal(r.compressedSegments.length, 1);
    const entry = r.compressedSegments[0];
    assert.equal(entry.segment, OLD_NAME);
    assert.deepEqual(entry.files.sort(), ['events.jsonl', 'suppressed.jsonl']);
    assert.ok(entry.bytesBefore > entry.bytesAfter);
    assert.equal(r.skippedOpen, 1);
    assert.equal(r.skippedTooNew, 1);
    assert.deepEqual(r.errors, []);

    // 旧段：原文消失、.gz 存在、metadata 仍在（永不压缩）
    for (const base of COMPRESSIBLE_FILES) {
      assert.equal(existsSync(path.join(old.dir, base)), false, `${base} 应已删除`);
      assert.equal(existsSync(path.join(old.dir, `${base}.gz`)), true, `${base}.gz 应存在`);
      assert.equal(existsSync(path.join(old.dir, `${base}.gz.tmp`)), false, '不得残留 tmp');
    }
    assert.equal(existsSync(path.join(old.dir, 'metadata.json')), true);

    // open / too-new 段：原文原封不动、没有 .gz
    for (const seg of [open, fresh]) {
      assert.equal(existsSync(path.join(seg.dir, 'events.jsonl')), true);
      assert.equal(existsSync(path.join(seg.dir, 'events.jsonl.gz')), false);
    }
  });

  test('afterDays=0 → 已关闭段立即符合；未来段仍跳过', () => {
    const home = newHome();
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const done = mkSeg(home, '2026-10-01T10-00-00.000Z', { events: sampleEvents() });
    const future = mkSeg(home, '2026-10-02T10-00-00.000Z', { events: sampleEvents() });
    const r = compressOldSegments(home, { now, afterDays: 0 });
    assert.equal(r.compressedSegments.length, 1);
    assert.equal(r.compressedSegments[0].segment, '2026-10-01T10-00-00.000Z');
    assert.ok(existsSync(path.join(done.dir, 'events.jsonl.gz')));
    assert.equal(r.skippedTooNew, 1);
    assert.ok(existsSync(path.join(future.dir, 'events.jsonl')));
  });
});

// ---------- ② 压缩结果正确性 ----------

describe('压缩结果：内容零损失', () => {
  test('gunzip(.gz) 与原文件 sha256 一致（events / suppressed 各一）', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const beforeRaw = {
      'events.jsonl': readFileSync(path.join(seg.dir, 'events.jsonl')),
      'suppressed.jsonl': readFileSync(path.join(seg.dir, 'suppressed.jsonl')),
    };
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r.errors.length, 0);
    for (const base of COMPRESSIBLE_FILES) {
      const gz = readFileSync(path.join(seg.dir, `${base}.gz`));
      const restored = gunzipSync(gz);
      assert.equal(sha256(restored), sha256(beforeRaw[base]), `${base} 内容必须逐字节一致`);
      assert.ok(gz.length < beforeRaw[base].length, `${base} 应更小`);
    }
    assert.ok(r.bytesSaved > 0);
  });
});

// ---------- ③ 读者透明 ----------

describe('读者透明：segments.mjs / compression 助手', () => {
  test('readSegmentEvents（events 与 withSuppressed）压缩前后逐条一致', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    clearSegmentCache();
    const before = readSegmentEvents(home, OLD_NAME, { withSuppressed: true });
    const beforeList = listSegments(home);

    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r.errors.length, 0);
    clearSegmentCache();

    const after = readSegmentEvents(home, OLD_NAME, { withSuppressed: true });
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.suppressed, before.suppressed);
    assert.equal(after.skipped, 0);

    // 不做 withSuppressed 时不返回 suppressed 字段（旧语义）
    const plain = readSegmentEvents(home, OLD_NAME);
    assert.deepEqual(plain.events, before.events);
    assert.equal('suppressed' in plain, false);

    const afterList = listSegments(home);
    assert.equal(afterList[0].eventCount, beforeList[0].eventCount);
    assert.equal(afterList[0].open, false);
    assert.equal(afterList[0].segmentEnd, beforeList[0].segmentEnd);
    // 显式要 suppressed 计数时，压缩后仍能数出来
    assert.equal(listSegments(home, { withSuppressed: true })[0].suppressedCount, sampleSuppressed().length);
  });

  test('metadata 缺 eventCount → 从 .gz 兜底数行数', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() }); // 无 eventCount
    clearSegmentCache();
    assert.equal(listSegments(home)[0].eventCount, sampleEvents().length);
    assert.equal(compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') }).errors.length, 0);
    clearSegmentCache();
    assert.equal(listSegments(home)[0].eventCount, sampleEvents().length, '压缩后计数必须不变');
    // 再确认 index.scanSegments 同一路径也一致
    const stats = ensureIndex(home);
    assert.equal(stats.events, sampleEvents().length);
  });

  test('compression 助手：优先原文、其次 .gz；stamp 未压缩时与旧格式一致', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    // 只有原文
    const r1 = resolveSegmentDataFile(seg.dir, 'events.jsonl');
    assert.deepEqual({ compressed: r1.compressed }, { compressed: false });
    assert.match(stampSegmentDataFile(seg.dir, 'events.jsonl'), /^events\.jsonl:\d+:\d+$/);
    assert.equal(readSegmentDataText(seg.dir, 'events.jsonl').split('\n').filter(Boolean).length, 3);

    // 压缩后只有 .gz
    compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    const r2 = resolveSegmentDataFile(seg.dir, 'events.jsonl');
    assert.equal(r2.compressed, true);
    assert.match(stampSegmentDataFile(seg.dir, 'events.jsonl'), /^events\.jsonl\.gz:\d+:\d+$/);
    assert.equal(readSegmentDataText(seg.dir, 'events.jsonl').split('\n').filter(Boolean).length, 3);
    assert.equal(isSegmentCompressed(seg.dir), true);

    // 两者并存 → 读者优先原文（真相）
    writeFileSync(path.join(seg.dir, 'events.jsonl'), '{"ts":"2026-09-01T02:00:05.000Z","type":"x","data":{}}\n');
    assert.equal(resolveSegmentDataFile(seg.dir, 'events.jsonl').compressed, false);
  });

  test('summarize.segmentSourceDigest 兼容 .gz（不抛错、格式稳定、压缩后允许变化）', () => {
    const home = newHome();
    mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const before = segmentSourceDigest(home, OLD_NAME);
    assert.match(before, /^[0-9a-f]{64}$/);
    compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    const after = segmentSourceDigest(home, OLD_NAME);
    assert.match(after, /^[0-9a-f]{64}$/);
    assert.equal(segmentSourceDigest(home, OLD_NAME), after, '重复调用必须稳定');
  });
});

// ---------- ④ 索引透明 ----------

describe('索引透明：压缩前后检索结果一致', () => {
  test('先建索引再压缩 → 再搜（触发重建）结果逐条一致', () => {
    const home = newHome();
    const old = mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const newer = mkSeg(home, '2026-09-28T03-00-00.000Z', { // cutoff=2026-09-24 → 这段太新，不压
      events: [{ ts: '2026-09-28T03:01:00.000Z', type: 'app-switch', data: { bundleId: 'com.apple.finder', appName: 'Finder' } }],
    });
    clearSegmentCache();
    const first = ensureIndex(home);
    assert.equal(first.events, 4);
    const snap = (q) => searchEventsPaged(home, { query: q, limit: 100 });
    const beforeAll = snap('');
    const beforeHit = snap('terminal');
    const beforeUrl = snap('example.test');

    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r.errors.length, 0);
    assert.equal(r.compressedSegments.length, 1);

    // 压缩改了文件指纹 → 下次 ensureIndex 重建该段；事件集合必须不变
    const stats = indexStats(home);
    assert.equal(stats.events, 4);
    assert.deepEqual(snap('').items, beforeAll.items);
    assert.deepEqual(snap('terminal').items, beforeHit.items);
    assert.deepEqual(snap('example.test').items, beforeUrl.items);
    assert.equal(snap('terminal').total, 2);
    // 重建后两段仍都在索引里
    assert.equal(indexStats(home).segments, 2);
    assert.equal(existsSync(path.join(old.dir, 'events.jsonl.gz')), true);
    assert.equal(existsSync(path.join(newer.dir, 'events.jsonl')), true);
  });
});

// ---------- ⑤ dryRun / 幂等 / 并存去重 ----------

describe('dryRun、幂等与并存去重', () => {
  test('dryRun=true 零写入（文件集合/大小/mtime 全不变），但返回待压缩清单', () => {
    const home = newHome();
    mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const before = snapshot(home);
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z'), dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.compressedSegments.length, 1);
    assert.equal(r.compressedSegments[0].segment, OLD_NAME);
    assert.ok(r.compressedSegments[0].bytesAfter > 0, 'dryRun 也应给出预估压缩后大小');
    assert.deepEqual(snapshot(home), before, 'dryRun 不得写任何文件');
  });

  test('二次运行 no-op：不重复压缩、不报错、bytesSaved=0', () => {
    const home = newHome();
    mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const first = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(first.compressedSegments.length, 1);
    assert.ok(first.bytesSaved > 0);

    const snapAfterFirst = snapshot(home);
    const second = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.deepEqual(second.compressedSegments, []);
    assert.equal(second.bytesSaved, 0);
    assert.deepEqual(second.errors, []);
    assert.equal(second.skippedAlreadyCompressed, 1);
    assert.deepEqual(snapshot(home), snapAfterFirst, '二次运行不得改动文件');
  });

  test('两文件并存且内容一致 → 校验通过后删原件（dedupe），不重复压缩', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const plain = path.join(seg.dir, 'events.jsonl');
    const raw = readFileSync(plain);
    writeFileSync(`${plain}.gz`, gzipSync(raw)); // 手工造出「已压缩 + 原文仍在」的中间态

    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.deepEqual(r.errors, []);
    assert.equal(r.compressedSegments.length, 1);
    assert.deepEqual(r.compressedSegments[0].files, ['events.jsonl']);
    assert.equal(existsSync(plain), false, '校验一致后应删除原件');
    assert.equal(existsSync(`${plain}.gz`), true);
  });
});

// ---------- ⑥ 失败安全 ----------

describe('失败安全：绝不为了压缩丢数据', () => {
  test('原文与 .gz 不一致 → 保留原文件、删除 .gz、记 error', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const plain = path.join(seg.dir, 'events.jsonl');
    const goodRaw = readFileSync(plain);
    writeFileSync(`${plain}.gz`, gzipSync(Buffer.from('完全不同的事件内容\n'))); // 内容不一致

    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].code, 'DUPLICATE_MISMATCH');
    assert.equal(r.errors[0].segment, OLD_NAME);
    assert.equal(r.errors[0].file, 'events.jsonl');
    assert.equal(existsSync(plain), true, '原件必须保留');
    assert.equal(sha256(readFileSync(plain)), sha256(goodRaw), '原件内容不得被改动');
    assert.equal(existsSync(`${plain}.gz`), false, '不可信的 .gz 应被删除');
    assert.equal(r.compressedSegments.length, 0);
  });

  test('截断/损坏的 .gz → 保留原文件、删坏 .gz、记 error（绝不删原件）', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const plain = path.join(seg.dir, 'events.jsonl');
    const raw = readFileSync(plain);
    writeFileSync(`${plain}.gz`, Buffer.from('not a gzip stream at all')); // 损坏

    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].code, 'DUPLICATE_MISMATCH');
    assert.equal(existsSync(plain), true);
    assert.equal(sha256(readFileSync(plain)), sha256(raw));
    assert.equal(existsSync(`${plain}.gz`), false);
  });

  test('写临时文件失败（段目录只读）→ 保留原件、清理 tmp、记 error', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const raw = readFileSync(path.join(seg.dir, 'events.jsonl'));
    chmodSync(seg.dir, 0o500); // 只读：写 .gz.tmp 会 EACCES
    try {
      const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
      assert.ok(r.errors.length >= 1);
      assert.ok(r.errors.some((e) => e.code === 'WRITE_TMP_FAILED'), `实际: ${JSON.stringify(r.errors)}`);
      assert.equal(existsSync(path.join(seg.dir, 'events.jsonl')), true, '原件必须保留');
      assert.equal(sha256(readFileSync(path.join(seg.dir, 'events.jsonl'))), sha256(raw));
      assert.equal(existsSync(path.join(seg.dir, 'events.jsonl.gz')), false);
      assert.equal(existsSync(path.join(seg.dir, 'events.jsonl.gz.tmp')), false);
    } finally {
      chmodSync(seg.dir, 0o700);
    }
  });

  test('events.jsonl 是符号链接 → 拒绝压缩并记 error（不跟随、不删除）', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const elseWhere = path.join(home, 'outside.jsonl');
    writeFileSync(elseWhere, '{"ts":"2026-09-01T02:00:00.000Z","type":"x","data":{}}\n');
    rmSync(path.join(seg.dir, 'events.jsonl'));
    symlinkSync(elseWhere, path.join(seg.dir, 'events.jsonl'));

    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.ok(r.errors.some((e) => e.code === 'NOT_REGULAR_FILE'), JSON.stringify(r.errors));
    assert.equal(existsSync(elseWhere), true, '链接目标不得被删除或改写');
    assert.equal(existsSync(path.join(seg.dir, 'events.jsonl.gz')), false);
  });

  test('metadata 缺失/损坏 → 保守跳过（skippedUnparsable），不盲压', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    writeFileSync(path.join(seg.dir, 'metadata.json'), '{ this is not json');
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.equal(r.skippedUnparsable, 1);
    assert.equal(r.compressedSegments.length, 0);
    assert.equal(existsSync(path.join(seg.dir, 'events.jsonl')), true);
  });
});

// ---------- ⑦ 日志不泄露内容 + 结果形状 ----------

describe('日志与返回结构', () => {
  test('日志只含段名/文件名/字节数，绝不含事件内容（哨兵字符串）', () => {
    const home = newHome();
    mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const lines = [];
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z'), log: (m) => lines.push(String(m)) });
    assert.ok(lines.length >= 1);
    assert.equal(r.errors.length, 0);
    for (const line of lines) {
      assert.equal(line.includes(SECRET_SENTINEL), false, `日志泄露了事件内容: ${line}`);
      assert.equal(line.includes('com.apple.Terminal'), false, `日志泄露了 bundleId: ${line}`);
      assert.equal(line.includes('example.test'), false, `日志泄露了 URL: ${line}`);
    }
    // 日志里有段名与字节数（可运维）
    assert.ok(lines.some((l) => l.includes(OLD_NAME)));
    assert.ok(lines.some((l) => /\d+→\d+ 字节/.test(l)));
  });

  test('返回结构字段齐全且自洽', () => {
    const home = newHome();
    mkSeg(home, OLD_NAME, { events: sampleEvents(), suppressed: sampleSuppressed() });
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    for (const key of ['dryRun', 'cutoffIso', 'compressedSegments', 'skippedOpen', 'skippedTooNew', 'skippedAlreadyCompressed', 'skippedUnparsable', 'errors', 'bytesSaved']) {
      assert.ok(key in r, `缺少字段 ${key}`);
    }
    assert.equal(typeof r.bytesSaved, 'number');
    const summed = r.compressedSegments.reduce((acc, e) => acc + Math.max(0, e.bytesBefore - e.bytesAfter), 0);
    assert.equal(r.bytesSaved, summed, 'bytesSaved 应等于各段节省之和');
    assert.ok(existsSync(path.join(home, 'segments')));
  });

  test('空 home / 不存在 segments 目录 → 安全返回空结果', () => {
    const home = newHome();
    const r = compressOldSegments(home, { now: 1_700_000_000_000 });
    assert.deepEqual(r.compressedSegments, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.bytesSaved, 0);
    assert.equal(r.dryRun, false);
  });

  test('跨段并发安全：多段混合（可压/open/太新）只动该动的', () => {
    const home = newHome();
    const a = mkSeg(home, '2026-09-01T01-00-00.000Z', { events: sampleEvents() });
    const b = mkSeg(home, '2026-09-02T02-00-00.000Z', { events: sampleEvents(), suppressed: sampleSuppressed() });
    const openSeg = mkSeg(home, '2026-09-03T03-00-00.000Z', { events: sampleEvents(), closed: false });
    const newSeg = mkSeg(home, '2026-09-29T04-00-00.000Z', { events: sampleEvents() });
    // cutoff = 2026-10-01 - 7 天 = 2026-09-24：a/b 都够旧 → 都压；open 段与 9-29 段不动
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.deepEqual(r.compressedSegments.map((e) => e.segment).sort(),
      ['2026-09-01T01-00-00.000Z', '2026-09-02T02-00-00.000Z']);
    assert.equal(existsSync(path.join(a.dir, 'events.jsonl.gz')), true);
    assert.equal(existsSync(path.join(b.dir, 'events.jsonl.gz')), true);
    assert.equal(existsSync(path.join(b.dir, 'suppressed.jsonl.gz')), true);
    assert.equal(existsSync(path.join(openSeg.dir, 'events.jsonl')), true);
    assert.equal(existsSync(path.join(newSeg.dir, 'events.jsonl')), true);
    assert.equal(r.skippedOpen, 1);
    assert.equal(r.skippedTooNew, 1);
  });
});

// ---------- ⑧ 残留物与统计口径 ----------

describe('残留清理与统计口径', () => {
  test('崩溃残留的 .gz.tmp 会被清理并重建为正确的 .gz（不丢数据）', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const plain = path.join(seg.dir, 'events.jsonl');
    writeFileSync(`${plain}.gz.tmp`, 'half-written garbage from a crashed run');
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.deepEqual(r.errors, []);
    assert.equal(existsSync(`${plain}.gz.tmp`), false, '残留 tmp 应被清理');
    assert.equal(existsSync(plain), false);
    const restored = gunzipSync(readFileSync(`${plain}.gz`));
    assert.equal(restored.toString('utf8'), sampleEvents().map((e) => JSON.stringify(e)).join('\n') + '\n');
  });

  test('dryRun 连残留 tmp 也不清（严格零写入）', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: sampleEvents() });
    const tmp = path.join(seg.dir, 'events.jsonl.gz.tmp');
    writeFileSync(tmp, 'stale');
    const before = snapshot(home);
    compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z'), dryRun: true });
    assert.deepEqual(snapshot(home), before, 'dryRun 不得清理/写入任何文件');
  });

  test('压缩无收益（空文件）→ 保持原文、不记压缩、不记错误', () => {
    const home = newHome();
    const seg = mkSeg(home, OLD_NAME, { events: [] }); // events.jsonl 为 0 字节
    const r = compressOldSegments(home, { now: Date.parse('2026-10-01T00:00:00Z') });
    assert.deepEqual(r.compressedSegments, []);
    assert.equal(r.skippedAlreadyCompressed, 0, '空段不应算作已压缩');
    assert.deepEqual(r.errors, []);
    assert.equal(r.bytesSaved, 0);
    assert.equal(existsSync(path.join(seg.dir, 'events.jsonl')), true, '无收益时不写 .gz、保留原文');
    assert.equal(existsSync(path.join(seg.dir, 'events.jsonl.gz')), false);
  });
});
