'use strict';

const { buildTierPlan } = require('./tiers');

/**
 * 周报/月报纯函数（v0.8 M3）。
 * 周报＝托盘里那句大白话（这周 AI 又生成了 N 个文件，M 个可以让管家收走）；
 * 月报＝本机近 30 天四个数字（收走/放回/释放/留下）＋一行服务入口话术。
 * 口径铁律：
 * - 「可收走」直接复用三档预案（tiers.buildTierPlan），和「一键瘦身」同一把尺子，两套数字不许打架；
 * - 所有数字只从本机日志算，软件不上报任何东西（零遥测，写死在关于页）；
 * - 文案只准用大白话词表（受 _test/run_word_gate.js 约束）。
 * 署名：智维工作室 / Zhiwei Studio
 */

const DAY = 24 * 60 * 60 * 1000;

/** 时间字段兼容：日志里可能放 at，也可能放 mtimeMs/时间戳 */
function tsOf(o) {
  if (!o) return 0;
  return Number(o.at != null ? o.at : o.mtimeMs != null ? o.mtimeMs : o.mtime) || 0;
}

/**
 * 周报：files＝扫描产出（含 mtime/source/category）。
 * 返回 { newAiFiles, removable }：本周新增的 AI 产出数、其中按三档口径可收走的数。
 */
function weeklySummary(files, nowMs) {
  const now = nowMs || Date.now();
  const all = Array.isArray(files) ? files : [];
  const weekAgo = now - 7 * DAY;
  const fresh = all.filter((f) => {
    if (!f || !f.source || f.source.id === 'unknown') return false; // 认不出的不在托盘里吹牛
    const t = tsOf(f);
    return t >= weekAgo && t <= now + 60 * 1000; // 未来时间戳（时钟漂移）不算新增
  });
  const plan = buildTierPlan(fresh);
  return { newAiFiles: fresh.length, removable: plan.stats.dupes + plan.stats.stash };
}

/**
 * 月报：输入四类本机记录（30 天外的不计入本月）。
 * stashMoved/stashRestored/trashed 元素带 size，archived 元素带 count。
 */
function monthlyReport(rec, nowMs) {
  const now = nowMs || Date.now();
  const r = rec || {};
  const in30 = (list) => (Array.isArray(list) ? list : []).filter((x) => now - tsOf(x) <= 30 * DAY && tsOf(x) > 0);
  const removed = in30(r.stashMoved).length;
  const restored = in30(r.stashRestored).length;
  const kept = in30(r.archived).reduce((s, b) => s + (Number(b.count) || 0), 0);
  const freedBytes = in30(r.trashed).reduce((s, x) => s + (Number(x.size) || 0), 0);
  return { removed, restored, kept, freedBytes, honest: true };
}

/** 把字节说成人话：不到 1MB 说 KB，大到才说 MB/GB */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 托盘一句话（≤60 字，装得下 tooltip）。
 *
 * 只说"上次扫描看到了什么"，不说"正在盯着"——托盘不是实时监控，
 * 数字来自最近一次扫描，用户没扫过就是空的。说"在盯着"是假话，会让人以为工具在工作其实没有。
 */
function trayLine(week, o) {
  const zh = !o || o.zh !== false;
  const w = week || { newAiFiles: 0, removable: 0 };
  if (!w.newAiFiles) {
    return zh
      ? 'AI产出管家 · 点我打开（想看清硬盘，点开做次体检）'
      : 'AI Artifact Manager · click to open (run a checkup to see disk usage)';
  }
  if (w.removable) {
    return zh
      ? `上次扫描：这周 AI 产出 ${w.newAiFiles} 个文件，${w.removable} 个可以收走——点开看看？`
      : `Last scan: ${w.newAiFiles} new AI files this week, ${w.removable} can be stashed — open?`;
  }
  return zh
    ? `上次扫描：这周 AI 产出 ${w.newAiFiles} 个文件，暂时没什么可收的。`
    : `Last scan: ${w.newAiFiles} new AI files this week — nothing to stash.`;
}

/** 月报页那行汇总话术 */
function monthLine(m, o) {
  const zh = !o || o.zh !== false;
  const r = m || { removed: 0, restored: 0, kept: 0, freedBytes: 0 };
  if (!r.removed && !r.restored && !r.kept && !r.freedBytes) {
    return zh ? '这个月还没让管家动过手——一切都在原位。' : 'Nothing touched this month — everything in place.';
  }
  return zh
    ? `这个月：收走 ${r.removed} 个 · 放回 ${r.restored} 个 · 释放约 ${fmtBytes(r.freedBytes)} · 收进整理目录 ${r.kept} 个。`
    : `This month: ${r.removed} stashed · ${r.restored} restored · ~${fmtBytes(r.freedBytes)} freed · ${r.kept} tidied away.`;
}

module.exports = { weeklySummary, monthlyReport, trayLine, monthLine, fmtBytes };
