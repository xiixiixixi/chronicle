#!/usr/bin/env node
// scripts/work-ledger.mjs — 工作对象 / 洞察 / 闭环账本 CLI（P1 v0）
//
// 用法：
//   node scripts/work-ledger.mjs list [--type task] [--state inbox] [--query x] [--json]
//   node scripts/work-ledger.mjs add --type task --title "..." [--next "..."] [--due ISO] [--review ISO] [--project id] [--evidence a.md,b.md]
//   node scripts/work-ledger.mjs update <id> --state doing [--next "..."] [--due ISO] [--review ISO]
//   node scripts/work-ledger.mjs archive <id> [--reason "..."]
//   node scripts/work-ledger.mjs seed [--hours 48] [--max 10]
//   node scripts/work-ledger.mjs sweep
//   node scripts/work-ledger.mjs exceptions
//   node scripts/work-ledger.mjs review [--cadence today|week|month]
//   node scripts/work-ledger.mjs insight add --claim "..." --evidence a.md,b.md [--confidence 0.7]
//   node scripts/work-ledger.mjs insight list [--status candidate]
//   node scripts/work-ledger.mjs insight validate|refute|apply|retire <id> [...]
//   node scripts/work-ledger.mjs coverage [--days 7]
//   node scripts/work-ledger.mjs team export [--project id] [--days 30] [--out pack.json]
//   node scripts/work-ledger.mjs team import <pack.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { chronicleHome } from '../shared/segments.mjs';
import {
  WORK_TYPES, WORK_CAPS, createObject, updateObject, archiveObject, listObjects,
  computeExceptions, reviewQueue, sweepLedger, seedFromSummaries, createInsight,
  validateInsight, applyInsight, retireInsight, listInsights, generateCandidateInsights, workStats, buildContextPack,
} from '../shared/work-ledger.mjs';
import { buildCoverage } from '../shared/coverage.mjs';
import { buildTeamPack, importTeamPack } from '../shared/team.mjs';

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out.flags[key] = true; continue; }
    out.flags[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const home = args.flags.home ? String(args.flags.home) : chronicleHome();
const json = Boolean(args.flags.json);
const cmd = args._[0] || 'list';

function out(value) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  if (typeof value === 'string') { console.log(value); return; }
  console.log(JSON.stringify(value, null, 2));
}

function short(text, n = 70) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmtList(items) {
  if (!items.length) return '(空)';
  return items.map((o) => `${o.id}  ${o.type}/${o.state}  ${short(o.title)}\n  next: ${short(o.next_action || '—')}${o.due_at ? `\n  due: ${o.due_at}` : ''}`).join('\n\n');
}

function fmtExceptions(items) {
  if (!items.length) return '没有需要关注的对象。';
  return items.map((e) => `[${e.severity}] ${e.kind}  ${e.object_id || ''}\n  ${e.message}`).join('\n');
}

function fmtReview(r) {
  const lines = [`复盘：${r.cadence}（${r.generated_at}）`, `活跃 ${r.counts.active} · 项目 ${r.counts.projects} · 目标 ${r.counts.goals} · 洞察 ${r.counts.insights} · 异常 ${r.counts.exceptions}`, ''];
  lines.push('优先对象：');
  lines.push(fmtList(r.priorities));
  lines.push('', '到期/即将到期：');
  lines.push(fmtList(r.due));
  lines.push('', '异常：');
  lines.push(fmtExceptions(r.exceptions));
  lines.push('', '洞察：');
  lines.push(r.insights.length ? r.insights.map((i) => `${i.id}  ${i.state}  ${short(i.claim)}  conf=${i.confidence}`).join('\n') : '(空)');
  return lines.join('\n');
}

function evidenceList(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

try {
  if (cmd === 'list') {
    const items = listObjects(home, {
      type: args.flags.type, state: args.flags.state, query: args.flags.query,
      limit: Number(args.flags.limit) || 50, includeArchived: Boolean(args.flags.all),
    });
    out(json ? items : fmtList(items));
  } else if (cmd === 'add') {
    if (!args.flags.type || !args.flags.title) throw new Error('add 需要 --type 和 --title');
    const obj = createObject(home, {
      type: args.flags.type,
      title: args.flags.title,
      state: args.flags.state,
      next_action: args.flags.next,
      due_at: args.flags.due,
      review_at: args.flags.review,
      project_id: args.flags.project,
      goal_id: args.flags.goal,
      evidence: evidenceList(args.flags.evidence),
      source: args.flags.source || 'cli',
    });
    out(json ? obj : `已创建 ${obj.id}  ${obj.type}/${obj.state}  ${obj.title}`);
  } else if (cmd === 'update') {
    const id = args._[1];
    if (!id) throw new Error('update 需要对象 id');
    const obj = updateObject(home, id, {
      state: args.flags.state,
      next_action: args.flags.next,
      due_at: args.flags.due,
      review_at: args.flags.review,
      project_id: args.flags.project,
      goal_id: args.flags.goal,
      title: args.flags.title,
    });
    out(json ? obj : `已更新 ${obj.id}  ${obj.type}/${obj.state}  ${obj.title}`);
  } else if (cmd === 'archive') {
    const id = args._[1];
    if (!id) throw new Error('archive 需要对象 id');
    const obj = archiveObject(home, id, args.flags.reason || 'manual');
    out(json ? obj : `已归档 ${obj.id}  ${obj.title}`);
  } else if (cmd === 'seed') {
    const r = seedFromSummaries(home, {
      sinceHours: Number(args.flags.hours) || 48,
      maxCreate: Number(args.flags.max) || 10,
    });
    out(json ? r : `从摘要生成 ${r.created.length} 个 inbox Task，跳过 ${r.skipped.length} 个\n` + fmtList(r.created));
  } else if (cmd === 'sweep') {
    const r = sweepLedger(home);
    out(json ? r : `sweep 完成：${r.changes.length} 个变更\n` + (r.changes.length ? r.changes.map((c) => `${c.id}  ${c.action}`).join('\n') : '(无)'));
  } else if (cmd === 'exceptions') {
    const items = computeExceptions(home);
    out(json ? items : fmtExceptions(items));
  } else if (cmd === 'review') {
    const r = reviewQueue(home, { cadence: args.flags.cadence || 'today' });
    out(json ? r : fmtReview(r));
  } else if (cmd === 'coverage') {
    const cov = buildCoverage(home, { days: args.flags.days || 7 });
    if (json) out(cov);
    else {
      const s = cov.summary;
      out(`近 ${cov.days} 天 · ${s.apps} 个应用 · good ${s.good} / thin ${s.thin} / none ${s.none}`);
      for (const a of cov.apps.slice(0, 20)) {
        out(`${(a.appName || a.bundleId).padEnd(16).slice(0, 16)}  ${String(a.activeMinutes + 'm').padStart(5)}  ${a.coverage.padEnd(6)}  ${a.reason}`);
      }
      if (s.zeroAxApps.length) out(`\n零 AX 盲区：${s.zeroAxApps.map((a) => a.appName).join('、')}`);
    }
  } else if (cmd === 'team' && args._[1] === 'export') {
    const pack = buildTeamPack(home, {
      projectId: args.flags.project || args.flags.projectId || '',
      days: args.flags.days || 30,
    });
    if (args.flags.out) {
      writeFileSync(String(args.flags.out), JSON.stringify(pack, null, 2));
      out(`已写入 ${args.flags.out}（${pack.stats.objects} 个对象，${pack.stats.insights} 条洞察）`);
    } else out(pack);
  } else if (cmd === 'team' && args._[1] === 'import') {
    const file = args._[2];
    if (!file) { out('用法: work-ledger.mjs team import <pack.json>'); process.exitCode = 2; }
    else {
      const pack = JSON.parse(readFileSync(file, 'utf8'));
      const r = importTeamPack(home, pack);
      out(`导入 ${r.imported} 个对象${r.skipped.length ? `，跳过 ${r.skipped.length} 个：${r.skipped.map((x) => x.reason).slice(0, 3).join(' / ')}` : ''}`);
    }
  } else if (cmd === 'pack') {
    const pack = buildContextPack(home, {
      objectIds: args.flags.object ? String(args.flags.object).split(',').map((s) => s.trim()).filter(Boolean) : [],
      projectId: args.flags.project || '',
      limit: Number(args.flags.limit) || 100,
    });
    if (args.flags.out) {
      writeFileSync(String(args.flags.out), JSON.stringify(pack, null, 2));
      out(`已写入 ${args.flags.out}（${pack.objects.length} 个对象，${pack.insights.length} 条洞察）`);
    } else out(json ? pack : JSON.stringify(pack, null, 2));
  } else if (cmd === 'stats') {
    const st = workStats(home);
    out(json ? st : `对象 ${st.total}（活跃 ${st.active} · 归档 ${st.archived} · Inbox ${st.inbox}）\n任务闭环率 ${(st.taskClosureRate * 100).toFixed(0)}% · 承诺闭环率 ${(st.commitmentClosureRate * 100).toFixed(0)}%\n洞察：候选 ${st.insights.candidate} · 已验证 ${st.insights.validated} · 已应用 ${st.insights.applied} · 验证率 ${(st.insights.validationRate * 100).toFixed(0)}% · 应用率 ${(st.insights.applicationRate * 100).toFixed(0)}%\n异常 ${st.exceptions.total}（critical ${st.exceptions.critical} / warn ${st.exceptions.warn} / info ${st.exceptions.info}）· 无主率 ${(st.orphanRate * 100).toFixed(0)}%`);
  } else if (cmd === 'insight') {
    const sub = args._[1] || 'list';
    if (sub === 'add') {
      const evidence = evidenceList(args.flags.evidence);
      const obj = createInsight(home, {
        claim: args.flags.claim || args.flags.title,
        evidence,
        confidence: args.flags.confidence !== undefined ? Number(args.flags.confidence) : 0.5,
        scope: args.flags.scope,
        suggested_action: args.flags.action,
        expiry: args.flags.expiry,
      });
      out(json ? obj : `已创建洞察 ${obj.id}  ${obj.title}`);
    } else if (sub === 'list') {
      const items = listInsights(home, { status: args.flags.status, query: args.flags.query, limit: Number(args.flags.limit) || 50 });
      out(json ? items : (items.length ? items.map((i) => `${i.id}  ${i.state}  ${short(i.claim)}  conf=${i.confidence}  evidence=${i.evidence.length}`).join('\n') : '(空)'));
    } else if (sub === 'generate') {
      const r = generateCandidateInsights(home, { minSupport: Number(args.flags.min) || 3, maxCreate: Number(args.flags.max) || 3 });
      out(json ? r : `生成 ${r.created.length} 条候选洞察，跳过 ${r.skipped.length} 个\n` + (r.created.length ? r.created.map((i) => `${i.id}  ${short(i.title)}`).join('\n') : '(无)'));
    } else {
      const id = args._[2];
      if (!id) throw new Error(`insight ${sub} 需要 id`);
      const obj = sub === 'validate' ? validateInsight(home, id, { note: args.flags.note })
        : sub === 'refute' ? validateInsight(home, id, { refute: true, note: args.flags.note })
          : sub === 'apply' ? applyInsight(home, id, { appliedTo: args.flags.to, note: args.flags.note })
            : sub === 'retire' ? retireInsight(home, id, args.flags.reason)
              : null;
      if (!obj) throw new Error(`未知 insight 子命令: ${sub}`);
      out(json ? obj : `洞察 ${obj.id} → ${obj.state}`);
    }
  } else if (cmd === 'help' || cmd === '--help') {
    console.log(`用法: node scripts/work-ledger.mjs <list|add|update|archive|seed|sweep|exceptions|review|insight> [...]
类型: ${WORK_TYPES.join(' / ')}
上限: project=${WORK_CAPS.project}, goal=${WORK_CAPS.goal}, insight=${WORK_CAPS.insight}`);
  } else {
    throw new Error(`未知命令: ${cmd}`);
  }
} catch (err) {
  console.error(`[work-ledger] ${err.message}`);
  process.exitCode = 1;
}
