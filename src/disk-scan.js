'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * 磁盘体检·体积统计（只统计，不读文件内容）。
 *
 * 和 scanner.js 的区别：
 * - scanner 要读每个文件的开头来认「是不是 AI 产出的」，慢（要 open + read）
 * - 这里只 stat，不 open，所以快一个数量级——用户要的是「谁吃了我的空间」，
 *   这件事跟文件内容没关系，没必要为它付读盘的钱。
 *
 * 规矩：
 * - 只读，绝不改动任何文件；
 * - 单个目录/文件出错（没权限、被占用）跳过并计数，不让整次统计失败；
 * - 支持取消，用户点「停」立刻停。
 * 署名：智维工作室 / Zhiwei Studio
 */

// 这些目录里全是可重建的东西，单独归类，统计时也单独算。
//
// 真机回归后刻意移除三类名字——它们"理论可重建、实际删了会断当前工作"：
// - bin：<工具>\bin（各类运行时、JDK）是程序本体的可执行文件
// - node_modules / site-packages：程序自带的那份删了程序就跑不起来；项目那份本来就有项目依赖保护
// - venv / .venv / env：虚拟环境，重装依赖可能受网络影响装不回来
// 留下的都是真正的缓存/字节码/构建产物，删了无感或能自动重建。
const REBUILDABLE_DIRS = new Set([
  '__pycache__',
  'dist', 'build', 'out', 'target', 'release', '.next', '.nuxt',
  '.cache', '.parcel-cache', '.turbo', '.gradle', '.m2',
  'obj', 'Debug', 'Release'
]);

const SYSTEM_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata',
  '$recycle.bin', 'system volume information', 'recovery', 'perflogs',
  '$windows.~bt', '$windows.~ws', 'config.msi', 'boot'
]);

function isRebuildableName(name) {
  return REBUILDABLE_DIRS.has(String(name || '').toLowerCase());
}

function isSystemTop(name) {
  return SYSTEM_DIRS.has(String(name || '').toLowerCase());
}

// 程序的数据目录 / 安装目录特征：这些目录的"名字"再像缓存也不能清，
// 因为里面装的是正在运行的程序自己的东西。真机实测命中的：
//   DoubaoData\...\pip_runtime\cache（9GB）、deepseek\resources\app.asar.unpacked、Node 安装目录…
const PROGRAM_DATA_HINT = /(user data|app\.asar|\\resources\\|pip_runtime|sandbox_runtime|deliveryoptimization|node-v?\d|electron\\cache|\.workbuddy|wechat files|xwechat_files)/i;

function isInsideProgramData(target) {
  return PROGRAM_DATA_HINT.test(String(target || ''));
}

/**
 * 整条路径里只要任何一层是系统目录，就当系统目录处理。
 *
 * 为什么需要这个：真机上 C:\Windows\System32\winevt\Logs 最后一级叫 "Logs"，
 * 单独看名字会被当成"日志缓存"判成可清。但它躺在 Windows 里面，是系统事件日志。
 * 判档和清理守门都必须看完整路径，不能只看末级名。
 */
function isUnderSystemPath(target) {
  const parts = String(target || '')
    .replace(/[\\/]+/g, '/')
    .split('/')
    .filter(Boolean);
  // 跳过开头的盘符（C:），检查后面每一段
  for (const part of parts) {
    if (SYSTEM_DIRS.has(part.toLowerCase())) return true;
  }
  return false;
}

/**
 * 统计一个目录的体积。
 * 返回 { path, name, size, files, dirs, errors, children:[...不展开时为 null], truncated }
 * options:
 *   maxDepth    往下统计的层数（默认 3：根 → 一级 → 二级 → 三级）
 *   keepTree    是否保留子目录明细（false 时只算总和，省内存）
 *   onProgress  已处理文件数回调
 *   shouldStop  返回 true 时中止
 */
async function measure(target, options) {
  const opts = options || {};
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 3;
  const keepTree = opts.keepTree !== false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;

  const startedAt = Date.now();
  let seenFiles = 0;
  let errors = 0;
  let stopped = false;
  let lastTick = 0;

  /** 递归量一个目录 */
  async function walk(dir, depth) {
    const node = {
      path: dir,
      name: path.basename(dir) || dir,
      size: 0,
      files: 0,
      dirs: 0,
      errors: 0,
      children: keepTree && depth < maxDepth ? [] : null
    };
    if (shouldStop()) {
      stopped = true;
      return node;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      node.errors += 1;
      errors += 1;
      return node;
    }
    for (const ent of entries) {
      if (stopped || shouldStop()) {
        stopped = true;
        break;
      }
      const full = path.join(dir, ent.name);
      let st;
      try {
        // 符号链接不跟随：跟了会绕圈，也会把别的盘算进来
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          st = null;
        } else if (ent.isFile()) {
          st = await fsp.stat(full);
        } else {
          continue;
        }
      } catch {
        node.errors += 1;
        errors += 1;
        continue;
      }
      if (st === null) {
        const sub = await walk(full, depth + 1);
        node.size += sub.size;
        node.files += sub.files;
        node.dirs += 1 + sub.dirs;
        node.errors += sub.errors;
        if (node.children) node.children.push(sub);
      } else {
        node.size += st.size;
        node.files += 1;
        seenFiles += 1;
        if (onProgress && seenFiles - lastTick >= 2000) {
          lastTick = seenFiles;
          try {
            onProgress(seenFiles);
          } catch {
            /* 进度回调出错不影响统计 */
          }
        }
      }
    }
    return node;
  }

  const root = await walk(path.resolve(target), 0);
  root.durationMs = Date.now() - startedAt;
  root.totalFiles = seenFiles;
  root.totalErrors = errors;
  root.stopped = stopped;
  return root;
}

/** 把一棵树压平成「目录 → 体积」的排行（只取到指定层） */
function flatten(node, depth, out, maxDepth) {
  const list = out || [];
  const limit = maxDepth == null ? 2 : maxDepth;
  if ((depth || 0) > limit) return list;
  if (node && node.children) {
    for (const c of node.children) {
      list.push({ path: c.path, name: c.name, size: c.size, files: c.files, dirs: c.dirs });
      flatten(c, (depth || 0) + 1, list, limit);
    }
  }
  return list;
}

/**
 * 回收站体检：只统计，不清理。
 * Windows 回收站结构：<drive>:\$RECYCLE.BIN\<SID>\$R*（真文件）+ $I*（记账，含原路径）
 */
async function measureRecycleBin(drive) {
  const rootDir = path.join(drive.endsWith(':') ? drive + '\\' : drive, '$RECYCLE.BIN');
  const result = { path: rootDir, exists: false, size: 0, files: 0, errors: 0, byExt: [] };
  let buckets;
  try {
    buckets = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return result;
  }
  result.exists = true;
  const byExt = new Map();

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      result.errors += 1;
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.startsWith('$R')) continue;
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        result.errors += 1;
        continue;
      }
      result.size += st.size;
      result.files += 1;
      const ext = (path.extname(ent.name) || '(无扩展名)').toLowerCase();
      const cur = byExt.get(ext) || { ext, size: 0, files: 0 };
      cur.size += st.size;
      cur.files += 1;
      byExt.set(ext, cur);
    }
  }

  for (const b of buckets) {
    if (b.isDirectory()) await walk(path.join(rootDir, b.name));
  }
  result.byExt = Array.from(byExt.values()).sort((a, b) => b.size - a.size);
  return result;
}

module.exports = {
  measure,
  flatten,
  measureRecycleBin,
  isRebuildableName,
  isSystemTop,
  isUnderSystemPath,
  isInsideProgramData,
  REBUILDABLE_DIRS,
  SYSTEM_DIRS
};
