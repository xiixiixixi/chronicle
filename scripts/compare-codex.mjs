#!/usr/bin/env node
// scripts/compare-codex.mjs — 同窗口对比 Codex skysight 10min 摘要 vs Chronicle 摘要
// 用法：
//   node scripts/compare-codex.mjs --codex <codex.md> --chronicle <chronicle.md>
//   node scripts/compare-codex.mjs --window 2026-11-11T05-20-00（自动找 Codex resource 与最接近的 Chronicle 摘要）
// 只读本地文件，不联网；输出 Markdown 对照表（给用户/验收用的证据）。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const CODEX_DIR = path.join(HOME, '.codex/memories/extensions/skysight/resources');
const CHRON_DIR = path.join(HOME, '.chronicle/summaries');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--codex') out.codex = argv[++i];
    else if (argv[i] === '--chronicle') out.chronicle = argv[++i];
    else if (argv[i] === '--window') out.window = argv[++i];
    else if (argv[i] === '--batch') out.batch = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function parseFile(file) {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      const raw = line.slice(i + 1).trim();
      if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('"')) {
        try { meta[k] = JSON.parse(raw); } catch {
          // YAML flow 列表（Codex 的 applications: [a.b, c.d] 未加引号）
          if (raw.startsWith('[') && raw.endsWith(']')) {
            meta[k] = raw.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          } else meta[k] = raw;
        }
      } else meta[k] = raw;
    }
  }
  return { meta, body: (m ? m[2] : text) || '' };
}

const FILE_RE = /(?:[A-Za-z0-9_\-.\u4e00-\u9fff]+\/)*[A-Za-z0-9_\-.\u4e00-\u9fff]+\.(?:md|json|jsonl|xlsx|xls|pdf|pptx|docx|html|toml|ya?ml|ts|js|mjs|swift|py|csv|txt)\b/g;
const URL_RE = /https?:\/\/[^\s)）\]"']+/g;
const PATH_RE = /\/Users\/[^\s)）\]"',，。；：]+/g;
const RESULT_RE = /(成功|已完成|完成|失败|报错|未|没有|卡住|卡在|等待|无结果|未观察到|尚未)/g;

function metrics(file, kind) {
  const { meta, body } = parseFile(file);
  const all = body + '\n' + JSON.stringify(meta);
  const files = [...new Set((all.match(FILE_RE) || []).filter((x) => !/^\d+\.\d+$/.test(x)))];
  const urls = [...new Set(all.match(URL_RE) || [])];
  const paths = [...new Set(all.match(PATH_RE) || [])];
  const resultHits = (all.match(RESULT_RE) || []).length;
  const headings = [...body.matchAll(/^##+\s+(.+)$/gm)].map((m) => m[1].trim());
  const apps = Array.isArray(meta.applications) ? meta.applications.length : 0;
  const chars = body.length;
  return {
    kind, file, chars, files: files.length, urls: urls.length, paths: paths.length,
    resultHits, headings: headings.length, apps,
    title: meta.title || '', description: meta.description || '',
    headingList: headings, fileSamples: files.slice(0, 8), urlSamples: urls.slice(0, 5), pathSamples: paths.slice(0, 5),
    model: meta.model || '', promptVersion: meta.promptVersion || '',
  };
}

function pickCodex(window) {
  if (!existsSync(CODEX_DIR)) return null;
  const files = readdirSync(CODEX_DIR).filter((f) => f.endsWith('.md')).sort();
  if (window) {
    const hit = files.find((f) => f.includes(window));
    if (hit) return path.join(CODEX_DIR, hit);
  }
  return path.join(CODEX_DIR, files[files.length - 1]);
}

function pickChronicle(win) {
  if (!existsSync(CHRON_DIR)) return null;
  const files = readdirSync(CHRON_DIR).filter((f) => f.startsWith('10min-') && f.endsWith('.md')).sort();
  if (!files.length) return null;
  if (!win) return path.join(CHRON_DIR, files[files.length - 1]);
  // 找与 Codex 窗口时间最近的 Chronicle 段（按文件名时间戳）
  const target = win.replace(/Z$/, '');
  let best = null; let bestDelta = Infinity;
  for (const f of files) {
    const m = /^10min-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/.exec(f);
    if (!m) continue;
    const iso = `${m[1]}:${m[2]}:${m[3]}`;
    const delta = Math.abs(new Date(iso + 'Z').getTime() - new Date(target + 'Z').getTime());
    if (delta < bestDelta) { bestDelta = delta; best = f; }
  }
  return best ? path.join(CHRON_DIR, best) : path.join(CHRON_DIR, files[files.length - 1]);
}

function listAll(dir, re) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}

function runBatch(filter = '') {
  const codexFiles = listAll(CODEX_DIR, /-10min-.*\.md$/).filter((f) => !filter || f.includes(filter));
  const chronFiles = listAll(CHRON_DIR, /^10min-.*\.md$/);
  const rows = [];
  for (const cf of codexFiles) {
    const base = path.basename(cf);
    const wm = /(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-00/.exec(base);
    if (!wm) continue;
    const windowStart = `${wm[1]}:${wm[2]}:00`;
    const t0 = new Date(windowStart + 'Z').getTime();
    let best = null; let bestDelta = Infinity;
    for (const of of chronFiles) {
      const m = /^10min-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/.exec(path.basename(of));
      if (!m) continue;
      const t = new Date(`${m[1]}:${m[2]}:${m[3]}Z`).getTime();
      const delta = Math.abs(t - t0);
      if (delta < bestDelta) { bestDelta = delta; best = of; }
    }
    if (!best || bestDelta > 15 * 60 * 1000) continue;
    const c = metrics(cf, 'Codex'); const o = metrics(best, 'Chronicle');
    rows.push({ window: windowStart.slice(0, 16) + 'Z', codex: c, ours: o, deltaMin: Math.round(bestDelta / 60000) });
  }
  console.log('# 多窗口对照：Codex skysight vs Chronicle（同窗口 ±15 分钟）\n');
  console.log('| 窗口 | 版本 | 字符 Codex/我们 | 文件名 Codex/我们 | 绝对路径 Codex/我们 | URL Codex/我们 | 结果句 Codex/我们 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.window} | ${r.ours.promptVersion || 'v?'} | ${r.codex.chars}/${r.ours.chars} | ${r.codex.files}/${r.ours.files} | ${r.codex.paths}/${r.ours.paths} | ${r.codex.urls}/${r.ours.urls} | ${r.codex.resultHits}/${r.ours.resultHits} |`);
  }
  const sum = (k, side) => rows.reduce((a, r) => a + (side === 'c' ? r.codex[k] : r.ours[k]), 0);
  if (rows.length) {
    console.log(`\n**合计**：字符 Codex ${sum('chars','c')} vs 我们 ${sum('chars','o')}；文件名 ${sum('files','c')} vs ${sum('files','o')}；绝对路径 ${sum('paths','c')} vs ${sum('paths','o')}；URL ${sum('urls','c')} vs ${sum('urls','o')}；结果句 ${sum('resultHits','c')} vs ${sum('resultHits','o')}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.batch) { runBatch(args.batch === true ? '' : String(args.batch)); process.exit(0); }
const codexFile = args.codex || pickCodex(args.window);
const chronFile = args.chronicle || pickChronicle(args.window || path.basename(codexFile || ''));
if (!codexFile || !existsSync(codexFile)) { console.error('找不到 Codex 摘要文件'); process.exit(2); }
if (!chronFile || !existsSync(chronFile)) { console.error('找不到 Chronicle 摘要文件'); process.exit(2); }

const c = metrics(codexFile, 'Codex');
const o = metrics(chronFile, 'Chronicle');
const rows = [
  ['字符数', c.chars, o.chars],
  ['章节数', c.headings, o.headings],
  ['具体文件名', c.files, o.files],
  ['绝对路径', c.paths, o.paths],
  ['URL', c.urls, o.urls],
  ['结果/卡点句', c.resultHits, o.resultHits],
  ['应用数', c.apps, o.apps],
  ['模型', c.model, o.model],
];
const pad = (s, n) => String(s).padEnd(n);
console.log('# 同窗口对比：Codex skysight vs Chronicle\n');
console.log('| 指标 | Codex | Chronicle |\n|---|---|---|');
for (const [k, a, b] of rows) console.log(`| ${k} | ${a} | ${b} |`);
console.log('\n## 标题\n');
console.log(`- Codex: ${c.title}`);
console.log(`- Chronicle: ${o.title}`);
console.log('\n## 具体对象（文件/路径）\n');
console.log(`- Codex: ${c.fileSamples.join('、') || '—'}`);
console.log(`- Chronicle: ${o.fileSamples.join('、') || '—'}`);
console.log('\n## 章节\n');
console.log(`- Codex: ${c.headingList.join(' / ') || '—'}`);
console.log(`- Chronicle: ${o.headingList.join(' / ') || '—'}`);
