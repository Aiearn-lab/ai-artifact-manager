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

/** 参与认亲的资格：AI 来源 + 非「这是我写的」+ 非项目内 */
function eligible(f) {
  if (!f || !f.source || f.source.id === 'unknown') return false;
  if (f.mine || f.inProject) return false;
  return true;
}

// 未来时间戳容差（与 digest.js 同一口径）：超过 now+60s 的 mtime 一律不信任。
// 不需要恶意输入也会出现「明年」的时间戳——U 盘/移动硬盘拷贝、网盘同步回写、
// 系统时钟回拨、虚拟机快照都会留下这种时间戳。按它认最新，结果就是「留旧删新」，
// 把用户真正最新的那份列进删除清单。这类文件不参与 keeper 竞争，也不进删除候选，
// 单独列为 suspect 交给上层（宁可不认，不可乱删）。
const FUTURE_TOLERANCE_MS = 60 * 1000;

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
    for (const f of members) {
      const st = stampOf(f, now);
      tBy.set(f, st.t);
      if (st.future) suspects.push(f);
      else trusted.push(f);
    }
    if (trusted.length < 2) continue; // 可信的不足两个：孤文件不成链，宁可不出卡
    const sorted = trusted.sort((a, b) => {
      // 扫描器真实产出把 stat.mtimeMs 放在 mtime 字段；两种形状都要认，认反了会「留旧删新」
      const ta = tBy.get(a) || 0;
      const tb = tBy.get(b) || 0;
      if (tb !== ta) return tb - ta; // 新在前
      return String(a.path).localeCompare(String(b.path));
    });
    const [keeper, ...older] = sorted;
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

module.exports = { findVersionChains, familyOf, eligible };
