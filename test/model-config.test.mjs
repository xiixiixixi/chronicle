// test/model-config.test.mjs — N1：模型配置（预设/归一化/密钥安全/连接测试/输出解析）
//
// 覆盖：
//   ① 预设完整性 + normalise（预设补默认值、按 baseUrl 反推、未知→custom、数值钳制）
//   ② 校验拒绝：非法 baseUrl / 空 model / 超范围 timeoutMs / maxChars / 非法 apiKeyEnv
//   ③ 读写：fresh home 默认值、save/load 幂等、保留 config.json 其它配置键
//   ④ 密钥安全红线：key 只进 secrets.json(0600)、config.json 永不含 key、redact 只回
//      hasKey/keySource、优先级 secrets > env > none、清除密钥
//   ⑤ testModelConfig：/models 成功与失败、chat ping、鉴权头、失败错误（fetch 注入，无网络）
//   ⑥ stripReasoning / extractJson（围栏、前后缀、嵌套、字符串内括号、畸形）
//   ⑦ HTTP 路由集成：GET/PUT /api/model/config、PUT 非法 400、缺 Content-Type 415、
//      POST /api/model/test（无 key + 注入 fetch 成功）、POST /api/summarize/run
//      （未启用结构化禁用 / 启用后真实写出一份摘要，fetch 注入）

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MODEL_CONFIG, MAX_CHARS_RANGE, MODEL_PRESETS, PRESET_IDS, SECRETS_FIELD,
  clearApiKey, extractJson, getPreset, loadModelConfig, normalizeModelConfig, readSecretKey,
  redactConfig, resolveApiKey, saveApiKey, saveModelConfig, secretsMode, stripReasoning,
  testModelConfig, validateModelConfig,
} from '../shared/model-config.mjs';
import { createHttpApp } from '../daemon.mjs';

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'chronicle-model-'));
const homes = [];
function newHome() { const h = tmpHome(); homes.push(h); return h; }
afterEach(() => {
  for (const h of homes.splice(0)) {
    try { for (const n of ['', 'index']) { try { chmodSync(path.join(h, n), 0o700); } catch { /* 忽略 */ } } } catch { /* 忽略 */ }
    rmSync(h, { recursive: true, force: true });
  }
});

/** 假 fetch：记录请求，按 pathname 返回预设响应。 */
function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    return handler(u, init, calls.length);
  };
  return { calls, impl };
}
// 测试环境可能导出了 MINIMAX_API_KEY；本文件的“无 key”用例要求干净环境。
let savedMinimaxKey;
before(() => { savedMinimaxKey = process.env.MINIMAX_API_KEY; delete process.env.MINIMAX_API_KEY; });
after(() => { if (savedMinimaxKey !== undefined) process.env.MINIMAX_API_KEY = savedMinimaxKey; });

const jsonRes = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

// ---------- ① 预设与归一化 ----------

describe('预设与归一化', () => {
  test('5 个预设齐全，minimax 为默认（含实测模型列表）', () => {
    assert.deepEqual(PRESET_IDS, ['minimax', 'deepseek', 'openai', 'ollama', 'custom']);
    const mm = MODEL_PRESETS.minimax;
    assert.equal(mm.baseUrl, 'https://api.minimaxi.com/v1');
    assert.equal(mm.model, 'MiniMax-M3.1-Flash');
    for (const id of ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1']) {
      assert.ok(mm.models.includes(id), `minimax 预设应含 ${id}`);
    }
    assert.equal(MODEL_PRESETS.deepseek.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(MODEL_PRESETS.ollama.keyOptional, true);
    assert.equal(DEFAULT_MODEL_CONFIG.enabled, false, '默认不启用');
    assert.equal(getPreset('nope').id, 'custom');
  });

  test('normalize：预设补默认值、按 baseUrl 反推、未知 preset→custom、数值钳制', () => {
    const a = normalizeModelConfig({ preset: 'minimax' });
    assert.equal(a.baseUrl, MODEL_PRESETS.minimax.baseUrl);
    assert.equal(a.model, MODEL_PRESETS.minimax.model);
    assert.equal(a.provider, 'openai-compatible');
    assert.equal(a.enabled, false);

    // 显式值不被预设覆盖
    const b = normalizeModelConfig({ preset: 'minimax', baseUrl: 'https://x.example/v1', model: 'm1' });
    assert.equal(b.baseUrl, 'https://x.example/v1');
    assert.equal(b.model, 'm1');

    // 只有 baseUrl 的旧配置 → 反推出 preset
    assert.equal(normalizeModelConfig({ baseUrl: 'https://api.deepseek.com/v1/' }).preset, 'deepseek');
    assert.equal(normalizeModelConfig({ baseUrl: 'http://127.0.0.1:11434/v1' }).preset, 'ollama');
    assert.equal(normalizeModelConfig({ baseUrl: 'https://unknown.example/v1' }).preset, 'custom');
    assert.equal(normalizeModelConfig({ preset: 'nope' }).preset, 'custom');

    // 数值钳制 + 类型回落
    const c = normalizeModelConfig({ timeoutMs: 1, maxChars: 999_999_999, provider: 'weird' });
    assert.equal(c.timeoutMs, 1_000);
    assert.equal(c.maxChars, MAX_CHARS_RANGE.max);
    assert.equal(c.provider, 'openai-compatible');
    const d = normalizeModelConfig({ timeoutMs: 'abc', maxChars: null, enabled: 1 });
    assert.equal(d.timeoutMs, 60_000);
    assert.equal(d.maxChars, 30_000);
    assert.equal(d.enabled, false, 'enabled 只接受严格 true');

    // baseUrl 去尾斜杠
    assert.equal(normalizeModelConfig({ baseUrl: 'https://a.example/v1///' }).baseUrl, 'https://a.example/v1');
  });

  test('validate：合法通过；非法 baseUrl/model/数值/apiKeyEnv 被拒', () => {
    const ok = normalizeModelConfig({ ...MODEL_PRESETS.minimax, enabled: true, preset: 'minimax' });
    assert.deepEqual(validateModelConfig(ok), []);

    assert.ok(validateModelConfig({ ...ok, baseUrl: 'ftp://x.example/v1' }).some((e) => e.includes('http')));
    assert.ok(validateModelConfig({ ...ok, baseUrl: '' }).some((e) => e.includes('baseUrl')));
    assert.ok(validateModelConfig({ ...ok, baseUrl: 'https://a b.example' }).some((e) => e.includes('空白')));
    assert.ok(validateModelConfig({ ...ok, model: '   ' }).some((e) => e.includes('model')));
    assert.ok(validateModelConfig({ ...ok, timeoutMs: 10 }).some((e) => e.includes('timeoutMs')));
    assert.ok(validateModelConfig({ ...ok, maxChars: 1 }).some((e) => e.includes('maxChars')));
    assert.ok(validateModelConfig({ ...ok, apiKeyEnv: 'BAD ENV' }).some((e) => e.includes('apiKeyEnv')));
    assert.ok(validateModelConfig({ ...ok, preset: 'unknown' }).some((e) => e.includes('preset')));
    assert.deepEqual(validateModelConfig(null), ['配置须为 JSON 对象']);
  });
});

// ---------- ② 读写与密钥安全 ----------

describe('配置读写', () => {
  test('fresh home → 默认值；save/load 幂等且保留其它配置键', () => {
    const home = newHome();
    const initial = loadModelConfig(home);
    assert.equal(initial.enabled, false);
    assert.equal(initial.preset, 'minimax');
    assert.equal(initial.baseUrl, MODEL_PRESETS.minimax.baseUrl);

    // 先写一份带隐私规则的 config.json
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabled: true, blocklist: [{ scope: 'app', value: 'com.x.*' }], summarizer: { enabled: false, provider: 'none' } }, null, 2));

    const saved = saveModelConfig(home, { enabled: true, preset: 'minimax' });
    assert.equal(saved.enabled, true);
    assert.equal(saved.baseUrl, MODEL_PRESETS.minimax.baseUrl);

    const onDisk = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.blocklist, [{ scope: 'app', value: 'com.x.*' }], '不得覆盖其它配置键');
    assert.equal(onDisk.enabled, true);
    assert.equal(onDisk.summarizer.enabled, true);
    assert.equal(onDisk.summarizer.preset, 'minimax');
    assert.equal(onDisk.summarizer.model, 'MiniMax-M3.1-Flash');

    // 幂等：再保存一次结果一致
    const saved2 = saveModelConfig(home, { enabled: true });
    assert.deepEqual(saved2, saved);
    assert.deepEqual(loadModelConfig(home), saved);
  });

  test('密钥红线：只进 secrets.json(0600)，config.json 永不含 key，redact 只回 hasKey/keySource', () => {
    const home = newHome();
    const SECRET = 'sk-test-0123456789abcdef';
    saveModelConfig(home, { enabled: true, preset: 'minimax', key: SECRET });

    // config.json 不含 key
    const configText = readFileSync(path.join(home, 'config.json'), 'utf8');
    assert.equal(configText.includes(SECRET), false, 'config.json 绝不能写入 key');
    assert.equal(configText.includes('openaiCompatibleKey'), false);

    // secrets.json 存在且 0600，内容可读回
    const secretsFile = path.join(home, 'secrets.json');
    assert.ok(existsSync(secretsFile));
    assert.equal(secretsMode(home), 0o600, 'secrets.json 必须是 0600');
    const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
    assert.equal(secrets[SECRETS_FIELD], SECRET);
    assert.equal(readSecretKey(home), SECRET);
    // 目录权限（新建时应收紧到 0700）
    assert.equal(statSync(home).mode & 0o777, 0o700);

    // 对外脱敏视图：无 key 值
    const cfg = loadModelConfig(home);
    const redacted = redactConfig(home, cfg);
    assert.equal(redacted.hasKey, true);
    assert.equal(redacted.keySource, 'secrets');
    const redactedText = JSON.stringify(redacted);
    assert.equal(redactedText.includes(SECRET), false, 'redactConfig 绝不能回显 key');
    for (const forbidden of ['"apiKey"', '"key"', 'sk-test']) {
      assert.equal(redactedText.includes(forbidden), false, `脱敏视图不应含 ${forbidden}`);
    }
    assert.equal(redacted.apiKeyEnv, 'MINIMAX_API_KEY', 'apiKeyEnv 是变量名，可安全返回');
    assert.equal(redacted.presetLabel, 'MiniMax');
    assert.ok(Array.isArray(redacted.presetModels) && redacted.presetModels.length > 0);

    // 清除密钥
    saveModelConfig(home, { key: '' });
    assert.equal(redactConfig(home, loadModelConfig(home)).hasKey, false);
    assert.equal(redactConfig(home, loadModelConfig(home)).keySource, 'none');
    assert.equal(existsSync(secretsFile), true, '清除后保留空 secrets 文件（不回退权限）');
    assert.equal(secretsMode(home), 0o600);
  });

  test('优先级：secrets > apiKeyEnv 环境变量 > none', () => {
    const home = newHome();
    const cfg = normalizeModelConfig({ preset: 'minimax', apiKeyEnv: 'TEST_MODEL_KEY' });

    // 无 secrets、无 env → none
    assert.deepEqual(resolveApiKey(home, cfg, {}), { key: '', source: 'none' });
    // 仅 env → env
    assert.deepEqual(resolveApiKey(home, cfg, { TEST_MODEL_KEY: 'env-key' }), { key: 'env-key', source: 'env' });
    // 未配置 apiKeyEnv 时忽略 env
    assert.deepEqual(resolveApiKey(home, normalizeModelConfig({ preset: 'ollama' }), { TEST_MODEL_KEY: 'env-key' }), { key: '', source: 'none' });
    // secrets 优先于 env
    saveApiKey(home, 'secret-key');
    assert.deepEqual(resolveApiKey(home, cfg, { TEST_MODEL_KEY: 'env-key' }), { key: 'secret-key', source: 'secrets' });
    // clearApiKey 幂等
    clearApiKey(home);
    assert.deepEqual(resolveApiKey(home, cfg, {}), { key: '', source: 'none' });
    clearApiKey(home); // 再清一次不抛
    // 空 key 拒绝
    assert.throws(() => saveApiKey(home, '   '), (e) => e.code === 'INVALID_MODEL_CONFIG');
  });

  test('saveModelConfig 非法配置拒绝且不落盘（code=INVALID_MODEL_CONFIG）', () => {
    const home = newHome();
    assert.throws(
      () => saveModelConfig(home, { baseUrl: 'ftp://x.example/v1', model: 'm' }),
      (e) => e.code === 'INVALID_MODEL_CONFIG' && Array.isArray(e.errors) && e.errors.length > 0,
    );
    assert.equal(existsSync(path.join(home, 'config.json')), false, '校验失败不得写 config.json');
  });
});

// ---------- ③ 连接测试（fetch 注入，无网络） ----------

describe('testModelConfig', () => {
  const cfg = normalizeModelConfig({ preset: 'minimax', enabled: true });

  test('成功路径：/models 列表 + ping 对话；鉴权头带 key；不含任何用户数据', async () => {
    const f = mockFetch((url) => (url.endsWith('/models')
      ? jsonRes({ data: [{ id: 'MiniMax-M3.1-Flash' }, { id: 'MiniMax-M3' }] })
      : jsonRes({ choices: [{ message: { content: 'pong' } }] })));
    const r = await testModelConfig({ cfg, apiKey: 'sk-abc', fetchImpl: f.impl });
    assert.equal(r.ok, true);
    assert.equal(r.chatOk, true);
    assert.equal(r.modelsOk, true);
    assert.deepEqual(r.models, ['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    assert.equal(typeof r.latencyMs, 'number');
    assert.equal(r.error, undefined);

    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].url, 'https://api.minimaxi.com/v1/models');
    assert.equal(f.calls[1].url, 'https://api.minimaxi.com/v1/chat/completions');
    assert.equal(f.calls[0].headers.authorization, 'Bearer sk-abc');
    const body = JSON.parse(f.calls[1].body);
    assert.equal(body.model, 'MiniMax-M3.1-Flash');
    assert.equal(body.max_tokens, 64);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'ping', '只允许发送固定 ping，不含用户事件');
    assert.equal(JSON.stringify(body).includes('events'), false);
  });

  test('/models 失败不致命（chat 成功即 ok）；无 key 时不带鉴权头', async () => {
    const f = mockFetch((url) => (url.endsWith('/models')
      ? jsonRes({ error: 'not found' }, 404)
      : jsonRes({ choices: [{ message: { content: 'pong' } }] })));
    const r = await testModelConfig({ cfg, apiKey: '', fetchImpl: f.impl });
    assert.equal(r.ok, true);
    assert.equal(r.chatOk, true);
    assert.equal(r.modelsOk, false);
    assert.match(String(r.modelsError), /HTTP 404/);
    assert.equal(f.calls[0].headers.authorization, undefined, '无 key 不得发 Authorization');
  });

  test('chat 失败 → ok:false + error（不回显 key）', async () => {
    const f = mockFetch(() => jsonRes({ error: { message: 'invalid api key' } }, 401));
    const r = await testModelConfig({ cfg, apiKey: 'sk-secret-value', fetchImpl: f.impl });
    assert.equal(r.ok, false);
    assert.equal(r.chatOk, false);
    assert.match(String(r.error), /HTTP 401/);
    assert.equal(JSON.stringify(r).includes('sk-secret-value'), false, '错误信息不得包含 key');
  });

  test('网络异常 → ok:false 且错误可读', async () => {
    const r = await testModelConfig({ cfg, apiKey: 'k', fetchImpl: async () => { throw new Error('conn refused'); } });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /conn refused/);
  });
});

// ---------- ④ 输出解析工具 ----------

describe('stripReasoning / extractJson', () => {
  test('stripReasoning：去 <think>/<reasoning>（含未闭合尾巴）', () => {
    assert.equal(stripReasoning('<think>思考</think>{"title":"T"}'), '{"title":"T"}');
    assert.equal(stripReasoning('前<THINK a="1">内部</Think>后'), '前后');
    assert.equal(stripReasoning('<reasoning>x</reasoning>ok'), 'ok');
    const unclosed = stripReasoning('<think>未闭合的思考\n{"title":"T"}');
    assert.equal(unclosed.includes('<think>'), false, '未闭合标签也应剥掉');
    assert.deepEqual(extractJson(unclosed), { title: 'T' }, '标签后的 JSON 必须仍可取到');
    assert.equal(stripReasoning('普通文本'), '普通文本');
    assert.equal(stripReasoning(null), '');
    assert.equal(stripReasoning('<think>a</think><reasoning>b</reasoning>{"x":1}'), '{"x":1}');
  });

  test('extractJson：围栏/前后缀/嵌套/字符串内括号/数组/畸形', () => {
    assert.deepEqual(extractJson('{"title":"T","body":"B"}'), { title: 'T', body: 'B' });
    assert.deepEqual(extractJson('```json\n{"title":"T"}\n```'), { title: 'T' });
    assert.deepEqual(extractJson('说明文字 {"title":"T"} 结尾说明'), { title: 'T' });
    assert.deepEqual(extractJson('{"a":{"b":[1,2,{"c":"d"}]},"title":"N"}'), { a: { b: [1, 2, { c: 'd' }] }, title: 'N' });
    // 字符串里出现花括号/转义引号不能误判
    assert.deepEqual(extractJson('{"title":"含 } 和 \\" 的标题"}'), { title: '含 } 和 " 的标题' });
    // 外层对象未闭合 → 跳过它，返回第一个完整的内层对象
    assert.deepEqual(extractJson('{"broken": {"ok":1}'), { ok: 1 });
    // 无对象 / JSON 数组 → null
    assert.equal(extractJson('就是一段裸文本'), null);
    assert.equal(extractJson('[1,2,3]'), null);
    assert.equal(extractJson(''), null);
    assert.equal(extractJson(null), null);
    // 前面有未闭合 '{' 时能跳过并找到后面完整对象
    assert.deepEqual(extractJson('{ dangling {"title":"T"}'), { title: 'T' });
  });
});

// ---------- ⑤ HTTP 路由集成 ----------

function stubDaemon() {
  return { binary: '/stub/chronicle-daemon', proc: () => null, async request() { return { running: false, paused: false }; } };
}
async function startHttp(home) {
  const server = createHttpApp({ daemon: stubDaemon(), home });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, init) => {
    const r = await fetch(base + p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, call, close };
}
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('HTTP /api/model/* 与 /api/summarize/run', () => {
  test('GET 脱敏（无 key）；PUT 非法 400；PUT 合法后 hasKey/keySource 正确且 key 不落 config', async () => {
    const home = newHome();
    const http = await startHttp(home);
    try {
      const g1 = await http.call('/api/model/config');
      assert.equal(g1.status, 200);
      assert.equal(g1.body.ok, true);
      assert.equal(g1.body.config.hasKey, false);
      assert.equal(g1.body.config.preset, 'minimax');
      assert.equal('key' in g1.body.config, false);
      assert.equal('apiKey' in g1.body.config, false);

      // 非法 baseUrl → 400 且带 errors
      const bad = await http.call('/api/model/config', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ baseUrl: 'ftp://x', model: 'm' }) });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.ok, false);
      assert.ok(Array.isArray(bad.body.errors) && bad.body.errors.length > 0);

      // 缺 Content-Type → 415（沿用既有写接口安全边界）
      const noCt = await fetch(`${http.base}/api/model/config`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
      assert.equal(noCt.status, 415);

      const SECRET = 'sk-route-test-987654321';
      const put = await http.call('/api/model/config', {
        method: 'PUT', headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true, preset: 'minimax', key: SECRET }),
      });
      assert.equal(put.status, 200);
      assert.equal(put.body.config.enabled, true);
      assert.equal(put.body.config.hasKey, true);
      assert.equal(put.body.config.keySource, 'secrets');
      assert.equal(JSON.stringify(put.body).includes(SECRET), false, '响应不得回显 key');
      assert.equal(readFileSync(path.join(home, 'config.json'), 'utf8').includes(SECRET), false);
      assert.equal(secretsMode(home), 0o600);
    } finally { await http.close(); }
  });

  test('POST /api/model/test：无 key 结构化失败；内联 key + 注入 fetch 成功', async () => {
    const home = newHome();
    const http = await startHttp(home);
    const realFetch = globalThis.fetch;
    try {
      saveModelConfig(home, { enabled: true, preset: 'minimax' });

      const noKey = await http.call('/api/model/test', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(noKey.status, 200);
      assert.equal(noKey.body.ok, true);
      assert.equal(noKey.body.test.ok, false);
      assert.match(String(noKey.body.test.error), /API Key/);

      // 注入全局 fetch：仅用于该路由的连接测试（不联网）
      const seen = [];
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith(http.base)) return realFetch(url, init); // 本地路由调用走真实 fetch
        seen.push({ url: u, body: init.body, headers: init.headers });
        if (u.endsWith('/models')) return jsonRes({ data: [{ id: 'MiniMax-M3.1-Flash' }] });
        return jsonRes({ choices: [{ message: { content: 'pong' } }] });
      };
      const tested = await http.call('/api/model/test', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ key: 'sk-inline-abc', persistKey: true }),
      });
      assert.equal(tested.status, 200);
      assert.equal(tested.body.ok, true);
      assert.equal(tested.body.test.ok, true);
      assert.deepEqual(tested.body.test.models, ['MiniMax-M3.1-Flash']);
      assert.equal(tested.body.keySaved, true, 'persistKey=true 且测试通过后应保存 key');
      assert.equal(tested.body.config.hasKey, true);
      assert.equal(tested.body.config.keySource, 'secrets');
      // 测试请求只含 ping，不含事件数据
      const chatCall = seen.find((c) => c.url.endsWith('/chat/completions'));
      assert.match(String(chatCall.body), /"ping"/);
      assert.equal(String(chatCall.body).includes('events'), false);
      assert.equal(JSON.stringify(tested.body).includes('sk-inline-abc'), false);
    } finally {
      globalThis.fetch = realFetch;
      await http.close();
    }
  });

  test('POST /api/summarize/run：未启用 → SUMMARIZER_DISABLED；启用后（注入 fetch）真写出一份摘要', async () => {
    const home = newHome();
    const http = await startHttp(home);
    const realFetch = globalThis.fetch;
    try {
      // 未启用
      writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabled: true, summarizer: { enabled: false, provider: 'openai-compatible', preset: 'minimax', baseUrl: MODEL_PRESETS.minimax.baseUrl, model: MODEL_PRESETS.minimax.model } }, null, 2));
      const disabled = await http.call('/api/summarize/run', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.ok, false);
      assert.equal(disabled.body.code, 'SUMMARIZER_DISABLED');

      // 启用 + 密钥 + 一个已关闭的段（当前 6h 桶内，避免触发 6h 摘要）
      const segDate = new Date(Date.now() - 5 * 60_000);
      const name = segDate.toISOString().replace(/:/g, '-');
      const dir = path.join(home, 'segments', name);
      mkdirSync(dir, { recursive: true });
      const events = [
        { ts: new Date(segDate.getTime()).toISOString(), type: 'app-switch', data: { bundleId: 'com.apple.Terminal', appName: 'Terminal' } },
        { ts: new Date(segDate.getTime() + 60_000).toISOString(), type: 'window-change', data: { bundleId: 'com.apple.Terminal', windowTitle: 'chronicle — zsh' } },
      ];
      writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
      writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
        segmentStart: segDate.toISOString(),
        segmentEnd: new Date(segDate.getTime() + 10 * 60_000).toISOString(),
        eventCount: events.length,
      }));
      saveModelConfig(home, {
        enabled: true, preset: 'custom', provider: 'openai-compatible',
        baseUrl: 'https://fake.example/v1', model: 'fake-model', key: 'sk-fake-key',
      });

      globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith(http.base)) return realFetch(url, init); // 本地 HTTP 走真 fetch
        return jsonRes({ choices: [{ message: { content: '{"title":"10:00-10:10 编码","body":"## 活动摘要\\n- 在终端写代码"}' } }], usage: { total_tokens: 42 } });
      };
      const ran = await http.call('/api/summarize/run', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      assert.equal(ran.status, 200);
      assert.equal(ran.body.ok, true);
      assert.ok(ran.body.summarized >= 1, JSON.stringify(ran.body));
      assert.equal(typeof ran.body.elapsedMs, 'number');

      const summaryFile = path.join(home, 'summaries', `10min-${name}.md`);
      assert.ok(existsSync(summaryFile), '应立即生成 10min 摘要文件');
      const md = readFileSync(summaryFile, 'utf8');
      assert.match(md, /title: "10:00-10:10 编码"/);
      assert.match(md, /## 活动摘要/);
      assert.match(md, /usage/);
      assert.equal(md.includes('sk-fake-key'), false, '摘要文件不得含 key');

      // 指定不存在的段 → 404
      const missing = await http.call('/api/summarize/run', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ segment: '2020-01-01T00-00-00.000Z' }) });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'SEGMENT_NOT_FOUND');
    } finally {
      globalThis.fetch = realFetch;
      await http.close();
    }
  });
});

// ---------- ⑥ 推理型模型：HTTP 200 有 choices 但 content 为空 → 视为连通 ----------

describe('testModelConfig 推理型模型兼容', () => {
  test('max_tokens 探测无正文（reasoning 耗尽）但返回 choices → chatOk=true 且带 note', async () => {
    const { testModelConfig } = await import('../shared/model-config.mjs');
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? String(init.body) : '' });
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, async json() { return { data: [{ id: 'MiniMax-M3.1-Flash' }] }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking…' } }] };
        },
      };
    };
    const r = await testModelConfig({
      cfg: { preset: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3.1-Flash' },
      apiKey: 'test-key',
      fetchImpl: fakeFetch,
    });
    assert.equal(r.ok, true, '有 choices 应视为连通');
    assert.equal(r.chatOk, true);
    assert.ok(r.models.length >= 1);
    assert.match(String(r.note || ''), /模型已响应/);
    // 探测请求只包含固定 ping，不含用户事件
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'));
    assert.ok(chat && chat.body.includes('"ping"'), '只允许发送固定 ping');
  });
});

// ---------- DSH 式模型选项：maxTokens / reasoningEffort / 能力声明 ----------

describe('模型选项（maxTokens、reasoningEffort、capabilities）', () => {
  test('默认值与归一化：maxTokens=8000、reasoningEffort 空；非法值容错', () => {
    const a = normalizeModelConfig({ preset: 'minimax' });
    assert.equal(a.maxTokens, 8000);
    assert.equal(a.reasoningEffort, '');
    assert.equal(DEFAULT_MODEL_CONFIG.maxTokens, 8000);
    const b = normalizeModelConfig({ preset: 'minimax', maxTokens: 1, reasoningEffort: 'weird' });
    assert.equal(b.maxTokens, 256, '低于下限被夹到 256');
    assert.equal(b.reasoningEffort, '', '非法 effort 归一为空');
    const c = normalizeModelConfig({ preset: 'minimax', maxTokens: 32_000, reasoningEffort: 'low' });
    assert.equal(c.maxTokens, 32_000);
    assert.equal(c.reasoningEffort, 'low');
  });

  test('校验：maxTokens 范围、reasoningEffort 枚举', () => {
    const ok = normalizeModelConfig({ preset: 'minimax', maxTokens: 8000, reasoningEffort: 'low' });
    assert.deepEqual(validateModelConfig(ok), []);
    assert.match(validateModelConfig({ ...ok, maxTokens: 100 }).join(), /maxTokens/);
    assert.match(validateModelConfig({ ...ok, reasoningEffort: 'none' }).join(), /reasoningEffort/);
  });

  test('保存/读取往返：maxTokens 与 reasoningEffort 持久化进 summarizer', () => {
    const home = newHome();
    saveModelConfig(home, {
      enabled: true, preset: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
      model: 'MiniMax-M3.1-Flash', maxTokens: 10_000, reasoningEffort: 'low',
    });
    const cfg = loadModelConfig(home);
    assert.equal(cfg.maxTokens, 10_000);
    assert.equal(cfg.reasoningEffort, 'low');
    const raw = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(raw.summarizer.maxTokens, 10_000);
    assert.equal(raw.summarizer.reasoningEffort, 'low');
  });

  test('redactConfig 暴露能力声明：M3.1 支持低档推荐 low；M2.7 不支持', () => {
    const home = newHome();
    const m31 = redactConfig(home, { preset: 'minimax', model: 'MiniMax-M3.1-Flash' });
    assert.equal(m31.capabilities.reasoningEffort.supported, true);
    assert.equal(m31.capabilities.reasoningEffort.recommended, 'low');
    assert.ok(m31.capabilities.reasoningEffort.values.includes('max'));
    const m27 = redactConfig(home, { preset: 'minimax', model: 'MiniMax-M2.7' });
    assert.equal(m27.capabilities.reasoningEffort.supported, false);
  });
});
