// test/coverage.test.mjs — 采集覆盖账本（P0）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCoverage } from '../shared/coverage.mjs';

const NOW = new Date('2026-11-12T12:00:00.000Z');

function writeSegment(home, name, events) {
  const dir = path.join(home, 'segments', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ segmentStart: events[0]?.ts || null, eventCount: events.length }));
}

function ev(ts, type, data) {
  return { ts, type, data };
}

describe('采集覆盖', () => {
  test('按应用分类 good/thin/none，并统计前台时长', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'chronicle-coverage-'));
    try {
      const t = (m) => `2026-11-12T${String(m).padStart(2, '0')}:00:00.000Z`;
      writeSegment(home, '2026-11-12T10-00-00.000Z', [
        ev(t(10), 'app-switch', { bundleId: 'com.good', appName: 'Good' }),
        ev(t(10).replace(':00:00', ':01:00'), 'ax-snapshot', { bundleId: 'com.good', appName: 'Good', nodeCount: 120, text: '内容'.repeat(100) }),
        ev(t(10).replace(':00:00', ':09:00'), 'text-input', { bundleId: 'com.good', appName: 'Good', text: 'hello', charCount: 5 }),
        ev(t(11), 'app-switch', { bundleId: 'com.thin', appName: 'Thin' }),
        ev(t(11).replace(':00:00', ':02:00'), 'ax-snapshot', { bundleId: 'com.thin', appName: 'Thin', nodeCount: 3, text: '画布' }),
        ev(t(11).replace(':00:00', ':05:00'), 'app-switch', { bundleId: 'com.none', appName: 'None' }),
        ...Array.from({ length: 10 }, (_, i) => ev(t(11).replace(':00:00', `:0${i + 2}:00`), 'click', { bundleId: 'com.none', appName: 'None', target: { role: 'AXButton' } })),
        ev(t(11).replace(':00:00', ':07:00'), 'visible-windows', { windows: [{ bundleId: 'com.bg', appName: 'Background', title: '报告' }] }),
      ]);
      const cov = buildCoverage(home, { days: 3, now: NOW });
      const by = Object.fromEntries(cov.apps.map((a) => [a.bundleId, a]));
      assert.equal(by['com.good'].coverage, 'good');
      assert.equal(by['com.good'].snapshots, 1);
      assert.equal(by['com.good'].textChars, 5);
      assert.ok(by['com.good'].activeMs > 0);
      assert.equal(by['com.thin'].coverage, 'thin');
      assert.equal(by['com.none'].coverage, 'none');
      assert.equal(by['com.bg'].events, 0);
      assert.equal(by['com.bg'].visibleWindows, 1);
      assert.equal(cov.summary.good, 1);
      assert.equal(cov.summary.thin, 1);
      assert.equal(cov.summary.none, 1);
      assert.deepEqual(cov.summary.zeroAxApps.map((a) => a.bundleId), ['com.none']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('只扫窗口内段；无事件返回空账本', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'chronicle-coverage-'));
    try {
      writeSegment(home, '2026-10-01T10-00-00.000Z', [
        ev('2026-10-01T10:01:00.000Z', 'app-switch', { bundleId: 'com.old', appName: 'Old' }),
      ]);
      const cov = buildCoverage(home, { days: 7, now: NOW });
      assert.equal(cov.apps.length, 0);
      assert.equal(cov.summary.scannedSegments, 0);
      const empty = buildCoverage(path.join(home, 'nope'), { days: 7, now: NOW });
      assert.deepEqual(empty.apps, []);
      assert.equal(empty.summary.truncated, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
