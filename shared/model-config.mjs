// shared/model-config.mjs — 模型配置（服务商预设 / 归一化 / 密钥安全 / 连接测试）
//
// 职责（N1）：
//   ① 预设：minimax / deepseek / openai / ollama / custom（Base URL + 默认模型 + 模型列表）
//   ② 读写 config.json 的 `summarizer` 段（保留旧字段兼容：enabled/provider/baseUrl/model/
//      apiKeyEnv/timeoutMs/maxChars；新增 preset）
//   ③ **密钥安全（红线）**：key 绝不写入 config.json；只写 `<home>/secrets.json`（0600），
//      读取优先级 secrets → apiKeyEnv 环境变量 → 无；对外只回 hasKey/keySource，永不回显 key，
//      也绝不把 key 写进日志/错误信息。
//   ④ 连接测试：先 GET /models（失败不致命），再发一条 max_tokens=64 的固定 "ping" 对话；
//      （推理型模型在极小 max_tokens 下可能把额度全花在 reasoning 上、content 为空——
//       因此 HTTP 200 且返回非空 choices 即视为连通，不因 content 为空误判失败）
//      全程不发送任何用户事件数据。
//   ⑤ 模型输出工具：stripReasoning（去 <think>/<reasoning>）、extractJson（平衡括号扫描）。
//
// 本模块只依赖 node 内建，不 import 其它内部模块（避免循环依赖）。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** 密钥文件名与字段名（只在服务端内部使用，绝不通过 API 返回）。 */
export const SECRETS_FILE = 'secrets.json';
export const SECRETS_FIELD = 'openaiCompatibleKey';
/** 测试连接时发送的固定内容（不含任何用户数据）。 */
export const PING_PROMPT = 'ping';
/** 默认超时/上限（与 summarize.mjs 保持一致）。 */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_CHARS = 30_000;
export const DEFAULT_MAX_TOKENS = 8_000;
export const TIMEOUT_RANGE = { min: 1_000, max: 600_000 };
export const MAX_CHARS_RANGE = { min: 1_000, max: 200_000 };
export const MAX_TOKENS_RANGE = { min: 256, max: 32_000 };
/** 推理强度取值（'' = 不传 reasoning_effort，由服务商默认）。 */
export const REASONING_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 模型能力：只有 MiniMax-M3.1 系支持 reasoning_effort（且默认 max 会烧光输出预算，
 * 摘要场景推荐 low）；M3/M2.x 传了会被服务商忽略或报错，因此 UI 默认不展示。
 */
export function modelCapabilities(model) {
  const id = String(model ?? '');
  const isM31 = /MiniMax-M3\.1/i.test(id);
  return {
    reasoningEffort: isM31
      ? { supported: true, values: REASONING_EFFORTS, recommended: 'low', note: 'M3.1 默认 max 档会耗尽输出预算；摘要建议 low。' }
      : { supported: false, values: [], recommended: '', note: '当前模型不支持推理强度设置。' },
  };
}

/** 服务商预设。models 为「已实测可用」的候选列表（UI 可展示，真实列表以 /models 为准）。 */
export const MODEL_PRESETS = {
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3.1-Flash',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1'],
    apiKeyEnv: 'MINIMAX_API_KEY',
    keyOptional: false,
    note: 'MiniMax-M2 已下线；M2.7-highspeed 可能把思考过程混在 content 里（已自动剥离）。',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    keyOptional: false,
    note: '',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    apiKeyEnv: 'OPENAI_API_KEY',
    keyOptional: false,
    note: '需要可访问 api.openai.com 的网络。',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b'],
    apiKeyEnv: '',
    keyOptional: true,
    note: '本地模型，API Key 可留空；数据不出本机。',
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    models: [],
    apiKeyEnv: '',
    keyOptional: true,
    note: '任何 OpenAI 兼容端点：填 Base URL（以 /v1 结尾）与模型名。',
  },
};

export const PRESET_IDS = Object.keys(MODEL_PRESETS);
export const PROVIDERS = ['openai-compatible', 'none'];

/** 默认配置（未配置时给 UI 的初值：MiniMax，但默认不启用）。 */
export const DEFAULT_MODEL_CONFIG = Object.freeze({
  enabled: false,
  preset: 'minimax',
  provider: 'openai-compatible',
  baseUrl: MODEL_PRESETS.minimax.baseUrl,
  model: MODEL_PRESETS.minimax.model,
  apiKeyEnv: MODEL_PRESETS.minimax.apiKeyEnv,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxChars: DEFAULT_MAX_CHARS,
  maxTokens: DEFAULT_MAX_TOKENS,
  reasoningEffort: '',
});

// ---------- 基础工具 ----------

function homeDir(home) {
  return home && String(home).length ? path.resolve(String(home)) : path.join(os.homedir(), '.chronicle');
}

function configFile(home) { return path.join(homeDir(home), 'config.json'); }
function secretsFile(home) { return path.join(homeDir(home), SECRETS_FILE); }

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 原子写（同目录 tmp → rename），失败清理 tmp 并上抛。 */
function writeFileAtomic(file, contents, mode) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, contents, mode ? { mode } : undefined);
    if (mode) { try { chmodSync(tmp, mode); } catch { /* 部分文件系统不支持 */ } }
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 已清理 */ }
    throw err;
  }
}

function clampInt(value, { min, max }, fallback) {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 预设查找（未知 → custom）。 */
export function getPreset(id) {
  return MODEL_PRESETS[String(id ?? '')] ?? MODEL_PRESETS.custom;
}

// ---------- 归一化 / 校验 ----------

/**
 * 归一化模型配置（容错；不做合法性拒绝——拒绝交给 validateModelConfig/save）。
 * @param {object} input
 * @returns {{enabled:boolean,preset:string,provider:string,baseUrl:string,model:string,apiKeyEnv:string,timeoutMs:number,maxChars:number}}
 */
export function normalizeModelConfig(input = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let preset = typeof src.preset === 'string' && MODEL_PRESETS[src.preset] ? src.preset : '';
  let baseUrl = typeof src.baseUrl === 'string' ? src.baseUrl.trim().replace(/\/+$/, '') : '';
  let model = typeof src.model === 'string' ? src.model.trim() : '';
  let apiKeyEnv = typeof src.apiKeyEnv === 'string' ? src.apiKeyEnv.trim() : '';
  // 预设提供缺省值（只在字段为空时补，不覆盖用户显式值）
  if (preset && preset !== 'custom') {
    const p = MODEL_PRESETS[preset];
    if (!baseUrl) baseUrl = p.baseUrl;
    if (!model) model = p.model;
    if (!apiKeyEnv && p.apiKeyEnv) apiKeyEnv = p.apiKeyEnv;
  }
  // 没给 preset 时按 baseUrl 反推（旧配置兼容：只有 baseUrl/model 的老用户）
  if (!preset) {
    const hit = PRESET_IDS.find((id) => id !== 'custom' && MODEL_PRESETS[id].baseUrl && MODEL_PRESETS[id].baseUrl === baseUrl);
    preset = hit ?? 'custom';
  }
  return {
    enabled: src.enabled === true,
    preset,
    provider: PROVIDERS.includes(src.provider) ? src.provider : 'openai-compatible',
    baseUrl,
    model,
    apiKeyEnv,
    timeoutMs: clampInt(src.timeoutMs, TIMEOUT_RANGE, DEFAULT_TIMEOUT_MS),
    maxChars: clampInt(src.maxChars, MAX_CHARS_RANGE, DEFAULT_MAX_CHARS),
    maxTokens: clampInt(src.maxTokens, MAX_TOKENS_RANGE, DEFAULT_MAX_TOKENS),
    reasoningEffort: REASONING_EFFORTS.includes(src.reasoningEffort) ? src.reasoningEffort : '',
  };
}

/**
 * 校验模型配置合法性（写接口 PUT 的闸门）。
 * @returns {string[]} 错误列表（空 = 合法）
 */
export function validateModelConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['配置须为 JSON 对象'];
  if (typeof cfg.enabled !== 'boolean') errors.push('enabled 须为布尔值');
  if (!PRESET_IDS.includes(cfg.preset)) errors.push(`preset 须为 ${PRESET_IDS.join('/')} 之一`);
  if (!PROVIDERS.includes(cfg.provider)) errors.push(`provider 须为 ${PROVIDERS.join('/')} 之一`);
  // baseUrl：必须是 http(s) 绝对 URL
  const baseUrl = String(cfg.baseUrl ?? '');
  if (!baseUrl) errors.push('baseUrl 不能为空（形如 https://api.example.com/v1）');
  else if (!/^https?:\/\//i.test(baseUrl)) errors.push('baseUrl 必须以 http:// 或 https:// 开头');
  else {
    try { const u = new URL(baseUrl); if (!u.hostname) errors.push('baseUrl 缺少主机名'); } catch { errors.push('baseUrl 不是合法 URL'); }
    if (/[\s"'`<>]/.test(baseUrl)) errors.push('baseUrl 不能包含空白或引号');
  }
  // model：非空且不含控制字符
  const model = String(cfg.model ?? '');
  if (!model.trim()) errors.push('model 不能为空');
  else if (/[\u0000-\u001f\u007f]/.test(model)) errors.push('model 含非法控制字符');
  // 数值范围
  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < TIMEOUT_RANGE.min || cfg.timeoutMs > TIMEOUT_RANGE.max) {
    errors.push(`timeoutMs 须为 ${TIMEOUT_RANGE.min}..${TIMEOUT_RANGE.max} 的整数`);
  }
  if (!Number.isInteger(cfg.maxChars) || cfg.maxChars < MAX_CHARS_RANGE.min || cfg.maxChars > MAX_CHARS_RANGE.max) {
    errors.push(`maxChars 须为 ${MAX_CHARS_RANGE.min}..${MAX_CHARS_RANGE.max} 的整数`);
  }
  if (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens < MAX_TOKENS_RANGE.min || cfg.maxTokens > MAX_TOKENS_RANGE.max) {
    errors.push(`maxTokens 须为 ${MAX_TOKENS_RANGE.min}..${MAX_TOKENS_RANGE.max} 的整数`);
  }
  if (!REASONING_EFFORTS.includes(cfg.reasoningEffort)) {
    errors.push(`reasoningEffort 须为 ${REASONING_EFFORTS.map((x) => x || '(auto)').join('/')} 之一`);
  }
  if (typeof cfg.apiKeyEnv !== 'string' || /[\s=]/.test(cfg.apiKeyEnv)) errors.push('apiKeyEnv 须为环境变量名（不含空白/=）');
  return errors;
}

// ---------- 密钥（secrets.json，0600） ----------

/**
 * 读取 secrets（内部用；不对外暴露 key）。损坏/缺失返回 null。
 * @returns {string|null}
 */
export function readSecretKey(home) {
  const file = secretsFile(home);
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = raw[SECRETS_FIELD];
  return typeof key === 'string' && key.trim().length ? key.trim() : null;
}

/** secrets 文件是否已是 0600（测试/诊断用）。 */
export function secretsMode(home) {
  try { return statSync(secretsFile(home)).mode & 0o777; } catch { return null; }
}

/**
 * 写入 API Key：<home>/secrets.json（目录 0700、文件 0600）；内容只在磁盘上，不回显。
 * @returns {{ok:true, mode:number}}
 */
export function saveApiKey(home, key) {
  const value = String(key ?? '').trim();
  if (!value) throw Object.assign(new Error('API Key 不能为空'), { code: 'INVALID_MODEL_CONFIG' });
  const dir = homeDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* 部分文件系统不支持 */ }
  const payload = { [SECRETS_FIELD]: value, updatedAt: new Date().toISOString() };
  writeFileAtomic(secretsFile(dir), `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  try { chmodSync(secretsFile(dir), 0o600); } catch { /* 忽略 */ }
  return { ok: true, mode: secretsMode(dir) };
}

/** 清除已保存的 API Key（文件保留为空对象，避免误删其它未来字段）。 */
export function clearApiKey(home) {
  const dir = homeDir(home);
  if (!existsSync(secretsFile(dir))) return { ok: true, mode: null };
  writeFileAtomic(secretsFile(dir), `${JSON.stringify({}, null, 2)}\n`, 0o600);
  try { chmodSync(secretsFile(dir), 0o600); } catch { /* 忽略 */ }
  return { ok: true, mode: secretsMode(dir) };
}

/**
 * 解析实际使用的 API Key（优先级：secrets → apiKeyEnv 环境变量 → 无）。
 * 返回值只在服务端内部流转，绝不通过 HTTP 返回。
 * @returns {{key:string, source:'secrets'|'env'|'none'}}
 */
export function resolveApiKey(home, cfg = {}, env = process.env) {
  const fileKey = readSecretKey(home);
  if (fileKey) return { key: fileKey, source: 'secrets' };
  const envName = typeof cfg?.apiKeyEnv === 'string' ? cfg.apiKeyEnv.trim() : '';
  const envValue = envName ? env?.[envName] : '';
  if (typeof envValue === 'string' && envValue.trim().length) return { key: envValue.trim(), source: 'env' };
  return { key: '', source: 'none' };
}

/**
 * 对外安全视图：绝不含 key，只说明「有没有 / 从哪来」。
 * @returns {object} 归一化配置 + hasKey/keySource
 */
export function redactConfig(home, cfg, env = process.env) {
  const normalized = normalizeModelConfig(cfg ?? {});
  const { source } = resolveApiKey(home, normalized, env);
  const preset = getPreset(normalized.preset);
  return {
    ...normalized,
    hasKey: source !== 'none',
    keySource: source,
    presetLabel: preset.label,
    presetModels: Array.isArray(preset.models) ? [...preset.models] : [],
    keyOptional: preset.keyOptional === true,
    presetNote: preset.note ?? '',
    capabilities: modelCapabilities(normalized.model),
  };
}

// ---------- 读写配置 ----------

/**
 * 读模型配置（config.json 的 summarizer 段；缺失时给默认值）。
 * @returns 归一化配置
 */
export function loadModelConfig(home) {
  const raw = readJson(configFile(home));
  const section = raw && typeof raw.summarizer === 'object' && raw.summarizer !== null && !Array.isArray(raw.summarizer)
    ? raw.summarizer
    : null;
  if (!section) return normalizeModelConfig(DEFAULT_MODEL_CONFIG);
  return normalizeModelConfig(section);
}

/** 允许通过 API 修改的字段（防止写入任意键）。 */
const EDITABLE_FIELDS = ['enabled', 'preset', 'provider', 'baseUrl', 'model', 'apiKeyEnv', 'timeoutMs', 'maxChars', 'maxTokens', 'reasoningEffort'];

/**
 * 保存模型配置（只更新 config.json 的 summarizer 段，其它配置键原样保留）。
 * patch 里若有 key/apiKey：写入 secrets.json（0600），绝不落到 config.json。
 * @param {string} home
 * @param {object} patch
 * @param {{env?:object}} [opts]
 * @returns 归一化后的配置（不含 key）
 * @throws {Error & {code:'INVALID_MODEL_CONFIG', errors:string[]}}
 */
export function saveModelConfig(home, patch = {}, { env = process.env } = {}) {
  const dir = homeDir(home);
  const file = configFile(dir);
  const raw = readJson(file);
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const prevSection = base.summarizer && typeof base.summarizer === 'object' && !Array.isArray(base.summarizer) ? base.summarizer : {};

  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const hasKeyField = Object.prototype.hasOwnProperty.call(input, 'key') || Object.prototype.hasOwnProperty.call(input, 'apiKey');
  const rawKey = Object.prototype.hasOwnProperty.call(input, 'key') ? input.key : input.apiKey;

  const patchFields = {};
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) patchFields[field] = input[field];
  }
  // 换预设且未显式给 baseUrl/model → 用预设默认值
  const prevCfg = normalizeModelConfig({ ...DEFAULT_MODEL_CONFIG, ...prevSection });
  let candidate = normalizeModelConfig({
    ...prevCfg,
    ...patchFields,
    preset: patchFields.preset ?? prevCfg.preset,
  });
  if (Object.prototype.hasOwnProperty.call(patchFields, 'preset') && patchFields.preset !== prevCfg.preset) {
    const preset = getPreset(patchFields.preset);
    if (!Object.prototype.hasOwnProperty.call(patchFields, 'baseUrl') && preset.baseUrl) candidate.baseUrl = preset.baseUrl;
    if (!Object.prototype.hasOwnProperty.call(patchFields, 'model') && preset.model) candidate.model = preset.model;
    if (!Object.prototype.hasOwnProperty.call(patchFields, 'apiKeyEnv') && preset.apiKeyEnv && !prevSection.apiKeyEnv) candidate.apiKeyEnv = preset.apiKeyEnv;
  }
  const errors = validateModelConfig(candidate);
  if (errors.length) {
    throw Object.assign(new Error(`模型配置无效：${errors[0]}`), { code: 'INVALID_MODEL_CONFIG', errors });
  }

  // 先写密钥（失败则不写 config，避免「配置说已启用但没 key」的半状态）
  if (hasKeyField) {
    const value = rawKey === null || rawKey === undefined ? '' : String(rawKey).trim();
    if (value) saveApiKey(dir, value);
    else clearApiKey(dir); // 显式空串 = 清除
  }

  base.summarizer = { ...prevSection, ...candidate };
  writeFileAtomic(file, `${JSON.stringify(base, null, 2)}\n`);
  return candidate;
}

// ---------- 连接测试（不含任何用户数据） ----------

function pickModels(payload) {
  const list = payload?.data ?? payload?.models ?? [];
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id ?? item?.name ?? item?.model;
    if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  }
  return ids;
}

/**
 * 测试模型连接：GET /models（失败不致命）+ 一条 max_tokens=64 的 "ping" 对话。
 * @param {{cfg:object, apiKey?:string, fetchImpl?:Function, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, latencyMs:number, models:string[], chatOk:boolean,
 *   modelsOk:boolean, error?:string, modelsError?:string, httpStatus?:number}>}
 */
export async function testModelConfig({ cfg, apiKey = '', fetchImpl, timeoutMs = 15_000 } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const started = Date.now();
  const normalized = normalizeModelConfig(cfg ?? {});
  const baseUrl = normalized.baseUrl;
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const result = { ok: false, latencyMs: 0, models: [], chatOk: false, modelsOk: false };
  if (typeof doFetch !== 'function') {
    return { ...result, latencyMs: Date.now() - started, error: '本环境无 fetch（需要 Node 18+）' };
  }
  const budget = clampInt(timeoutMs, { min: 1_000, max: 60_000 }, 15_000);

  // ① /models（可选能力：很多兼容端点不实现，失败不致命）
  try {
    const res = await doFetch(`${baseUrl}/models`, { method: 'GET', headers, signal: AbortSignal.timeout(budget) });
    if (res?.ok) {
      const payload = await res.json().catch(() => null);
      result.models = pickModels(payload);
      result.modelsOk = true;
    } else {
      result.modelsError = `HTTP ${res?.status ?? '?'}`;
    }
  } catch (err) {
    result.modelsError = `请求失败: ${err?.message ?? err}`;
  }

  // ② 固定 ping 对话（决定性判定；不含任何用户事件数据）
  try {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        messages: [{ role: 'user', content: PING_PROMPT }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(budget),
    });
    result.httpStatus = res?.status ?? null;
    if (!res?.ok) {
      const detail = await res?.text?.().catch?.(() => '') ?? '';
      result.error = `HTTP ${res?.status ?? '?'}${detail ? `：${String(detail).slice(0, 160)}` : ''}`;
    } else {
      const payload = await res.json().catch(() => null);
      const choice = payload?.choices?.[0];
      const content = choice?.message?.content;
      const hasChoices = Array.isArray(payload?.choices) && payload.choices.length > 0;
      if (hasChoices && typeof content === 'string' && content.trim()) {
        result.chatOk = true;
      } else if (hasChoices) {
        // 推理型模型可能把 max_tokens 全用于 reasoning，content 为空；有 choices 即证明端点可用。
        // 记录 note 供 UI 区分「连通但轻量返回」，摘要调用（大预算）不受影响。
        result.chatOk = true;
        result.note = '模型已响应（本次轻量探测无正文；推理型模型正常现象）';
      } else {
        result.error = '返回内容为空且无 choices（模型未按 OpenAI 兼容格式响应）';
      }
    }
  } catch (err) {
    result.error = `请求失败: ${err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `超时（${budget}ms）` : err?.message ?? err}`;
  }

  result.ok = result.chatOk === true;
  result.latencyMs = Date.now() - started;
  return result;
}

// ---------- 模型输出工具 ----------

/** 去掉模型混入的思考段（<think>…</think>、<reasoning>…</reasoning>，含未闭合尾巴）。 */
export function stripReasoning(content) {
  return String(content ?? '')
    // ① 先去掉成对的思考块
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning\s*>/gi, '')
    // ② 未闭合/孤立标签：只剥标签本身，保留其后正文（答案 JSON 常在里面，交给 extractJson）
    .replace(/<\/?think\b[^>]*>/gi, '')
    .replace(/<\/?reasoning\b[^>]*>/gi, '')
    .trim();
}

/** 从 start（必须是 '{'）开始做平衡括号扫描；字符串/转义内的括号不算。 */
function scanBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从可能带前后缀 / 代码围栏的文本里取第一个完整 JSON 对象。
 * 失败返回 null（不抛）。
 * @returns {object|null}
 */
export function extractJson(content) {
  const text = String(content ?? '');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const candidate = scanBalanced(text, i);
    if (!candidate) continue; // 这个 '{' 没闭合，试下一个
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 继续找下一个 '{' */ }
  }
  return null;
}
