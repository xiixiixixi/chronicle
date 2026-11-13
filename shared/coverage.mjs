// shared/coverage.mjs — 采集覆盖账本（P0 v0）
//
// 回答一个问题：每个应用，到底采到了多少“可解释的内容”？
//   · good：有 AX 快照，且平均节点数 ≥ 20（窗口内容可读）；
//   · thin：有 AX 快照，但树很浅（Canvas/自绘界面，内容读不全）；
//   · none：有活动但没有 AX 快照（零 AX 盲区）；
//   · visible-only：只出现在屏幕可见窗口清单里，未聚焦过。
//
// 数据全部来自本机段文件，不新增采集、不落盘缓存。扫描有上限，超限如实标注 truncated。

import { chronicleHome, listSegments, readSegmentEvents, parseSegmentTs } from './segments.mjs';

const DAY_MS = 86_400_000;
const ACTIVE_GAP_CAP_MS = 10 * 60_000;
const GOOD_AVG_NODES = 20;

function eventTs(e) {
  const t = Date.parse(e?.ts);
  return Number.isNaN(t) ? null : t;
}

function appIdentity(e) {
  const d = (e && e.data) || {};
  const bundleId = typeof d.bundleId === 'string' ? d.bundleId : '';
  const appName = typeof d.appName === 'string' ? d.appName : '';
  if (!bundleId && !appName) return null;
  return { bundleId, appName };
}

function textLen(value) {
  return typeof value === 'string' ? Array.from(value).length : 0;
}

function bucketFor(map, identity) {
  const key = identity.bundleId || `name:${identity.appName}`;
  let app = map.get(key);
  if (!app) {
    app = {
      bundleId: identity.bundleId,
      appName: identity.appName,
      events: 0,
      activeMs: 0,
      snapshots: 0,
      snapshotNodes: 0,
      snapshotChars: 0,
      textChars: 0,
      scrolls: 0,
      visibleWindows: 0,
      firstSeen: null,
      lastSeen: null,
    };
    map.set(key, app);
  }
  if (!app.appName && identity.appName) app.appName = identity.appName;
  if (!app.bundleId && identity.bundleId) app.bundleId = identity.bundleId;
  return app;
}

function touch(app, ts) {
  if (ts == null) return;
  if (app.firstSeen == null || ts < app.firstSeen) app.firstSeen = ts;
  if (app.lastSeen == null || ts > app.lastSeen) app.lastSeen = ts;
}

/**
 * 近 N 天的应用级采集覆盖。
 * @param {string} home
 * @param {{days?: number, now?: Date, maxSegments?: number, maxEvents?: number}} opts
 * @returns {{version:number, generated_at:string, days:number, apps:Array, summary:object}}
 */
export function buildCoverage(home = chronicleHome(), { days = 7, now = new Date(), maxSegments = 1500, maxEvents = 300_000 } = {}) {
  const span = Math.max(1, Math.min(90, Number(days) || 7));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const cutoff = (Number.isNaN(nowMs) ? Date.now() : nowMs) - span * DAY_MS;
  const allSegments = listSegments(home).filter((s) => {
    const t = parseSegmentTs(s.segment);
    return t && t.getTime() >= cutoff;
  });
  const segments = allSegments.slice(0, Math.max(1, maxSegments));
  const apps = new Map();
  let scannedEvents = 0;
  let truncated = segments.length < allSegments.length;

  for (const seg of segments) {
    if (scannedEvents >= maxEvents) { truncated = true; break; }
    const data = readSegmentEvents(home, seg.segment);
    if (!data || !Array.isArray(data.events)) continue;
    const segSwitches = [];
    for (const e of data.events) {
      if (scannedEvents >= maxEvents) { truncated = true; break; }
      const ts = eventTs(e);
      if (ts == null || ts < cutoff) continue;
      scannedEvents += 1;
      const type = String(e.type || '');
      if (type === 'visible-windows') {
        const wins = Array.isArray(e?.data?.windows) ? e.data.windows : [];
        for (const w of wins) {
          const identity = appIdentity({ data: { bundleId: w?.bundleId, appName: w?.appName } });
          if (!identity) continue;
          const app = bucketFor(apps, identity);
          app.visibleWindows += 1;
          touch(app, ts);
        }
        continue;
      }
      const identity = appIdentity(e);
      if (!identity) continue;
      const app = bucketFor(apps, identity);
      app.events += 1;
      touch(app, ts);
      if (type === 'app-switch') segSwitches.push({ key: identity.bundleId || `name:${identity.appName}`, ts });
      else if (type === 'ax-snapshot') {
        app.snapshots += 1;
        const nodes = Number(e?.data?.nodeCount);
        if (Number.isFinite(nodes) && nodes > 0) app.snapshotNodes += nodes;
        app.snapshotChars += textLen(e?.data?.text);
      } else if (type === 'text-input') {
        const chars = Number(e?.data?.charCount);
        app.textChars += Number.isFinite(chars) ? chars : textLen(e?.data?.text);
      } else if (type === 'scroll') {
        app.scrolls += 1;
      }
    }
    // 前台时长：段内 app-switch 到下一次切换；最后一次用段结束/现在兜底，单次封顶 10 分钟。
    const referenceNow = Number.isNaN(nowMs) ? Date.now() : nowMs;
    const segEnd = seg.segmentEnd ? Date.parse(seg.segmentEnd) : referenceNow;
    const endTs = Number.isFinite(segEnd) ? Math.min(segEnd, referenceNow) : referenceNow;
    segSwitches.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < segSwitches.length; i += 1) {
      const next = i + 1 < segSwitches.length ? segSwitches[i + 1].ts : Math.min(endTs, segSwitches[i].ts + ACTIVE_GAP_CAP_MS);
      const app = apps.get(segSwitches[i].key);
      if (app) app.activeMs += Math.min(Math.max(0, next - segSwitches[i].ts), ACTIVE_GAP_CAP_MS);
    }
  }

  const out = [];
  for (const app of apps.values()) {
    const avgNodes = app.snapshots > 0 ? app.snapshotNodes / app.snapshots : 0;
    let coverage = 'unknown';
    let reason = '数据不足（活动时间太短）';
    if (app.snapshots > 0 && avgNodes >= GOOD_AVG_NODES) {
      coverage = 'good';
      reason = `AX 快照平均 ${Math.round(avgNodes)} 个节点`;
    } else if (app.snapshots > 0) {
      coverage = 'thin';
      reason = `AX 树很浅（平均 ${Math.round(avgNodes)} 个节点），可能是自绘界面`;
    } else if (app.events >= 10 || app.activeMs >= 60_000) {
      coverage = 'none';
      reason = '有活动但没有任何窗口内容（零 AX 盲区）';
    } else if (app.events === 0 && app.visibleWindows > 0) {
      coverage = 'unknown';
      reason = '仅出现在可见窗口清单（未聚焦）';
    }
    out.push({
      bundleId: app.bundleId,
      appName: app.appName || app.bundleId || '未知应用',
      events: app.events,
      activeMs: app.activeMs,
      activeMinutes: Math.round(app.activeMs / 60_000),
      snapshots: app.snapshots,
      snapshotNodes: app.snapshotNodes,
      avgNodes: Math.round(avgNodes * 10) / 10,
      snapshotChars: app.snapshotChars,
      textChars: app.textChars,
      scrolls: app.scrolls,
      visibleWindows: app.visibleWindows,
      firstSeen: app.firstSeen ? new Date(app.firstSeen).toISOString() : null,
      lastSeen: app.lastSeen ? new Date(app.lastSeen).toISOString() : null,
      coverage,
      reason,
    });
  }
  out.sort((a, b) => b.activeMs - a.activeMs || b.events - a.events);

  const count = (level) => out.filter((a) => a.coverage === level).length;
  const zeroAxApps = out
    .filter((a) => a.coverage === 'none')
    .map((a) => ({ bundleId: a.bundleId, appName: a.appName, activeMinutes: a.activeMinutes }));
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    days: span,
    apps: out,
    summary: {
      apps: out.length,
      good: count('good'),
      thin: count('thin'),
      none: count('none'),
      unknown: count('unknown'),
      zeroAxApps,
      visibleOnly: out.filter((a) => a.events === 0 && a.visibleWindows > 0).length,
      snapshots: out.reduce((n, a) => n + a.snapshots, 0),
      scannedEvents,
      scannedSegments: segments.length,
      truncated,
    },
  };
}
