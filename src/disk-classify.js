'use strict';

const path = require('path');
const { isRebuildableName, isSystemTop, isUnderSystemPath, isInsideProgramData } = require('./disk-scan');

/**
 * 磁盘体检·可回收分级。
 *
 * 只有三档，而且**默认最保守**：不认识的当「别碰」。
 * 用户是小白，给他一个猜错的建议，比不给建议坏十倍。
 *
 * - safe    放心删：装回来的东西（依赖、构建产物、缓存、日志）。删了顶多重新装一次。
 * - careful 要你确认：可能是你留下的东西（备份、归档、旧版本、模型、安装包）。
 * - keep    别碰：源码、文档、照片、游戏本体、系统目录。
 * 署名：智维工作室 / Zhiwei Studio
 */

// 目录名就是"能重新生成"的：装得回来、编得回来。
// 和 disk-scan 的可重建名单保持一致——node_modules / venv / site-packages 已移除：
// 真机上它们大多是程序自带的那份（抖音、DeepSeek、Node 安装目录），删了程序就断。
const SAFE_DIR_NAMES = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
  'dist', 'build', 'out', 'output', 'target', 'release', 'debug',
  '.next', '.nuxt', '.svelte-kit', '.parcel-cache', '.turbo', '.vite',
  '.cache', 'cache', 'caches', 'temp', 'tmp', 'logs',
  '.gradle', '.m2', '.nuget', 'obj',
  '.idea', '.vscode', '.vs'
]);

// 路径里带这些词：多半是你特意留的，不能自作主张
const ARCHIVE_HINT = /(归档|存档|备份|历史|旧版|旧稿|副本|拷贝|archive|backup|\bbak\b|old|deprecated|snapshot)/i;

// 这些目录名里带"旧"也不动：游戏、软件安装目录
const KEEP_HINT = /(游戏|game|steam|幻塔|原神|leidian|模拟器|program files)/i;

function norm(p) {
  return String(p || '').replace(/[\\/]+/g, '/');
}

/**
 * 给一个目录节点定级。
 * node: { path, name, size, files, dirs }
 * 返回 { grade, why, explicit }
 *   explicit=true 表示"我们自己主动判的"，不是"没认出来默认别碰"。
 *   这个区分很关键：只有主动判定的目录才值得单独列给用户看，
 *   否则一个 235GB 的盘會被拆成几百条「没认出来」的碎块，用户根本看不动。
 */
function gradeDir(node) {
  const name = String(node.name || '');
  const full = norm(node.path);
  const sizeGB = (Number(node.size) || 0) / 1024 ** 3;

  // 1) 系统目录与游戏/软件安装目录：一律别碰。
  //    看整条路径而不只是末级名——C:\Windows\System32\winevt\Logs 末级叫 Logs，
  //    单看名字会被当成日志缓存判成可清，其实它是系统事件日志。
  if (isSystemTop(name) || isUnderSystemPath(node.path) || isInsideProgramData(node.path) || KEEP_HINT.test(name) || KEEP_HINT.test(full)) {
    return { grade: 'keep', why: '系统或软件安装目录，不该由清理工具动', explicit: true };
  }

  // 2) 路径里带归档/备份词：你特意留的，只能提示、不能替你决定
  if (ARCHIVE_HINT.test(full)) {
    return { grade: 'careful', why: '名字看着像备份或归档，是你留的存档，删不删你定', explicit: true };
  }

  // 3) 目录名就是可重建的
  const lower = name.toLowerCase();
  if (SAFE_DIR_NAMES.has(lower) || isRebuildableName(lower)) {
    return { grade: 'safe', why: '依赖或构建产物，删了重新装/重新编就能回来', explicit: true };
  }

  // 4) 文件极多、平均极小：典型的缓存（几万个几 KB 的小文件）
  if (node.files > 3000 && node.size / Math.max(node.files, 1) < 8 * 1024) {
    return { grade: 'careful', why: '几万个小文件挤在一起，通常是缓存或缩略图', explicit: true };
  }

  // 5) 单个目录超过 5GB：不管是什么，都得你自己看一眼
  if (sizeGB >= 5) {
    return { grade: 'careful', why: '块头很大，我们判断不了，点「打开」看一眼', explicit: true };
  }

  // 6) 其余一律「别碰」——不认识就不动，这是我们敢让你一键清的前提
  return { grade: 'keep', why: '没认出是可重建的东西，按规矩不碰', explicit: false };
}

/** 汇总一份体检结果：三档各占多少 */
function summarize(nodes) {
  const out = {
    safe: { size: 0, count: 0, items: [] },
    careful: { size: 0, count: 0, items: [] },
    keep: { size: 0, count: 0, items: [] }
  };
  for (const n of nodes || []) {
    const g = n.grade || 'keep';
    const bucket = out[g] || out.keep;
    bucket.size += Number(n.size) || 0;
    bucket.count += 1;
    bucket.items.push(n);
  }
  for (const k of Object.keys(out)) {
    out[k].items.sort((a, b) => b.size - a.size);
  }
  return out;
}

/**
 * 递归把整棵树分级并汇总。
 *
 * 每个字节只归属一次，归给它"最近的、被判了档的那一层"：
 * - 目录被判「放心删」→ 整棵子树一起算，不再往下（否则 dist/a/dist 会被算两遍）
 * - 否则往下看有没有嵌套的可删目录（node_modules 常藏在项目深处），
 *   已经认领掉的字节从父节点里扣掉，不会重复
 * 这样「放心删 20GB + 要确认 60GB」才和实际能释放的量对得上。
 */
function collectGrades(root, options) {
  const opts = options || {};
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 6;
  const out = {
    safe: { size: 0, count: 0, items: [] },
    careful: { size: 0, count: 0, items: [] },
    keep: { size: 0, count: 0, items: [] }
  };

  function add(grade, node, size, depth, why) {
    const bucket = out[grade] || out.keep;
    bucket.size += size;
    bucket.count += 1;
    bucket.items.push({
      path: node.path,
      name: node.name,
      size,
      files: node.files || 0,
      grade,
      depth,
      why: why || ''
    });
  }

  /** 返回这个节点（含子树）已认领掉的字节数 */
  function visit(node, inherited, depth) {
    if (!node) return 0;
    // 根节点（整块盘）不参与判档：它 224GB 必然满足「超过 5GB 要确认」，
    // 一旦给它判档，整棵树都会继承这个档位，游戏和系统目录就全被划进来了。
    const isRoot = depth === 0;
    const g = isRoot ? { grade: 'root', explicit: false } : gradeDir(node);
    // 档位优先级：
    // 1) 自己就是「可重建」→ 放心删（node_modules 藏在游戏目录里也照样能认）
    // 2) 祖先判了「别碰」→ 整棵子树都别碰（幻塔\...\Content 这种子目录名字里没有"幻塔"，
    //    只看自己的话会被「超过 5GB 就要确认」误判成可以动，那是游戏本体）
    // 3) 自己判「要确认」→ 要确认
    // 4) 祖先判「要确认」→ 跟着要确认
    // 5) 其余 → 别碰
    const own = isRoot
      ? null
      : g.grade === 'safe'
        ? 'safe'
        : inherited === 'keep'
          ? 'keep'
          : g.grade === 'careful'
            ? 'careful'
            : inherited || 'keep';

    // 自己能整块认领的（明确判成"删了能重建"）：整棵子树一起算，不再往下
    if (own === 'safe' && g.grade === 'safe') {
      add('safe', node, node.size || 0, depth, g.why);
      return node.size || 0;
    }

    let childSum = 0;
    if (depth < maxDepth && node.children) {
      for (const c of node.children) childSum += visit(c, own, depth + 1);
    }
    const selfBytes = Math.max(0, (node.size || 0) - childSum);

    // 列出来的条件（宁少不滥）：
    // - 盘的第一层目录 → 始终列，让用户知道这块盘由哪几个大文件夹组成；
    // - 其余只有「自己主动判了档、而且剩下的大头确实在它身上」才列。
    //   第 2 条专治一种噪音：下载软件/微信/Patch 这种一层套一层的祖先，
    //   每层都只剩一点零头，全列出来会变成一长串「xx 本级零散文件」，
    //   用户看到十个数字也不知道该看哪个。零头往上合并，只留真正的大块。
    const isSource = !!(g.explicit && own && g.grade === own);
    const mostly = selfBytes * 4 >= (node.size || 0);
    const shouldList = !isRoot && selfBytes > 0 && (depth === 1 || (isSource && mostly));
    if (shouldList) {
      add(own, node, selfBytes, depth, isSource || depth === 1 ? g.why : '跟着上层目录同属这一档');
      return node.size || 0;
    }
    // 不单独列：只把子树已认领的部分还回去，剩下的零头交给父节点合并
    return childSum;
  }

  const claimed = visit(root, null, 0);
  // 盘符根目录下直接躺着的零散文件（不属于任何子目录）也要算进去，
  // 否则「三档相加 = 整块盘」这句话就不成立了。
  const loose = Math.max(0, (root.size || 0) - claimed);
  if (loose > 0) {
    add('keep', { path: root.path, name: '盘符根目录下的零散文件', files: root.files || 0 }, loose, 1, '散在盘符根目录下的文件，没归类，也没动它');
  }
  for (const k of Object.keys(out)) out[k].items.sort((a, b) => b.size - a.size);
  return out;
}

// 三档的对外叫法（要和界面文案一致）
const GRADE_LABEL = { safe: '能安全清掉', careful: '占地方的大件', keep: '不用管' };

module.exports = { gradeDir, summarize, collectGrades, GRADE_LABEL, SAFE_DIR_NAMES, ARCHIVE_HINT };
