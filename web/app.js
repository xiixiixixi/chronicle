/* Chronicle Web UI
 * 三个页面，各讲一件事：时间线（这一天发生了什么）、记忆（它记住了你什么）、设置（它被允许做什么）。
 * 单文件、无依赖、无构建。纯函数挂在 globalThis.ChronicleUI 上供测试；只有在页面里才启动界面。
 */
(function () {
  'use strict';

  /* ================= 1. 纯函数：时间、文字、Markdown、数据整形 ================= */

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const SIX_HOURS = 6 * HOUR;
  const TEN_MIN = 10 * MIN;
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
  const SEGMENT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z$/;

  const pad2 = (n) => String(n).padStart(2, '0');

  function dateKey(input) {
    const d = input instanceof Date ? input : new Date(input);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseDateKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
  }

  function shiftDateKey(key, delta) {
    const d = parseDateKey(key);
    return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta));
  }

  function dayBounds(key) {
    const d = parseDateKey(key);
    return { start: d.getTime(), end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
  }

  function hm(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function hms(ms) {
    return `${hm(ms)}:${pad2(new Date(ms).getSeconds())}`;
  }

  /** 落在午夜的终点显示成 24:00，而不是 00:00 */
  function endLabel(ms) {
    const d = new Date(ms);
    return d.getHours() === 0 && d.getMinutes() === 0 ? '24:00' : hm(ms);
  }

  function fmtDur(ms) {
    const total = Math.round(Math.max(0, Number(ms) || 0) / MIN);
    if (total < 1) return '不到 1 分钟';
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    if (!hours) return `${mins} 分钟`;
    return mins ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  }

  const fmtCount = (n) => Number(n || 0).toLocaleString('zh-CN');

  function yearPrefix(d, today) {
    return d.getFullYear() !== parseDateKey(today).getFullYear() ? `${d.getFullYear()}年` : '';
  }

  function dayTitle(key, today) {
    if (key === today) return '今天';
    if (key === shiftDateKey(today, -1)) return '昨天';
    const d = parseDateKey(key);
    return `${yearPrefix(d, today)}${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function dayLabel(key, today) {
    const d = parseDateKey(key);
    return `${yearPrefix(d, today)}${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`;
  }

  /** 「14:42」「昨天 14:42」「11月11日 14:42」 */
  function whenLabel(ms, today) {
    const key = dateKey(ms);
    return key === today ? hm(ms) : `${dayTitle(key, today)} ${hm(ms)}`;
  }

  function relTime(ms, now) {
    const diff = now - ms;
    if (diff < MIN) return '刚刚';
    if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
    return whenLabel(ms, dateKey(now));
  }

  function partOfDay(ms) {
    const hour = new Date(ms).getHours();
    if (hour < 5) return '凌晨';
    if (hour < 8) return '早上';
    if (hour < 11) return '上午';
    if (hour < 13) return '中午';
    if (hour < 18) return '下午';
    return '晚上';
  }

  /** 摘要标题自带「10:33-10:43 」前缀；界面另有时间列，去掉它 */
  function stripTimePrefix(title) {
    return String(title ?? '').replace(/^\s*\d{1,2}:\d{2}\s*[-–—~～至]\s*\d{1,2}:\d{2}\s*/, '').trim();
  }

  /** 段名 2026-11-13T02-33-09.921Z 或 ISO 时间 → 毫秒 */
  function segmentStartMs(name) {
    const m = SEGMENT_RE.exec(String(name ?? ''));
    if (m) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    const t = Date.parse(String(name ?? ''));
    return Number.isFinite(t) ? t : null;
  }

  function clip(text, max) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function normTitle(text) {
    return String(text ?? '').toLowerCase().replace(/[\s，。,.；;：:！!？?、"'“”‘’「」（）()《》]/g, '');
  }

  // ---------- Markdown：只认摘要/记忆里会出现的子集；先转义再加标记 ----------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  function stripFrontmatter(text) {
    const s = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!s.startsWith('---\n')) return s;
    const end = s.indexOf('\n---', 3);
    if (end < 0) return s;
    const next = s.indexOf('\n', end + 4);
    return next < 0 ? '' : s.slice(next + 1);
  }

  function inlineMd(text) {
    const codes = [];
    const marked = String(text ?? '')
      .replace(/\u0000/g, '')
      .replace(/`([^`\n]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
    return esc(marked)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }

  const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

  function mdToHtml(src) {
    const lines = stripFrontmatter(src).split('\n');
    const out = [];
    const lists = [];
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inlineMd(para.join(' '))}</p>`);
      para = [];
    };
    const closeLists = () => {
      while (lists.length) out.push(`</li></${lists.pop().type}>`);
    };
    const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        closeLists();
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        i += 1;
        continue;
      }
      if (!line.trim()) {
        flush();
        i += 1;
        const next = lines[i] ?? '';
        if (lists.length && !LIST_ITEM_RE.test(next) && !/^\s{2,}\S/.test(next)) closeLists();
        continue;
      }
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        flush();
        closeLists();
        const level = Math.min(4, Math.max(2, heading[1].length));
        out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        closeLists();
        out.push('<hr>');
        i += 1;
        continue;
      }
      const item = LIST_ITEM_RE.exec(line);
      if (item) {
        flush();
        const indent = item[1].replace(/\t/g, '    ').length;
        const type = /\d/.test(item[2]) ? 'ol' : 'ul';
        while (lists.length && indent < lists[lists.length - 1].indent) out.push(`</li></${lists.pop().type}>`);
        const top = lists[lists.length - 1];
        if (!top || indent > top.indent) {
          out.push(`<${type}><li>`);
          lists.push({ type, indent });
        } else if (top.type !== type) {
          out.push(`</li></${lists.pop().type}><${type}><li>`);
          lists.push({ type, indent });
        } else {
          out.push('</li><li>');
        }
        out.push(inlineMd(item[3]));
        i += 1;
        continue;
      }
      if (lists.length && /^\s+\S/.test(line)) {
        out.push(` ${inlineMd(line.trim())}`);
        i += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        closeLists();
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${inlineMd(quote.join(' '))}</blockquote>`);
        continue;
      }
      if (TABLE_ROW_RE.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
        flush();
        closeLists();
        const rows = [];
        while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
          rows.push(lines[i]);
          i += 1;
        }
        const [head, , ...body] = rows;
        const th = cells(head).map((c) => `<th>${inlineMd(c)}</th>`).join('');
        const tb = body.map((r) => `<tr>${cells(r).map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
        continue;
      }
      closeLists();
      para.push(line.trim());
      i += 1;
    }
    flush();
    closeLists();
    return out.join('');
  }

  /** 按二级标题切段：[{title, body}]；标题前的内容 title 为空 */
  function splitSections(text) {
    const sections = [];
    let current = { title: '', lines: [] };
    let fenced = false;
    const push = () => {
      const body = current.lines.join('\n').trim();
      if (current.title || body) sections.push({ title: current.title, body });
    };
    for (const line of stripFrontmatter(text).split('\n')) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const m = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) {
        push();
        current = { title: m[1].trim(), lines: [] };
      } else {
        current.lines.push(line);
      }
    }
    push();
    return sections;
  }

  /** 摘要正文的段落归类：决定它在侧页里放哪儿、叫什么 */
  function sectionKind(title) {
    const t = String(title ?? '').trim();
    if (/^(总览|概览|概要|摘要)/.test(t)) return 'lead';
    if (/^(活动记录|活动|经过)/.test(t)) return 'story';
    if (/^(还没做完|未完成|卡点|待办)/.test(t)) return 'open';
    if (/^(相关上下文|重要上下文|上下文|背景)/.test(t)) return 'context';
    if (/^(依据|证据)/.test(t)) return 'evidence';
    if (/^引用/.test(t)) return 'refs';
    return 'other';
  }

  /** 顶层列表项（续行并入上一项） */
  function listItems(text) {
    const items = [];
    for (const line of String(text ?? '').split('\n')) {
      const m = /^[-*+]\s+(.*)$/.exec(line);
      if (m) items.push(m[1].trim());
      else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    }
    return items;
  }

  const STATUS_TONES = [
    [/blocked|卡住|阻塞/i, '卡住了', 'rose'],
    [/partial|in[\s_-]?progress|doing|active|进行中|部分/i, '进行中', 'amber'],
    [/success|done|complete|finished|完成/i, '完成了', 'leaf'],
  ];

  function statusTone(raw) {
    const s = String(raw ?? '').trim();
    for (const [re, text, tone] of STATUS_TONES) if (re.test(s)) return { text, tone };
    return null;
  }

  /** 「**名称（blocked）**：说明」「名称（partial）：说明」或「分组：任务（partial） [标签、标签]」 */
  function parseTaskLine(line) {
    let text = String(line ?? '').trim();
    let tags = [];
    const tagMatch = /\s*\[([^\]]+)\]\s*$/.exec(text);
    if (tagMatch) {
      tags = tagMatch[1].split(/[、,，]/).map((t) => t.trim()).filter(Boolean);
      text = text.slice(0, tagMatch.index).trim();
    }
    let title = text;
    let desc = '';
    let group = '';
    const bold = /^\*\*(.+?)\*\*\s*[：:]?\s*(.*)$/.exec(text);
    if (bold) {
      title = bold[1].trim();
      desc = bold[2].trim();
    } else {
      const sep = /：|:\s/.exec(text);
      if (sep && sep.index > 0 && sep.index < 40) {
        const head = text.slice(0, sep.index).trim();
        const rest = text.slice(sep.index + sep[0].length).trim();
        const st = /[（(]\s*([^（()）]{1,24})\s*[)）]$/.exec(head);
        if (st && statusTone(st[1])) {
          title = head;
          desc = rest;
        } else {
          group = head;
          title = rest;
        }
      }
    }
    let status = null;
    const st = /[（(]\s*([^（()）]{1,24})\s*[)）]\s*$/.exec(title);
    if (st && statusTone(st[1])) {
      status = statusTone(st[1]);
      title = title.slice(0, st.index).trim();
    }
    return { title, desc, group, status, tags };
  }

  /** 「最近进展。下一步：做某事」→ desc 只留进展，next 单独拿出来 */
  function splitNextStep(t) {
    const m = /[。；;，,]?\s*下一步[:：]\s*/.exec(t.desc || '');
    if (!m) return { ...t, next: '' };
    return { ...t, desc: t.desc.slice(0, m.index).trim(), next: t.desc.slice(m.index + m[0].length).trim() };
  }

  /** 记忆长期画像里的「在推进的事」（Ongoing Tasks 小节） */
  function ongoingFrom(summaryMarkdown) {
    const out = [];
    for (const sec of splitSections(summaryMarkdown || '')) {
      if (memoryKind(sec.title) === 'ongoing') out.push(...listItems(sec.body).map(parseTaskLine).map(splitNextStep));
    }
    return out;
  }

  /** 接下来 = 每件还没做完的事的下一步；做没做完由 AI 整理记忆时判断，不需要你操作 */
  function nextThings(ongoing) {
    return (ongoing || []).filter((t) => t.next && !(t.status && t.status.tone === 'leaf'));
  }

  /** 长期记忆摘要的二级标题 → 我们的叫法 */
  function memoryKind(title) {
    const t = String(title ?? '').toLowerCase();
    if (/profile|关于|画像/.test(t)) return 'profile';
    if (/ongoing|进行|在做/.test(t)) return 'ongoing';
    if (/preference|偏好|习惯/.test(t)) return 'prefs';
    if (/tip|经验|心得/.test(t)) return 'tips';
    if (/in memory|记忆内容|索引/.test(t)) return 'index';
    return 'other';
  }

  /** 「a；b；a」→ 去重后的短句列表 */
  function splitList(text, max = 6) {
    const seen = new Set();
    const out = [];
    for (const part of String(text ?? '').split(/[；;]\s*/)) {
      const s = part.trim().replace(/[。.]$/, '');
      const key = normTitle(s);
      if (!s || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 长期记忆 MEMORY.md：「# Task Group: 名称」下有 scope 行和若干「## Task N: 标题, 状态」，
   * 每个任务是「- 字段: 值」列表。返回 [{name, scope, tasks:[{title, status, fields}]}]。
   */
  function parseMemoryGroups(text) {
    const groups = [];
    let group = null;
    let task = null;
    for (const line of stripFrontmatter(text).split('\n')) {
      const g = /^#\s+Task Group\s*[:：]\s*(.+?)\s*$/i.exec(line);
      if (g) {
        group = { name: g[1], scope: '', tasks: [] };
        groups.push(group);
        task = null;
        continue;
      }
      if (!group) continue;
      const t = /^##\s+Task\b[^:：]*[:：]\s*(.+?)\s*$/i.exec(line);
      if (t) {
        const comma = Math.max(t[1].lastIndexOf(','), t[1].lastIndexOf('，'));
        const status = comma > 0 ? statusTone(t[1].slice(comma + 1)) : null;
        task = { title: status ? t[1].slice(0, comma).trim() : t[1], status, fields: {} };
        group.tasks.push(task);
        continue;
      }
      const scope = task ? null : /^scope\s*:\s*(.+)$/i.exec(line);
      if (scope) {
        group.scope = scope[1].trim();
        continue;
      }
      const field = task && /^\s*[-*]\s+([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (field) task.fields[field[1].toLowerCase()] = field[2].trim();
    }
    return groups;
  }

  /** 摘要文件名 → 起点毫秒：10min-<段名>.md / 6h-YYYY-MM-DDTHH.md */
  function summaryFileStartMs(name) {
    const s = String(name ?? '');
    const ten = /^10min-(.+)\.md$/.exec(s);
    if (ten) return segmentStartMs(ten[1]);
    const six = /^6h-(\d{4})-(\d{2})-(\d{2})T(\d{2})\.md$/.exec(s);
    if (six) return Date.UTC(Number(six[1]), Number(six[2]) - 1, Number(six[3]), Number(six[4]));
    return null;
  }

  /**
   * 一句话讲清这一天：亲手操作多久、主要在哪些应用；
   * 屏幕在变但没人动手（后台任务、AI 助手）的时间单独说，不混进「你做了什么」。
   */
  function describeDay({ activity, topApps, isToday }) {
    const a = activity || {};
    const active = Math.max(0, Number(a.activeMs) || 0);
    const seen = (a.buckets || []).reduce((sum, b) => sum + (Number(b && b.seenMs) || 0), 0);
    const passive = Math.max(0, seen - active);
    let apps = (a.apps || []).filter((x) => x && x.bundleId && x.activeMs > 0 && x.activeMs >= active * 0.1).slice(0, 3);
    if (!apps.length) apps = (topApps || []).filter((x) => x && x.bundleId).slice(0, 3);
    const tokens = [];
    if (active > 0) {
      const first = a.firstActiveMs;
      const last = a.lastActiveMs;
      if (isToday) tokens.push(first ? `今天从 ${hm(first)} 开始，你亲手操作了 ` : '今天你亲手操作了 ');
      else tokens.push(first && last ? `这一天从 ${hm(first)} 到 ${hm(last)}，你亲手操作了 ` : '这一天你亲手操作了 ');
      tokens.push({ strong: fmtDur(active) });
      if (apps.length) {
        tokens.push('，大部分时间在 ');
        apps.forEach((app, i) => {
          if (i) tokens.push(i === apps.length - 1 ? ' 和 ' : '、');
          tokens.push({ app: app.bundleId, name: app.appName });
        });
      }
      tokens.push('。');
    } else if (seen > 0) {
      tokens.push(isToday ? '今天你还没有亲手操作，不过屏幕记下了 ' : '这一天你没有亲手操作，不过屏幕记下了 ');
      tokens.push({ strong: fmtDur(seen) });
      tokens.push(' 的变化。');
    }
    const aside = [];
    if (active > 0 && passive >= 30 * MIN && passive >= seen * 0.25) {
      aside.push('另外有 ', { strong: fmtDur(passive) }, '，屏幕在变但你没有动手，通常是后台任务或 AI 助手在跑。');
    }
    return { tokens, aside, activeMs: active, seenMs: seen, passiveMs: passive };
  }

  /** AI 整理的排队情况（/api/analysis/status），一句人话：只有 10 分钟摘要按「段」数 */
  function backlogText(a) {
    const segs = Number(a && a.pending && a.pending.summaries10) || 0;
    const rest = Math.max(0, (Number(a && a.total) || 0) - segs);
    if (segs) return `还有 ${fmtCount(segs)} 段记录等 AI 整理。`;
    if (rest) return '记录都整理好了，AI 正在更新回顾和记忆。';
    return 'AI 已经整理完全部记录。';
  }

  /** 时间段内的主要应用（按亲手操作加权） */
  function appsInRange(buckets, start, end, bucketMs) {
    const weight = new Map();
    for (const b of buckets || []) {
      if (!b || !b.bundleId) continue;
      if (b.startMs + bucketMs <= start || b.startMs >= end) continue;
      weight.set(b.bundleId, (weight.get(b.bundleId) || 0) + (b.activeMs || 0) * 2 + (b.seenMs || 0));
    }
    return [...weight.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id).slice(0, 4);
  }

  /**
   * 把一天拆成章节：章节 = 6 小时回顾的时间窗（UTC 对齐，与摘要器一致），
   * 章节里是时刻：有 10 分钟摘要的段、还没整理的连续段（合成一条）、正在记录的段。
   * 返回按时间正序；界面自己决定倒着排。
   */
  function buildChapters({ dayStart, dayEnd, nowMs, segments, summaries, buckets, bucketMs }) {
    const step = bucketMs || 5 * MIN;
    const tens = (summaries || []).filter((x) => x && x.type === '10min');
    const sixes = (summaries || []).filter((x) => x && x.type === '6h' && Number.isFinite(x.startMs));
    const bySegment = new Map(tens.filter((x) => x.segment).map((x) => [x.segment, x]));
    const used = new Set();
    const items = [];
    for (const seg of segments || []) {
      if (!seg || !Number.isFinite(seg.startMs)) continue;
      const end = Number.isFinite(seg.endMs) ? seg.endMs : Math.max(seg.startMs, Math.min(nowMs, dayEnd));
      const summary = bySegment.get(seg.segment);
      if (summary) {
        used.add(summary.filename);
        items.push({ kind: 'summary', startMs: seg.startMs, endMs: end, summary, segments: [seg.segment], eventCount: seg.eventCount || 0 });
      } else {
        const live = seg.open === true || !Number.isFinite(seg.endMs);
        items.push({ kind: live ? 'live' : 'raw', startMs: seg.startMs, endMs: end, segments: [seg.segment], eventCount: seg.eventCount || 0 });
      }
    }
    for (const summary of tens) {
      if (used.has(summary.filename) || !Number.isFinite(summary.startMs)) continue;
      const end = summary.startMs + (summary.spanMs || TEN_MIN);
      if (summary.startMs >= dayEnd || end <= dayStart) continue;
      items.push({ kind: 'summary', startMs: summary.startMs, endMs: end, summary, segments: summary.segment ? [summary.segment] : [], eventCount: 0 });
    }
    items.sort((x, y) => x.startMs - y.startMs);

    const windowOf = (t) => Math.floor(t / SIX_HOURS) * SIX_HOURS;
    const windows = new Map();
    for (let ws = windowOf(dayStart); ws < dayEnd; ws += SIX_HOURS) windows.set(ws, { startMs: ws, summary: null, items: [] });
    for (const summary of sixes) {
      const w = windows.get(windowOf(summary.startMs));
      if (w && !w.summary) w.summary = summary;
    }
    for (const item of items) {
      const w = windows.get(windowOf(Math.max(item.startMs, dayStart)));
      if (!w) continue;
      const prev = w.items[w.items.length - 1];
      if (item.kind === 'raw' && prev && prev.kind === 'raw' && item.startMs - prev.endMs < 2 * MIN) {
        prev.endMs = Math.max(prev.endMs, item.endMs);
        prev.segments.push(...item.segments);
        prev.eventCount += item.eventCount;
      } else {
        w.items.push({ ...item, segments: [...item.segments] });
      }
    }
    const chapters = [];
    for (const w of windows.values()) {
      if (!w.items.length && !w.summary) continue;
      for (const item of w.items) {
        const listed = item.kind === 'summary' && Array.isArray(item.summary.applications) ? item.summary.applications.filter(Boolean) : [];
        item.apps = listed.length ? listed.slice(0, 6) : appsInRange(buckets, item.startMs, item.endMs, step);
      }
      chapters.push({ startMs: Math.max(w.startMs, dayStart), endMs: Math.min(w.startMs + SIX_HOURS, dayEnd), summary: w.summary, items: w.items });
    }
    return chapters;
  }

  const itemKey = (item) => (item.kind === 'summary' ? `s:${item.summary.filename}` : `r:${item.segments.join(',')}`);

  function itemAt(items, t) {
    let found = null;
    for (const item of items || []) if (item.startMs <= t && t < item.endMs) found = item;
    return found;
  }

  // ---------- 原始事件 → 人话 ----------

  const MOD_SYMBOLS = { command: '⌘', cmd: '⌘', control: '⌃', ctrl: '⌃', option: '⌥', alt: '⌥', shift: '⇧', fn: 'fn ' };
  const KEY_NAMES = { return: '↩', enter: '↩', delete: '⌫', backspace: '⌫', forwarddelete: '⌦', escape: 'esc', tab: '⇥', space: '空格', left: '←', right: '→', up: '↑', down: '↓' };

  function keyCombo(d) {
    const mods = (Array.isArray(d && d.modifiers) ? d.modifiers : []).map((m) => MOD_SYMBOLS[String(m).toLowerCase()] || '').join('');
    const raw = String((d && d.keyEquivalent) || '');
    const key = KEY_NAMES[raw.toLowerCase()] || (raw.length === 1 ? raw.toUpperCase() : raw);
    return `${mods}${key}`;
  }

  function targetName(t) {
    if (!t || typeof t !== 'object') return '';
    return String(t.title || t.value || t.description || '').trim();
  }

  /** 返回 {text, quote?, pre?, minor?}；null = 噪音，不显示 */
  function describeEvent(e) {
    const d = (e && e.data) || {};
    switch (e && e.type) {
      case 'window-change':
        return d.windowTitle ? { text: '窗口', quote: clip(d.windowTitle, 120) } : null;
      case 'click':
      case 'context-menu': {
        const verb = `${e.type === 'click' ? '点击' : '右键点击'}${d.target && d.target.role ? d.target.role : ''}`;
        const name = targetName(d.target);
        return name ? { text: verb, quote: clip(name, 80) } : { text: verb };
      }
      case 'text-input':
        return d.text ? { text: '输入', quote: clip(d.text, 200) } : { text: `输入了 ${d.charCount || 0} 个字` };
      case 'submit':
        return { text: '提交' };
      case 'shortcut':
        return d.keyEquivalent ? { text: `按下 ${keyCombo(d)}` } : null;
      case 'selection': {
        const picked = d.selectedText || d.text;
        if (picked) return { text: '选中', quote: clip(picked, 160) };
        const names = (Array.isArray(d.selectedItems) ? d.selectedItems : []).map(targetName).filter(Boolean);
        return names.length ? { text: '选中', quote: clip(names.join('、'), 120) } : null;
      }
      case 'drag': {
        const name = targetName(d.origin);
        return name ? { text: '拖动', quote: clip(name, 80) } : { text: '拖动' };
      }
      case 'url-change':
        return /^https?:/i.test(d.url || '') ? { text: '打开网页', quote: clip(d.url, 160) } : null;
      case 'visual-text':
        return { text: `读取了窗口里的文字（${d.lineCount || 0} 行）`, pre: String(d.text || '').slice(0, 4000) };
      case 'scroll':
        return { text: '滚动浏览', minor: true };
      default:
        return null;
    }
  }

  /** 事件里可被搜索/摘录的文字 */
  function eventText(e) {
    const d = (e && e.data) || {};
    const parts = [d.text, d.selectedText, d.value, d.url, d.windowTitle, d.title, targetName(d.target)];
    if (Array.isArray(d.windows)) parts.push(d.windows.map((w) => w && w.title).filter(Boolean).join(' · '));
    if (Array.isArray(d.selectedItems)) parts.push(d.selectedItems.map(targetName).filter(Boolean).join('、'));
    return parts.filter((p) => typeof p === 'string' && p.trim()).join(' · ');
  }

  /** 关键词附近的一小段原文 */
  function snippet(text, q, radius = 48) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    const at = q ? s.toLowerCase().indexOf(String(q).toLowerCase()) : -1;
    if (at < 0) return clip(s, radius * 2);
    const start = Math.max(0, at - radius);
    const end = Math.min(s.length, at + String(q).length + radius);
    return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`;
  }

  // ---------- 地址：只有三个页面；旧地址（菜单栏、文档里的链接）照样能用 ----------

  const VIEW_ALIASES = {
    '': ['day', ''], day: ['day', ''], today: ['day', ''], timeline: ['day', ''], history: ['day', ''], work: ['day', ''],
    memory: ['memory', ''], insights: ['memory', ''], skills: ['memory', ''],
    settings: ['settings', ''], recording: ['settings', 'recording'], permissions: ['settings', 'recording'],
    privacy: ['settings', 'privacy'], config: ['settings', 'privacy'],
    model: ['settings', 'model'], ai: ['settings', 'ai'], integrations: ['settings', 'ai'], data: ['settings', 'data'],
  };
  const SETTINGS_SECTIONS = ['recording', 'privacy', 'model', 'ai', 'data'];

  function parseRoute(loc) {
    const params = new URLSearchParams(loc.search || '');
    const hash = String(loc.hash || '').replace(/^#\/?/, '').toLowerCase();
    let view = String(params.get('view') || '').toLowerCase();
    if (!view && hash && Object.prototype.hasOwnProperty.call(VIEW_ALIASES, hash)) view = hash;
    const [name, alias] = Object.prototype.hasOwnProperty.call(VIEW_ALIASES, view) ? VIEW_ALIASES[view] : ['day', ''];
    const section = name === 'settings' && SETTINGS_SECTIONS.includes(hash) ? hash : alias;
    const date = name === 'day' && parseDateKey(params.get('date')) ? params.get('date') : '';
    const at = Number(params.get('at'));
    return { view: name, section, date, open: String(params.get('open') || ''), at: Number.isFinite(at) && at > 0 ? at : null };
  }

  function routeUrl(route, today) {
    const params = new URLSearchParams();
    if (route.view === 'memory' || route.view === 'settings') params.set('view', route.view);
    if (route.view === 'day' && route.date && route.date !== today) params.set('date', route.date);
    if (route.open) params.set('open', route.open);
    if (route.at) params.set('at', String(route.at));
    const qs = params.toString();
    return `/${qs ? `?${qs}` : ''}${route.view === 'settings' && route.section ? `#${route.section}` : ''}`;
  }

  /** 关键词高亮：先转义再包 <mark> */
  function highlight(text, q) {
    const s = String(text ?? '');
    const needle = String(q ?? '').trim().toLowerCase();
    if (!needle) return esc(s);
    const lower = s.toLowerCase();
    if (lower.length !== s.length) return esc(s);
    let out = '';
    let from = 0;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
      out += `${esc(s.slice(from, at))}<mark>${esc(s.slice(at, at + needle.length))}</mark>`;
      from = at + needle.length;
    }
    return out + esc(s.slice(from));
  }

  /**
   * 原始记录的搜索结果：只留能看见匹配的那些。搜索接口会因为前台应用名命中整条事件
   * （比如一分钟一条的「屏幕上的窗口」），这类只在 app-switch 上算数。
   * 同一应用、同一种动作、同一段匹配文字只留最新的一条。events 按新到旧排列。
   */
  function eventHits(events, q, max = 30) {
    const terms = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const has = (s) => terms.length > 0 && terms.every((w) => s.includes(w));
    const seen = new Set();
    const hits = [];
    for (const e of events || []) {
      if (hits.length >= max) break;
      const d = (e && e.data) || {};
      const text = eventText(e) || (e && e.type === 'app-switch' ? String(d.appName || d.bundleId || '') : '');
      const t = Number.isFinite(e && e.tsMs) ? e.tsMs : Date.parse(e && e.ts);
      if (!text || !Number.isFinite(t)) continue;
      const appHit = e.type === 'app-switch' && has(`${d.appName || ''} ${d.bundleId || ''}`.toLowerCase());
      if (!appHit && !has(text.toLowerCase())) continue;
      const key = `${e.type}|${d.bundleId || d.appName || ''}|${snippet(text, terms[0], 24)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ kind: 'event', e, t, text });
    }
    return hits;
  }

  // ---------- 波形：一天按 5 分钟铺开；窄屏把 k 个桶并成一列 ----------

  function ribbonColumns(activity, dayStart, dayEnd) {
    const step = (activity && activity.bucketMs) || 5 * MIN;
    const cols = Math.max(1, Math.round((dayEnd - dayStart) / step));
    const arr = new Array(cols).fill(null);
    for (const b of (activity && activity.buckets) || []) {
      const i = Math.floor((b.startMs - dayStart) / step);
      if (i >= 0 && i < cols) arr[i] = b;
    }
    return { step, cols, arr };
  }

  /** 高柱 = 亲手操作（越满越高），矮柱 = 开着但没动手；颜色归这一列的主角应用 */
  function ribbonBars(columns, k = 1) {
    const { step, cols, arr } = columns;
    const span = step * k;
    const bars = [];
    for (let j = 0; j * k < cols; j++) {
      let active = 0;
      let seen = 0;
      const weight = new Map();
      for (let i = j * k; i < Math.min(cols, j * k + k); i++) {
        const b = arr[i];
        if (!b) continue;
        active += b.activeMs || 0;
        seen += b.seenMs || 0;
        const id = b.bundleId || '';
        weight.set(id, (weight.get(id) || 0) + (b.activeMs || 0) * 4 + (b.seenMs || 0));
      }
      if (active <= 0 && seen <= 0) continue;
      let app = '';
      let best = -1;
      for (const [id, w] of weight) {
        if (w > best) {
          best = w;
          app = id;
        }
      }
      const a = Math.min(1, active / span);
      const height = a > 0 ? 12 + 50 * Math.pow(a, 0.6) : 4 + 8 * Math.min(1, seen / span);
      bars.push({ x: j, app, height, faint: a <= 0 });
    }
    return { count: Math.ceil(cols / k), bars };
  }

  /** 波形上方的图标：连续亲手操作最久的几段，互相不挤 */
  function pickPins(columns, { minGap = 12, max = 7, minActiveMs = 15 * MIN } = {}) {
    const runs = [];
    let cur = null;
    columns.arr.forEach((b, i) => {
      if (!b || !(b.activeMs > 0) || !b.bundleId) return;
      if (cur && cur.app === b.bundleId && i - cur.last <= 3) {
        cur.last = i;
        cur.active += b.activeMs;
      } else {
        cur = { app: b.bundleId, first: i, last: i, active: b.activeMs };
        runs.push(cur);
      }
    });
    const picked = [];
    for (const run of runs.filter((r) => r.active >= minActiveMs).sort((x, y) => y.active - x.active)) {
      const at = (run.first + run.last + 1) / 2;
      if (picked.some((p) => Math.abs(p.at - at) < minGap)) continue;
      picked.push({ app: run.app, at, active: run.active });
      if (picked.length >= max) break;
    }
    return picked.sort((x, y) => x.at - y.at);
  }

  /** 图标像素 → 最鲜明的那种颜色（按色相分桶、饱和度加权）；几乎没有彩色时返回 null */
  function vividColor(px) {
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let opaque = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 200) continue;
      opaque += 1;
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      const l = (max + min) / 2;
      if (d < 0.12 || l < 0.12 || l > 0.92) continue;
      const sector = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const bin = bins[Math.floor(sector * 2) % 12];
      const w = d * (d / (1 - Math.abs(2 * l - 1)));
      bin.w += w;
      bin.r += r * w;
      bin.g += g * w;
      bin.b += b * w;
    }
    const top = bins.reduce((x, y) => (y.w > x.w ? y : x));
    if (!opaque || top.w < opaque * 0.04) return null;
    const r = top.r / top.w;
    const g = top.g / top.w;
    const b = top.b / top.w;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min || 1e-6;
    const l = (max + min) / 2;
    const s = d / (1 - Math.abs(2 * l - 1) || 1e-6);
    const sector = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return `hsl(${Math.round(sector * 60)} ${Math.round(clamp(s, 0.42, 0.85) * 100)}% ${Math.round(clamp(l, 0.46, 0.6) * 100)}%)`;
  }

  /* ================= 2. 测试出口；不在浏览器里就到此为止 ================= */

  globalThis.ChronicleUI = {
    dateKey, parseDateKey, shiftDateKey, dayBounds, hm, hms, endLabel, fmtDur, fmtCount,
    dayTitle, dayLabel, whenLabel, relTime, partOfDay, stripTimePrefix, segmentStartMs, clip, normTitle,
    esc, stripFrontmatter, inlineMd, mdToHtml, splitSections, sectionKind, listItems, statusTone, parseTaskLine,
    memoryKind, splitList, parseMemoryGroups, splitNextStep, ongoingFrom, nextThings, summaryFileStartMs, describeDay, backlogText, appsInRange, buildChapters, itemKey, itemAt,
    keyCombo, describeEvent, eventText,
    snippet, highlight, eventHits, ribbonColumns, ribbonBars, pickPins, vividColor, parseRoute, routeUrl,
  };
  if (typeof document === 'undefined' || !document.getElementById('main')) return;

  /* ================= 3. 基础设施：请求、图标、提示、浮层 ================= */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = $('#main');
  const bar = $('#bar');
  const layerRoot = $('#layer');
  const toastZone = $('#toast');
  const statusBtn = $('#status');

  const SVG = {
    left: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>',
    right: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg>',
    up: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 12.5 10 7l5.5 5.5"/></svg>',
    down: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 7.5 10 13l5.5-5.5"/></svg>',
    close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg>',
    check: '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 7.4 2.6 2.6L11 4.4"/></svg>',
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.6"/><path d="m12.8 12.8 4.2 4.2"/></svg>',
    lines: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>',
    globe: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c2.2 2.4 2.2 9.2 0 11.6M8 2.2c-2.2 2.4-2.2 9.2 0 11.6"/></svg>',
    app: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/></svg>',
  };

  class ApiError extends Error {
    constructor(message, { status = 0, code = '', body = null } = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError('连不上 Chronicle，它可能没有在运行。', { code: 'OFFLINE' });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const listed = data && Array.isArray(data.errors) ? data.errors.join('；') : '';
      const message = (data && (data.error || listed)) || `请求没有成功（${res.status}）`;
      throw new ApiError(message, { status: res.status, code: (data && data.code) || '', body: data });
    }
    return data || {};
  }

  // ---------- 应用图标与名字 ----------

  const appNames = new Map();
  const iconMissing = new Set();
  const iconColors = new Map();
  const iconColorJobs = new Map();

  function rememberApp(id, name) {
    if (id && name && name !== id) appNames.set(id, String(name));
  }

  function nameOf(id) {
    const s = String(id ?? '');
    if (!s) return '未知应用';
    if (appNames.has(s)) return appNames.get(s);
    if (!s.includes('.')) return s;
    const last = s.split('.').filter(Boolean).pop() || s;
    return last.charAt(0).toUpperCase() + last.slice(1);
  }

  function hueOf(text) {
    let h = 0;
    for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  const tintOf = (id) => `hsl(${hueOf(id)} 36% 50%)`;
  const isBundleId = (s) => s.includes('.') && BUNDLE_RE.test(s);

  function iconSrc(id) {
    const s = String(id ?? '');
    return `/api/app-icon?${isBundleId(s) ? 'bundleId' : 'app'}=${encodeURIComponent(s)}`;
  }

  function monoIcon(id, name, label) {
    const n = name || nameOf(id);
    const letter = (Array.from(n.trim())[0] || '?').toUpperCase();
    const a11y = label ? `role="img" aria-label="${esc(n)}"` : 'aria-hidden="true"';
    return `<span class="appicon mono" style="--tint:${tintOf(id || n)}" ${a11y} title="${esc(n)}">${esc(letter)}</span>`;
  }

  /** 真实应用图标；取不到时（error 监听）换成字母方块 */
  function icon(id, { name = '', label = false } = {}) {
    const s = String(id ?? '');
    const n = name || nameOf(s);
    if (!s || iconMissing.has(s)) return monoIcon(s, n, label);
    const a11y = label ? `alt="${esc(n)}"` : 'alt="" aria-hidden="true"';
    return `<img class="appicon" src="${esc(iconSrc(s))}" ${a11y} title="${esc(n)}" loading="lazy" decoding="async" data-icon="${esc(s)}">`;
  }

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('appicon')) return;
    const id = img.dataset.icon || '';
    iconMissing.add(id);
    const tpl = document.createElement('template');
    tpl.innerHTML = monoIcon(id, nameOf(id), img.getAttribute('aria-hidden') !== 'true');
    img.replaceWith(tpl.content.firstElementChild);
  }, true);

  /** 波形的颜色取自应用图标；灰色图标用中性色，拿不到图标用字母方块的颜色 */
  function iconColor(id) {
    if (iconColors.has(id)) return Promise.resolve(iconColors.get(id));
    if (iconColorJobs.has(id)) return iconColorJobs.get(id);
    const job = new Promise((resolve) => {
      if (!id || iconMissing.has(id)) {
        resolve(id ? tintOf(id) : 'var(--ink-3)');
        return;
      }
      const img = new Image();
      img.onload = () => {
        let color = null;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 24;
          canvas.height = 24;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 24, 24);
          color = vividColor(ctx.getImageData(0, 0, 24, 24).data);
        } catch {
          color = null;
        }
        resolve(color || 'var(--ink-3)');
      };
      img.onerror = () => {
        iconMissing.add(id);
        resolve(tintOf(id));
      };
      img.src = iconSrc(id);
    }).then((color) => {
      iconColors.set(id, color);
      iconColorJobs.delete(id);
      return color;
    });
    iconColorJobs.set(id, job);
    return job;
  }

  function iconStack(ids, max = 4) {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) return '<span class="icons"></span>';
    const shown = list.slice(0, max);
    const more = list.length - shown.length;
    return `<span class="icons" role="img" aria-label="${esc(list.map((id) => nameOf(id)).join('、'))}">${shown.map((id) => icon(id)).join('')}${more > 0 ? `<span class="more">+${more}</span>` : ''}</span>`;
  }

  // ---------- 提示、浮层、确认框、复制 ----------

  function toast(message, { bad = false, action = null, ms = 4200 } = {}) {
    const el = document.createElement('div');
    el.className = bad ? 'toast bad' : 'toast';
    el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
    if (action) {
      el.querySelector('button').addEventListener('click', () => {
        el.remove();
        action.run();
      });
    }
    toastZone.append(el);
    while (toastZone.children.length > 3) toastZone.firstElementChild.remove();
    setTimeout(() => el.remove(), action ? ms + 3000 : ms);
    return el;
  }

  const fail = (err) => toast(err && err.message ? err.message : String(err), { bad: true, ms: 6500 });

  const layers = [];
  const MODAL = new Set(['sheet', 'spot', 'dialog']);
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  function openLayer({ cls, html, label = '', anchor = null, onDismiss = null, onClose = null }) {
    const kind = cls.split(' ')[0];
    const shade = document.createElement('div');
    shade.className = kind === 'pop' ? 'backdrop clear' : 'backdrop';
    const box = document.createElement('div');
    box.className = cls;
    box.setAttribute('role', 'dialog');
    if (MODAL.has(kind)) box.setAttribute('aria-modal', 'true');
    if (label) box.setAttribute('aria-label', label);
    box.tabIndex = -1;
    box.innerHTML = html;
    layerRoot.append(shade, box);
    const layer = { kind, shade, box, restore: document.activeElement, onDismiss, onClose };
    layers.push(layer);
    shade.addEventListener('click', () => dismiss(layer));
    if (anchor) placeNear(box, anchor);
    syncScrollLock();
    requestAnimationFrame(() => (box.querySelector('[autofocus]') || box).focus({ preventScroll: true }));
    return layer;
  }

  /** 用户主动关掉（点背景、Esc）：有自定义收尾就走收尾 */
  function dismiss(layer = layers[layers.length - 1]) {
    if (!layer) return;
    if (layer.onDismiss) layer.onDismiss(layer);
    else closeLayer(layer);
  }

  function closeLayer(layer) {
    const at = layers.indexOf(layer);
    if (at < 0) return;
    const removed = layers.splice(at).reverse();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const l of removed) {
      l.shade.remove();
      if (l.kind === 'sheet' && !reduce) {
        l.box.classList.add('closing');
        setTimeout(() => l.box.remove(), 280);
      } else {
        l.box.remove();
      }
      if (l.onClose) l.onClose(l);
    }
    syncScrollLock();
    const back = removed[removed.length - 1].restore;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function closeAllLayers() {
    if (layers.length) closeLayer(layers[0]);
  }

  function syncScrollLock() {
    document.documentElement.style.overflow = layers.some((l) => MODAL.has(l.kind)) ? 'hidden' : '';
  }

  function placeNear(box, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth;
    const vw = document.documentElement.clientWidth;
    box.style.top = `${Math.round(r.bottom + 8)}px`;
    box.style.left = `${Math.round(Math.min(Math.max(12, r.left + r.width / 2 - w / 2), vw - w - 12))}px`;
  }

  function trapFocus(e, box) {
    const items = $$(FOCUSABLE, box).filter((el) => el.getClientRects().length > 0);
    if (!items.length) {
      e.preventDefault();
      box.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box || !box.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !box.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  function confirmDialog({ title, body, confirm, danger = false, typed = '' }) {
    return new Promise((resolve) => {
      let answered = false;
      const layer = openLayer({
        cls: 'dialog',
        label: title,
        html: `<h3>${esc(title)}</h3><p>${esc(body)}</p>${typed ? `<input class="field" type="text" autocomplete="off" spellcheck="false" placeholder="输入「${esc(typed)}」确认" aria-label="输入「${esc(typed)}」确认" autofocus>` : ''}`
          + `<div class="acts"><button class="btn" type="button" data-answer="no"${typed ? '' : ' autofocus'}>取消</button>`
          + `<button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-answer="yes"${typed ? ' disabled' : ''}>${esc(confirm)}</button></div>`,
        onClose: () => {
          if (!answered) resolve(false);
        },
      });
      const yes = $('[data-answer="yes"]', layer.box);
      const input = $('input', layer.box);
      if (input) {
        input.addEventListener('input', () => {
          yes.disabled = input.value.trim() !== typed;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !yes.disabled) yes.click();
        });
      }
      layer.box.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-answer]');
        if (!btn) return;
        answered = true;
        closeLayer(layer);
        resolve(btn.dataset.answer === 'yes');
      });
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  /** 按钮转圈：执行期间禁用，结束后恢复 */
  async function busy(btn, run) {
    if (btn) {
      btn.classList.add('busy');
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      return await run();
    } finally {
      if (btn) {
        btn.classList.remove('busy');
        btn.removeAttribute('aria-busy');
      }
    }
  }

  /* ================= 4. 状态与路由 ================= */

  const state = {
    today: dateKey(Date.now()),
    route: parseRoute(location),
    renderToken: 0,
    status: null,
    statusError: null,
    perms: null,
    permsAt: 0,
    analysis: null,
    model: null,
    presets: [],
    days: null,
    daysAt: 0,
    day: null,
    openChapters: new Set(),
    sheet: null,
  };

  const modelOn = () => Boolean(state.model && state.model.enabled === true && state.model.provider !== 'none');
  const isCurrent = (token) => token === state.renderToken;

  function go(route, { replace = false } = {}) {
    const url = routeUrl(route, state.today);
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    state.route = parseRoute(location);
    window.scrollTo(0, 0);
    render();
  }

  async function ensureModel(force = false) {
    if (state.model && !force) return state.model;
    try {
      const r = await api('/api/model/config');
      state.model = r.config || null;
      state.presets = Array.isArray(r.presets) ? r.presets : [];
    } catch {
      /* 拿不到模型信息不影响时间线 */
    }
    return state.model;
  }

  async function ensureDays(force = false) {
    if (state.days && !force && Date.now() - state.daysAt < 5 * MIN) return state.days;
    try {
      state.days = (await api('/api/days')).days || [];
      state.daysAt = Date.now();
    } catch {
      state.days = state.days || [];
    }
    return state.days;
  }

  function updateNav() {
    for (const a of $$('[data-nav]', bar)) {
      if (!a.classList.contains('brand') && a.dataset.nav === state.route.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  async function render() {
    const token = ++state.renderToken;
    closeAllLayers();
    updateNav();
    main.setAttribute('aria-busy', 'true');
    const slow = setTimeout(() => {
      if (isCurrent(token)) main.innerHTML = '<div class="page"><p class="loading">正在打开…</p></div>';
    }, 220);
    try {
      if (state.route.view === 'memory') await renderMemory(token);
      else if (state.route.view === 'settings') await renderSettings(token);
      else await renderDay(token);
    } catch (err) {
      if (isCurrent(token)) {
        main.innerHTML = errorHtml(err);
        document.title = 'Chronicle';
      }
    } finally {
      clearTimeout(slow);
      if (isCurrent(token)) main.setAttribute('aria-busy', 'false');
    }
  }

  /** 后台刷新：不清屏、不重播动画，保住滚动位置和焦点 */
  async function softRender() {
    if (layers.some((l) => l.kind !== 'sheet')) return;
    const token = ++state.renderToken;
    const y = window.scrollY;
    const focus = focusKey(document.activeElement);
    try {
      if (state.route.view === 'memory') await renderMemory(token, { quiet: true });
      else if (state.route.view === 'settings') await renderSettings(token, { quiet: true });
      else await renderDay(token, { quiet: true });
    } catch {
      return;
    }
    if (!isCurrent(token)) return;
    window.scrollTo(0, y);
    const again = focus && main.querySelector(focus);
    if (again) again.focus({ preventScroll: true });
  }

  function focusKey(el) {
    if (!el || !main.contains(el) || el === main) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    for (const attr of ['data-open', 'data-task', 'data-setting', 'data-action']) {
      const v = el.getAttribute(attr);
      if (v) return `[${attr}="${CSS.escape(v)}"]`;
    }
    return '';
  }

  function errorHtml(err) {
    const offline = err && err.code === 'OFFLINE';
    const title = offline ? '连不上 Chronicle' : '这一页没能打开';
    const body = offline ? '后台服务没有在运行。在终端里运行 npm run daemon，或者从菜单栏打开 Chronicle。' : (err && err.message) || '出了点问题。';
    return `<div class="page"><div class="empty"><b>${esc(title)}</b>${esc(body)}<p class="empty-acts"><button class="btn" type="button" data-action="reload">再试一次</button></p></div></div>`;
  }

  /* ================= 5. 顶栏：记录状态 ================= */

  const DOT_STYLE = {
    recording: 'background:var(--ember)',
    warn: 'background:var(--ember)',
    paused: 'background:transparent;box-shadow:inset 0 0 0 2px var(--ink-3)',
    off: 'background:transparent;box-shadow:inset 0 0 0 2px var(--ink-3)',
    down: 'background:var(--rose)',
  };

  const OCR_ERRORS = {
    SCREEN_PERMISSION_DENIED: '没有「屏幕录制」权限，读不了窗口文字。',
    NOT_RUNNING: '记录没有在运行，先继续记录再读。',
    CONTENT_DISABLED: '你关掉了「记录窗口里的文字」，所以不读。',
    SECURE_INPUT: '正在输入密码，这时候什么都不读。',
    APP_BLOCKED: '这个应用在「不记录」名单里。',
    INCOGNITO: '无痕窗口不读。',
    PRIVACY_BLOCKED: '这个窗口被隐私规则挡住了。',
    NO_WINDOW: '最前面没有可以读的窗口。',
  };

  function recState() {
    if (!state.status) {
      const offline = !state.statusError || state.statusError.code === 'OFFLINE';
      return {
        key: 'down',
        text: '未连接',
        title: offline ? '连不上 Chronicle' : '记录程序没有响应',
        desc: offline
          ? '后台服务没有在运行。在终端里运行 npm run daemon，或者从菜单栏打开 Chronicle。'
          : '后台服务还在，但记录程序没有回应。它通常会在几秒内自己重启。',
      };
    }
    const s = state.status.status || {};
    const cfg = s.config || {};
    if (s.paused) return { key: 'paused', text: '已暂停', title: '已暂停', desc: '暂停期间什么都不记。准备好了就继续。' };
    if (!s.running) {
      return cfg.enabled === false
        ? { key: 'off', text: '没在记录', title: '记录已关闭', desc: '打开后，Chronicle 会在后台记下你用过的应用、窗口和网页。不截屏，不录音。' }
        : { key: 'off', text: '已停止', title: '记录程序没有运行', desc: '后台服务会自动把它重新拉起来，通常只要几秒。' };
    }
    if (state.perms && state.perms.axGranted === false) {
      return { key: 'warn', text: '需要授权', title: '正在记录，但看不清细节', desc: '还没有「辅助功能」权限，Chronicle 只知道你在用哪个应用，看不到窗口标题、网页和你点了什么。' };
    }
    const seg = s.currentSegment || {};
    const since = Date.parse(seg.startTs);
    return {
      key: 'recording',
      text: '正在记录',
      title: '正在记录',
      desc: Number.isFinite(since)
        ? `这一段从 ${hm(since)} 开始，已经记下 ${fmtCount(seg.eventCount)} 条记录。每 10 分钟存成一段。不截屏，不录音。`
        : '每 10 分钟存成一段。不截屏，不录音。',
    };
  }

  function statusPopHtml() {
    const r = recState();
    const cfg = (state.status && state.status.status && state.status.status.config) || {};
    const out = [`<h3><i class="status-dot" style="${DOT_STYLE[r.key]}" aria-hidden="true"></i>${esc(r.title)}</h3><p>${esc(r.desc)}</p>`];
    if (r.key === 'recording' || r.key === 'warn') {
      out.push('<div class="stack"><div class="row-btns"><button class="btn" type="button" data-action="pause" data-sec="3600">暂停 1 小时</button><button class="btn" type="button" data-action="pause">一直暂停</button></div></div>');
    } else if (r.key === 'paused') {
      out.push('<div class="stack"><button class="btn primary" type="button" data-action="resume">继续记录</button></div>');
    } else if (r.key === 'off' && cfg.enabled === false) {
      out.push('<div class="stack"><button class="btn primary" type="button" data-action="enable">开始记录</button></div>');
    } else if (r.key === 'down') {
      out.push('<div class="stack"><button class="btn" type="button" data-action="status-retry">再试一次</button></div>');
    }
    if (r.key === 'warn') {
      out.push('<div class="warn">打开以后，摘要会具体得多：哪份文档、哪个网页、点了哪个按钮。<br><button class="btn primary small" type="button" data-action="perm-ax">打开「辅助功能」权限</button></div>');
    }
    const a = state.analysis;
    if (state.status && modelOn() && a) {
      const pending = Number(a.total) || 0;
      let line = backlogText(a);
      if (a.offline) line = '网络不通，AI 整理先停着，恢复后会自动补上。';
      else if (a.last_error) line = `上次整理没成功：${clip(a.last_error, 80)}`;
      const retry = pending || a.last_error ? '<div class="stack"><button class="btn small" type="button" data-action="analysis-retry">现在整理</button></div>' : '';
      out.push(`<div class="sep"></div><p>${esc(line)}</p>${retry}`);
    }
    if (r.key === 'recording' || r.key === 'warn') {
      out.push('<div class="sep"></div><div class="stack"><button class="btn" type="button" data-action="ocr">读取一个窗口的文字…</button></div>');
    }
    out.push('<div class="foot"><a class="link" href="/?view=settings#recording" data-nav="settings">记录设置</a><span class="muted">数据只在这台 Mac 上</span></div>');
    return out.join('');
  }

  function paintStatus() {
    const r = recState();
    statusBtn.dataset.state = r.key;
    $('.status-text', statusBtn).textContent = r.text;
    statusBtn.setAttribute('aria-label', `${r.title}，查看详情`);
    const pop = layers.find((l) => l.box.dataset.pop === 'status');
    if (!pop) return;
    const html = statusPopHtml();
    if (pop.html === html) return;
    const focused = pop.box.contains(document.activeElement) ? document.activeElement.getAttribute('data-action') : '';
    pop.box.innerHTML = html;
    pop.html = html;
    const again = focused && pop.box.querySelector(`[data-action="${focused}"]`);
    if (again) again.focus();
  }

  async function refreshStatus() {
    try {
      state.status = await api('/api/status');
      state.statusError = null;
    } catch (err) {
      state.status = null;
      state.statusError = err;
    }
    if (state.status && Date.now() - state.permsAt > MIN) {
      try {
        state.perms = await api('/api/permissions');
        state.permsAt = Date.now();
      } catch {
        /* 权限探测失败时沿用上次结果 */
      }
    }
    if (state.status && modelOn() && layers.some((l) => l.box.dataset.pop === 'status')) {
      state.analysis = await api('/api/analysis/status').catch(() => state.analysis);
    }
    paintStatus();
  }

  async function openStatus() {
    const layer = openLayer({
      cls: 'pop',
      label: '记录状态',
      anchor: statusBtn,
      html: statusPopHtml(),
      onClose: () => statusBtn.setAttribute('aria-expanded', 'false'),
    });
    layer.box.dataset.pop = 'status';
    statusBtn.setAttribute('aria-expanded', 'true');
    await ensureModel();
    if (modelOn()) state.analysis = await api('/api/analysis/status').catch(() => null);
    await refreshStatus();
  }

  async function afterRecordingChange() {
    await refreshStatus();
    if (state.route.view !== 'memory') softRender();
  }

  async function pause(sec) {
    try {
      await api('/api/pause', { method: 'POST', body: sec ? { durationSec: sec } : {} });
      toast(sec ? `已暂停，${hm(Date.now() + sec * 1000)} 自动继续` : '已暂停。需要时点「继续记录」。');
    } catch (err) {
      fail(err);
    }
    await afterRecordingChange();
  }

  async function resume() {
    try {
      await api('/api/resume', { method: 'POST' });
      toast('继续记录了');
    } catch (err) {
      fail(err);
    }
    await afterRecordingChange();
  }

  async function setRecording(enabled) {
    try {
      await api('/api/config', { method: 'PUT', body: { enabled } });
      toast(enabled ? '开始记录了' : '记录已关闭');
    } catch (err) {
      fail(err);
    }
    await afterRecordingChange();
  }

  async function requestAx() {
    try {
      const r = await api('/api/permissions/request', { method: 'POST', body: {} });
      if (r.axGranted) {
        toast('「辅助功能」权限已经打开了');
      } else {
        await api('/api/permissions/card', { method: 'POST', body: {} }).catch(() => null);
        toast('在「系统设置 › 隐私与安全性 › 辅助功能」里打开 Chronicle', { ms: 9000 });
      }
    } catch (err) {
      fail(err);
    }
    state.permsAt = 0;
    await afterRecordingChange();
  }

  async function requestScreen() {
    try {
      const r = await api('/api/permissions/screen', { method: 'POST', body: {} });
      toast(r.screenGranted ? '「屏幕录制」权限已经打开了' : '在「系统设置 › 隐私与安全性 › 屏幕录制」里打开 Chronicle', { ms: 9000 });
    } catch (err) {
      fail(err);
    }
    state.permsAt = 0;
    await afterRecordingChange();
  }

  /** 按需读取窗口文字：给 3 秒切到目标窗口；像素只在内存里，文字写进时间线 */
  async function readWindowText() {
    closeAllLayers();
    const note = toast('3 秒后读取最前面的窗口，现在切过去。', { ms: 3400 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    note.remove();
    try {
      const r = await api('/api/ocr', { method: 'POST', body: {} });
      const o = r.ocr || {};
      const where = clip(o.windowTitle || o.appName || '窗口', 24);
      toast(`读到「${where}」里的 ${fmtCount(o.lineCount)} 行文字${r.stored === false ? '，没有写进时间线' : '，已写进时间线'}`, { ms: 6000 });
      if (state.route.view === 'day') softRender();
    } catch (err) {
      const action = err.code === 'SCREEN_PERMISSION_DENIED' ? { label: '去授权', run: requestScreen } : null;
      toast(OCR_ERRORS[err.code] || err.message, { bad: true, ms: 7000, action });
    }
  }

  async function retryAnalysis(btn) {
    await busy(btn, async () => {
      try {
        const r = await api('/api/analysis/retry', { method: 'POST', body: {} });
        const result = r.result || {};
        if (result.offline) toast('网络还是不通，恢复后会自动补上', { bad: true });
        else toast(result.remaining ? `整理了一部分，还剩 ${result.remaining} 段` : '整理完了');
      } catch (err) {
        fail(err);
      }
    });
    state.analysis = await api('/api/analysis/status').catch(() => state.analysis);
    paintStatus();
    softRender();
  }

  /* ================= 6. 时间线：一天 ================= */

  const RIBBON_H = 64;
  let ribbonObserver = null;

  const currentDate = () => (state.day && state.day.date) || state.route.date || state.today;
  const urlKeyOf = (item) => (item.kind === 'summary' ? `s:${item.summary.filename}` : `r:${item.segments[0]}`);

  function replaceRoute(patch) {
    state.route = { ...state.route, ...patch };
    history.replaceState(history.state, '', routeUrl(state.route, state.today));
  }

  function goDay(date) {
    state.openChapters.clear();
    go({ view: 'day', section: '', date: date === state.today ? '' : date, open: '', at: null });
  }

  /** 前后翻：跳到最近一个有记录的日子；往后最多到今天 */
  function neighborDay(date, dir) {
    const known = (state.days || []).map((x) => x.date).filter((x) => (dir < 0 ? x < date : x > date && x <= state.today));
    if (known.length) return known.reduce((a, b) => ((dir < 0 ? a > b : a < b) ? a : b));
    if (dir > 0) return date < state.today ? state.today : null;
    return null;
  }

  async function loadDay(date) {
    const isToday = date === state.today;
    const [overview, sums, mem] = await Promise.all([
      api(`/api/overview?date=${encodeURIComponent(date)}`),
      api(`/api/summaries?date=${encodeURIComponent(date)}`).catch(() => ({ summaries: [] })),
      isToday ? api('/api/memory').catch(() => null) : null,
    ]);
    const { start, end } = dayBounds(date);
    const activity = overview.activity || { bucketMs: 5 * MIN, buckets: [], apps: [], activeMs: 0 };
    for (const a of overview.topApps || []) rememberApp(a.bundleId, a.appName);
    for (const a of activity.apps || []) rememberApp(a.bundleId, a.appName);
    for (const b of activity.buckets || []) rememberApp(b.bundleId, b.appName);
    const summaries = (sums.summaries || []).filter((s) => Number.isFinite(s.startMs));
    const chapters = buildChapters({
      dayStart: start,
      dayEnd: end,
      nowMs: Date.now(),
      segments: overview.segments || [],
      summaries,
      buckets: activity.buckets,
      bucketMs: activity.bucketMs,
    });
    return {
      date,
      isToday,
      start,
      end,
      overview,
      activity,
      summaries,
      chapters,
      items: chapters.flatMap((c) => c.items),
      ribbon: ribbonColumns(activity, start, end),
      ongoing: mem && mem.memory ? ongoingFrom(mem.memory.summaryMarkdown) : null,
    };
  }

  async function renderDay(token, { quiet = false } = {}) {
    const date = state.route.date || state.today;
    const [d] = await Promise.all([loadDay(date), ensureModel(), ensureDays()]);
    if (!isCurrent(token)) return;
    state.day = d;
    document.title = `${dayTitle(date, state.today)} · Chronicle`;
    main.innerHTML = dayHtml(d, !quiet);
    mountRibbon(d, !quiet);
    if (!quiet) openFromRoute(d);
  }

  function openFromRoute(d) {
    const { open, at } = state.route;
    if (!open && !at) return;
    const item = open ? findItem(d, open) : itemAt(d.items, at) || nearestItem(d.items, at);
    if (!item) {
      replaceRoute({ open: '', at: null });
      toast(open ? '没找到这一刻，它可能已经被删掉了' : '那个时间附近没有记录', { bad: true });
      return;
    }
    if (at) replaceRoute({ open: urlKeyOf(item), at: null });
    showSheet(item);
    let row = main.querySelector(`[data-open="${CSS.escape(urlKeyOf(item))}"]`);
    if (!row && !item.chapter) {
      const c = d.chapters.find((x) => x.items.includes(item));
      if (c) expandChapter(c.startMs);
      row = main.querySelector(`[data-open="${CSS.escape(urlKeyOf(item))}"]`);
    }
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('flash');
    }
  }

  function findItem(d, key) {
    const k = String(key || '');
    if (k.startsWith('s:')) {
      const file = k.slice(2);
      const hit = d.items.find((it) => it.kind === 'summary' && it.summary.filename === file);
      if (hit) return hit;
      const c = d.chapters.find((ch) => ch.summary && ch.summary.filename === file);
      if (!c) return null;
      const apps = Array.isArray(c.summary.applications) ? c.summary.applications.filter(Boolean).slice(0, 8) : [];
      return { kind: 'summary', chapter: true, summary: c.summary, startMs: c.startMs, endMs: c.endMs, segments: [], eventCount: 0, apps };
    }
    if (k.startsWith('r:')) {
      const seg = k.slice(2);
      return d.items.find((it) => it.segments.includes(seg)) || null;
    }
    return null;
  }

  function nearestItem(items, t, within = 10 * MIN) {
    let best = null;
    let dist = Infinity;
    for (const it of items || []) {
      const gap = t < it.startMs ? it.startMs - t : t >= it.endMs ? t - it.endMs : 0;
      if (gap < dist) {
        dist = gap;
        best = it;
      }
    }
    return dist <= within ? best : null;
  }

  function dayHtml(d, animate) {
    const en = (n = 1) => (animate ? ` enter${n > 1 ? ` enter-${n}` : ''}` : '');
    const hasData = d.items.length > 0 || (d.activity.buckets || []).length > 0;
    const title = dayTitle(d.date, state.today);
    const relative = title === '今天' || title === '昨天';
    const dateLabel = relative ? dayLabel(d.date, state.today) : `星期${WEEKDAYS[parseDateKey(d.date).getDay()]}`;
    const prev = neighborDay(d.date, -1);
    const next = neighborDay(d.date, 1);
    return `<div class="page">
      <div class="day-head${en()}">
        <button class="date-btn" type="button" data-action="cal-open" aria-haspopup="dialog" aria-label="选择日期，现在是${esc(dayLabel(d.date, state.today))}">${esc(dateLabel)}${SVG.down}</button>
        <div class="day-nav">
          ${d.isToday ? '' : '<button class="btn small" type="button" data-action="day-today">回到今天</button>'}
          <button class="icon-btn" type="button" data-action="day-prev" aria-label="更早一天"${prev ? '' : ' disabled'}>${SVG.left}</button>
          <button class="icon-btn" type="button" data-action="day-next" aria-label="更晚一天"${next ? '' : ' disabled'}>${SVG.right}</button>
        </div>
      </div>
      <h1 class="display day-title${en()}">${esc(title)}</h1>
      ${leadHtml(d, en(2))}
      ${hasData ? ribbonShell(d, en(3)) : ''}
      ${d.isToday ? nextHtml(d, en(3)) : ''}
      ${ctaHtml(d)}
      ${hasData ? chaptersHtml(d) : emptyDayHtml(d)}
    </div>`;
  }

  function tokensHtml(tokens, strongTag = 'strong') {
    return tokens.map((t) => {
      if (typeof t === 'string') return esc(t);
      if (t.strong) return `<${strongTag}>${esc(t.strong)}</${strongTag}>`;
      if (t.app) return `<span class="app-inline">${icon(t.app, { name: t.name })}${esc(t.name || nameOf(t.app))}</span>`;
      return '';
    }).join('');
  }

  function leadHtml(d, cls) {
    const story = describeDay({ activity: d.activity, topApps: d.overview.topApps, isToday: d.isToday });
    if (!story.tokens.length) return '';
    const aside = story.aside.length ? `<p class="note${cls}">${tokensHtml(story.aside, 'b')}</p>` : '';
    return `<p class="lead day-lead${cls}">${tokensHtml(story.tokens)}</p>${aside}`;
  }

  // ---------- 一天的波形 ----------

  function ribbonShell(d, cls) {
    const minutes = Math.round((d.end - d.start) / MIN);
    return `<section class="ribbon breakout${cls}" aria-label="这一天的节奏">
      <div class="ribbon-icons" aria-hidden="true"></div>
      <div class="ribbon-wave" tabindex="0" role="slider" aria-label="时间轴：左右键移动，回车打开那一刻" aria-valuemin="0" aria-valuemax="${minutes - 1}"></div>
      <div class="ribbon-axis" aria-hidden="true">${axisHtml(d)}</div>
      <div class="ribbon-legend"><span><i class="tall"></i>亲手操作</span><span><i class="short"></i>开着，没动手</span><span>颜色来自当时在用的应用</span></div>
    </section>`;
  }

  function axisHtml(d) {
    const base = parseDateKey(d.date);
    const total = d.end - d.start;
    const out = [];
    for (let h = 0; h <= 24; h += 3) {
      const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h).getTime() - d.start;
      out.push(`<span${h % 6 ? ' class="minor"' : ''} style="left:${((t / total) * 100).toFixed(3)}%">${h}:00</span>`);
    }
    return out.join('');
  }

  function ribbonSvg(d, k, animate) {
    const { count, bars } = ribbonBars(d.ribbon, k);
    const mid = RIBBON_H / 2;
    const groups = new Map();
    for (const b of bars) {
      if (!groups.has(b.app)) groups.set(b.app, []);
      const y = (mid - b.height / 2).toFixed(2);
      groups.get(b.app).push(`<rect x="${(b.x + 0.18).toFixed(2)}" y="${y}" width=".64" height="${b.height.toFixed(2)}"${b.faint ? ' opacity=".38"' : ''}/>`);
    }
    const nowX = d.isToday ? Math.max(0, Math.min(count, ((Date.now() - d.start) / (d.end - d.start)) * count)) : count;
    let track = `<rect class="track" x="0" y="${mid - 0.5}" width="${nowX.toFixed(2)}" height="1"/>`;
    if (nowX < count) track += `<rect class="track" x="${nowX.toFixed(2)}" y="${mid - 0.5}" width="${(count - nowX).toFixed(2)}" height="1" opacity=".4"/>`;
    const body = [...groups].map(([app, rects]) => `<g data-app="${esc(app)}" style="fill:${iconColors.get(app) || 'var(--ink-3)'};transition:fill .6s">${rects.join('')}</g>`).join('');
    return `<svg viewBox="0 0 ${count} ${RIBBON_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${track}<g class="bars"${animate ? '' : ' style="animation:none;clip-path:none"'}>${body}</g></svg>`;
  }

  function mountRibbon(d, animate) {
    if (ribbonObserver) {
      ribbonObserver.disconnect();
      ribbonObserver = null;
    }
    const wave = $('.ribbon-wave', main);
    if (!wave) return;
    let lastK = 0;
    let lastWidth = 0;
    const draw = (first) => {
      const width = wave.clientWidth;
      if (!width || Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      const k = Math.max(1, Math.ceil((2.6 * d.ribbon.cols) / width));
      if (k !== lastK) {
        lastK = k;
        const old = wave.querySelector('svg');
        if (old) old.remove();
        wave.insertAdjacentHTML('afterbegin', ribbonSvg(d, k, first && animate));
        paintRibbon(wave);
      }
      placePins(d, width);
    };
    draw(true);
    if (d.isToday) {
      const pct = Math.max(0, Math.min(100, ((Date.now() - d.start) / (d.end - d.start)) * 100));
      wave.insertAdjacentHTML('beforeend', `<div class="ribbon-now" style="left:${pct.toFixed(3)}%"><span>现在</span></div>`);
    }
    ribbonObserver = new ResizeObserver(() => draw(false));
    ribbonObserver.observe(wave);
    wireRibbon(wave, d);
  }

  function paintRibbon(wave) {
    for (const g of $$('g[data-app]', wave)) {
      const app = g.dataset.app;
      if (!app || iconColors.has(app)) continue;
      iconColor(app).then((color) => {
        g.style.fill = color;
      });
    }
  }

  function placePins(d, width) {
    const box = $('.ribbon-icons', main);
    if (!box) return;
    const perCol = width / d.ribbon.cols;
    const pins = pickPins(d.ribbon, { minGap: Math.ceil(36 / perCol), max: width < 520 ? 4 : 7 });
    box.innerHTML = pins.map((p) => `<span class="pin" style="left:${((p.at / d.ribbon.cols) * 100).toFixed(3)}%">${icon(p.app)}</span>`).join('');
  }

  function defaultRibbonTime(d) {
    if (d.isToday) return Date.now() - MIN;
    return d.activity.lastActiveMs || d.start + 12 * HOUR;
  }

  function ribbonTipHtml(d, t) {
    const step = d.ribbon.step;
    const i = Math.floor((t - d.start) / step);
    const from = d.start + i * step;
    const head = `<div class="t">${hm(from)} – ${endLabel(from + step)}</div>`;
    if (d.isToday && from > Date.now()) return `${head}<div class="s">还没到</div>`;
    const b = d.ribbon.arr[i];
    const item = itemAt(d.items, t);
    let body = '';
    if (b && b.bundleId) {
      body += `<div class="a">${icon(b.bundleId, { name: b.appName })}${esc(b.appName || nameOf(b.bundleId))}</div>`;
      body += `<div class="s">${b.activeMs > 0 ? `亲手操作 ${esc(fmtDur(b.activeMs))}` : '开着，没动手'}</div>`;
    } else {
      body += '<div class="s">没有记录</div>';
    }
    if (item && item.kind === 'summary') body += `<div class="s">${esc(clip(stripTimePrefix(item.summary.title), 40))}</div>`;
    if (item) body += '<div class="go">点一下，打开这一刻</div>';
    return head + body;
  }

  function wireRibbon(wave, d) {
    const total = d.end - d.start;
    let cursorT = null;
    const cursor = document.createElement('div');
    cursor.className = 'ribbon-cursor';
    cursor.hidden = true;
    const tip = document.createElement('div');
    tip.className = 'ribbon-tip';
    tip.hidden = true;
    wave.append(cursor, tip);
    const timeAt = (clientX) => {
      const r = wave.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - r.left, 0), r.width - 0.01);
      return d.start + (x / r.width) * total;
    };
    const show = (t) => {
      cursorT = Math.min(Math.max(t, d.start), d.end - 1);
      const width = wave.clientWidth;
      const x = ((cursorT - d.start) / total) * width;
      cursor.hidden = false;
      cursor.style.left = `${x}px`;
      tip.innerHTML = ribbonTipHtml(d, cursorT);
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(x, half), width - half)}px`;
      wave.setAttribute('aria-valuenow', String(Math.floor((cursorT - d.start) / MIN)));
      wave.setAttribute('aria-valuetext', tip.textContent.replace(/\s+/g, ' ').trim());
    };
    const hide = () => {
      cursor.hidden = true;
      tip.hidden = true;
    };
    const openAt = (t) => {
      if (d.isToday && t > Date.now()) return;
      const item = itemAt(d.items, t) || nearestItem(d.items, t, 5 * MIN);
      if (item) openItem(item);
      else toast('这个时间没有记录');
    };
    wave.addEventListener('pointermove', (e) => show(timeAt(e.clientX)));
    wave.addEventListener('pointerleave', () => {
      if (document.activeElement !== wave) hide();
    });
    wave.addEventListener('click', (e) => openAt(timeAt(e.clientX)));
    wave.addEventListener('focus', () => show(cursorT ?? defaultRibbonTime(d)));
    wave.addEventListener('blur', hide);
    wave.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? HOUR : d.ribbon.step;
      let t = cursorT ?? defaultRibbonTime(d);
      if (e.key === 'ArrowRight') t += step;
      else if (e.key === 'ArrowLeft') t -= step;
      else if (e.key === 'Home') t = d.start;
      else if (e.key === 'End') t = d.isToday ? Date.now() - MIN : d.end - 1;
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAt(t);
        return;
      } else {
        return;
      }
      e.preventDefault();
      show(t);
    });
  }

  // ---------- 接下来 ----------

  function nextHtml(d, cls) {
    const things = nextThings(d.ongoing);
    if (!things.length) return '';
    const rows = things.map((t) => `<li class="todo"><span class="suggest-dot" aria-hidden="true"></span><div class="todo-text">${esc(t.next)}<small>${esc(t.title)}${t.status ? ` · ${esc(t.status.text)}` : ''}</small></div></li>`).join('');
    return `<section class="next${cls}" aria-labelledby="next-title">
      <div class="next-head"><h2 class="section-title" id="next-title">接下来</h2><span class="muted num">${things.length} 件</span></div>
      <ul class="next-list">${rows}</ul>
    </section>`;
  }

  // ---------- 提示卡、章节、时刻 ----------

  function ctaHtml(d) {
    const cfg = state.status && state.status.status && state.status.status.config;
    if (d.isToday && cfg && cfg.enabled === false) {
      return '<section class="cta"><h3>记录已关闭</h3><p>打开后，Chronicle 会在后台记下你用过的应用、窗口和网页，每 10 分钟存成一段。不截屏，不录音。</p><button class="btn primary" type="button" data-action="enable">开始记录</button></section>';
    }
    if (state.model && !modelOn() && d.items.length) {
      return '<section class="cta"><h3>让 AI 把每 10 分钟写成一句话</h3><p>现在你看到的只是原始记录。接上一个模型（也可以是本机的 Ollama），Chronicle 会写下每一段在做什么、卡在哪里，还会慢慢记住你在推进的事。</p><a class="btn primary" href="/?view=settings#model" data-nav="settings">设置模型</a></section>';
    }
    return '';
  }

  const CHAPTER_PEEK = 6;

  function chaptersHtml(d) {
    return `<div class="chapters">${[...d.chapters].reverse().map((c) => chapterHtml(c, d)).join('')}</div>`;
  }

  function chapterHtml(c, d) {
    const six = c.summary;
    const part = partOfDay(c.startMs);
    const range = `${hm(c.startMs)} – ${endLabel(c.endMs)}${six ? ` · ${part}` : ''}`;
    const title = (six && stripTimePrefix(six.title)) || part;
    const head = six
      ? `<h2><button class="chapter-title" type="button" data-open="s:${esc(six.filename)}">${esc(title)}</button></h2>${six.description ? `<p class="chapter-desc">${esc(six.description)}</p>` : ''}`
      : `<h2 class="chapter-title">${esc(title)}</h2>`;
    const all = [...c.items].reverse();
    const folded = all.length > CHAPTER_PEEK + 2 && !state.openChapters.has(c.startMs);
    const items = (folded ? all.slice(0, CHAPTER_PEEK) : all).map((it) => momentHtml(it, d)).join('');
    const more = folded ? `<button class="moments-more" type="button" data-action="chapter-more" data-chapter="${c.startMs}">再看 ${all.length - CHAPTER_PEEK} 个时刻</button>` : '';
    return `<section class="chapter" data-chapter="${c.startMs}"><header class="chapter-head"><p class="chapter-range">${esc(range)}</p>${head}</header>${items ? `<div class="moments">${items}</div>${more}` : ''}</section>`;
  }

  /** 长章节先只露出最近的几个时刻；展开后焦点落在第一个新露出来的时刻上 */
  function expandChapter(startMs, focus = false) {
    const c = state.day && state.day.chapters.find((x) => x.startMs === startMs);
    const el = c && main.querySelector(`.chapter[data-chapter="${startMs}"]`);
    if (!el) return;
    state.openChapters.add(startMs);
    el.outerHTML = chapterHtml(c, state.day);
    const first = focus && main.querySelectorAll(`.chapter[data-chapter="${startMs}"] .moment`)[CHAPTER_PEEK];
    if (first) first.focus({ preventScroll: true });
  }

  function momentHtml(it, d) {
    const key = esc(urlKeyOf(it));
    const time = `<span class="moment-time">${hm(Math.max(it.startMs, d.start))}</span>`;
    const icons = iconStack(it.apps, 4);
    if (it.kind === 'summary') {
      const s = it.summary;
      const desc = s.description ? `<span class="moment-desc">${esc(s.description)}</span>` : '';
      return `<button class="moment" type="button" data-open="${key}">${time}<span class="moment-main"><span class="moment-title">${esc(stripTimePrefix(s.title) || '没有标题')}</span>${desc}</span>${icons}</button>`;
    }
    if (it.kind === 'live') {
      const desc = `已经记下 ${fmtCount(it.eventCount)} 条记录。${modelOn() ? '这一段结束后，AI 会把它写成一句话。' : ''}`;
      return `<button class="moment live" type="button" data-open="${key}">${time}<span class="moment-main"><span class="moment-title">正在记录</span><span class="moment-desc">${esc(desc)}</span></span>${icons}</button>`;
    }
    return `<button class="moment quiet" type="button" data-open="${key}">${time}<span class="moment-main"><span class="moment-title">${esc(`${fmtDur(it.endMs - it.startMs)}的原始记录`)}</span></span>${icons}</button>`;
  }

  function emptyDayHtml(d) {
    if (d.isToday) return '<div class="empty"><b>今天还没有记录</b>Chronicle 开着的时候，你用过的应用、窗口和网页会一段一段出现在这里。</div>';
    return '<div class="empty"><b>这一天没有记录</b>那天 Chronicle 没有在运行，或者记录已经被删掉了。</div>';
  }

  /* ================= 7. 侧边阅读页：一个时刻 ================= */

  const EVENTS_PAGE = 250;
  const eventStore = new WeakMap();

  const sheetLayer = () => layers.find((l) => l.kind === 'sheet') || null;
  const appChips = (ids) => ids.map((id) => `<span class="chip">${icon(id)}${esc(nameOf(id))}</span>`).join('');

  /** 打开一个时刻：地址里带上 open=，浏览器的返回键能关掉它 */
  function openItem(item) {
    const key = urlKeyOf(item);
    if (state.route.view === 'day' && state.route.open !== key) {
      const next = { ...state.route, open: key, at: null };
      const url = routeUrl(next, state.today);
      if (state.route.open) history.replaceState(history.state, '', url);
      else history.pushState({ sheet: true }, '', url);
      state.route = next;
    }
    showSheet(item);
  }

  /** 用户关掉侧页（关闭按钮、Esc、点背景）：地址同步回去 */
  function userCloseSheet() {
    const layer = sheetLayer();
    if (layer) closeLayer(layer);
    if (!state.route.open) return;
    if (history.state && history.state.sheet) {
      state.route = { ...state.route, open: '' };
      history.back();
    } else {
      replaceRoute({ open: '' });
    }
  }

  /** 打开侧页，已经开着就换内容 */
  function presentSheet({ html, label, item = null }) {
    let layer = sheetLayer();
    if (layer) {
      const above = layers[layers.indexOf(layer) + 1];
      if (above) closeLayer(above);
      layer.box.innerHTML = html;
      layer.box.setAttribute('aria-label', label);
      layer.box.scrollTop = 0;
      layer.box.focus({ preventScroll: true });
    } else {
      layer = openLayer({
        cls: 'sheet',
        label,
        html,
        onDismiss: userCloseSheet,
        onClose: (l) => {
          if (state.sheet && state.sheet.layer === l) state.sheet = null;
        },
      });
    }
    state.sheet = { item, layer };
    return state.sheet;
  }

  function sheetBarHtml(meta, nav = null) {
    const arrows = nav
      ? `<button class="icon-btn" type="button" data-action="sheet-newer" aria-label="更晚的一段"${nav.newer ? '' : ' disabled'}>${SVG.up}</button>`
        + `<button class="icon-btn" type="button" data-action="sheet-older" aria-label="更早的一段"${nav.older ? '' : ' disabled'}>${SVG.down}</button>`
      : '';
    return `<div class="sheet-bar"><span class="meta">${esc(meta)}</span><span class="tools">${arrows}<button class="icon-btn" type="button" data-action="sheet-close" aria-label="关闭">${SVG.close}</button></span></div>`;
  }

  function itemNeighbors(item) {
    const items = (state.day && state.day.items) || [];
    const key = urlKeyOf(item);
    const at = items.findIndex((x) => urlKeyOf(x) === key);
    return at < 0 ? null : { older: items[at - 1] || null, newer: items[at + 1] || null };
  }

  function rangeLabel(start, end) {
    return `${dayTitle(dateKey(start), state.today)} ${hm(start)} – ${endLabel(end)}`;
  }

  function showSheet(item) {
    const meta = rangeLabel(item.startMs, item.endMs);
    const body = item.kind === 'summary' ? summaryBodyHtml(item.summary, item) : rawBodyHtml(item);
    const label = item.kind === 'summary' ? stripTimePrefix(item.summary.title) || meta : `${meta} 的记录`;
    const { layer } = presentSheet({ html: `${sheetBarHtml(meta, item.chapter ? null : itemNeighbors(item))}<div class="sheet-body">${body}</div>`, label, item });
    if (item.kind !== 'summary') {
      const box = $('.events[data-events]', layer.box);
      if (box) fillEvents(box);
    }
  }

  function foldHtml(title, inner, extra = '') {
    return `<details class="fold"><summary>${esc(title)}${extra}</summary><div class="fold-body md">${inner}</div></details>`;
  }

  function summaryBodyHtml(s, item) {
    const groups = { lead: [], story: [], open: [], context: [], evidence: [], refs: [], other: [] };
    for (const sec of splitSections(s.body || '')) groups[sectionKind(sec.title)].push(sec);
    const md = (list) => list.map((sec) => mdToHtml(sec.body)).join('');
    const listed = Array.isArray(s.applications) ? s.applications.filter(Boolean) : [];
    const apps = (listed.length ? listed : item.apps || []).slice(0, 8);
    const out = [`<h2 class="sheet-title">${esc(stripTimePrefix(s.title) || '没有标题')}</h2>`];
    if (apps.length) out.push(`<div class="sheet-apps">${appChips(apps)}</div>`);
    const lead = md(groups.lead) || (s.description ? `<p>${esc(s.description)}</p>` : '');
    if (lead) out.push(`<div class="md lead-md sheet-lead">${lead}</div>`);
    out.push(nextActionsHtml(s));
    if (groups.story.length) out.push(`<section class="sheet-section"><h3>经过</h3><div class="md">${md(groups.story)}</div></section>`);
    if (groups.open.length) out.push(`<section class="sheet-section"><h3>还没做完</h3><div class="md">${md(groups.open)}</div></section>`);
    out.push(skillCardHtml(s));
    const folds = [];
    if (groups.context.length) folds.push(foldHtml('背景', md(groups.context)));
    for (const sec of groups.other) if (sec.body) folds.push(foldHtml(sec.title || '其他', mdToHtml(sec.body)));
    if (groups.evidence.length) folds.push(foldHtml('依据', md(groups.evidence)));
    if (item.segments && item.segments.length) {
      folds.push(`<details class="fold"><summary>原始记录</summary><div class="fold-body events" data-events="${esc(item.segments.join(','))}"><p class="muted">正在读取…</p></div></details>`);
    }
    if (folds.length) out.push(`<section class="sheet-section">${folds.join('')}</section>`);
    return out.join('');
  }

  function nextActionsHtml(s) {
    const list = (s.nextActions || []).filter((n) => n && n.action).slice(0, 4);
    if (!list.length) return '';
    const rows = list.map((n) => `<li class="todo"><span class="suggest-dot" aria-hidden="true"></span><div class="todo-text">${esc(n.action)}${n.reason ? `<small>${esc(clip(n.reason, 140))}</small>` : ''}</div></li>`).join('');
    return `<section class="sheet-section"><h3>AI 建议的下一步</h3><ul class="next-list">${rows}</ul></section>`;
  }

  function skillCardHtml(s) {
    const sug = s.suggestion;
    if (!sug || sug.type !== 'skill' || !sug.name) return '';
    const desc = sug.description ? `<p>${esc(clip(sug.description, 160))}</p>` : '';
    return `<section class="sheet-section"><div class="sheet-card"><h4>这件事以后可能还要做</h4><p>可以把做法存成技能「${esc(sug.name)}」，AI 工具下次照着做。</p>${desc}<button class="btn small" type="button" data-action="skill-save">存成技能</button></div></section>`;
  }

  function rawBodyHtml(item) {
    const live = item.kind === 'live';
    const apps = (item.apps || []).slice(0, 8);
    let note = '下面是记下的原始动作。接上模型后，AI 会把每 10 分钟写成一句话。';
    if (live) note = `这一段还在进行，已经记下 ${fmtCount(item.eventCount)} 条记录。${modelOn() ? '结束后 AI 会把它写成一句话。' : ''}`;
    else if (modelOn()) note = 'AI 还没有整理这一段。可以现在整理，也可以等它自己补上。';
    let act = '';
    if (!live && modelOn()) act = '<button class="btn primary small" type="button" data-action="summarize-now">现在整理</button>';
    else if (!modelOn()) act = '<a class="btn small" href="/?view=settings#model" data-nav="settings">设置模型</a>';
    return `<h2 class="sheet-title">${live ? '正在记录' : '还没整理的记录'}</h2>`
      + `${apps.length ? `<div class="sheet-apps">${appChips(apps)}</div>` : ''}`
      + `<p class="sheet-note">${esc(note)}</p>${act ? `<div class="sheet-acts">${act}</div>` : ''}`
      + `<section class="sheet-section"><h3>记下的动作</h3><div class="events" data-events="${esc(item.segments.join(','))}"><p class="muted">正在读取…</p></div></section>`;
  }

  // ---------- 原始动作：按应用分组，连续重复的只留一条 ----------

  function eventRows(events) {
    const rows = [];
    let last = '';
    for (const e of events || []) {
      const desc = describeEvent(e);
      if (!desc) continue;
      const d = e.data || {};
      const app = d.bundleId || d.appName || '';
      rememberApp(d.bundleId, d.appName);
      const key = `${app}|${desc.text}|${desc.quote || ''}`;
      if (key === last) continue;
      last = key;
      const t = Number.isFinite(e.tsMs) ? e.tsMs : Date.parse(e.ts);
      rows.push({ t, app, appName: d.appName || '', ...desc });
    }
    return rows;
  }

  function eventsHtml(rows) {
    const groups = [];
    for (const r of rows) {
      const g = groups[groups.length - 1];
      if (g && g.app === r.app) g.rows.push(r);
      else groups.push({ app: r.app, name: r.appName, rows: [r] });
    }
    return groups.map((g) => {
      const head = `<div class="ev-app">${g.app ? icon(g.app, { name: g.name }) : ''}<span>${esc(g.name || nameOf(g.app))}</span><span class="t">${hm(g.rows[0].t)}</span></div>`;
      const rowsHtml = g.rows.map((r) => {
        const quote = r.quote ? ` <q>${esc(r.quote)}</q>` : '';
        const pre = r.pre ? `<pre>${esc(r.pre)}</pre>` : '';
        return `<div class="ev${r.minor ? ' minor' : ''}"><span class="t">${hms(r.t)}</span><div class="x">${esc(r.text)}${quote}${pre}</div></div>`;
      }).join('');
      return `<div class="ev-group">${head}${rowsHtml}</div>`;
    }).join('');
  }

  /** 段一批批读（一次 3 段），够一屏就停；「显示更多」再往后读 */
  async function fillEvents(box, more = false) {
    let st = eventStore.get(box);
    if (!st) {
      st = { segs: String(box.dataset.events || '').split(',').filter(Boolean), loaded: 0, rows: [], limit: EVENTS_PAGE, busy: false, failed: false };
      eventStore.set(box, st);
    }
    if (st.busy) return;
    if (more) st.limit += EVENTS_PAGE;
    st.busy = true;
    try {
      while (st.rows.length < st.limit && st.loaded < st.segs.length) {
        const batch = st.segs.slice(st.loaded, st.loaded + 3);
        const results = await Promise.all(batch.map((seg) => api(`/api/segment/${encodeURIComponent(seg)}/events`).catch(() => null)));
        st.loaded += batch.length;
        for (const r of results) {
          if (r && Array.isArray(r.events)) st.rows.push(...eventRows(r.events));
          else st.failed = true;
        }
      }
    } finally {
      st.busy = false;
    }
    if (!box.isConnected) return;
    const shown = st.rows.slice(0, st.limit);
    if (!shown.length) {
      box.innerHTML = `<p class="muted">${st.failed ? '没能读到这一段的记录。' : '这一段没有可以显示的动作。'}</p>`;
      return;
    }
    const more_ = st.rows.length > shown.length || st.loaded < st.segs.length;
    box.innerHTML = eventsHtml(shown) + (more_ ? `<div class="ev-more"><span>先显示到 ${hm(shown[shown.length - 1].t)}</span><button class="btn small" type="button" data-action="events-more">显示更多</button></div>` : '');
  }

  // ---------- 侧页里的动作 ----------

  function stepSheet(dir) {
    const item = state.sheet && state.sheet.item;
    const nb = item && itemNeighbors(item);
    const next = nb && (dir > 0 ? nb.newer : nb.older);
    if (next) openItem(next);
  }


  async function saveSkill(btn) {
    const s = state.sheet && state.sheet.item && state.sheet.item.summary;
    const sug = s && s.suggestion;
    if (!sug) return;
    await busy(btn, async () => {
      try {
        const description = String(sug.description || s.description || sug.name).slice(0, 2000);
        await api('/api/skills/create', { method: 'POST', body: { name: sug.name.slice(0, 80), description, file: s.filename } });
        btn.outerHTML = '<span class="added">已存成技能，在「记忆」里能看到</span>';
        toast('技能存好了');
      } catch (err) {
        if (err.code === 'SKILL_EXISTS') toast('已经有同名的技能了');
        else fail(err);
      }
    });
  }

  async function summarizeNow(btn) {
    const item = state.sheet && state.sheet.item;
    if (!item || !item.segments.length) return;
    await busy(btn, async () => {
      try {
        const r = await api('/api/summarize/run', { method: 'POST', body: item.segments.length === 1 ? { segment: item.segments[0] } : {} });
        if (!r.summarized) {
          const why = Array.isArray(r.skipped) && r.skipped.length ? `：${clip(String(r.skipped[0]), 60)}` : '';
          toast(`这一段没有整理出东西${why}`);
          return;
        }
        toast('整理好了');
        await softRender();
        const again = state.day && findItem(state.day, `r:${item.segments[0]}`);
        if (again && sheetLayer()) openItem(again);
      } catch (err) {
        fail(err);
      }
    });
  }

  /* ================= 8. 搜索 ================= */

  const EVENT_KINDS = {
    'ax-snapshot': '窗口内容', 'visible-windows': '屏幕上的窗口', 'window-change': '窗口', 'url-change': '网页',
    'text-input': '输入', selection: '选中', click: '点击', 'context-menu': '右键', 'visual-text': '窗口文字', shortcut: '快捷键',
  };
  let searchSeq = 0;

  function openSearch() {
    const open = layers.find((l) => l.kind === 'spot');
    if (open) {
      $('input', open.box).select();
      return;
    }
    const layer = openLayer({
      cls: 'spot',
      label: '搜索',
      html: `<div class="spot-input">${SVG.search}<input type="text" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="搜索做过的事、看过的网页、打过的字" aria-label="搜索记录" role="combobox" aria-expanded="false" aria-controls="spot-list" aria-autocomplete="list" autofocus></div>`
        + '<div class="spot-results" id="spot-list" role="listbox" aria-label="搜索结果"></div>'
        + '<div class="spot-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↩</kbd>打开</span><span><kbd>esc</kbd>关闭</span></div>',
    });
    layer.hits = [];
    layer.sel = -1;
    const input = $('input', layer.box);
    const list = $('.spot-results', layer.box);
    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => runSearch(layer, input.value), 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectHit(layer, layer.sel + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (layer.sel >= 0) pickHit(layer, layer.sel);
        else {
          clearTimeout(timer);
          runSearch(layer, input.value);
        }
      }
    });
    list.addEventListener('click', (e) => {
      const hit = e.target.closest('.hit');
      if (hit) pickHit(layer, Number(hit.dataset.hit));
    });
    list.addEventListener('pointermove', (e) => {
      const hit = e.target.closest('.hit');
      if (hit && Number(hit.dataset.hit) !== layer.sel) selectHit(layer, Number(hit.dataset.hit), false);
    });
  }

  async function runSearch(layer, raw) {
    const q = String(raw || '').trim();
    const seq = ++searchSeq;
    const input = $('input', layer.box);
    const list = $('.spot-results', layer.box);
    if (!q) {
      layer.hits = [];
      layer.sel = -1;
      list.innerHTML = '';
      list.removeAttribute('aria-busy');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    // 第一次搜：先说一声在找；已经有结果：留着，淡一点，等新结果替换
    if (!list.querySelector('.hit')) list.innerHTML = '<p class="spot-note">正在找…</p>';
    list.setAttribute('aria-busy', 'true');
    const enc = encodeURIComponent(q);
    const [sums, evs] = await Promise.all([
      api(`/api/summaries?q=${enc}&limit=6`).catch(() => null),
      api(`/api/search?q=${enc}&limit=60`).catch(() => null),
    ]);
    if (seq !== searchSeq || !layer.box.isConnected) return;
    list.removeAttribute('aria-busy');
    const hits = [];
    for (const s of (sums && sums.summaries) || []) {
      if (Number.isFinite(s.startMs)) hits.push({ kind: 'summary', s, t: s.startMs });
    }
    hits.push(...eventHits(evs && evs.events, q, 30 - hits.length));
    layer.hits = hits;
    layer.sel = -1;
    input.setAttribute('aria-expanded', hits.length ? 'true' : 'false');
    if (!sums && !evs) {
      list.innerHTML = '<p class="spot-note">搜索没能完成，Chronicle 可能没有在运行。</p>';
      return;
    }
    if (!hits.length) {
      list.innerHTML = `<p class="spot-note">没有找到「${esc(q)}」</p>`;
      return;
    }
    const moments = hits.filter((h) => h.kind === 'summary');
    const events = hits.filter((h) => h.kind === 'event');
    let html = '';
    if (moments.length) html += `<p class="spot-group" role="presentation">AI 整理的时刻</p>${moments.map((h) => hitHtml(h, hits.indexOf(h), q)).join('')}`;
    if (events.length) html += `<p class="spot-group" role="presentation">原始记录</p>${events.map((h) => hitHtml(h, hits.indexOf(h), q)).join('')}`;
    list.innerHTML = html;
    selectHit(layer, 0, false);
  }

  function hitHtml(h, i, q) {
    const open = `<button class="hit" type="button" role="option" id="hit-${i}" data-hit="${i}" aria-selected="false" tabindex="-1">`;
    if (h.kind === 'summary') {
      const s = h.s;
      // 摘要正文命中、一句话描述没命中时，从正文里截出命中的那一段
      const ql = String(q).toLowerCase();
      const plain = stripFrontmatter(String(s.body || '')).replace(/^#+\s.*$/gm, ' ').replace(/^\s*[-+]\s+/gm, '').replace(/[*`>]/g, '');
      const body = s.description && (s.description.toLowerCase().includes(ql) || !plain.toLowerCase().includes(ql)) ? s.description : plain;
      const kind = s.type === '6h' ? '6 小时回顾' : '10 分钟';
      return `${open}<span class="hit-moment-glyph">${SVG.lines}</span><span><span class="ht">${highlight(stripTimePrefix(s.title) || '没有标题', q)}</span><span class="hs">${highlight(snippet(body, q, 40), q)}</span><span class="hm">${esc(whenLabel(h.t, state.today))} · ${kind}</span></span></button>`;
    }
    const d = h.e.data || {};
    const app = d.bundleId || d.appName || '';
    rememberApp(d.bundleId, d.appName);
    const what = EVENT_KINDS[h.e.type] || '记录';
    return `${open}${app ? icon(app, { name: d.appName }) : `<span class="hit-moment-glyph">${SVG.app}</span>`}<span><span class="ht">${esc(d.appName || nameOf(app))} · ${esc(what)}</span><span class="hs">${highlight(snippet(h.text, q, 40), q)}</span><span class="hm">${esc(whenLabel(h.t, state.today))}</span></span></button>`;
  }

  function selectHit(layer, i, scroll = true) {
    const els = $$('.hit', layer.box);
    const input = $('input', layer.box);
    if (!els.length) return;
    const n = Math.max(0, Math.min(els.length - 1, i));
    for (const el of els) el.setAttribute('aria-selected', String(Number(el.dataset.hit) === n));
    const el = els.find((x) => Number(x.dataset.hit) === n);
    input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    layer.sel = n;
  }

  function pickHit(layer, i) {
    const hit = layer.hits[i];
    if (!hit) return;
    closeLayer(layer);
    if (hit.kind === 'summary') openMoment(dateKey(hit.t), `s:${hit.s.filename}`);
    else openMomentAt(dateKey(hit.t), hit.t);
  }

  const dayRoute = (date, extra) => ({ view: 'day', section: '', date: date === state.today ? '' : date, open: '', at: null, ...extra });

  function openMoment(date, key) {
    const item = state.route.view === 'day' && state.day && state.day.date === date ? findItem(state.day, key) : null;
    if (item) openItem(item);
    else go(dayRoute(date, { open: key }));
  }

  function openMomentAt(date, t) {
    const d = state.route.view === 'day' && state.day && state.day.date === date ? state.day : null;
    const item = d && (itemAt(d.items, t) || nearestItem(d.items, t));
    if (item) openItem(item);
    else go(dayRoute(date, { at: t }));
  }

  /* ================= 9. 日历 ================= */

  function openCalendar(anchor) {
    const cur = parseDateKey(currentDate());
    const layer = openLayer({ cls: 'pop cal', label: '选择日期', anchor: null, html: '' });
    layer.month = new Date(cur.getFullYear(), cur.getMonth(), 1);
    paintCalendar(layer);
    placeNear(layer.box, anchor);
    layer.box.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-cal]');
      if (nav) {
        layer.month = new Date(layer.month.getFullYear(), layer.month.getMonth() + Number(nav.dataset.cal), 1);
        paintCalendar(layer);
        const again = $(`[data-cal="${nav.dataset.cal}"]:not([disabled])`, layer.box);
        (again || layer.box).focus();
        return;
      }
      const day = e.target.closest('[data-date]');
      if (day) {
        closeLayer(layer);
        goDay(day.dataset.date);
      }
    });
    layer.box.addEventListener('keydown', (e) => {
      const btn = e.target.closest('[data-date]');
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!btn || !delta) return;
      e.preventDefault();
      const key = shiftDateKey(btn.dataset.date, delta);
      if (key > state.today) return;
      const target = parseDateKey(key);
      if (target.getMonth() !== layer.month.getMonth() || target.getFullYear() !== layer.month.getFullYear()) {
        layer.month = new Date(target.getFullYear(), target.getMonth(), 1);
        paintCalendar(layer);
      }
      const el = $(`[data-date="${key}"]`, layer.box);
      if (el) el.focus();
    });
    ensureDays().then(() => {
      if (!layer.box.isConnected) return;
      const focused = document.activeElement && layer.box.contains(document.activeElement) ? document.activeElement.dataset.date : '';
      paintCalendar(layer);
      const el = focused && $(`[data-date="${focused}"]`, layer.box);
      if (el) el.focus();
    });
  }

  function paintCalendar(layer) {
    const y = layer.month.getFullYear();
    const m = layer.month.getMonth();
    const has = new Set((state.days || []).filter((x) => x.segments > 0).map((x) => x.date));
    const sel = currentDate();
    const today = parseDateKey(state.today);
    const cells = [];
    for (let i = (new Date(y, m, 1).getDay() + 6) % 7; i > 0; i--) cells.push('<span></span>');
    const count = new Date(y, m + 1, 0).getDate();
    for (let dd = 1; dd <= count; dd++) {
      const key = dateKey(new Date(y, m, dd));
      const cls = ['cal-day', has.has(key) ? 'has' : '', key === state.today ? 'today' : '', key === sel ? 'sel' : ''].filter(Boolean).join(' ');
      const attrs = [
        `aria-label="${m + 1}月${dd}日${has.has(key) ? '，有记录' : ''}"`,
        key === sel ? 'aria-pressed="true" autofocus' : '',
        key === state.today ? 'aria-current="date"' : '',
        key > state.today ? 'disabled' : '',
      ].filter(Boolean).join(' ');
      cells.push(`<button class="${cls}" type="button" data-date="${key}" ${attrs}>${dd}</button>`);
    }
    const canNext = y < today.getFullYear() || (y === today.getFullYear() && m < today.getMonth());
    layer.box.innerHTML = `<div class="cal-head"><button class="icon-btn" type="button" data-cal="-1" aria-label="上个月">${SVG.left}</button><b>${y}年${m + 1}月</b>`
      + `<button class="icon-btn" type="button" data-cal="1" aria-label="下个月"${canNext ? '' : ' disabled'}>${SVG.right}</button></div>`
      + `<div class="cal-grid">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<span class="wd" aria-hidden="true">${w}</span>`).join('')}${cells.join('')}</div>`
      + '<div class="foot"><span class="muted">带小点的日子有记录</span><button class="link" type="button" data-date-today>今天</button></div>';
    $('[data-date-today]', layer.box).addEventListener('click', () => {
      closeLayer(layer);
      goDay(state.today);
    });
  }

  /* ================= 10. 记忆 ================= */

  const MEM_FIELDS = [['learnings', '学到的'], ['failures', '卡住的地方'], ['preferences', '你的偏好']];
  const proseList = (items, soft = false) => `<ul class="prose-list${soft ? ' soft' : ''}">${items.map((x) => `<li>${inlineMd(x)}</li>`).join('')}</ul>`;

  /** 摘要里的一条任务 → MEMORY.md 里对应的任务组 */
  function findGroup(groups, t) {
    const title = normTitle(t.title);
    const group = normTitle(t.group);
    const loose = (n) => n && title && (n.includes(title) || title.includes(n));
    return groups.find((g) => group && normTitle(g.name) === group)
      || groups.find((g) => title && normTitle(g.name) === title)
      || groups.find((g) => g.tasks.some((k) => normTitle(k.title) === title))
      || groups.find((g) => g.tasks.some((k) => loose(normTitle(k.title))))
      || null;
  }

  async function renderMemory(token, { quiet = false } = {}) {
    const [mem, ins, sk] = await Promise.all([
      api('/api/memory'),
      api('/api/insights').catch(() => ({ insights: [] })),
      api('/api/skills').catch(() => ({ skills: [] })),
      ensureModel(),
    ]);
    if (!isCurrent(token)) return;
    const m = mem.memory || {};
    const by = { profile: [], ongoing: [], prefs: [], tips: [], index: [] };
    const extra = [];
    for (const sec of splitSections(m.summaryMarkdown || '')) {
      const items = listItems(sec.body);
      if (!items.length) continue;
      const kind = memoryKind(sec.title);
      if (kind === 'other') extra.push({ title: sec.title || '其他', items });
      else by[kind].push(...items);
    }
    const groups = parseMemoryGroups(m.memoryMarkdown || '');
    const withGroup = (t) => ({ ...t, ref: findGroup(groups, t) });
    const ongoing = by.ongoing.map(parseTaskLine).map(splitNextStep).map(withGroup);
    const covered = new Set(ongoing.map((t) => t.ref).filter(Boolean));
    const others = by.index.map(parseTaskLine).map(withGroup).filter((t) => !t.ref || !covered.has(t.ref));
    state.memory = {
      updatedAt: Date.parse(m.updatedAt || ''),
      hasAny: Boolean(m.hasSummary || m.hasMemory),
      profile: by.profile, prefs: by.prefs, tips: by.tips, extra, ongoing, others,
      insights: (ins.insights || []).slice().sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))),
      skills: sk.skills || [],
    };
    document.title = '记忆 · Chronicle';
    main.innerHTML = memoryHtml(state.memory, !quiet);
  }

  function memSection(title, inner, aside = '') {
    return `<section class="mem-section"><header><h2 class="section-title">${esc(title)}</h2>${aside ? `<span class="muted">${esc(aside)}</span>` : ''}</header>${inner}</section>`;
  }

  function memoryHtml(m, animate) {
    const en = (n = 1) => (animate ? ` enter${n > 1 ? ` enter-${n}` : ''}` : '');
    const out = [
      `<h1 class="display${en()}">记忆</h1>`,
      `<p class="lead mem-lead${en(2)}">Chronicle 从每天的记录里慢慢记住的事：你在推进什么、习惯怎么做、踩过哪些坑。接入的 AI 工具也能读到这些。</p>`,
    ];
    if (Number.isFinite(m.updatedAt)) out.push(`<p class="mem-updated${en(2)}">最近更新：${esc(relTime(m.updatedAt, Date.now()))}</p>`);
    if (!m.hasAny) {
      const act = modelOn() ? '' : '<p class="empty-acts"><a class="btn primary" href="/?view=settings#model" data-nav="settings">设置模型</a></p>';
      out.push(`<div class="empty${en(3)}"><b>还没有记忆</b>AI 整理过一些记录以后，这里会出现它记住的事。${act}</div>`);
    }
    if (m.ongoing.length) out.push(memSection('你在推进的事', `<div class="rows">${m.ongoing.map((t, i) => memRowHtml(t, `ongoing:${i}`)).join('')}</div>`, `${m.ongoing.length} 件`));
    if (m.profile.length) out.push(memSection('关于你', proseList(m.profile)));
    if (m.prefs.length) out.push(memSection('你的习惯', proseList(m.prefs, true)));
    if (m.tips.length) out.push(memSection('经验', proseList(m.tips, true)));
    for (const x of m.extra) out.push(memSection(x.title, proseList(x.items, true)));
    if (m.others.length) out.push(memSection('也记得这些', `<div class="rows">${m.others.map((t, i) => memRowHtml(t, `others:${i}`)).join('')}</div>`));
    out.push(insightsHtml(m));
    if (m.skills.length) out.push(skillsHtml(m));
    return `<div class="page">${out.join('')}</div>`;
  }

  function memRowHtml(t, key) {
    const pill = t.status ? `<span class="pill ${t.status.tone}">${esc(t.status.text)}</span>` : '';
    const desc = `${t.desc ? `<span class="rowx-desc">${inlineMd(t.desc)}</span>` : ''}${t.next ? `<span class="rowx-desc">下一步：${inlineMd(t.next)}</span>` : ''}`;
    const meta = t.group && normTitle(t.group) !== normTitle(t.title) ? `<span class="rowx-meta">${esc(t.group)}</span>` : '';
    const tags = t.tags.length ? `<span class="tags">${t.tags.slice(0, 5).map((x) => `<span>${esc(x)}</span>`).join('')}</span>` : '';
    const body = `<span class="rowx-main"><span class="rowx-title">${inlineMd(t.title)}</span>${desc}${meta}${tags}</span>`;
    if (!t.ref) return `<div class="rowx">${body}<span class="rowx-side no-chev">${pill}</span></div>`;
    return `<button class="rowx" type="button" data-mem="${key}">${body}<span class="rowx-side">${pill}<span class="chev" aria-hidden="true"></span></span></button>`;
  }

  function insightsHtml(m) {
    const rows = m.insights.map((x) => {
      const kind = x.range === 'day' ? '一天的回顾' : '一周的回顾';
      const when = Date.parse(x.generatedAt);
      const meta = `${kind}${Number.isFinite(when) ? ` · ${whenLabel(when, state.today)} 写的` : ''}`;
      return `<button class="rowx" type="button" data-insight="${esc(x.file)}"><span class="rowx-main"><span class="rowx-title">${esc(x.title || kind)}</span><span class="rowx-meta">${esc(meta)}</span></span><span class="rowx-side"><span class="chev" aria-hidden="true"></span></span></button>`;
    }).join('');
    const gen = modelOn()
      ? '<div class="gen-row"><button class="btn small" type="button" data-action="insight-gen" data-range="day">写今天的回顾</button><button class="btn small" type="button" data-action="insight-gen" data-range="week">写这一周的回顾</button><span class="muted">AI 会读这段时间的摘要，找出反复出现的事和没收尾的事。</span></div>'
      : '<div class="gen-row"><span class="muted">接上模型以后，AI 可以把一天或一周写成回顾。</span><a class="link" href="/?view=settings#model" data-nav="settings">设置模型</a></div>';
    return memSection('回顾', `${rows ? `<div class="rows">${rows}</div>` : ''}${gen}`);
  }

  function skillsHtml(m) {
    const rows = m.skills.map((k) => {
      const when = Date.parse(k.createdAt);
      const meta = Number.isFinite(when) ? `<span class="rowx-meta">${esc(whenLabel(when, state.today))} 存下</span>` : '';
      return `<div class="rowx"><span class="rowx-main"><span class="rowx-title">${esc(k.name || k.slug)}</span>${k.description ? `<span class="rowx-desc">${esc(k.description)}</span>` : ''}${meta}</span>`
        + `<span class="rowx-side"><button class="btn small" type="button" data-action="copy" data-copy="${esc(k.path)}">复制路径</button></span></div>`;
    }).join('');
    return memSection('技能', `<p class="section-sub">存下来的做法。AI 工具读到它，下次就能照着做。</p><div class="rows">${rows}</div>`);
  }

  function openMemoryRow(key) {
    const [list, at] = String(key).split(':');
    const m = state.memory;
    const t = m && (list === 'ongoing' ? m.ongoing : m.others)[Number(at)];
    if (!t || !t.ref) return;
    const dates = t.ref.tasks.map((k) => k.fields.date).filter((x) => parseDateKey(x)).sort();
    const meta = dates.length ? `记忆 · 最近一次在 ${dayTitle(dates[dates.length - 1], state.today)}` : '记忆';
    presentSheet({ html: `${sheetBarHtml(meta)}<div class="sheet-body">${memoryGroupHtml(t.ref, t)}</div>`, label: t.ref.name });
  }

  function memoryGroupHtml(g, t) {
    const out = [`<h2 class="sheet-title">${esc(g.name)}</h2>`];
    if (t.desc) out.push(`<div class="md lead-md sheet-lead"><p>${inlineMd(t.desc)}</p></div>`);
    if (g.scope) out.push(`<p class="sheet-note">${esc(g.scope)}</p>`);
    for (const task of g.tasks) {
      const f = task.fields;
      const pill = task.status ? ` <span class="pill ${task.status.tone}">${esc(task.status.text)}</span>` : '';
      const parts = [`<h3 class="mem-task-title">${esc(task.title)}${pill}</h3>`];
      const tags = splitList(String(f.keywords || '').replace(/[、,，]/g, '；'), 8);
      if (tags.length) parts.push(`<div class="tags">${tags.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`);
      for (const [field, label] of MEM_FIELDS) {
        const items = splitList(f[field], 5);
        if (items.length) parts.push(`<h4 class="mem-field">${label}</h4>${proseList(items, true)}`);
      }
      parts.push(memRefsHtml(f.references));
      if (f.evidence) parts.push(foldHtml('依据', `<p>${inlineMd(f.evidence)}</p>`));
      out.push(`<section class="sheet-section mem-task">${parts.join('')}</section>`);
    }
    return out.join('');
  }

  /** 记忆引用的摘要文件 → 可以点开的时刻 */
  function memRefsHtml(text) {
    const seen = new Set();
    const links = [];
    for (const raw of String(text || '').split(/[；;,，\s]+/)) {
      const file = raw.trim();
      const t = summaryFileStartMs(file);
      if (!Number.isFinite(t) || seen.has(file)) continue;
      seen.add(file);
      const href = routeUrl(dayRoute(dateKey(t), { open: `s:${file}` }), state.today);
      links.push({ t, html: `<a class="ref" href="${esc(href)}" data-nav="day">${esc(whenLabel(t, state.today))}${file.startsWith('6h-') ? ' 的回顾' : ''}</a>` });
    }
    if (!links.length) return '';
    links.sort((a, b) => b.t - a.t);
    return `<h4 class="mem-field">相关的时刻</h4><div class="refs">${links.slice(0, 12).map((x) => x.html).join('')}</div>`;
  }

  async function openInsight(file) {
    const x = state.memory && state.memory.insights.find((i) => i.file === file);
    const kind = x && x.range === 'day' ? '一天的回顾' : '一周的回顾';
    const sheet = presentSheet({ html: `${sheetBarHtml(kind)}<div class="sheet-body"><p class="muted">正在读取…</p></div>`, label: (x && x.title) || kind });
    let html;
    try {
      const ins = (await api(`/api/insights/${encodeURIComponent(file)}`)).insight || {};
      html = `<h2 class="sheet-title">${esc(ins.title || kind)}</h2><div class="md sheet-lead">${mdToHtml(ins.markdown || '')}</div>`;
    } catch (err) {
      html = `<p class="muted">${esc(err.message)}</p>`;
    }
    if (state.sheet === sheet) $('.sheet-body', sheet.layer.box).innerHTML = html;
  }

  async function generateInsight(btn) {
    const range = btn.dataset.range === 'day' ? 'day' : 'week';
    await busy(btn, async () => {
      try {
        const r = await api('/api/insights/generate', { method: 'POST', body: { range } });
        toast(r.skipped ? '这段时间没有新内容，回顾还是最新的' : '回顾写好了');
        await softRender();
        if (r.insight && r.insight.file) openInsight(r.insight.file);
      } catch (err) {
        if (err.body && err.body.queued) toast('模型暂时连不上，已经排队，恢复后自动补上', { ms: 6500 });
        else if (err.code === 'NO_SUMMARIES') toast(range === 'day' ? '今天还没有整理好的记录，晚点再写' : '这一周还没有整理好的记录', { bad: true });
        else fail(err);
      }
    });
  }

  /* ================= 11. 设置 ================= */

  const RETENTION_CHOICES = [[0, '永远保留'], [7, '保留 7 天'], [30, '保留 30 天'], [90, '保留 90 天'], [180, '保留半年'], [365, '保留一年']];
  const CLIENT_HINTS = { cli: '在终端里运行这一行', json: '把这段合并进它的配置文件', toml: '把这段加到配置文件末尾' };
  const EFFORT_LABELS = { '': '自动', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
  const SETTINGS_NAV = [['recording', '记录'], ['privacy', '隐私'], ['model', 'AI 整理'], ['ai', '接入 AI 工具'], ['data', '数据']];

  async function renderSettings(token, { quiet = false } = {}) {
    const [cfg, integ, observed] = await Promise.all([
      api('/api/config').then((r) => r.config || null).catch(() => null),
      api('/api/integrations').catch(() => null),
      api('/api/observed').catch(() => null),
      ensureModel(true),
      api('/api/permissions').then((p) => {
        state.perms = p;
        state.permsAt = Date.now();
      }).catch(() => {}),
      api('/api/analysis/status').then((a) => {
        state.analysis = a;
      }).catch(() => {}),
    ]);
    if (!isCurrent(token)) return;
    state.config = cfg;
    state.integrations = integ;
    state.observed = observed;
    for (const a of (observed && observed.apps) || []) rememberApp(a.bundleId, a.appName);
    document.title = '设置 · Chronicle';
    const page = $('.settings', main);
    if (quiet && page) {
      const group = $('#recording', page);
      if (group) group.outerHTML = recordingGroupHtml();
      return;
    }
    state.modelDraft = null;
    main.innerHTML = settingsHtml(!quiet);
    if (!quiet && state.route.section) scrollToSection(state.route.section, false);
  }

  function scrollToSection(id, smooth = true) {
    const el = id && document.getElementById(id);
    if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
  }

  /** label / desc 传进来的是已经转义好的 HTML */
  function rowHtml({ label, desc = '', side = '', cls = '' }) {
    return `<div class="row${cls ? ` ${cls}` : ''}"><div class="row-main"><div class="row-label">${label}</div>${desc ? `<div class="row-desc">${desc}</div>` : ''}</div>${side ? `<div class="row-side">${side}</div>` : ''}</div>`;
  }

  function switchHtml(key, on, label, attr = 'data-setting') {
    return `<label class="switch"><input type="checkbox" role="switch" ${attr}="${esc(key)}"${on ? ' checked' : ''} aria-label="${esc(label)}"><span></span></label>`;
  }

  const okMark = (text) => `<span class="ok-mark">${SVG.check}${esc(text)}</span>`;

  function settingsHtml(animate) {
    const en = (n = 1) => (animate ? ` enter${n > 1 ? ` enter-${n}` : ''}` : '');
    const nav = SETTINGS_NAV.map(([id, label]) => `<a href="/?view=settings#${id}" data-nav="settings">${label}</a>`).join('');
    return `<div class="page settings"><h1 class="display${en()}">设置</h1>`
      + `<p class="lead set-intro${en(2)}">Chronicle 能看到什么、交给谁读、留多久，都在这里决定。所有记录只存在这台 Mac 上。</p>`
      + `<nav class="set-nav${en(2)}" aria-label="设置分区">${nav}</nav>`
      + `${recordingGroupHtml()}${privacyGroupHtml()}${modelGroupHtml()}${aiGroupHtml()}${dataGroupHtml()}</div>`;
  }

  function recordingGroupHtml() {
    const cfg = state.config || {};
    const r = recState();
    const live = r.key === 'recording' || r.key === 'warn';
    let now = '';
    if (live) now = '<button class="btn small" type="button" data-action="pause" data-sec="3600">暂停 1 小时</button>';
    else if (r.key === 'paused') now = '<button class="btn primary small" type="button" data-action="resume">继续记录</button>';
    const perms = state.perms || {};
    const ax = perms.axGranted === true ? okMark('已打开') : '<button class="btn primary small" type="button" data-action="perm-ax">打开</button>';
    const screen = perms.screenGranted === true ? okMark('已打开') : '<button class="btn small" type="button" data-action="perm-screen">打开</button>';
    return `<section class="set-group" id="recording"><h2>记录</h2>`
      + '<p class="section-sub">在后台记下你用过的应用、窗口和网页，每 10 分钟存成一段。不截屏，不录音。</p>'
      + `<div class="card">${rowHtml({ label: '在后台记录', desc: '关掉以后什么都不记，已经记下的不受影响。', side: switchHtml('enabled', cfg.enabled !== false, '在后台记录') })}`
      + `${rowHtml({ label: esc(r.title), desc: esc(r.desc), side: now })}</div>`
      + `<div class="card">${rowHtml({ label: '辅助功能', desc: '让 Chronicle 看清窗口标题、网页和你点了什么。没有它，只知道你在用哪个应用。', side: ax })}`
      + `${rowHtml({ label: '屏幕录制', desc: '只在你要「读取窗口文字」时用一次。图片只在内存里识别，不保存。', side: screen })}</div>`
      + `<div class="card">${rowHtml({ label: '读取一个窗口的文字', desc: '有些应用里的字读不到，比如远程桌面、图片。点一下，3 秒后读取最前面的窗口，文字写进时间线。', side: `<button class="btn small" type="button" data-action="ocr"${live ? '' : ' disabled'}>读取…</button>` })}</div>`
      + '</section>';
  }

  function privacyGroupHtml() {
    const cfg = state.config;
    if (!cfg) return '<section class="set-group" id="privacy"><h2>隐私</h2><p class="section-sub">还没有配置文件。先在终端里运行一次 npm run setup。</p></section>';
    const p = cfg.privacy || {};
    const toggles = [
      ['includeURLs', cfg.includeURLs !== false, '记录网址', '浏览器里打开的网页地址。'],
      ['privacy.redactURLQuery', p.redactURLQuery !== false, '去掉网址里的参数', '问号后面的部分常带着搜索词和登录信息。建议打开。'],
      ['includeContent', cfg.includeContent !== false, '记录窗口里的文字', '窗口里能读到的文字和你输入的内容。摘要会具体得多。'],
      ['includeFocusedElement', cfg.includeFocusedElement !== false, '记录正在操作的控件', '比如按钮和输入框的名字。'],
      ['privacy.safariPrivateDetection', p.safariPrivateDetection !== 'off', '识别 Safari 无痕窗口', 'Safari 不会直接说哪个窗口是无痕的，Chronicle 靠窗口特征认。关掉后可能会记下无痕窗口。'],
      ['privacy.excludeSafariURLs', p.excludeSafariURLs === true, '不记 Safari 的网址', '只记 Safari 的窗口标题，不记地址。'],
    ];
    const allow = (cfg.allowlist || []).length;
    return `<section class="set-group" id="privacy"><h2>隐私</h2>`
      + '<p class="section-sub">输入密码的时候，什么都不读也不写。其余的由你决定。</p>'
      + `<div class="card">${toggles.map(([key, on, label, desc]) => rowHtml({ label: esc(label), desc: esc(desc), side: switchHtml(key, on, label) })).join('')}</div>`
      + rulesCardHtml('blocklist')
      + `<details class="fold set-fold"${allow ? ' open' : ''}><summary>只记录指定的应用${allow ? `<small>${allow} 条</small>` : '<small>高级</small>'}</summary><div class="fold-body">${rulesCardHtml('allowlist')}</div></details>`
      + '</section>';
  }

  function globToRe(glob) {
    return new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  }

  function ruleHtml(list, r, i) {
    let glyph = `<span class="rule-glyph">${SVG.globe}</span>`;
    let name = `网址里有 ${r.value.replace(/^\*+|\*+$/g, '')}`;
    if (r.scope === 'app' && !/[*?]/.test(r.value)) {
      glyph = icon(r.value);
      name = nameOf(r.value);
    } else if (r.scope === 'app') {
      const re = globToRe(r.value);
      const known = [...appNames].find(([id]) => re.test(id));
      glyph = known ? icon(known[0]) : `<span class="rule-glyph">${SVG.app}</span>`;
      name = known ? `${known[1]} 等应用` : '一组应用';
    }
    return `<div class="rule">${glyph}<div class="rule-main"><div class="rule-name">${esc(name)}</div><div class="rule-val">${esc(r.value)}</div></div>`
      + `<button class="icon-btn" type="button" data-action="rule-remove" data-list="${list}" data-i="${i}" aria-label="移除：${esc(name)}">${SVG.close}</button></div>`;
  }

  function rulesCardHtml(list) {
    const rules = (state.config && state.config[list]) || [];
    const block = list === 'blocklist';
    const title = block ? '不记录的应用和网站' : '只记录这些应用';
    const desc = block ? '用这些应用、或者打开这些网址的时候，Chronicle 什么都不记。' : '列表里有东西时，只记录这些应用；网址规则可以单独放行某个网站。';
    const empty = block ? '还没有。' : '没有设置，所有应用都会记录。';
    const items = rules.length ? rules.map((r, i) => ruleHtml(list, r, i)).join('') : `<p class="rule-empty">${empty}</p>`;
    return `<div class="card" data-rules="${list}">${rowHtml({ label: esc(title), desc: esc(desc), cls: 'stack' })}${items}`
      + `<div class="adder"><input class="field" type="text" data-adder="${list}" placeholder="应用 ID 或网址，比如 com.apple.Notes、bank.com" aria-label="${esc(title)}：输入应用 ID 或网址" autocomplete="off" spellcheck="false">`
      + `<select class="field scope" data-adder-scope="${list}" aria-label="规则类型"><option value="app">应用</option><option value="url">网址</option></select>`
      + `<button class="btn small" type="button" data-action="rule-add" data-list="${list}">添加</button>`
      + `<button class="btn plain small" type="button" data-action="rule-pick" data-list="${list}">从用过的里选…</button></div></div>`;
  }

  /** 输入框里的东西更像应用 ID 还是网址 */
  function guessScope(text) {
    const s = String(text || '').trim();
    if (!s || appNames.has(s)) return 'app';
    if (/[/:]/.test(s)) return 'url';
    return /^(com|org|net|io|dev|app|me|cn|co|ai|de|jp|uk|us|tv)\.[A-Za-z0-9-]+\.[A-Za-z0-9.*-]+$/i.test(s) ? 'app' : 'url';
  }

  async function saveConfig(patch, message = '已保存', { quiet = false } = {}) {
    try {
      const r = await api('/api/config', { method: 'PUT', body: patch });
      state.config = r.config || state.config;
      if (!quiet) toast(r.applied ? `${message}，马上生效` : message);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  function repaintRules(list) {
    const card = $(`[data-rules="${list}"]`, main);
    if (card) card.outerHTML = rulesCardHtml(list);
  }

  async function addRule(list, rule) {
    const rules = ((state.config && state.config[list]) || []).slice();
    if (rules.some((r) => r.scope === rule.scope && r.value === rule.value)) {
      toast('已经在列表里了');
      return;
    }
    rules.push(rule);
    if (await saveConfig({ [list]: rules }, '已添加')) repaintRules(list);
  }

  async function addRuleFromInput(list) {
    const card = $(`[data-rules="${list}"]`, main);
    const input = card && $('input[data-adder]', card);
    const value = input ? input.value.trim() : '';
    if (!value) {
      if (input) input.focus();
      return;
    }
    const scopeSel = $('select[data-adder-scope]', card);
    const scope = scopeSel ? scopeSel.value : guessScope(value);
    await addRule(list, { scope, value: scope === 'url' && !/[*?]/.test(value) ? `*${value}*` : value });
    // 卡片重画过了：焦点留在新输入框里，方便接着加
    const again = $(`input[data-adder="${list}"]`, main);
    if (again && document.activeElement === document.body) again.focus();
  }

  async function removeRule(list, i) {
    const rules = ((state.config && state.config[list]) || []).slice();
    const [gone] = rules.splice(i, 1);
    if (!gone) return;
    if (!(await saveConfig({ [list]: rules }, '', { quiet: true }))) return;
    repaintRules(list);
    toast('已移除', { action: { label: '撤销', run: () => addRule(list, gone) } });
  }

  function openRulePicker(btn) {
    const list = btn.dataset.list;
    const rules = (state.config && state.config[list]) || [];
    const has = (scope, value) => rules.some((r) => r.scope === scope && r.value === value);
    const apps = ((state.observed && state.observed.apps) || []).filter((a) => a.bundleId && !has('app', a.bundleId));
    const domains = ((state.observed && state.observed.domains) || []).filter((d) => d.domain && !has('url', d.domain));
    const appRows = apps.map((a) => `<button class="rule" type="button" data-pick-scope="app" data-pick="${esc(a.bundleId)}">${icon(a.bundleId, { name: a.appName })}<span class="rule-main"><span class="rule-name">${esc(a.appName)}</span><span class="rule-val">${esc(a.bundleId)}</span></span></button>`).join('');
    const siteRows = domains.map((d) => `<button class="rule" type="button" data-pick-scope="url" data-pick="${esc(d.domain)}"><span class="rule-glyph">${SVG.globe}</span><span class="rule-main"><span class="rule-name">${esc(d.domain)}</span><span class="rule-val">网站</span></span></button>`).join('');
    const body = appRows || siteRows
      ? `<div class="picker">${appRows}${siteRows}</div>`
      : '<p>最近的记录里没有别的应用了。</p>';
    const layer = openLayer({ cls: 'pop pick', label: '最近用过的应用和网站', anchor: btn, html: `<h3>最近用过的</h3>${body}` });
    layer.box.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      closeLayer(layer);
      addRule(list, { scope: pick.dataset.pickScope, value: pick.dataset.pick });
    });
  }

  async function onSettingChange(input) {
    const key = input.dataset.setting;
    const on = input.checked;
    if (key === 'enabled') {
      await setRecording(on);
      return;
    }
    let patch = { [key]: on };
    if (key.startsWith('privacy.')) {
      const field = key.slice('privacy.'.length);
      const value = field === 'safariPrivateDetection' ? (on ? 'heuristic' : 'off') : on;
      patch = { privacy: { ...((state.config && state.config.privacy) || {}), [field]: value } };
    }
    input.disabled = true;
    const ok = await saveConfig(patch);
    input.disabled = false;
    if (!ok) input.checked = !on;
  }

  async function onRetentionChange(select) {
    const days = Number(select.value) || 0;
    const section = (state.config && state.config.maintenance) || {};
    const prev = Number(section.retentionDays) || 0;
    if (days > 0 && (prev === 0 || days < prev)) {
      const yes = await confirmDialog({
        title: `只保留最近 ${days} 天？`,
        body: '更早的原始记录和它们的摘要会在下一次检查时删除（每 6 小时一次），删了就找不回来。记忆不受影响。',
        confirm: '确定',
        danger: true,
      });
      if (!yes) {
        select.value = String(prev);
        return;
      }
    }
    if (!(await saveConfig({ maintenance: { ...section, retentionDays: days } }, days ? `已改成保留 ${days} 天` : '已改成永远保留'))) select.value = String(prev);
  }

  // ---------- AI 整理 ----------

  function modelDraft() {
    if (!state.modelDraft && state.model) {
      const m = state.model;
      state.modelDraft = { preset: m.preset, model: m.model, baseUrl: m.baseUrl, reasoningEffort: m.reasoningEffort || '' };
    }
    return state.modelDraft;
  }

  function modelStatusText() {
    const m = state.model;
    const a = state.analysis;
    if (!modelOn()) return m && !m.hasKey && !m.keyOptional ? '先选一个服务商，填上 API Key。' : '打开以后，每 10 分钟写成一句话，每 6 小时写一段回顾。';
    if (!a) return '每 10 分钟写成一句话，每 6 小时写一段回顾。';
    if (a.offline) return '网络不通，整理先停着，恢复后自动补上。';
    if (a.last_error) return `上次没成功：${clip(a.last_error, 80)}`;
    return backlogText(a);
  }

  function modelGroupHtml() {
    const m = state.model;
    const head = '<h2>AI 整理</h2><p class="section-sub">发给模型的只有文字记录，没有截图。可以用你自己的 API Key，也可以用本机的 Ollama，数据不出这台 Mac。</p>';
    if (!m) return `<section class="set-group" id="model">${head}<div class="card"><p class="rule-empty">读不到模型设置。</p></div></section>`;
    const a = state.analysis;
    const retry = modelOn() && a && (Number(a.total) || a.last_error) ? '<button class="btn small" type="button" data-action="analysis-retry">现在整理</button>' : '';
    return `<section class="set-group" id="model">${head}`
      + `<div class="card">${rowHtml({ label: '用 AI 整理记录', desc: esc(modelStatusText()), side: `${retry}${switchHtml('enabled', m.enabled === true, '用 AI 整理记录', 'data-model')}` })}</div>`
      + `<div class="card"><form class="form" id="model-form" novalidate>${modelFormHtml()}</form></div></section>`;
  }

  function modelFormHtml() {
    const m = state.model;
    const d = modelDraft();
    const presets = state.presets.length ? state.presets : [{ id: m.preset, label: m.presetLabel || m.preset, models: m.presetModels || [], keyOptional: m.keyOptional, note: m.presetNote }];
    const p = presets.find((x) => x.id === d.preset) || { models: [], keyOptional: false, note: '' };
    const providers = presets.map((x) => `<button class="provider" type="button" role="radio" aria-checked="${x.id === d.preset}" data-preset="${esc(x.id)}">${esc(x.label)}</button>`).join('');
    const models = [...new Set([...(p.models || []), d.model].filter(Boolean))];
    const effort = m.capabilities && m.capabilities.reasoningEffort;
    const effortField = effort && effort.supported && d.model === m.model
      ? `<label>推理强度<select class="field" name="reasoningEffort">${effort.values.map((v) => `<option value="${esc(v)}"${v === d.reasoningEffort ? ' selected' : ''}>${esc(EFFORT_LABELS[v] || v)}${v === effort.recommended ? '（推荐）' : ''}</option>`).join('')}</select><span class="hint">${esc(effort.note || '')}</span></label>`
      : '';
    const modelField = `<label>模型<input class="field" name="model" value="${esc(d.model)}" list="model-options" autocomplete="off" spellcheck="false" required><datalist id="model-options">${models.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></label>`;
    let keyHint = p.keyOptional ? '本机模型可以不填。' : '只存在这台 Mac 上，之后不会再显示出来。';
    if (m.hasKey) keyHint = m.keySource === 'env' ? `已经从环境变量 ${m.apiKeyEnv} 读到。在这里填了就改用这里的。` : '已经保存过。留空就不改。';
    return `<div class="providers" role="radiogroup" aria-label="服务商">${providers}</div>${p.note ? `<p class="hint">${esc(p.note)}</p>` : ''}`
      + (effortField ? `<div class="two">${modelField}${effortField}</div>` : modelField)
      + `<label>API Key<input class="field" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${m.hasKey ? '已保存' : '粘贴 API Key'}"><span class="hint">${esc(keyHint)}</span></label>`
      + `<label>接口地址<input class="field" name="baseUrl" value="${esc(d.baseUrl)}" inputmode="url" autocomplete="off" spellcheck="false" required><span class="hint">OpenAI 兼容的接口，形如 https://api.example.com/v1</span></label>`
      + '<div class="form-acts"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" data-action="model-test">测试连接</button><span class="test-line" role="status"></span></div>';
  }

  /** 重画模型区，保住正在填的 Key */
  function repaintModel() {
    const group = $('#model', main);
    if (!group) return;
    const typed = $('#model-form [name="key"]', main);
    const key = typed ? typed.value : '';
    group.outerHTML = modelGroupHtml();
    const again = $('#model-form [name="key"]', main);
    if (again && key) again.value = key;
  }

  function pickPreset(id) {
    const p = state.presets.find((x) => x.id === id);
    const d = modelDraft();
    if (!p || !d || d.preset === id) return;
    const form = $('#model-form', main);
    const key = form ? $('[name="key"]', form).value : '';
    state.modelDraft = { preset: id, model: p.model || '', baseUrl: p.baseUrl || '', reasoningEffort: '' };
    if (form) {
      form.innerHTML = modelFormHtml();
      $('[name="key"]', form).value = key;
      const checked = $(`[data-preset="${CSS.escape(id)}"]`, form);
      if (checked) checked.focus();
    }
  }

  function modelFormValues(form) {
    const fd = new FormData(form);
    const body = { preset: modelDraft().preset, model: String(fd.get('model') || '').trim(), baseUrl: String(fd.get('baseUrl') || '').trim() };
    if (fd.has('reasoningEffort')) body.reasoningEffort = String(fd.get('reasoningEffort'));
    const key = String(fd.get('key') || '').trim();
    if (key) body.key = key;
    return body;
  }

  async function saveModel(form) {
    const body = modelFormValues(form);
    await busy($('button[type="submit"]', form), async () => {
      try {
        const r = await api('/api/model/config', { method: 'PUT', body });
        state.model = r.config;
        state.modelDraft = null;
        const typed = $('[name="key"]', form);
        if (typed) typed.value = '';
        repaintModel();
        const canTurnOn = !modelOn() && (state.model.hasKey || state.model.keyOptional);
        toast('模型设置已保存', canTurnOn ? { action: { label: '打开 AI 整理', run: () => setModelEnabled(true) } } : {});
      } catch (err) {
        fail(err);
      }
    });
  }

  async function testModel(btn) {
    const form = btn.closest('form');
    const line = $('.test-line', form);
    line.className = 'test-line';
    line.textContent = '正在测试…';
    await busy(btn, async () => {
      try {
        const t = (await api('/api/model/test', { method: 'POST', body: modelFormValues(form) })).test || {};
        line.className = t.ok ? 'test-line ok' : 'test-line bad';
        line.textContent = t.ok ? `连接正常，${(Number(t.latencyMs || 0) / 1000).toFixed(1)} 秒有回应` : `没连上：${clip(t.error || '没有回应', 120)}`;
      } catch (err) {
        line.className = 'test-line bad';
        line.textContent = err.message;
      }
    });
  }

  async function setModelEnabled(on) {
    try {
      state.model = (await api('/api/model/config', { method: 'PUT', body: { enabled: on } })).config;
      if (on) state.analysis = await api('/api/analysis/status').catch(() => state.analysis);
      toast(on ? 'AI 整理已打开' : 'AI 整理已关闭');
    } catch (err) {
      fail(err);
    }
    repaintModel();
  }

  async function onModelSwitch(input) {
    const m = state.model || {};
    if (input.checked && !m.hasKey && !m.keyOptional) {
      input.checked = false;
      toast('先填上 API Key，保存以后再打开');
      const key = $('#model-form [name="key"]', main);
      if (key) key.focus();
      return;
    }
    input.disabled = true;
    await setModelEnabled(input.checked);
  }

  // ---------- 接入 AI 工具、数据 ----------

  function aiGroupHtml() {
    const head = '<h2>接入 AI 工具</h2><p class="section-sub">接好以后，在这些工具里直接问「我今天上午在做什么」「上周那个报错最后怎么解决的」。它们只能读，不能改。</p>';
    const integ = state.integrations;
    if (!integ) return `<section class="set-group" id="ai">${head}<div class="card"><p class="rule-empty">读不到接入信息。</p></div></section>`;
    const clients = (integ.tools || []).map((t) => `<div class="client"><div class="client-head">${icon(t.iconApp || t.label, { name: t.label })}<div><b>${esc(t.label)}</b><p>${esc(CLIENT_HINTS[t.kind] || '')}</p></div>`
      + `<button class="btn small" type="button" data-action="copy" data-copy-from="snip-${esc(t.id)}">复制</button></div>`
      + `<pre class="code" id="snip-${esc(t.id)}">${esc(t.snippet)}</pre>${t.path ? `<p class="path">${esc(t.path)}</p>` : ''}</div>`).join('');
    const cmd = integ.installer && integ.installer.command;
    const all = cmd
      ? `<div class="card">${rowHtml({ label: '一次接好全部', desc: '在终端里运行这一行，会把上面每个工具的配置都写好。写之前会先备份原来的文件。', side: '<button class="btn small" type="button" data-action="copy" data-copy-from="snip-installer">复制命令</button>' })}<div class="client-code"><pre class="code" id="snip-installer">${esc(cmd)}</pre></div></div>`
      : '';
    return `<section class="set-group" id="ai">${head}<div class="card">${clients}</div>${all}</section>`;
  }

  function dataGroupHtml() {
    const cfg = state.config || {};
    const days = Number((cfg.maintenance || {}).retentionDays) || 0;
    const choices = RETENTION_CHOICES.some(([n]) => n === days) ? RETENTION_CHOICES : [...RETENTION_CHOICES, [days, `保留 ${days} 天`]].sort((a, b) => a[0] - b[0]);
    const home = state.integrations && state.integrations.home;
    const where = home ? rowHtml({ label: '存放位置', desc: `<span class="mono">${esc(home)}</span>`, side: `<button class="btn small" type="button" data-action="copy" data-copy="${esc(home)}">复制路径</button>` }) : '';
    const select = `<select class="field" data-setting-select="retentionDays" aria-label="旧记录保留多久">${choices.map(([n, label]) => `<option value="${n}"${n === days ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    return '<section class="set-group" id="data"><h2>数据</h2><p class="section-sub">所有记录都是这台 Mac 上的普通文件。删掉就没了。</p>'
      + `<div class="card">${where}${rowHtml({ label: '旧记录保留多久', desc: '每 6 小时检查一次。只删原始记录和它们的摘要，记忆保留。', side: select })}</div>`
      + `<div class="card danger-zone">${rowHtml({ label: '清空全部记录', desc: '删除所有原始记录和 AI 摘要。设置、记忆和技能都保留。不能撤销。', side: '<button class="btn danger small" type="button" data-action="clear-history">清空…</button>' })}</div>`
      + '</section>';
  }

  async function clearAll() {
    const yes = await confirmDialog({
      title: '清空全部记录？',
      body: '所有原始记录和 AI 摘要都会被删除，找不回来。设置、记忆和技能会保留。',
      confirm: '清空',
      danger: true,
      typed: '清空',
    });
    if (!yes) return;
    try {
      const r = await api('/api/history', { method: 'DELETE' });
      toast(`已删除 ${fmtCount(r.removedSegments)} 段记录和 ${fmtCount(r.removedSummaries)} 份摘要`);
      state.day = null;
      await ensureDays(true);
    } catch (err) {
      fail(err);
    }
  }

  async function copyFrom(btn) {
    const source = btn.dataset.copyFrom ? document.getElementById(btn.dataset.copyFrom) : null;
    const text = btn.dataset.copy ?? (source ? source.textContent : '');
    if (!text) return;
    const ok = await copyText(text);
    toast(ok ? '已复制' : '没能复制，请手动选中后复制', { bad: !ok });
  }

  /* ================= 12. 事件与启动 ================= */

  const ACTIONS = {
    'status-open': () => openStatus(),
    'search-open': () => openSearch(),
    'cal-open': (btn) => openCalendar(btn),
    'day-prev': () => {
      const date = neighborDay(currentDate(), -1);
      if (date) goDay(date);
    },
    'day-next': () => {
      const date = neighborDay(currentDate(), 1);
      if (date) goDay(date);
    },
    'day-today': () => goDay(state.today),
    'chapter-more': (btn) => expandChapter(Number(btn.dataset.chapter), true),
    enable: () => setRecording(true),
    pause: (btn) => pause(Number(btn.dataset.sec) || 0),
    resume: () => resume(),
    'status-retry': () => refreshStatus(),
    'perm-ax': () => requestAx(),
    'perm-screen': () => requestScreen(),
    'analysis-retry': (btn) => retryAnalysis(btn),
    ocr: () => readWindowText(),
    reload: () => render(),
    'sheet-close': () => userCloseSheet(),
    'sheet-newer': () => stepSheet(1),
    'sheet-older': () => stepSheet(-1),
    'skill-save': (btn) => saveSkill(btn),
    'summarize-now': (btn) => summarizeNow(btn),
    'events-more': (btn) => {
      const box = btn.closest('.events');
      if (box) busy(btn, () => fillEvents(box, true));
    },
    'insight-gen': (btn) => generateInsight(btn),
    copy: (btn) => copyFrom(btn),
    'rule-add': (btn) => addRuleFromInput(btn.dataset.list),
    'rule-pick': (btn) => openRulePicker(btn),
    'rule-remove': (btn) => removeRule(btn.dataset.list, Number(btn.dataset.i)),
    'model-test': (btn) => testModel(btn),
    'clear-history': () => clearAll(),
  };

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || !(e.target instanceof Element)) return;
    const t = e.target;
    const nav = t.closest('a[data-nav]');
    if (nav) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const route = parseRoute(new URL(nav.href, location.href));
      if (route.view === 'settings' && state.route.view === 'settings' && $('.settings', main)) {
        closeAllLayers();
        replaceRoute({ section: route.section });
        scrollToSection(route.section);
        return;
      }
      go(route);
      return;
    }
    const open = t.closest('[data-open]');
    if (open && main.contains(open)) {
      const item = state.day && findItem(state.day, open.dataset.open);
      if (item) openItem(item);
      return;
    }
    const mem = t.closest('[data-mem]');
    if (mem) return openMemoryRow(mem.dataset.mem);
    const insight = t.closest('[data-insight]');
    if (insight) return openInsight(insight.dataset.insight);
    const preset = t.closest('[data-preset]');
    if (preset) return pickPreset(preset.dataset.preset);
    const act = t.closest('[data-action]');
    if (act && !act.disabled && Object.prototype.hasOwnProperty.call(ACTIONS, act.dataset.action)) ACTIONS[act.dataset.action](act);
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.matches('input[data-setting]')) onSettingChange(t);
    else if (t.matches('input[data-model]')) onModelSwitch(t);
    else if (t.matches('select[data-setting-select]')) onRetentionChange(t);
    else if (t.matches('select[data-adder-scope]')) t.dataset.touched = '1';
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.dataset.adder) return;
    const scope = t.parentElement && $('select[data-adder-scope]', t.parentElement);
    if (scope && !scope.dataset.touched) scope.value = guessScope(t.value);
  });

  document.addEventListener('submit', (e) => {
    if (e.target instanceof HTMLFormElement && e.target.id === 'model-form') {
      e.preventDefault();
      saveModel(e.target);
    }
  });

  // 折起来的「原始记录」第一次展开时才去读
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;
    const box = d.querySelector(':scope > .events[data-events]');
    if (box && !eventStore.has(box)) fillEvents(box);
  }, true);

  document.addEventListener('keydown', (e) => {
    const top = layers[layers.length - 1];
    if (e.key === 'Escape' && top) {
      e.preventDefault();
      dismiss(top);
      return;
    }
    if (e.key === 'Tab' && top && MODAL.has(top.kind)) {
      trapFocus(e, top.box);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSearch();
      return;
    }
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' && t instanceof HTMLInputElement && t.dataset.adder) return;
    if (e.key === '/' && !top) {
      e.preventDefault();
      openSearch();
    }
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Enter' && !e.isComposing && t instanceof HTMLInputElement && t.dataset.adder) {
      e.preventDefault();
      addRuleFromInput(t.dataset.adder);
    }
  });

  window.addEventListener('popstate', () => {
    const prev = state.route;
    const next = parseRoute(location);
    state.route = next;
    const sameDay = prev.view === 'day' && next.view === 'day' && state.day && (next.date || state.today) === state.day.date;
    if (sameDay && !next.at) {
      if (!next.open) {
        const sheet = sheetLayer();
        if (sheet) closeLayer(sheet);
        return;
      }
      const item = findItem(state.day, next.open);
      if (item) {
        showSheet(item);
        return;
      }
    }
    if (prev.view === 'settings' && next.view === 'settings' && $('.settings', main)) {
      closeAllLayers();
      scrollToSection(next.section);
      return;
    }
    render();
  });

  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });

  // 每 15 秒看一眼记录状态；今天的时间线每分钟悄悄刷新；过了午夜换到新的一天
  let lastSoft = Date.now();
  async function tick() {
    if (document.hidden) return;
    const today = dateKey(Date.now());
    if (today !== state.today && !layers.length) {
      state.today = today;
      ensureDays(true);
      if (state.route.view === 'day' && !state.route.date) {
        render();
        return;
      }
    }
    await refreshStatus();
    const quietDay = state.route.view === 'day' && state.day && state.day.isToday && !layers.some((l) => l.kind !== 'sheet');
    if (quietDay && Date.now() - lastSoft > MIN) {
      lastSoft = Date.now();
      softRender();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  onScroll();
  paintStatus();
  refreshStatus();
  render();
  setInterval(tick, 15 * 1000);
})();
