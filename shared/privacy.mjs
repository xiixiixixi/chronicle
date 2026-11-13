// shared/privacy.mjs — 观察规则闸门（纯逻辑，Node 侧镜像）
//
// 权威实现在 swift/chronicle-daemon.swift 的 ChronicleConfig.evaluate（采集端，
// 事件落盘前过滤）。本模块是同一语义的 JS 镜像，供 daemon.mjs 展示层与测试使用
// （例如 /api/segments 预览某 app 是否会被观察、测试验证 block 永远赢）。
// 两处语义必须保持一致：改一处必改另一处；`evaluateSample` 与 Swift `decide`
// 命令在 test/privacy.test.mjs 里用同一组 golden case 逐条对拍（不等即 fail）。
//
// 语义：
//   规则 {scope:"app"|"url", value:"glob"}；app 匹配 bundleId，url 匹配完整 URL 或 host
//   （均不区分大小写，`*` 任意序列，整串锚定）。
//   ① secureInput（整机安全输入）→ 一律不观察（优先于一切规则），reason=secure-input
//   ② 命中 blocklist（app 或 url 层）→ 一律不观察（即便同时命中 allowlist——block 永远赢）
//   ③ Safari + privacy.excludeSafariURLs → 不观察 URL/内容，reason=safari-url-excluded
//   ④ 无痕（incognito）→ 不观察 URL/内容，reason=incognito
//   ⑤ allowlist 非空 → 必须命中 allowlist（app 命中，或 URL 明确命中 url 规则）才观察
//   ⑥ 其余情况（无 block 命中且 allowlist 为空）→ 观察
//
// URL 落盘脱敏：默认 privacy.redactURLQuery=true 时，存储值去掉 query 与 fragment
// （保留 scheme+host+path）；规则匹配始终使用**原始** URL。Swift 端同语义。
//
// R1 内容采集（点击/键盘/AX 内容）：默认 `includeContent:true`；四个截断上限
// `contentMaxChars/diffMaxChars/inputTextMaxChars/selectionMaxChars` 与 Swift
// `ChronicleConfig.fromJSON` 同边界归一化（contentSettings）；false 时严格退化为旧行为
// （只记 app-switch/window-change）。密码控件/secure input/无痕永远不产生内容事件。
//
// 本文件是纯逻辑，不读文件、不写文件、不联网。

/**
 * 内容采集配置（R1）：includeContent 总开关 + 四个截断上限。
 * 与 Swift `ChronicleConfig.fromJSON` 同边界归一化（缺省/非法值回落；越界夹到边界）。
 */
export function contentSettings(config = {}) {
  const raw = config && typeof config === 'object' ? config : {};
  const clampInt = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
  };
  return {
    // 新总开关：false → 只记 app-switch/window-change（旧行为），不采集点击/键盘/AX 内容。
    includeContent: raw.includeContent !== false,
    contentMaxChars: clampInt(raw.contentMaxChars, 16384, 256, 65536),
    diffMaxChars: clampInt(raw.diffMaxChars, 4096, 256, 16384),
    inputTextMaxChars: clampInt(raw.inputTextMaxChars, 2000, 32, 20000),
    selectionMaxChars: clampInt(raw.selectionMaxChars, 300, 16, 10000),
  };
}

/** 新配置 `privacy` 子段（缺省值与 Swift 端一致；非法值回落默认）。 */
export function privacySettings(config = {}) {
  const raw = config && typeof config.privacy === 'object' && config.privacy !== null && !Array.isArray(config.privacy)
    ? config.privacy : {};
  return {
    // "heuristic"（默认）| "off"：Safari 无痕启发式检测的开关（真正执行在 Swift 采集端）。
    safariPrivateDetection: raw.safariPrivateDetection === 'off' ? 'off' : 'heuristic',
    // 手动强制排除全部 Safari URL/内容（默认 false）。
    excludeSafariURLs: raw.excludeSafariURLs === true,
    // 落盘前去掉 URL 的 query 与 fragment（默认 true；规则匹配仍用原始 URL）。
    redactURLQuery: raw.redactURLQuery !== false,
  };
}

/**
 * URL 落盘脱敏：截断第一个 `?` 或 `#` 之后的部分（保留 scheme+host+path）。
 * 与 Swift `redactURLString` 同语义：纯字符串截断，不做 URL 规范化，保证双实现对拍一致。
 * @returns {string|null} 空串/非字符串 → null
 */
export function redactURL(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return null;
  const i = s.search(/[?#]/);
  const cut = i < 0 ? s : s.slice(0, i);
  return cut.length ? cut : null;
}

/**
 * glob：`*` 任意序列，不区分大小写，其余按字面（"com.1password.*"、"*banking*"）。
 * 整串锚定，语义等价 `^...$` 且 `*` 可匹配空串/换行。使用与 Swift 相同的
 * 双指针回溯算法（按 Unicode code point 比较），而非正则，避免两语言正则差异。
 */
export function globMatch(pattern, text) {
  const p = Array.from(String(pattern ?? '').toLowerCase());
  const t = Array.from(String(text ?? '').toLowerCase());
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && p[pi] === t[ti]) { pi += 1; ti += 1; }
    else if (pi < p.length && p[pi] === '*') { star = pi; pi += 1; mark = ti; }
    else if (star >= 0) { pi = star + 1; mark += 1; ti = mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

/** URL 规则：命中完整 URL 或其 host（不含端口）任一即算（与 Swift URL.host 对齐）。 */
export function urlRuleMatch(pattern, url) {
  if (typeof url !== 'string' || !url) return false;
  if (globMatch(pattern, url)) return true;
  try {
    const host = new URL(url).hostname;
    return Boolean(host) && globMatch(pattern, host);
  } catch { return false; }
}

function parseRules(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && (r.scope === 'app' || r.scope === 'url') && typeof r.value === 'string' && r.value.length > 0);
}

const SAFARI_BUNDLE_ID = 'com.apple.safari';

function isSafariBundleId(bundleId) {
  return String(bundleId ?? '').toLowerCase() === SAFARI_BUNDLE_ID;
}

function storedURL(url, settings) {
  if (typeof url !== 'string' || url.length === 0) return null;
  return settings.redactURLQuery ? redactURL(url) : (url.trim() || null);
}

/**
 * 统一决策（与 Swift `decide` / `ChronicleConfig.evaluate` 逐字段对拍）。
 * @param {{bundleId?: string, url?: string|null, title?: string|null, focusRole?: string|null,
 *          focusTitle?: string|null, secureInput?: boolean, incognito?: boolean}} sample
 * @param {{allowlist?: Array, blocklist?: Array, privacy?: object}} config
 * @returns {{observe: boolean, blockedScope: 'app'|'url'|'system'|null, reason: string, redactedURL: string|null}}
 *   reason 取值：secure-input | app-blocklist | safari-url-excluded | url-blocklist | incognito |
 *                allowlist-app | allowlist-url | not-in-allowlist | default-observe
 */
export function evaluateSample(sample = {}, config = {}) {
  // 字段类型严格按协议：非字符串 bundleId 视为空串（与 Swift `as? String ?? ""` 对齐）
  const bundleId = typeof sample?.bundleId === 'string' ? sample.bundleId : '';
  const url = typeof sample?.url === 'string' && sample.url.length > 0 ? sample.url : null;
  const secureInput = sample?.secureInput === true;
  const incognito = sample?.incognito === true;
  const settings = privacySettings(config);
  const block = parseRules(config.blocklist);
  const allow = parseRules(config.allowlist);

  // ① secure input 整机抑制：优先于一切规则/开关
  if (secureInput) {
    return { observe: false, blockedScope: 'system', reason: 'secure-input', redactedURL: null };
  }
  // ② app 层 block（block 永远赢）
  if (block.some((r) => r.scope === 'app' && globMatch(r.value, bundleId))) {
    return { observe: false, blockedScope: 'app', reason: 'app-blocklist', redactedURL: null };
  }
  // ③ Safari 手动强制排除（不记录 URL/内容）
  if (isSafariBundleId(bundleId) && settings.excludeSafariURLs) {
    return { observe: false, blockedScope: 'url', reason: 'safari-url-excluded', redactedURL: null };
  }
  // ④ url 层 block（匹配原始 URL；block 永远赢）
  if (url && block.some((r) => r.scope === 'url' && urlRuleMatch(r.value, url))) {
    return { observe: false, blockedScope: 'url', reason: 'url-blocklist', redactedURL: null };
  }
  // ⑤ 无痕：无条件不观察 URL/内容
  if (incognito) {
    return { observe: false, blockedScope: 'url', reason: 'incognito', redactedURL: null };
  }
  // ⑥ allowlist（非空时白名单外一律不观察；app 命中或 URL 明确放行）
  if (allow.length > 0) {
    if (allow.some((r) => r.scope === 'app' && globMatch(r.value, bundleId))) {
      return { observe: true, blockedScope: null, reason: 'allowlist-app', redactedURL: storedURL(url, settings) };
    }
    if (url && allow.some((r) => r.scope === 'url' && urlRuleMatch(r.value, url))) {
      return { observe: true, blockedScope: null, reason: 'allowlist-url', redactedURL: storedURL(url, settings) };
    }
    return { observe: false, blockedScope: 'app', reason: 'not-in-allowlist', redactedURL: null };
  }
  return { observe: true, blockedScope: null, reason: 'default-observe', redactedURL: storedURL(url, settings) };
}

/**
 * 旧版决策（向后兼容，mock 守护与既有测试在用）。语义保持不变：
 * 只看 app/url 两层 block+allowlist，不含 secureInput/incognito/脱敏。
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
    includeContent: true,
    contentMaxChars: 16384,
    diffMaxChars: 4096,
    inputTextMaxChars: 2000,
    selectionMaxChars: 300,
    privacy: {
      safariPrivateDetection: 'heuristic',
      excludeSafariURLs: false,
      redactURLQuery: true,
    },
  };
}

/**
 * 校验配置形状（PUT /api/config 写入前的闸门；只查形状，不改匹配语义——
 * 语义由 Swift 端 evaluate() 与本文件 evaluateSample() 双实现保持一致）。
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
  for (const key of ['enabled', 'includeURLs', 'includeFocusedElement', 'includeContent']) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'boolean') errors.push(`${key} 须为布尔值`);
  }
  // 内容采集截断上限：类型/整数/边界（与 Swift 同边界；写入前拒绝明显错误值）
  const contentLimits = [
    ['contentMaxChars', 256, 65536],
    ['diffMaxChars', 256, 16384],
    ['inputTextMaxChars', 32, 20000],
    ['selectionMaxChars', 16, 10000],
  ];
  for (const [key, min, max] of contentLimits) {
    const v = cfg[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v)) errors.push(`${key} 须为整数`);
    else if (v < min || v > max) errors.push(`${key} 须在 ${min}-${max} 之间`);
  }
  if (cfg.privacy !== undefined) {
    const p = cfg.privacy;
    if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push('privacy 须为对象');
    else {
      if (p.safariPrivateDetection !== undefined && p.safariPrivateDetection !== 'heuristic' && p.safariPrivateDetection !== 'off') {
        errors.push('privacy.safariPrivateDetection 须为 "heuristic" 或 "off"');
      }
      for (const key of ['excludeSafariURLs', 'redactURLQuery']) {
        if (p[key] !== undefined && typeof p[key] !== 'boolean') errors.push(`privacy.${key} 须为布尔值`);
      }
    }
  }
  return errors;
}
