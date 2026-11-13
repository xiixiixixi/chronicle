// shared/maintenance.mjs — 维护编排（保留策略 → 压缩 → 索引刷新）
//
// 编排原则：
//   ① 任何一步失败都**不抛给调用方**：在 report.errors 里记录，其它步骤继续。
//   ② 默认配置（retentionDays=0）时 retention 不跑、不删任何数据（安全默认）。
//   ③ 压缩来自 shared/compression.mjs（F 的写域）：用动态 import + try/catch；
//      模块尚未实现/未导出时返回 compressionSkipped=true，不阻塞维护。
//   ④ 索引刷新用 shared/index.mjs 的 ensureIndex(home)（动态 import + try/catch），
//      让索引删除已消失的段；dryRun 时跳过（ensureIndex 会写索引库，dryRun 必须零写入）。
//   ⑤ 报告只含计数/段名/错误，不含事件内容。
//
// 报告形状：
//   {
//     at, dryRun, retentionDays, compressAfterDays, warnings:[],
//     retention: pruneReport|null, retentionSkipped:boolean,
//     compression: any|null, compressionSkipped:boolean, compressionSkipReason?,
//     index: {ok?,skipped?,reason?,segments?,events?,removed?}|null,
//     errors: string[], summary: string
//   }

import { normalizeMaintenanceConfig, pruneOldSegments } from './retention.mjs';

/**
 * 跑一次维护。
 * @param {string} home 数据根
 * @param {object} config config.json 内容（或直接 maintenance 段；缺省=安全默认）
 * @param {{now?:number|Date, dryRun?:boolean, log?:Function}} opts
 * @returns {Promise<object>} 合并报告（永不抛）
 */
export async function runMaintenance(home, config = {}, { now = Date.now(), dryRun = false, log = () => {} } = {}) {
  const normalized = normalizeMaintenanceConfig(config);
  const report = {
    at: new Date(now instanceof Date ? now.getTime() : Number(now) || Date.now()).toISOString(),
    dryRun: Boolean(dryRun),
    retentionDays: normalized.retentionDays,
    compressAfterDays: normalized.compressAfterDays,
    warnings: [...normalized.warnings],
    retention: null,
    retentionSkipped: true,
    compression: null,
    compressionSkipped: true,
    index: null,
    errors: [],
  };
  for (const w of normalized.warnings) log(`[maintenance] 配置警告: ${w}`);

  // ① 保留策略（默认关闭：retentionDays=0 → 不调用 prune，绝不删除）
  if (normalized.retentionDays > 0) {
    report.retentionSkipped = false;
    try {
      report.retention = pruneOldSegments(home, {
        retentionDays: normalized.retentionDays,
        now,
        dryRun: report.dryRun,
        log,
      });
      report.warnings.push(...(report.retention.warnings ?? []));
    } catch (err) {
      report.errors.push(`retention: ${err.message}`);
      report.retention = { error: String(err.message) };
      log(`[maintenance] retention 失败（继续其它步骤）: ${err.message}`);
    }
  } else {
    log('[maintenance] retention 已关闭（retentionDays=0）：不删除任何数据');
  }

  // ② 压缩（F 的 shared/compression.mjs：动态 import，未就绪则跳过）
  if (normalized.compressAfterDays > 0) {
    try {
      const mod = await import('./compression.mjs');
      if (typeof mod.compressOldSegments === 'function') {
        report.compressionSkipped = false;
        try {
          report.compression = await mod.compressOldSegments(home, {
            afterDays: normalized.compressAfterDays,
            now,
            dryRun: report.dryRun,
            log,
          });
        } catch (err) {
          report.compression = { error: String(err.message) };
          report.errors.push(`compression: ${err.message}`);
          log(`[maintenance] compression 失败（继续）: ${err.message}`);
        }
      } else {
        report.compressionSkipReason = 'shared/compression.mjs 未导出 compressOldSegments';
        log(`[maintenance] compression 跳过: ${report.compressionSkipReason}`);
      }
    } catch (err) {
      report.compressionSkipReason = err?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'shared/compression.mjs 尚未实现（F 的写域）'
        : String(err?.message ?? err);
      log(`[maintenance] compression 跳过: ${report.compressionSkipReason}`);
    }
  } else {
    report.compressionSkipReason = 'compressAfterDays=0（关闭）';
  }

  // ③ 索引刷新（让索引删掉已消失的段）；dryRun 零写入，必须跳过
  if (report.dryRun) {
    report.index = { skipped: true, reason: 'dryRun（不写索引库）' };
  } else {
    try {
      const mod = await import('./index.mjs');
      if (typeof mod.ensureIndex === 'function') {
        const stats = mod.ensureIndex(home);
        report.index = stats
          ? { ok: true, segments: stats.segments, events: stats.events, removed: stats.removed, rebuilt: stats.rebuilt }
          : { ok: false, reason: '索引不可用（sqlite 未启用），已跳过' };
      } else {
        report.index = { ok: false, reason: 'shared/index.mjs 未导出 ensureIndex' };
      }
    } catch (err) {
      report.index = { ok: false, error: String(err?.message ?? err) };
      log(`[maintenance] 索引刷新失败（不致命）: ${err?.message ?? err}`);
    }
  }

  report.summary = summarizeMaintenanceReport(report);
  log(`[maintenance] ${report.summary}`);
  return report;
}

/** 单行摘要（只含计数/状态，不含任何内容字段），供 daemon 日志使用。 */
export function summarizeMaintenanceReport(report) {
  if (!report || typeof report !== 'object') return 'maintenance: (无报告)';
  const ret = report.retention && typeof report.retention === 'object' ? report.retention : null;
  const removedSegments = Array.isArray(ret?.removedSegments) ? ret.removedSegments.length : 0;
  const removedSummaries = Array.isArray(ret?.removedSummaries) ? ret.removedSummaries.length : 0;
  const bytesFreed = Number.isFinite(ret?.bytesFreed) ? ret.bytesFreed : 0;
  const compression = report.compressionSkipped ? 'skipped' : (report.compression?.error ? 'error' : 'ok');
  const index = report.index?.skipped ? 'skipped' : (report.index?.ok ? 'ok' : 'error');
  const errors = (Array.isArray(report.errors) ? report.errors.length : 0) + (Number.isInteger(ret?.errors) ? ret.errors : 0);
  return `dryRun=${Boolean(report.dryRun)} retentionDays=${report.retentionDays} removedSegments=${removedSegments} removedSummaries=${removedSummaries} bytesFreed=${bytesFreed} compression=${compression} index=${index} errors=${errors}`;
}
