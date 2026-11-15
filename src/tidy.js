'use strict';

/**
 * 一键整理的「来源闸 + 置信分级」——纯函数，不碰文件系统，方便单测。
 *
 * 铁律（2026-11-06 评审定案）：
 * 1. 自动路径只动「确认是 AI 产出 + 高置信」的文件；
 * 2. 未识别来源 / 中低置信 / 用户标过「这是我写的」/ 项目内代码，一律进待确认桶，
 *    只能由用户在界面上手动勾选处理，工具绝不自动搬、自动删；
 * 3. 项目内代码（package.json / .git 所在项目）只盘点，任何路径都不搬不删——
 *    搬走会断掉项目的依赖链；
 * 4. 「相似但不完全相同」的重复永远不自动删，只提示。
 */

/** 这个文件按分类该走哪条路：'keep'=值得归档留存，'trash'=可清理，null=不参与整理 */
function actionFor(f) {
  if (!f || !f.category) return null;
  if (f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'exact') return 'trash';
  if (f.category.key === 'junk') return 'trash';
  if (f.category.group === 'knowledge' || f.category.group === 'tool') return 'keep';
  return null;
}

/**
 * 是否允许「自动」处理。返回 { ok, why }：
 * why 用机器可读的短语，界面负责翻译成人话。
 */
function autoEligible(f, aiOnly) {
  if (f.inProject) return { ok: false, why: 'in-project' };
  if (f.mine) return { ok: false, why: 'mine' };
  if (aiOnly && (!f.source || f.source.id === 'unknown' || !f.source.id)) {
    return { ok: false, why: 'source-unknown' };
  }
  if (!f.category || f.category.confidence !== 'high') return { ok: false, why: 'low-confidence' };
  return { ok: true, why: '' };
}

/**
 * 生成整理预案。返回：
 *   keep    —— 自动归档的（值得留的知识/工具）
 *   trash   —— 自动清理的（完全重复/高置信冗余）
 *   pending —— 本来够格但被闸门拦下的，附拦截原因，只能手动处理
 *   similar —— 相似重复，永远只提示不动手
 */
function buildPlan(files, options) {
  const opts = options || {};
  const aiOnly = opts.aiOnly !== false; // 默认开闸；关掉=老行为，仅供调试
  const plan = { aiOnly, keep: [], trash: [], pending: [], similar: [] };

  for (const f of files || []) {
    if (f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'similar') {
      plan.similar.push(f);
      continue; // 相似的连预案都不进，避免任何自动路径碰到它
    }
    const action = actionFor(f);
    if (!action) continue;
    const gate = autoEligible(f, aiOnly);
    if (gate.ok) {
      plan[action].push(f);
    } else {
      plan.pending.push({ file: f, action, why: gate.why });
    }
  }

  // 同一个文件不能既归档又删除（理论上不会，双保险）
  const trashSet = new Set(plan.trash.map((f) => f.path));
  plan.keep = plan.keep.filter((f) => !trashSet.has(f.path));

  plan.stats = {
    keep: plan.keep.length,
    trash: plan.trash.length,
    pending: plan.pending.length,
    similar: plan.similar.length
  };
  return plan;
}

module.exports = { buildPlan, actionFor, autoEligible };