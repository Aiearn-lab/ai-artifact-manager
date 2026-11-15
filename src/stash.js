'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ensureNote } = require('./folder-note.js'); // 卸载保护提醒：箱里放一张说明书

/**
 * 回收箱（AI 回收箱）——三档责任模型的第三档「只收不删」。
 *
 * 规矩（2026-11-06 哥哥定案）：
 * 1. 拿不准的 AI 产出只从视线里「搬走」，永远不销毁：无期限、不到期、不自毁。
 * 2. 一键放回原位；原位被别的文件占了就加后缀，绝不覆盖。
 * 3. 真删只有一种触发方式：用户主动点「清空回收箱」，且由调用方走系统回收站——
 *    本模块自己从头到尾不 unlink 任何用户内容（临时索引写入除外）。
 *
 * 索引 stash-index.json 原子写（tmp+rename），损坏自愈当空表，工具不能因为自己的
 * 账本坏了就崩。箱内文件与索引双份留痕，from 记录原路径供放回。
 * 署名：智维工作室 / Zhiwei Studio
 */

function normPath(p) {
  return path.resolve(String(p || ''));
}

async function existsAsync(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 目标目录里避开同名：a.md → a (1).md → a (2).md，绝不覆盖 */
async function uniqueTarget(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 1;
  while (await existsAsync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
    if (i > 999) throw new Error('同名文件过多，已中止');
  }
  return candidate;
}

/** 移动（跨盘时先复制再删源，净效果仍是移动；这是实现细节，用户看不见） */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(from, to);
      await fsp.unlink(from);
    } else {
      throw err;
    }
  }
}

class Stash {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'stash-index.json');
    this.boxDir = path.join(userDataDir, 'stash-box');
    this.items = []; // { id, from, to, name, hash, size, mtimeMs, stashedAt }
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
    } catch {
      this.items = []; // 没有/损坏都当空的
    }
    return this.items;
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify({ items: this.items }, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  list() {
    return this.items;
  }

  /** 只读统计：界面报数用（数量/占用），不做任何删除 */
  stats() {
    let size = 0;
    for (const it of this.items) size += Number(it.size) || 0;
    return { count: this.items.length, size };
  }

  /**
   * 搬入回收箱。entries: [{ path, hash? }]（文件对象也行，取 path/hash）。
   * 单个失败进 failed 清单，不炸整批。
   */
  async stash(entries) {
    const result = { ok: 0, moved: [], failed: [] };
    await fsp.mkdir(this.boxDir, { recursive: true });
    for (const e of entries || []) {
      const src = normPath(e.path);
      try {
        const st = await fsp.stat(src);
        if (!st.isFile()) throw new Error('不是文件');
        const to = await uniqueTarget(this.boxDir, path.basename(src));
        await moveFile(src, to);
        const item = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          from: src,
          to,
          name: path.basename(src),
          hash: e.hash || null,
          size: st.size,
          mtimeMs: st.mtimeMs,
          stashedAt: Date.now()
        };
        this.items.push(item);
        result.ok += 1;
        result.moved.push({ id: item.id, from: src, to, name: item.name });
      } catch (err) {
        result.failed.push({ path: src, error: err.code || err.message });
      }
    }
    if (result.ok) await this.save();
    // 只要箱子里真有东西，就在旁边留一张「卸载后请看」，
    // 免得日后用户在资源管理器里把它当成垃圾删掉（写失败不影响搬文件）
    if (result.ok) await ensureNote(this.boxDir, 'stash');
    return result;
  }

  /**
   * 一键放回。ids 省略＝全部放回。
   * 原位被占 → 同目录加后缀落位（restored[].to 给实际位置），绝不覆盖；
   * 原目录没了 → 重建；箱内文件不见了 → 如实 skipped，不放回不造假。
   */
  async restore(ids) {
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    const result = { ok: 0, restored: [], skipped: [], failed: [] };
    if (wanted) {
      // 账上查无此件：如实报跳过，不无声吞掉调用方的意图
      const known = new Set(this.items.map((it) => String(it.id)));
      for (const id of wanted) {
        if (!known.has(String(id))) result.skipped.push({ id: String(id), reason: '回收箱里没有这一条（可能已被放回）' });
      }
    }
    const targets = wanted ? this.items.filter((it) => wanted.has(String(it.id))) : this.items.slice();
    for (const item of targets) {
      if (!(await existsAsync(item.to))) {
        result.skipped.push({ id: item.id, path: item.from, reason: '回收箱里的文件不见了，没敢凭空放回' });
        this.items = this.items.filter((x) => x !== item); // 账实不符的记录不留，下次扫到还能重新收
        continue;
      }
      try {
        const dir = path.dirname(item.from);
        await fsp.mkdir(dir, { recursive: true });
        const to = (await existsAsync(item.from)) ? await uniqueTarget(dir, item.name) : item.from;
        await moveFile(item.to, to);
        this.items = this.items.filter((x) => x !== item);
        result.ok += 1;
        result.restored.push({ id: item.id, from: item.from, to });
      } catch (err) {
        result.failed.push({ id: item.id, path: item.from, error: err.code || err.message });
      }
    }
    if (result.ok || result.skipped.length) await this.save();
    return result;
  }

  /**
   * 清空是「用户的动作」，不是模块的职责：这里只交出箱内文件路径让调用方
   * 走系统回收站（cleanupTrash），成功返回后才由调用方调 drop(ids) 销账。
   * 本模块永远不直接销毁用户内容。
   */
  pendingForRemoval(ids) {
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    return (wanted ? this.items.filter((it) => wanted.has(String(it.id))) : this.items.slice()).map(
      (it) => ({ id: it.id, path: it.to, from: it.from, name: it.name })
    );
  }

  /** 调用方确认已进系统回收站后销账 */
  async drop(ids) {
    const set = new Set((ids || []).map(String));
    const before = this.items.length;
    this.items = this.items.filter((it) => !set.has(String(it.id)));
    if (this.items.length !== before) await this.save();
    return before - this.items.length;
  }
}

module.exports = { Stash };
