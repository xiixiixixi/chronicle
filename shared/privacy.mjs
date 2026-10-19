// shared/privacy.mjs — 观察规则闸门（纯逻辑，Node 侧镜像）
//
// 权威实现在 swift/chronicle-daemon.swift 的 ChronicleConfig.decision（采集端，
// 事件落盘前过滤）。本模块是同一语义的 JS 镜像，供 daemon.mjs 展示层与测试使用
// （例如 /api/segments 预览某 app 是否会被观察、测试验证 block 永远赢）。
// 两处语义必须保持一致：改一处必改另一处。
//
// 语义（与 Swift 端一致）：
//   规则 {scope:"app"|"url", value:"glob"}；app 匹配 bundleId，url 匹配完整 URL 或 host
//   （均不区分大小写，`*` 任意序列）。
//   ① 命中 blocklist（app 或 url 层）→ 一律不观察（即便同时命中 allowlist——block 永远赢）
//   ② allowlist 非空 → 必须命中 allowlist（app 命中，或 URL 明确命中 url 规则）才观察
//   ③ 其余情况（无 block 命中且 allowlist 为空）→ 观察

/** glob：`*` 任意序列，不区分大小写，其余按字面（"com.1password.*"、"*banking*"）。 */
export function globMatch(pattern, text) {
  const p = String(pattern ?? '').toLowerCase();
  const t = String(text ?? '').toLowerCase();
  if (!p.includes('*')) return p === t;
  const re = new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(t);
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** URL 规则：命中完整 URL 或其 host 任一即算（子域靠 glob 表达，如 "*://mail.example.com/*"）。 */
export function urlRuleMatch(pattern, url) {
  if (globMatch(pattern, url)) return true;
  try {
    const host = new URL(url).host?.toLowerCase();
    return host ? globMatch(pattern, host) : false;
  } catch { return false; }
}

function parseRules(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && (r.scope === 'app' || r.scope === 'url') && typeof r.value === 'string' && r.value.length > 0);
}

/**
 * 隐私闸门决策（与 Swift 端 decision() 同语义）。
 * @param {{bundleId: string, url?: string|null}} sample 一次采样的 app/URL
 * @param {{allowlist?: Array, blocklist?: Array}} config 观察规则
 * @returns {{observe: boolean, blockedScope: 'app'|'url'|null, reason: string}}
 */
export function privacyDecision(sample, config = {}) {
  const bundleId = String(sample?.bundleId ?? '');
  const url = typeof sample?.url === 'string' && sample.url.length > 0 ? sample.url : null;
  const block = parseRules(config.blocklist);
  const allow = parseRules(config.allowlist);

  if (block.some((r) => r.scope === 'app' && globMatch(r.value, bundleId))) {
    return { observe: false, blockedScope: 'app', reason: 'blocklist(app)' };
  }
  if (url && block.some((r) => r.scope === 'url' && urlRuleMatch(r.value, url))) {
    return { observe: false, blockedScope: 'url', reason: 'blocklist(url)' };
  }
  if (allow.length > 0) {
    if (allow.some((r) => r.scope === 'app' && globMatch(r.value, bundleId))) {
      return { observe: true, blockedScope: null, reason: 'allowlist(app)' };
    }
    if (url && allow.some((r) => r.scope === 'url' && urlRuleMatch(r.value, url))) {
      return { observe: true, blockedScope: null, reason: 'allowlist(url)' }; // app 不在白名单但 URL 明确放行
    }
    return { observe: false, blockedScope: 'app', reason: 'not-in-allowlist' };
  }
  return { observe: true, blockedScope: null, reason: 'default-observe' };
}

/** 默认配置（setup.mjs 落盘、Swift 端缺省一致）。 */
export function defaultConfig() {
  return {
    enabled: true,
    allowlist: [],
    blocklist: [
      { scope: 'app', value: 'com.1password.*' },
      { scope: 'app', value: 'com.apple.keychainaccess' },
      { scope: 'app', value: 'com.apple.Passwords' },
      { scope: 'url', value: '*banking*' },
    ],
    includeURLs: true,
    includeFocusedElement: true,
  };
}

/**
 * 校验配置形状（PUT /api/config 写入前的闸门；只查形状，不改匹配语义——
 * 语义由 Swift 端 decision() 与本文件 privacyDecision() 双实现保持一致）。
 * @returns {string[]} 错误列表（空数组 = 合法）
 */
export function validatePrivacyConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['配置须为 JSON 对象'];
  const errors = [];
  for (const key of ['allowlist', 'blocklist']) {
    const v = cfg[key];
    if (v === undefined) continue; // 缺省 = 沿用现有值（PUT 侧会 merge）
    if (!Array.isArray(v)) { errors.push(`${key} 须为数组`); continue; }
    v.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) errors.push(`${key}[${i}] 须为 {scope, value} 对象`);
      else if (r.scope !== 'app' && r.scope !== 'url') errors.push(`${key}[${i}].scope 须为 "app" 或 "url"`);
      else if (typeof r.value !== 'string' || r.value.length === 0) errors.push(`${key}[${i}].value 须为非空字符串`);
    });
  }
  for (const key of ['enabled', 'includeURLs', 'includeFocusedElement']) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'boolean') errors.push(`${key} 须为布尔值`);
  }
  return errors;
}
