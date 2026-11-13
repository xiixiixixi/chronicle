// shared/app-icons.mjs — GET /api/app-icon 的取图层：校验目标 → 磁盘缓存 → 单飞渲染 → 未命中负缓存
//
// 缓存：<home>/cache/app-icons/（目录 0700），文件名由已校验的键派生：
//   b-<bundleId>.png / n-<encodeURIComponent(name)>.png；过长（>200）改用 h-<sha256>.png。
// 新鲜度 7 天；写入走临时文件 + rename；PNG 签名校验通过才缓存/返回。
// 渲染：默认 macOS osascript（JXA，AppKit 画到 size×size 位图并写 PNG）；非 darwin 一律未找到。

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const APP_ICON_SIZE = 128;
export const APP_ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_ICON_MISS_TTL_MS = 10 * 60 * 1000;
export const APP_ICON_MAX_PARALLEL = 3;
export const APP_ICON_RENDER_TIMEOUT_MS = 8000;

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const APP_NAME_RE = /^[\p{L}\p{N} ._-]{1,80}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_FILE_KEY_LENGTH = 200;
const MISS_CACHE_MAX = 1000;

/**
 * 解析查询参数（bundleId 与 app 二选一）。
 * @param {URLSearchParams} params
 * @returns {{target:{bundleId:string}|{app:string}} | {error:string}}
 */
export function parseAppIconQuery(params) {
  const hasBundle = params.has('bundleId');
  const hasApp = params.has('app');
  if (hasBundle === hasApp) return { error: 'bundleId 与 app 必须且只能给一个' };
  if (hasBundle) {
    const bundleId = params.get('bundleId');
    if (!BUNDLE_ID_RE.test(bundleId)) return { error: 'bundleId 不合法' };
    return { target: { bundleId } };
  }
  const app = params.get('app');
  if (!APP_NAME_RE.test(app) || app.startsWith('.')) return { error: 'app 名称不合法' };
  return { target: { app } };
}

/** 已校验目标 → 缓存文件名（单射：前缀区分模式，过长走哈希）。 */
export function appIconCacheName(target) {
  const [prefix, raw] = target.bundleId !== undefined ? ['b', target.bundleId] : ['n', encodeURIComponent(target.app)];
  const key = `${prefix}-${raw}`;
  if (key.length <= MAX_FILE_KEY_LENGTH) return `${key}.png`;
  return `h-${createHash('sha256').update(key).digest('hex')}.png`;
}

function hasPngSignature(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(PNG_SIGNATURE.length);
    return readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.equals(PNG_SIGNATURE);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// JXA：argv = [mode('bundle'|'name'), value, outFile, size]；参数只经 argv 传入，绝不拼进脚本。
const JXA_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const mode = argv[0], value = argv[1], out = argv[2], size = Number(argv[3] || 128);
  const ws = $.NSWorkspace.sharedWorkspace;
  let appPath;
  if (mode === 'bundle') {
    const url = ws.URLForApplicationWithBundleIdentifier(value);
    if (!url || url.isNil()) return 'missing';
    appPath = url.path;
  } else {
    const p = ws.fullPathForApplication(value);
    if (!p || p.isNil()) return 'missing';
    appPath = p;
  }
  const icon = ws.iconForFile(appPath);
  if (!icon || icon.isNil()) return 'missing';
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  ctx.imageInterpolation = $.NSImageInterpolationHigh;
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1.0);
  ctx.flushGraphics;
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return png.writeToFileAtomically(out, true) ? 'ok' : 'write-failed';
}`;

/**
 * 默认渲染器：macOS 上用 osascript -l JavaScript（execFile，无 shell，8s 超时）；其它平台 → false。
 * @returns {Promise<boolean>} 写出 PNG → true；应用不存在 → false；进程失败 → 抛错
 */
export function osascriptAppIconRenderer(target, outFile, size) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const args = target.bundleId !== undefined ? ['bundle', target.bundleId] : ['name', target.app];
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT, ...args, outFile, String(size)],
      { timeout: APP_ICON_RENDER_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const out = String(stdout).trim();
        if (out === 'ok') return resolve(true);
        if (out === 'missing') return resolve(false);
        return reject(new Error(`app icon render failed: ${out || 'no output'}`));
      });
  });
}

/**
 * 应用图标服务。
 * @param {{home:string, renderer?:(target:object, outFile:string, size:number)=>Promise<boolean>, now?:()=>number, size?:number, log?:(msg:string)=>void}} opts
 * @returns {{get:(target:{bundleId:string}|{app:string})=>Promise<{status:200,file:string}|{status:404}>}}
 */
export function createAppIconService({
  home, renderer = osascriptAppIconRenderer, now = Date.now, size = APP_ICON_SIZE, log = () => {},
} = {}) {
  const dir = path.join(home, 'cache', 'app-icons');
  const inflight = new Map(); // fileName → Promise
  const misses = new Map(); // fileName → expiresAtMs
  const waiting = [];
  let running = 0;

  const acquire = () => new Promise((resolve) => {
    if (running < APP_ICON_MAX_PARALLEL) { running += 1; resolve(); } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else running -= 1;
  };

  const freshCached = (file) => {
    try {
      const st = statSync(file);
      if (!st.isFile() || now() - st.mtimeMs >= APP_ICON_TTL_MS) return false;
    } catch { return false; }
    return hasPngSignature(file);
  };

  const rememberMiss = (name) => {
    if (misses.size >= MISS_CACHE_MAX) {
      const t = now();
      for (const [k, exp] of misses) if (exp <= t) misses.delete(k);
      if (misses.size >= MISS_CACHE_MAX) misses.delete(misses.keys().next().value);
    }
    misses.set(name, now() + APP_ICON_MISS_TTL_MS);
  };

  async function render(target, name, file) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* 部分文件系统不支持 */ }
    const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}.png`);
    await acquire();
    try {
      let wrote = false;
      try {
        wrote = await renderer(target, tmp, size);
      } catch (err) {
        log(`应用图标渲染失败: ${err?.message ?? err}`);
        wrote = false;
      }
      if (wrote !== true || !hasPngSignature(tmp)) {
        rememberMiss(name);
        return { status: 404 };
      }
      renameSync(tmp, file);
      return { status: 200, file };
    } finally {
      release();
      try { unlinkSync(tmp); } catch { /* 已 rename 或未生成 */ }
    }
  }

  async function get(target) {
    const name = appIconCacheName(target);
    const file = path.join(dir, name);
    const missUntil = misses.get(name);
    if (missUntil !== undefined) {
      if (missUntil > now()) return { status: 404 };
      misses.delete(name);
    }
    if (freshCached(file)) return { status: 200, file };
    let pending = inflight.get(name);
    if (!pending) {
      pending = render(target, name, file).finally(() => inflight.delete(name));
      inflight.set(name, pending);
    }
    return pending;
  }

  return { get };
}
