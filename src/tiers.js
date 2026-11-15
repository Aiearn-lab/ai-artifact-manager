'use strict';

const { findVersionChains } = require('./versionchain');

/**
 * 三档责任预案（2026-11-06 哥哥定案，小白模式的核心口径）：
 *
 * 第一档·静默删：全文哈希完全相同的副本（正本必然还在＝信息零损失，唯一能承诺 100% 的场景）。
 * 第二档·点头删：版本链——工具认亲分组，用户对「组」一次点头「留最新删其余」，不逐文件判断。
 * 第三档·只收不删：来源是 AI 但拿不准的（一次性脚本、没跑过证据的垃圾分类）→ 回收箱，无期限。
 *
 * 铁律：
 * - 前三档接走的文件不重复出现在后档；
 * - 「这是我写的」/项目内/来源未识别的文件任何档都不进（工具不冒充知道）；
 * - 高置信垃圾在没有重复证据时也不静默删——降级进第三档只收。判得越没底，动手越轻。
 * 署名：智维工作室 / Zhiwei Studio
 */

const STASH_CATEGORY_KEYS = new Set(['junk', 'tool-onetime']); // 拿不准的默认只收这几类

/** 基本资格：AI 来源 + 非负样本 + 非项目内（三档共用第一道门） */
function basicEligible(f) {
  return !!f && !!f.source && f.source.id !== 'unknown' && !f.mine && !f.inProject;
}

/** 第一档：逐字节相同的副本（inProject/mine 由 basicEligible 拦；正本 isKeeper 不在这里） */
function isExactCopy(f) {
  return !!(f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'exact');
}

/**
 * 生成预案。files＝扫描产出（已去过重标记与人工判定回填）。
 * 返回 { silentDupes, chains, stash, stats }，全部可序列化。
 */
function buildTierPlan(files) {
  const all = Array.isArray(files) ? files : [];

  const silentDupes = all.filter((f) => basicEligible(f) && isExactCopy(f));
  const takenIds = new Set(silentDupes.map((f) => f.id));
  // 完全重复组的正本（isKeeper）任何单子都不上：界面承诺「正本一个都不动」，
  // 哪怕它自己被判成垃圾或混在版本链里，也不进第二、三档（2026-11-06 e2e 回归）。
  for (const f of all) {
    if (f.duplicate && f.duplicate.isKeeper && f.duplicate.kind === 'exact') takenIds.add(f.id);
  }

  // 第二档：已被第一档接走的不参与认亲，避免一个文件出现在两张单子上
  const restForChains = all.filter((f) => !takenIds.has(f.id));
  const chains = findVersionChains(restForChains);
  for (const c of chains) {
    takenIds.add(c.keeper.id); // 链里那份最新的「留」，不进任何后续桶
    for (const f of c.older) takenIds.add(f.id);
  }

  // 第三档：剩下的里挑「垃圾/一次性」分类的收进回收箱；高置信也一样只收（无重复证据不静默删）
  const stash = all.filter(
    (f) => basicEligible(f) && !takenIds.has(f.id) && f.category && STASH_CATEGORY_KEYS.has(f.category.key)
  );
  for (const f of stash) takenIds.add(f.id);

  let freedBytes = 0;
  for (const f of silentDupes) freedBytes += Number(f.size) || 0;
  let chainOlderBytes = 0;
  for (const c of chains) for (const f of c.older) chainOlderBytes += Number(f.size) || 0;

  return {
    silentDupes,
    chains,
    stash,
    stats: {
      dupes: silentDupes.length,
      chainCards: chains.length,
      chainOlder: chains.reduce((s, c) => s + c.older.length, 0),
      stash: stash.length,
      freedBytes, // 只有第一档算「肯定能释放」；版本卡要等用户点头才计数，界面上报数别虚
      chainOlderBytes
    }
  };
}

module.exports = { buildTierPlan, basicEligible, isExactCopy };
