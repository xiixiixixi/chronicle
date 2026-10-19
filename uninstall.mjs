#!/usr/bin/env node
// uninstall.mjs — 卸载：停守护 → 删 .app → 清数据目录（可选保留数据）
//
// 用法：node uninstall.mjs [--home DIR] [--keep-data]
//   默认连 ~/.chronicle/ 一起删（含 segments 数据与 config.json）；
//   --keep-data 只删 Chronicle Helper.app 与 pidfile，保留你的活动记录与隐私配置。

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chronicleHome } from './daemon.mjs';
import { APP_NAME } from './setup.mjs';

const log = (s) => console.log(s);

export function parseArgs(argv) {
  const out = { home: null, keepData: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`缺少参数值: ${a}`); return v; };
    if (a === '--home') out.home = path.resolve(next());
    else if (a === '--keep-data') out.keepData = true;
    else if (a === '--help' || a === '-h') { log('用法: node uninstall.mjs [--home DIR] [--keep-data]'); process.exit(0); }
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

function readPid(home) {
  try {
    const pid = Number.parseInt(readFileSync(path.join(home, 'daemon.pid'), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home = args.home ?? chronicleHome();

  // ① 停在跑的守护管理器（SIGTERM → 它会转发 stop 给 Swift 守护并退出）
  const pid = readPid(home);
  if (pidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    log(`① 已发送停止信号给守护管理器 pid ${pid}`);
  } else {
    log('① 守护未在运行');
  }

  // ② 删 Chronicle Helper.app（系统设置「辅助功能」列表里的条目会随之失效，可手动移除）
  const appPath = path.join(home, `${APP_NAME}.app`);
  if (existsSync(appPath)) {
    rmSync(appPath, { recursive: true, force: true });
    log(`② 已删除 ${appPath}`);
    log('   （系统设置 → 隐私与安全性 → 辅助功能 里的残留条目可手动移除）');
  } else {
    log('② Chronicle Helper.app 不存在（跳过）');
  }

  // ③ 数据目录
  if (args.keepData) {
    log(`③ 保留数据目录 ${home}（--keep-data）`);
  } else if (existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
    log(`③ 已删除数据目录 ${home}（活动记录与配置一并清除，不可恢复）`);
  } else {
    log('③ 数据目录不存在（跳过）');
  }

  // ④ 仓库内的编译产物（源码保留，随时 npm run setup 重装）
  const repoHost = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'host');
  if (existsSync(repoHost)) {
    rmSync(repoHost, { recursive: true, force: true });
    log('④ 已删除编译产物 host/（源码保留，npm run setup 可随时重装）');
  }
  log('卸载完成。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`[uninstall] 失败: ${e.message}`); process.exit(1); });
}
