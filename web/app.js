// web/app.js — Chronicle 时间线 UI 逻辑（无框架，纯 JS + 本地 HTTP API）
//
// 功能：时间线（按天分组）/ AI 摘要卡片 / 跨段搜索 / 暂停恢复 / 隐私设置 / 5s 轮询刷新。
// 红线：只展示结构化活动事件；所有插值一律 escapeHtml。

const $ = (sel) => document.querySelector(sel);

const LOAD_SEGMENTS = 20;    // 每次载入最近多少个段
const ROW_CAP_STEP = 400;    // 时间线渲染行数上限（可逐步加载更多）
const POLL_MS = 5000;

const state = {
  paused: false,
  searching: false,
  rowCap: ROW_CAP_STEP,
  timelineSignature: '',     // 段列表指纹（变化才重载时间线）
};

// ---------- 基础工具 ----------

async function api(path, init) {
  const r = await fetch(path, init);
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || !body || body.ok === false) {
    const msg = body && body.error ? body.error : `HTTP ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return body;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const pad2 = (n) => String(n).padStart(2, '0');
const timeOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const dayKey = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 'unknown' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const todayKey = () => dayKey(new Date());

function dayLabel(key) {
  if (key === todayKey()) return '今天';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y)) return '昨天';
  const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${key}T12:00:00`).getDay()] ?? '?';
  return `周${wd}`;
}

/** 段目录名（HH-mm-ss 变体）或 ISO 串 → Date。 */
function segToDate(seg) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(String(seg ?? ''));
  if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  const d = new Date(seg);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 事件图标：终端 → >、浏览器 → 🌐、Finder → 📁、其他 → 📦。 */
function iconFor(e) {
  const d = e.data ?? {};
  const b = String(d.bundleId ?? '').toLowerCase();
  if (d.url || b.includes('chrome') || b.includes('safari') || b.includes('firefox') || b.includes('edge') || b.includes('arc.') || b.includes('brave')) {
    return { cls: '', html: '🌐' };
  }
  if (b.includes('finder')) return { cls: '', html: '📁' };
  if (b.includes('terminal') || b.includes('iterm') || b.includes('tmux') || b.includes('vim') || b.includes('neovim')) {
    return { cls: 'gt', html: '&gt;' };
  }
  return { cls: '', html: '📦' };
}

function describeEvent(e, appNameByBundle) {
  const d = e.data ?? {};
  const app = d.appName ?? appNameByBundle.get(d.bundleId) ?? d.bundleId ?? '?';
  switch (e.type) {
    case 'app-switch': return `切换到 <b>${escapeHtml(app)}</b>`;
    case 'window-change': return `${escapeHtml(app)} 窗口「${escapeHtml(d.windowTitle ?? '')}」`;
    case 'url-change': {
      const url = String(d.url ?? '');
      let host = url;
      try { host = new URL(url).host; } catch { /* 保留原串 */ }
      return `${escapeHtml(app)} <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(host)}</a>`;
    }
    case 'focus-change': return `${escapeHtml(app)} 焦点 ${escapeHtml(d.role ?? '?')}${d.title ? `「${escapeHtml(d.title)}」` : ''}`;
    default: return `${escapeHtml(e.type ?? '?')} <code>${escapeHtml(JSON.stringify(d))}</code>`;
  }
}

/** 摘要正文用于展示：剥掉开头的 Markdown 标题行（卡片已有自己的标题）。 */
function summaryBodyForDisplay(body) {
  return String(body ?? '').split('\n').filter((line, i) => !(i === 0 && /^#\s/.test(line.trim()))).join('\n').trim();
}

function eventRow(e, appNameByBundle, withDate) {
  if (e.data?.appName && e.data?.bundleId) appNameByBundle.set(e.data.bundleId, e.data.appName);
  const ic = iconFor(e);
  const dateTag = withDate ? `<span class="seg">${escapeHtml(dayKey(e.ts).slice(5))} </span>` : '';
  return `<li>${dateTag}<span class="t">${escapeHtml(timeOf(e.ts))}</span><span class="ic ${ic.cls}">${ic.html}</span>` +
    `<span class="app">${escapeHtml(e.data?.appName ?? appNameByBundle.get(e.data?.bundleId) ?? e.data?.bundleId ?? '?')}</span>` +
    `<span class="what">${describeEvent(e, appNameByBundle)}</span></li>`;
}

// ---------- 状态轮询 ----------

async function refreshStatus() {
  let st = null;
  try { st = await api('/api/status'); } catch (err) {
    $('#status-line').textContent = `守护不可达：${err.message}`;
    return;
  }
  const s = st.status ?? {};
  state.paused = s.paused === true;
  $('#paused-badge').classList.toggle('hidden', !state.paused);
  $('#btn-pause').textContent = state.paused ? '▶ 恢复' : '⏸ 暂停';
  const cur = s.currentSegment;
  const bits = [];
  bits.push(s.running ? (state.paused ? '已暂停' : '采集中') : '未采集');
  if (cur) bits.push(`当前段 ${String(cur.startTs ?? '').slice(11, 16)} · 事件 ${cur.eventCount}`);
  else bits.push(`累计事件 ${s.totalEvents ?? 0}`);
  $('#status-line').textContent = bits.join(' · ');
}

// ---------- 时间线 ----------

async function loadTimeline() {
  const [segsRes, sumsRes] = await Promise.all([
    api('/api/segments').catch(() => ({ segments: [] })),
    api('/api/summaries').catch(() => ({ summaries: [] })),
  ]);
  const segments = segsRes.segments ?? [];
  state.timelineSignature = segments.map((s) => `${s.segment}:${s.eventCount}:${s.open ? 1 : 0}`).join('|');

  const recent = segments.slice(0, LOAD_SEGMENTS);
  const perSeg = await Promise.all(recent.map((s) =>
    fetch(`/api/segment/${encodeURIComponent(s.segment)}/events`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .catch(() => ({ events: [] }))));

  // 事件按天分组（天内时间正序）
  const byDay = new Map();
  const appNameByBundle = new Map();
  for (const data of perSeg) {
    for (const e of data?.events ?? []) {
      if (!e?.ts) continue;
      const k = dayKey(e.ts);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  // 摘要按天分组（天内新的在前）
  const sumsByDay = new Map();
  for (const s of sumsRes.summaries ?? []) {
    const d = segToDate(s.segment) ?? (s.mtimeMs ? new Date(s.mtimeMs) : null);
    if (!d) continue;
    const k = dayKey(d.toISOString());
    if (!sumsByDay.has(k)) sumsByDay.set(k, []);
    sumsByDay.get(k).push(s);
  }

  if (!byDay.size) {
    $('#days').innerHTML = '<div class="empty">还没有记录。等采集跑一会儿，或检查守护是否在运行（npm run daemon）。</div>';
    return;
  }

  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  let total = 0;
  let html = '';
  for (const k of days) {
    const events = byDay.get(k);
    const sums = sumsByDay.get(k) ?? [];
    const shown = events.slice(0, Math.max(0, state.rowCap - total));
    total += shown.length;
    html += `<section class="day"><h2 class="day-h">${escapeHtml(k)} <span class="day-sub">${escapeHtml(dayLabel(k))} · ${events.length} 条事件${sums.length ? ` · ${sums.length} 份摘要` : ''}</span></h2>`;
    for (const s of sums) {
      html += `<article class="sumcard type-${escapeHtml(s.type ?? '?')}"><div class="sum-title">📝 ${escapeHtml(s.title || s.filename)}<span class="badge">${escapeHtml(s.type === '6h' ? '6 小时' : '10 分钟')}</span></div><pre class="sum-body">${escapeHtml(summaryBodyForDisplay(s.body))}</pre></article>`;
    }
    html += '<ol class="tl">';
    for (const e of shown) html += eventRow(e, appNameByBundle, false);
    html += '</ol>';
    if (shown.length < events.length) {
      html += `<div class="more-row"><button class="btn small" data-more="1">还有 ${events.length - shown.length} 条更早事件，载入更多</button></div>`;
    }
    html += '</section>';
    if (total >= state.rowCap) {
      html += '<div class="more-row"><button class="btn small" data-more="1">已达渲染上限，载入更多事件</button></div>';
      break;
    }
  }
  $('#days').innerHTML = html;
  $('#days').querySelectorAll('[data-more]').forEach((btn) => {
    btn.addEventListener('click', () => { state.rowCap += ROW_CAP_STEP; loadTimeline().catch(() => {}); });
  });
}

// ---------- 搜索 ----------

async function runSearch() {
  const q = $('#search-input').value.trim();
  if (!q) return;
  let res;
  try { res = await api(`/api/search?q=${encodeURIComponent(q)}&limit=200`); } catch (err) {
    $('#search-summary').textContent = `搜索失败：${err.message}`;
    $('#view-search').classList.remove('hidden');
    $('#view-timeline').classList.add('hidden');
    return;
  }
  state.searching = true;
  $('#view-search').classList.remove('hidden');
  $('#view-timeline').classList.add('hidden');
  $('#search-summary').textContent = `「${q}」命中 ${res.count} 条${res.capped ? '（达上限，可能还有更多）' : ''}`;
  const appNameByBundle = new Map();
  $('#search-results').innerHTML = (res.events ?? []).map((e) => eventRow(e, appNameByBundle, true)).join('')
    || '<li><span class="what">没有匹配的事件</span></li>';
}

function backToTimeline() {
  state.searching = false;
  $('#view-search').classList.add('hidden');
  $('#view-timeline').classList.remove('hidden');
}

// ---------- 暂停 / 恢复 ----------

async function togglePause() {
  const btn = $('#btn-pause');
  btn.disabled = true;
  try {
    if (state.paused) await api('/api/resume', { method: 'POST' });
    else await api('/api/pause', { method: 'POST' });
    await refreshStatus();
  } catch (err) {
    $('#status-line').textContent = `操作失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 设置弹窗 ----------

function rulesToText(list) {
  return (list ?? []).map((r) => `${r.scope}:${r.value}`).join('\n');
}

function textToRules(text, errors) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i <= 0) { errors.push(`无法解析的规则行「${t}」（须为 scope:value）`); continue; }
    const scope = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim();
    if (scope !== 'app' && scope !== 'url') errors.push(`未知 scope「${scope}」（须为 app 或 url）`);
    else if (!value) errors.push(`规则值为空：「${t}」`);
    else out.push({ scope, value });
  }
  return out;
}

function setMsg(msg, cls) {
  const el = $('#settings-msg');
  el.textContent = msg;
  el.className = `msg ${cls ?? ''}`;
}

function openSettings() {
  api('/api/config').then(({ config }) => {
    $('#cfg-enabled').checked = config.enabled !== false;
    $('#cfg-urls').checked = config.includeURLs !== false;
    $('#cfg-focus').checked = config.includeFocusedElement !== false;
    $('#cfg-block').value = rulesToText(config.blocklist);
    $('#cfg-allow').value = rulesToText(config.allowlist);
    setMsg('');
    $('#modal-settings').classList.remove('hidden');
  }).catch((err) => setMsg(`读取配置失败：${err.message}`, 'err'));
}

async function saveSettings() {
  const errors = [];
  const blocklist = textToRules($('#cfg-block').value, errors);
  const allowlist = textToRules($('#cfg-allow').value, errors);
  if (errors.length) return setMsg(errors[0], 'err');
  const body = {
    enabled: $('#cfg-enabled').checked,
    includeURLs: $('#cfg-urls').checked,
    includeFocusedElement: $('#cfg-focus').checked,
    blocklist,
    allowlist,
  };
  setMsg('保存中…');
  try {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    setMsg(r.applied === true ? '已保存，规则已生效（观察已重启）' : '已保存（采集未在跑或守护不可达，下次启动生效）', 'ok');
  } catch (err) {
    setMsg(`保存失败：${err.message}`, 'err');
  }
}

async function clearHistory() {
  if (!window.confirm('确定清除全部历史？所有段落与摘要都会被删除，不可恢复。')) return;
  if (!window.confirm('再确认一次：真的要删掉全部活动记录？')) return;
  setMsg('清除中…');
  try {
    const r = await api('/api/history', { method: 'DELETE' });
    setMsg(`已清除：${r.removedSegments} 个段落、${r.removedSummaries} 份摘要`, 'ok');
    state.rowCap = ROW_CAP_STEP;
    await loadTimeline();
  } catch (err) {
    setMsg(`清除失败：${err.message}`, 'err');
  }
}

// ---------- 启动 ----------

function bind() {
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', () => $('#modal-settings').classList.add('hidden'));
  $('#btn-save').addEventListener('click', saveSettings);
  $('#btn-clear').addEventListener('click', clearHistory);
  $('#btn-search').addEventListener('click', runSearch);
  $('#btn-back').addEventListener('click', backToTimeline);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
}

async function poll() {
  await refreshStatus().catch(() => {});
  if (state.searching) return;
  try {
    const { segments } = await api('/api/segments');
    const sig = (segments ?? []).map((s) => `${s.segment}:${s.eventCount}:${s.open ? 1 : 0}`).join('|');
    if (sig !== state.timelineSignature) await loadTimeline();
  } catch { /* 守护未起：状态栏已提示 */ }
}

bind();
refreshStatus().catch(() => {});
loadTimeline().catch((err) => {
  $('#days').innerHTML = `<div class="empty">时间线加载失败：${escapeHtml(err.message)}</div>`;
});
setInterval(poll, POLL_MS);
