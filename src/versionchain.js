'use strict';

const path = require('path');

/**
 * 版本链认亲（三档责任·第二档的引擎）。
 *
 * 认亲＝同一族名的多个版本（v1/v2/final/copy/日期尾/(1)…）× 同扩展名 × 时间戳。
 * 每组挑出「最新那份」当 keeper，其余才是「留最新删旧」卡片的候选——
 * 认错了也不出事：第二档必须用户对每张卡点头才动手，这是设计里的魂。
 *
 * 规矩：
 * - 只给离线规则，不调模型；模型坏了认亲照常跑。
 * - 来源未识别 / 「这是我写的」/ 项目内文件 **不参与**（宁可不组卡）。
 * - 系列名里的年份不是版本尾（报告_2025 和 报告_2026 是两代报告，不是一个版本链）。
 * - 宁可漏认，不可硬凑：凑错了顶多没卡可点，认亲认错会打扰用户。
 * 署名：智维工作室 / Zhiwei Studio
 */

// 版本尾 token：只认「明确的版本记号」，反复剥到剥不动为止
const TOKENS = [
  '[\\s._-]+(?:v|ver|版本)\\.?\\d+(?:\\.\\d+)?', // _v1 -v2 版本3
  '[\\s._-]+\\(?\\d{1,2}\\)?', // 空格1 / (1) / （2） 注意：无分隔直接跟名字时不匹配（见下方守卫）
  '[\\s._-]+20\\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\\d|3[01])', // _20261101 紧凑 8 位
  '[\\s._-]+20\\d{2}(?:[-_.](?:0?[1-9]|1[0-2])(?:[-_.](?:0?[1-9]|[12]\\d|3[01]))?)', // -2026-11-01 / _2026-11（必须带分隔+月份，孤年份不算）
  '[\\s._-]+(?:final|最新版|最新|最终版|最终|副本|拷贝|备份|copy|bak|old|new|ok|good|best|draft\\d*|定稿|第\\d+[版份])',
];
const TOKEN_RE = new RegExp('(?:' + TOKENS.join('|') + ')$', 'i');

/** 从名字尾部反复剥版本记号，得到「族名」 */
function familyOf(fileName) {
  const ext = path.extname(fileName);
  let base = path.basename(fileName, ext);
  let prev;
  do {
    prev = base;
    base = base.replace(TOKEN_RE, '');
  } while (base !== prev && base.length > 1);
  base = base.trim();
  // 守卫：剥空了、或只剩分隔符，说明整名都是记号，不认（回退原名，等于孤立）
  if (!base || /^[\s._-]+$/.test(base)) return path.basename(fileName, ext);
  return base;
}

// 文档类扩展名：AI 写的方案/报告/README 常常就放在项目文件夹里。
// 一刀切把「项目内文件」全排除，等于让工具对"按项目整理文件的人"完全失效——
// 而这类人恰恰是 AI 产出最多的人。所以项目内只放行文档，代码一律不碰。
const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.text']);

function isProjectDoc(f) {
  if (!f || !f.inProject) return false;
  return DOC_EXTS.has(String(f.ext || '').toLowerCase());
}

// 归档类目录：用户主动留档的地方，里面的文件一律不当「可删旧版」。
// 真实结构长这样：原位置留一张「已作废」便条，原文搬进 _归档/旧推广文案/。
// 工具的天然倾向是「留最新的、删旧的」——结果删掉原文、留下一张指向空路径的便条。
const ARCHIVE_SEG = /^[_\-.]?(归档|存档|备份|历史|旧|archive|archived|backup|bak|old|deprecated)([_\-.\d].*)?$/i;

function isArchivePath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  parts.pop(); // 去掉文件名本身，只看目录
  return parts.some((seg) => ARCHIVE_SEG.test(seg));
}

/** 参与认亲的资格：AI 来源 + 非「这是我写的」+ 项目内只放行文档 */
function eligible(f) {
  if (!f || !f.source || f.source.id === 'unknown') return false;
  if (f.mine) return false;
  if (f.inProject) return isProjectDoc(f);
  return true;
}

// 未来时间戳容差（与 digest.js 同一口径）：超过 now+60s 的 mtime 一律不信任。
// 不需要恶意输入也会出现「明年」的时间戳——U 盘/移动硬盘拷贝、网盘同步回写、
// 系统时钟回拨、虚拟机快照都会留下这种时间戳。按它认最新，结果就是「留旧删新」，
// 把用户真正最新的那份列进删除清单。这类文件不参与 keeper 竞争，也不进删除候选，
// 单独列为 suspect 交给上层（宁可不认，不可乱删）。
const FUTURE_TOLERANCE_MS = 60 * 1000;

// 时间戳「分不出来」的窗口：两秒以内认为先后不可辨。
// 现实里三种场景会让同族文件的时间戳撞在一起或几乎撞在一起——
// U 盘/移动硬盘拷贝（时间被统一改写）、网盘同步下载（同一时刻落盘）、解压压缩包。
// 这时按名字排序会「留 v1 删 v3」，必须改用文件名里的版本记号判断谁更新。
const SAME_TIME_MS = 2000;

const NEWER_WORDS = /(final|最新版|最新|最终版|最终|定稿|ok|good|best)/i;
const OLDER_WORDS = /(old|bak|备份|副本|拷贝|copy)/i;
const DRAFT_WORD = /draft/i;

/**
 * 从文件名估一个「谁更新」的权重（越大越新）。只在时间戳分不出来时使用。
 * 认得：v3 / ver3 / 版本3（含 v3.1）、尾部 1-2 位序号 (3) _3 空格3，
 * 以及 final/最新/定稿 这类「更新」词与 old/备份/副本 这类「更旧」词。
 * 8 位日期（20261101）不算版本号——那是另一代报告，不是同一族的第 N 版。
 */
function versionScore(name) {
  const raw = String(name || '');
  const base = path.basename(raw, path.extname(raw));
  let score = 0;
  // 日期尾优先认：20261101 这种，本身就能比大小，别落到下面按 1-2 位序号误判
  const mDate = base.match(/[\s._-](20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
  if (mDate) {
    score = parseInt(mDate[1] + mDate[2] + mDate[3], 10);
  } else {
    const m = base.match(/(?:v|ver|版本)\.?(\d+)(?:\.(\d+))?/i);
    if (m) {
      score = parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
    } else {
      const m2 = base.match(/[\s._-]\(?(\d{1,2})\)?$/);
      if (m2) score = parseInt(m2[1], 10) * 100;
    }
  }
  if (NEWER_WORDS.test(base)) score += 100000000;
  if (OLDER_WORDS.test(base)) score -= 100000000;
  if (DRAFT_WORD.test(base)) score -= 50000000;
  return score;
}

/** 取文件时间戳，并判断是否「不可信的未来时间」 */
function stampOf(f, now) {
  const raw = Number(f.mtimeMs != null ? f.mtimeMs : f.mtime) || 0;
  return { t: raw, future: raw > (now || Date.now()) + FUTURE_TOLERANCE_MS };
}

/**
 * 找出所有版本链。files: 扫描产出的文件对象数组。
 * 返回 [{ family, ext, keeper, older:[...], members:[...], suspects:[...] }]，
 * older 按新→旧排，最新那份永远是 keeper——时间戳一样时保留路径字典序小者，保证可复现。
 *
 * suspects＝时间戳在未来的成员：不参与 keeper 竞争，也不进 older（删除候选），
 * 只交给上层标注「时间戳异常」。可信成员不足两个时整组不出卡。
 */
function findVersionChains(files) {
  const now = Date.now();
  const buckets = new Map();
  for (const f of files || []) {
    if (!eligible(f)) continue;
    const name = f.name || path.basename(f.path || '');
    const ext = (f.ext || path.extname(name) || '').toLowerCase();
    const family = familyOf(name).toLowerCase();
    if (!family) continue;
    const key = `${family}|${ext}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ...f, name });
  }
  const chains = [];
  for (const [key, members] of buckets) {
    const trusted = [];
    const suspects = [];
    const tBy = new Map();
    const vBy = new Map();
    for (const f of members) {
      const st = stampOf(f, now);
      tBy.set(f, st.t);
      vBy.set(f, versionScore(f.name));
      if (st.future) suspects.push(f);
      else trusted.push(f);
    }
    if (trusted.length < 2) continue; // 可信的不足两个：孤文件不成链，宁可不出卡
    // 必须至少有一个成员「名字里带版本记号」才算版本链。
    // 否则「A产品/README.md」和「B产品/README.md」会被当成同一文档的两个版本，
    // 5 个项目就成 5 个版本——建议删掉 4 个项目的主文件，这是灾难级误判。
    // 真实版本链一定有人带记号（v2/final/(1)/日期尾），纯同名只是"不同目录里的同名文件"。
    const anyToken = trusted.some((f) => {
      const base = path.basename(f.name, path.extname(f.name));
      return familyOf(f.name).toLowerCase() !== base.toLowerCase();
    });
    if (!anyToken) continue;
    const sorted = trusted.sort((a, b) => {
      // 扫描器真实产出把 stat.mtimeMs 放在 mtime 字段；两种形状都要认，认反了会「留旧删新」
      const ta = tBy.get(a) || 0;
      const tb = tBy.get(b) || 0;
      if (Math.abs(tb - ta) > SAME_TIME_MS) return tb - ta; // 时间能分辨先后，以时间准
      // 时间撞在一起（拷贝/同步/解压）：改看文件名里的版本记号，别让 v1 因为字典序小就留下
      const sa = vBy.get(a) || 0;
      const sb = vBy.get(b) || 0;
      if (sb !== sa) return sb - sa;
      return String(a.path).localeCompare(String(b.path));
    });
    const [keeper, ...rest] = sorted;
    // 归档/备份目录里的东西不算「可删旧版」——那是用户主动留的存档
    const older = rest.filter((f) => !isArchivePath(f.path));
    if (!older.length) continue; // 可删的一个都不剩，这张卡没意义
    // 墓碑保护：keeper 比要删的最大的那份还短一半以上，多半是「已作废」便条，
    // 不是真正的最新版。此时宁可不出卡，也不能建议删掉原文。
    const maxOlderSize = older.reduce((m, f) => Math.max(m, Number(f.size) || 0), 0);
    if (maxOlderSize > 0 && (Number(keeper.size) || 0) * 2 < maxOlderSize) continue;
    const sep = key.lastIndexOf('|');
    chains.push({
      family: key.slice(0, sep),
      ext: key.slice(sep + 1),
      keeper,
      older,
      members: sorted,
      suspects,
    });
  }
  // 族名字典序输出，稳定可复现
  chains.sort((a, b) => a.family.localeCompare(b.family));
  return chains;
}

module.exports = { findVersionChains, familyOf, eligible, versionScore, isProjectDoc, DOC_EXTS };
