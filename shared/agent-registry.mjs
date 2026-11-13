// shared/agent-registry.mjs — Agent 注册 / 权限 / 信任（P2 后端 v0）
//
// 设计依据：docs/product-blueprint.md 第 15/16 章。
//   · Agent 默认 L0（只看）；L1 建议；L2 经批准执行；L3 范围内自主。
//   · 默认等级之外，可发临时 grant（带 scope / 过期时间）。
//   · 权限检查是纯函数，供未来的 agent 执行器 / MCP 写接口调用。
//   · 审计日志由 shared/audit.mjs 负责；本模块只做注册与授权。
//
// 存储：<home>/agents.json（原子写 0600）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chronicleHome } from './segments.mjs';

export const AGENT_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const AGENT_LEVEL_RANK = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3 });
export const AGENT_REGISTRY_VERSION = 1;

export class AgentRegistryError extends Error {
  constructor(message, code = 'AGENT_REGISTRY_ERROR') {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
  }
}

export function agentsPath(home = chronicleHome()) {
  return path.join(home, 'agents.json');
}

function emptyRegistry() {
  return { version: AGENT_REGISTRY_VERSION, agents: [] };
}

function normalizeLevel(level, fallback = 'L0') {
  const v = String(level ?? fallback).toUpperCase();
  if (!AGENT_LEVELS.includes(v)) throw new AgentRegistryError(`未知权限等级: ${level}（可用: ${AGENT_LEVELS.join('/')}）`, 'BAD_LEVEL');
  return v;
}

function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents)) return emptyRegistry();
  return {
    version: Number.isInteger(raw.version) ? raw.version : AGENT_REGISTRY_VERSION,
    agents: raw.agents.filter((a) => a && typeof a === 'object' && typeof a.id === 'string' && typeof a.name === 'string'),
  };
}

export function loadAgentRegistry(home = chronicleHome()) {
  const file = agentsPath(home);
  if (!existsSync(file)) return emptyRegistry();
  try { return normalizeRegistry(JSON.parse(readFileSync(file, 'utf8'))); } catch { return emptyRegistry(); }
}

export function saveAgentRegistry(home = chronicleHome(), registry = emptyRegistry()) {
  const file = agentsPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent';
}

function nowIso(now = Date.now()) {
  return new Date(now instanceof Date ? now.getTime() : Number(now) || Date.now()).toISOString();
}

function cleanList(list, max = 50) {
  const raw = Array.isArray(list) ? list : (typeof list === 'string' && list ? [list] : []);
  return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, max);
}

export function listAgents(home = chronicleHome()) {
  return loadAgentRegistry(home).agents;
}

export function getAgent(home = chronicleHome(), id) {
  return loadAgentRegistry(home).agents.find((a) => a.id === id) || null;
}

export function registerAgent(home = chronicleHome(), input = {}, { now = Date.now() } = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new AgentRegistryError('Agent 缺少 name', 'BAD_NAME');
  const registry = loadAgentRegistry(home);
  const base = slugify(input.id || name);
  let id = base;
  let n = 2;
  while (registry.agents.some((a) => a.id === id)) { id = `${base}-${n}`; n += 1; }
  const agent = {
    id,
    name,
    kind: String(input.kind || 'generic').slice(0, 60),
    default_level: normalizeLevel(input.default_level, 'L0'),
    scopes: cleanList(input.scopes),
    grants: [],
    trust: { success: 0, corrections: 0, incidents: 0 },
    created_at: nowIso(now),
    updated_at: nowIso(now),
  };
  registry.agents.push(agent);
  saveAgentRegistry(home, registry);
  return agent;
}

export function grantPermission(home = chronicleHome(), agentId, input = {}, { now = Date.now() } = {}) {
  const registry = loadAgentRegistry(home);
  const agent = registry.agents.find((a) => a.id === agentId);
  if (!agent) throw new AgentRegistryError(`Agent 不存在: ${agentId}`, 'NOT_FOUND');
  const level = normalizeLevel(input.level, 'L1');
  const grant = {
    id: `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    level,
    scopes: cleanList(input.scopes),
    object_id: String(input.object_id || '').slice(0, 160),
    thread_id: String(input.thread_id || '').slice(0, 160),
    created_at: nowIso(now),
    expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
  };
  agent.grants.push(grant);
  agent.updated_at = nowIso(now);
  saveAgentRegistry(home, registry);
  return grant;
}

export function revokeGrant(home = chronicleHome(), agentId, grantId, { now = Date.now() } = {}) {
  const registry = loadAgentRegistry(home);
  const agent = registry.agents.find((a) => a.id === agentId);
  if (!agent) throw new AgentRegistryError(`Agent 不存在: ${agentId}`, 'NOT_FOUND');
  const before = agent.grants.length;
  agent.grants = agent.grants.filter((g) => g.id !== grantId);
  if (agent.grants.length === before) throw new AgentRegistryError(`授权不存在: ${grantId}`, 'NOT_FOUND');
  agent.updated_at = nowIso(now);
  saveAgentRegistry(home, registry);
  return { ok: true };
}

function scopeMatches(grant, scope) {
  if (!grant.scopes || grant.scopes.length === 0) return true;
  if (!scope) return false;
  const s = String(scope);
  return grant.scopes.some((g) => g === '*' || g === s || s.startsWith(g.replace(/\*$/, '')));
}

/**
 * 检查 agent 是否达到 requiredLevel（L0..L3）且 scope 命中。
 * @returns {{allowed:boolean, level:string, reason:string, grant?:object}}
 */
export function checkPermission(home = chronicleHome(), agentId, { level = 'L0', scope = '', objectId = '', threadId = '', now = Date.now() } = {}) {
  const registry = loadAgentRegistry(home);
  const agent = registry.agents.find((a) => a.id === agentId);
  if (!agent) return { allowed: false, level: 'L0', reason: 'agent-not-found' };
  const required = normalizeLevel(level, 'L0');
  if (AGENT_LEVEL_RANK[agent.default_level] >= AGENT_LEVEL_RANK[required]) {
    return { allowed: true, level: agent.default_level, reason: 'default-level' };
  }
  for (const g of agent.grants || []) {
    if (AGENT_LEVEL_RANK[g.level] < AGENT_LEVEL_RANK[required]) continue;
    if (g.expires_at && Date.parse(g.expires_at) <= new Date(now).getTime()) continue;
    if (objectId && g.object_id && g.object_id !== objectId) continue;
    if (threadId && g.thread_id && g.thread_id !== threadId) continue;
    if (!scopeMatches(g, scope)) continue;
    return { allowed: true, level: g.level, reason: 'grant', grant: g };
  }
  return { allowed: false, level: agent.default_level, reason: 'no-grant' };
}

export function recordAgentOutcome(home = chronicleHome(), agentId, { success = 0, corrections = 0, incidents = 0 } = {}, { now = Date.now() } = {}) {
  const registry = loadAgentRegistry(home);
  const agent = registry.agents.find((a) => a.id === agentId);
  if (!agent) throw new AgentRegistryError(`Agent 不存在: ${agentId}`, 'NOT_FOUND');
  agent.trust = agent.trust || { success: 0, corrections: 0, incidents: 0 };
  agent.trust.success += Number(success) || 0;
  agent.trust.corrections += Number(corrections) || 0;
  agent.trust.incidents += Number(incidents) || 0;
  agent.updated_at = nowIso(now);
  saveAgentRegistry(home, registry);
  return agent;
}
