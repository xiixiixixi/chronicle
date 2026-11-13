// test/generic.test.mjs — 通用性红线：产品能力不得依赖/绑定第三方产品私有实现
//
// 目的（用户明确要求）：Chronicle 的技能建议/洞察/记忆等能力是产品自己的能力，
// 只参考同类产品的交互与数据结构，不读取第三方产品目录、不硬编码其私有端点。
// 允许的例外：provider 预设里的 OpenAI 兼容地址；mcp-install/daemon 的 AI 客户端接入目标。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

describe('通用性：分析/记忆/洞察/UI 不绑定第三方产品', () => {
  test('分析/记忆/洞察模块不出现 Codex/第三方产品名与私有路径', () => {
    for (const file of ['summarize.mjs', 'shared/memory.mjs', 'shared/insights.mjs', 'shared/model-config.mjs']) {
      const text = read(file);
      assert.doesNotMatch(text, /codex/i, `${file} 不应依赖第三方产品名`);
      assert.doesNotMatch(text, /\.codex\b|~\/\.codex/, `${file} 不应读取第三方产品目录`);
      assert.doesNotMatch(text, /chatgpt/i, `${file} 不应绑定第三方产品`);
    }
  });

  test('Web UI 与采集器不出现 Codex 定制文案/依赖', () => {
    for (const file of ['web/app.js', 'web/index.html', 'web/style.css', 'swift/chronicle-daemon.swift']) {
      const text = read(file);
      assert.doesNotMatch(text, /codex/i, `${file} 不应出现第三方产品定制字样`);
      assert.doesNotMatch(text, /\.codex\b|~\/\.codex/, `${file} 不应读取第三方产品目录`);
    }
  });

  test('技能/洞察/记忆文件全部落在本机 <home> 路径（不写第三方目录）', () => {
    // daemon.mjs 的 `.codex` 仅用于 AI 客户端接入目标（mcp-install 同类），不属于数据/记忆依赖，故不在此断言
    for (const file of ['shared/insights.mjs', 'shared/memory.mjs']) {
      const text = read(file);
      assert.doesNotMatch(text, /\.codex\b/, `${file} 不应写第三方产品目录`);
      assert.doesNotMatch(text, /Application Support\/Codex|Application Support\/com\.openai/i, `${file} 不应写第三方应用数据目录`);
    }
  });
});
