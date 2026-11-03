'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

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
 * 按分类归档。默认复制（不动原文件），mode='move' 时才剪切。
 * 目标结构：<archiveRoot>/<分类目录>/<文件名>
 */
async function archive(files, archiveRoot, options) {
  const opts = options || {};
  const mode = opts.mode === 'move' ? 'move' : 'copy';
  const root = path.resolve(archiveRoot);

  if (!root) throw new Error('归档目录不能为空');

  const result = {
    ok: 0,
    failed: [],
    skipped: [],
    done: [],
    target: root,
    mode,
    byDir: {}
  };

  for (const file of files) {
    const relDir = dirForCategory(file.category);
    const targetDir = path.join(root, relDir);

    try {
      await fsp.mkdir(targetDir, { recursive: true });

      if (path.resolve(file.path) === path.resolve(path.join(targetDir, file.name))) {
        result.skipped.push({ path: file.path, reason: '已在归档目录内' });
        continue;
      }

      const targetPath = await uniqueTarget(targetDir, file.name);

      if (mode === 'move') {
        try {
          await fsp.rename(file.path, targetPath);
        } catch (err) {
          if (err.code === 'EXDEV') {
            await fsp.copyFile(file.path, targetPath);
            await fsp.unlink(file.path);
          } else {
            throw err;
          }
        }
      } else {
        await fsp.copyFile(file.path, targetPath);
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
 * 删除重复文件（只允许删除被标记为 duplicate 的文件，且必须与保留版本不同路径）。
 */
async function removeDuplicates(files, options) {
  const opts = options || {};
  const toTrash = opts.toTrash !== false;
  const result = { ok: 0, failed: [], skipped: [] };

  for (const file of files) {
    if (!file.duplicate || !file.duplicate.isDuplicate) {
      result.skipped.push({ path: file.path, reason: '不是重复文件' });
      continue;
    }
    if (file.duplicate.withPath && path.resolve(file.path) === path.resolve(file.duplicate.withPath)) {
      result.skipped.push({ path: file.path, reason: '是保留版本' });
      continue;
    }
    try {
      if (toTrash && opts.trashDir) {
        await fsp.mkdir(opts.trashDir, { recursive: true });
        const target = await uniqueTarget(opts.trashDir, file.name);
        await fsp.rename(file.path, target).catch(async () => {
          await fsp.copyFile(file.path, target);
          await fsp.unlink(file.path);
        });
      } else {
        await fsp.unlink(file.path);
      }
      result.ok += 1;
    } catch (err) {
      result.failed.push({ path: file.path, error: err.code || err.message });
    }
  }

  return result;
}

/**
 * 把任意文件移到软件回收站（用于「一键整理」清理冗余，不限于重复文件）。
 */
async function moveToTrash(files, trashDir) {
  const result = { ok: 0, failed: [], skipped: [], done: [] };
  if (!trashDir) throw new Error('回收站目录不能为空');

  for (const file of files) {
    try {
      await fsp.mkdir(trashDir, { recursive: true });
      const target = await uniqueTarget(trashDir, file.name);
      try {
        await fsp.rename(file.path, target);
      } catch (err) {
        if (err.code === 'EXDEV') {
          await fsp.copyFile(file.path, target);
          await fsp.unlink(file.path);
        } else {
          throw err;
        }
      }
      result.ok += 1;
      result.done.push({ path: file.path, target });
    } catch (err) {
      result.failed.push({ path: file.path, error: err.code || err.message });
    }
  }

  return result;
}

module.exports = { archive, removeDuplicates, moveToTrash, dirForCategory, GROUP_DIRS };
