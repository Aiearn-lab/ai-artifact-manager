'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { ensureNote } = require('./folder-note.js'); // 卸载保护提醒：整理目录里放一张说明书
const { safeFileName, isInside, isProtectedPath } = require('./safe-path');

const GROUP_DIRS = {
  knowledge: '知识库沉淀',
  'tool-common': path.join('工具脚本', '常用工具'),
  'tool-onetime': path.join('工具脚本', '一次性脚本'),
  junk: '冗余可删',
  other: '其他文件'
};

function dirForCategory(category) {
  const key = (category && category.key) || 'other';
  return GROUP_DIRS[key] || GROUP_DIRS.other;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function uniqueTarget(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
    if (i > 999) throw new Error('同名文件过多，已中止');
  }
  return candidate;
}

/**
 * 按分类归档。一律移动（剪切），原位置不再保留——这是整理工具，永远不做复制，
 * 否则「越清越多」。跨盘移动时底层先复制再删原文件，那是对用户不可见的实现细节。
 * 目标结构：<archiveRoot>/<分类目录>/<文件名>
 */
async function archive(files, archiveRoot) {
  const root = path.resolve(archiveRoot);

  if (!root) throw new Error('归档目录不能为空');

  const result = {
    ok: 0,
    failed: [],
    skipped: [],
    done: [],
    target: root,
    mode: 'move',
    byDir: {}
  };

  // 根目录先落一张「卸载后请看」：日后用户在资源管理器里看到这批分类文件夹，
  // 知道是谁放的、怎么退回，不会当成垃圾一把删掉（写失败不影响整理）
  await ensureNote(root, 'archive');

  for (const file of files) {
    const relDir = dirForCategory(file.category);
    const targetDir = path.join(root, relDir);

    try {
      await fsp.mkdir(targetDir, { recursive: true });

      if (path.resolve(file.path) === path.resolve(path.join(targetDir, file.name))) {
        result.skipped.push({ path: file.path, reason: '已在归档目录内' });
        continue;
      }

      // 文件对象可能是从索引/账本读回来的，name 不可信：清洗掉路径分隔符与控制字符，
      // 再核一遍最终落点确实在分类目录里，绝不让「..\\..\\x」把文件写到归档根之外
      const safeName = safeFileName(file.name || path.basename(String(file.path || '')), path.extname(String(file.path || '')));
      if (!safeName) {
        result.skipped.push({ path: file.path, reason: '文件名不可用（清洗后为空）' });
        continue;
      }
      const targetPath = await uniqueTarget(targetDir, safeName);
      if (!isInside(targetDir, targetPath)) {
        result.skipped.push({ path: file.path, reason: '目标路径越出归档目录，已拒绝' });
        continue;
      }

      try {
        await fsp.rename(file.path, targetPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // 跨盘 rename 不行：先落到目标盘，再删原文件，净效果仍是移动
          await fsp.copyFile(file.path, targetPath);
          await fsp.unlink(file.path);
        } else {
          throw err;
        }
      }

      result.ok += 1;
      result.done.push({ path: file.path, target: targetPath, category: relDir });
      if (!result.byDir[relDir]) result.byDir[relDir] = 0;
      result.byDir[relDir] += 1;
    } catch (err) {
      result.failed.push({ path: file.path, error: err.code || err.message });
    }
  }

  return result;
}

/**
 * 撤销归档：把一批已归档文件搬回原位置（archive 的逆操作）。
 * items: [{ from: 原路径, to: 归档后的路径 }]
 * 原位置已被占用时自动加 (1)，绝不覆盖；归档端文件不在了就跳过并说明。
 *
 * 目标路径受保护（系统目录 / 盘符根本身）时拒绝并记进 refused：
 * 撤销归档要写到「任意原路径」，账本一旦被本机其他程序改写，这里就是最后一道闸。
 */
async function restoreArchived(items) {
  const result = { ok: 0, failed: [], skipped: [], refused: [], done: [] };
  for (const item of items || []) {
    try {
      if (!(await exists(item.to))) {
        result.skipped.push({ path: item.to, reason: '归档里的文件已不在（可能被手动挪走）' });
        continue;
      }
      if (isProtectedPath(item.from)) {
        result.refused.push({ path: String(item.from), reason: '目标路径受保护（系统目录/盘符根），已拒绝' });
        continue;
      }
      const targetDir = path.dirname(item.from);
      await fsp.mkdir(targetDir, { recursive: true });
      const target = await uniqueTarget(targetDir, path.basename(item.from));
      if (isProtectedPath(target)) {
        result.refused.push({ path: target, reason: '目标路径受保护（系统目录/盘符根），已拒绝' });
        continue;
      }
      try {
        await fsp.rename(item.to, target);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await fsp.copyFile(item.to, target);
          await fsp.unlink(item.to);
        } else {
          throw err;
        }
      }
      result.ok += 1;
      result.done.push({ path: target, from: item.to });
    } catch (err) {
      result.failed.push({ path: item.to, error: err.code || err.message });
    }
  }
  return result;
}

module.exports = { archive, restoreArchived, dirForCategory, GROUP_DIRS };
