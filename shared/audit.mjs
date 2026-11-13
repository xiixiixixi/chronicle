// shared/audit.mjs — 本机审计日志（v0）
//
// 记录“谁对哪个对象做了什么”，用于：
//   · 工作对象的创建/更新/归档/洞察验证；
//   · 未来 agent 行动的审计与回滚依据。
//
// 存储：<home>/audit/<YYYY-MM-DD>.jsonl，逐行 JSON，默认 0600。
// 不记录密码/密钥；detail 由调用方保证脱敏。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chronicleHome } from './segments.mjs';

export function auditDir(home = chronicleHome()) {
  return path.join(home, 'audit');
}

export function auditPath(home = chronicleHome(), date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const key = Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
  return path.join(auditDir(home), `${key}.jsonl`);
}

/** 追加一条审计事件（原子到行级；appendFileSync 负责 O_APPEND）。 */
export function appendAudit(home = chronicleHome(), event = {}, { now = new Date() } = {}) {
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const file = auditPath(home, now);
  mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts,
    actor: String(event.actor || 'user').slice(0, 80),
    action: String(event.action || 'unknown').slice(0, 120),
    target: String(event.target || '').slice(0, 160),
    ok: event.ok !== false,
    detail: event.detail && typeof event.detail === 'object' ? event.detail : {},
  };
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return entry;
}

/** 读某天审计（新→旧），limit 默认 200。 */
export function listAudit(home = chronicleHome(), { date = new Date(), limit = 200 } = {}) {
  const file = auditPath(home, date);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out.slice(-Math.max(1, limit)).reverse();
}
