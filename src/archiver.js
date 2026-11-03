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
  const result = { ok: 0, failed: [], skipped: [], done: [] };

  const picked = [];
  for (const file of files) {
    if (!file.duplicate || !file.duplicate.isDuplicate) {
      result.skipped.push({ path: file.path, reason: '不是重复文件' });
      continue;
    }
    if (file.duplicate.withPath && path.resolve(file.path) === path.resolve(file.duplicate.withPath)) {
      result.skipped.push({ path: file.path, reason: '是保留版本' });
      continue;
    }
    picked.push(file);
  }
  if (!picked.length) return result;

  // 默认一律走回收站（带 manifest，可恢复）
  if (toTrash && opts.trashDir) {
    const r = await moveToTrash(picked, opts.trashDir);
    return {
      ok: r.ok,
      failed: r.failed,
      skipped: [...result.skipped, ...r.skipped],
      done: r.done
    };
  }

  for (const file of picked) {
    try {
      await fsp.unlink(file.path);
      result.ok += 1;
      result.done.push({ path: file.path, target: null });
    } catch (err) {
      result.failed.push({ path: file.path, error: err.code || err.message });
    }
  }

  return result;
}

/**
 * 把任意文件移到软件回收站，并写 manifest 记录原路径（支持一键恢复）。
 */
async function moveToTrash(files, trashDir) {
  const result = { ok: 0, failed: [], skipped: [], done: [] };
  if (!trashDir) throw new Error('回收站目录不能为空');

  await fsp.mkdir(trashDir, { recursive: true });
  const manifest = { createdAt: Date.now(), files: [] };

  for (const file of files) {
    try {
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
      manifest.files.push({
        name: path.basename(target),
        originalPath: file.path,
        trashedPath: target,
        size: file.size || 0
      });
      result.ok += 1;
      result.done.push({ path: file.path, target });
    } catch (err) {
      result.failed.push({ path: file.path, error: err.code || err.message });
    }
  }

  if (manifest.files.length) {
    try {
      await fsp.writeFile(path.join(trashDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } catch {
      /* 记录失败不影响文件已经在回收站里 */
    }
  }

  return result;
}

/**
 * 从回收站恢复一个文件到原位置。原位置已有同名文件时自动加 (1)，不覆盖。
 */
async function restoreFromTrash(batchDir, trashedPath) {
  const manifestPath = path.join(batchDir, 'manifest.json');
  const m = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const item = (m.files || []).find((f) => path.resolve(f.trashedPath) === path.resolve(trashedPath));
  if (!item) throw new Error('回收站里找不到这个文件');

  try {
    await fsp.access(item.trashedPath);
  } catch {
    throw new Error('文件已经不在回收站里了');
  }

  const targetDir = path.dirname(item.originalPath);
  await fsp.mkdir(targetDir, { recursive: true });

  let target = item.originalPath;
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let i = 1;
  for (;;) {
    try {
      await fsp.access(target);
      target = path.join(targetDir, `${base} (${i})${ext}`);
      i += 1;
      if (i > 999) throw new Error('同名文件过多');
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
  }

  try {
    await fsp.rename(item.trashedPath, target);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // 跨盘恢复：先复制再删，避免直接 rename 失败
      await fsp.copyFile(item.trashedPath, target);
      await fsp.unlink(item.trashedPath);
    } else {
      throw err;
    }
  }
  item.restoredAt = Date.now();
  item.restoredTo = target;
  await fsp.writeFile(manifestPath, JSON.stringify(m, null, 2), 'utf8');
  return { ok: true, path: target };
}

module.exports = { archive, removeDuplicates, moveToTrash, restoreFromTrash, dirForCategory, GROUP_DIRS };
