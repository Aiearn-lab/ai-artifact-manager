'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { isSystemTop } = require('./disk-scan');
const { gradeDir } = require('./disk-classify');

/**
 * 磁盘体检·一键清理的守门逻辑。
 *
 * 这一层只做一件事：**决定"这一条现在还能不能清"**，并且宁可拒错，不可放过。
 * 全部重算，不信任界面传来的任何东西——界面只传路径，条数、体积、档位
 * 一律回查主进程自己那份体检结果。
 *
 * 三条硬规矩（对应产品承诺）：
 * 1. 只清「能安全清掉」这一档，且必须仍是"按目录名就能判定可重建"的（node_modules/dist/cache…）
 * 2. 凡是某个项目的依赖（旁边有 package.json / .git / requirements.txt…），一律不清——
 *    重装一次要跑几分钟，还可能因为网络问题装不回来，这不是"删了就能回来"
 * 3. 只在本次体检的根目录范围内动手，盘符根、系统目录、回收站目录永不碰
 *
 * 署名：智维工作室 / Zhiwei Studio
 */

// 项目标记文件：看见其中任何一个，说明目标多半是某个项目的依赖
const PROJECT_MARKERS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.git',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile'
];

function norm(p) {
  return path.resolve(String(p || ''));
}

/** child 是否在 parent 里面（严格子路径） */
function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return false;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/**
 * 往上找项目标记。只看祖先，不看目标自己里面（node_modules 里面当然没有 package.json
 * 的语义，我们要的是"它属于谁"）。
 * 最多往上 8 层——node_modules / venv 都在项目根下一两层，8 层够用且不会跑太久。
 *
 * @param {string} target 目标目录
 * @param {Map} [memo] 可选缓存：同一个盘上几百个 node_modules 往往共享祖先，
 *                     不缓存的话每个都要重新 stat 一遍十几层。
 */
async function findProjectMarker(target, memo) {
  let dir = path.dirname(norm(target));
  const chain = [];
  let found = null;
  for (let i = 0; i < 8; i += 1) {
    if (memo && memo.has(dir)) {
      found = memo.get(dir);
      break;
    }
    chain.push(dir);
    let hit = false;
    for (const marker of PROJECT_MARKERS) {
      try {
        await fsp.stat(path.join(dir, marker));
        hit = true;
        break;
      } catch {
        /* 没有这个标记 */
      }
    }
    if (hit) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (memo) for (const d of chain) memo.set(d, found);
  return found;
}

/**
 * 单条复核。
 * @param {string} target 要清的目录
 * @param {string} root   本次体检的根目录
 * @returns {Promise<{ok:boolean, reason?:string, size?:number}>}
 */
async function inspect(target, root) {
  const abs = norm(target);
  const rootAbs = norm(root);

  if (!target) return { ok: false, reason: '没有路径' };
  if (abs === rootAbs) return { ok: false, reason: '不能清整块盘' };
  if (!isInside(abs, rootAbs)) return { ok: false, reason: '不在本次体检的范围内' };

  const name = path.basename(abs);
  if (!name) return { ok: false, reason: '路径不完整' };
  if (isSystemTop(name)) return { ok: false, reason: '这是系统目录' };
  if (/\$recycle\.bin/i.test(abs)) return { ok: false, reason: '这是回收站自己的目录' };
  if (/^(windows|program files|program files \(x86\)|programdata|users)$/i.test(name)) {
    return { ok: false, reason: '这是系统或程序目录' };
  }
  // 体检根目录下的第一层一律不自动清。
  // 理由：E:\out、E:\env、E:\logs 这种名字在别处确实是"可重建"，
  // 但直接躺在根目录下的，很可能是用户自己建的导出/日志文件夹。
  // 少清一层不影响大局，清错一次就是事故。
  if (path.dirname(abs) === rootAbs) {
    return { ok: false, reason: '第一层的大目录不自动清，人工确认更稳' };
  }

  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    return { ok: false, reason: '这个目录已经不在了' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: '这是个快捷链接，不碰' };
  if (!st.isDirectory()) return { ok: false, reason: '现在不是文件夹了' };

  // 关键一步：拿现在的真实情况重新判一次档。
  // 不传 size/files，只走"按目录名就能判定可重建"那条分支——
  // 体积和文件数是会变的，名字不会，按名字判最稳。
  const g = gradeDir({ path: abs, name, size: 0, files: 0 });
  if (g.grade !== 'safe' || !g.explicit) {
    return { ok: false, reason: '再看一次已经不是可重建的目录了（可能被改过），不清' };
  }

  const proj = await findProjectMarker(abs);
  if (proj) {
    return {
      ok: false,
      reason: `这是某个项目的依赖（${proj}），清掉项目就跑不起来了。要清请自己在文件夹里删`
    };
  }

  return { ok: true };
}

module.exports = { inspect, findProjectMarker, isInside, PROJECT_MARKERS };
