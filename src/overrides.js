'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * 人工判定持久层：重扫不抹。
 *
 * 扫描每次都会重新跑规则分类（classifyAll），如果不把这层盖回去，
 * 用户点过的「这是我写的」、AI 复核过的分类，重扫一次就全丢了——
 * 那等于让用户反复兜底。所以凡是人（或 AI 复核后经人确认）做过的判定，
 * 都按「路径 + 内容哈希」记在这里，扫描后重新应用。
 *
 * 只存判定，不存文件内容；哈希用来在文件被改名/挪位置后还能认出同一份。
 */

const MAX_ITEMS = 5000; // 上限保护，超了丢最旧的

function normPath(p) {
  return path.resolve(String(p || '')).toLowerCase();
}

class OverridesStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'overrides.json');
    this.items = []; // { path, hash, mine, category, by, at }
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
    } catch {
      this.items = []; // 没有/损坏都当空的，不影响扫描
    }
    return this.items;
  }

  async save() {
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ items: this.items }, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /** 按路径或哈希找到已有记录；路径优先，哈希兜底（文件被挪走/改名时） */
  find(filePath, hash) {
    const key = normPath(filePath);
    let byPath = null;
    for (const it of this.items) {
      if (normPath(it.path) === key) byPath = it;
    }
    if (byPath) return byPath;
    if (hash) {
      for (let i = this.items.length - 1; i >= 0; i -= 1) {
        if (this.items[i].hash && this.items[i].hash === hash) return this.items[i];
      }
    }
    return null;
  }

  /**
   * 扫描完成后调用：把持久化的判定盖回文件对象。
   * 必须在去重之后调用（那时才有 f.hash）。
   */
  apply(files) {
    let applied = 0;
    for (const f of files || []) {
      const o = this.find(f.path, f.hash);
      if (!o) continue;
      if (o.mine) f.mine = true;
      if (o.category && typeof o.category === 'object') {
        f.category = { ...o.category, by: o.by || 'manual' };
      }
      applied += 1;
    }
    return applied;
  }

  upsert(filePath, hash) {
    let it = this.find(filePath, hash);
    if (!it) {
      it = { path: filePath, hash: hash || null, mine: false, category: null, by: '', at: Date.now() };
      this.items.push(it);
    }
    it.path = filePath; // 文件挪过位置就更新路径
    if (hash) it.hash = hash;
    it.at = Date.now();
    return it;
  }

  /** 「这是我写的」负样本：on=true 打标，false 撤销 */
  async setMine(filePath, hash, on) {
    const it = this.upsert(filePath, hash);
    it.mine = !!on;
    if (!it.mine && !it.category) {
      this.items = this.items.filter((x) => x !== it); // 空记录不留
    }
    await this.save();
    return it.mine;
  }

  /** 记住一次分类判定（AI 复核或人工改分类），by='ai'|'manual' */
  async setCategory(filePath, hash, category, by) {
    const it = this.upsert(filePath, hash);
    it.category = category ? JSON.parse(JSON.stringify(category)) : null;
    it.by = by || 'manual';
    await this.save();
    return it;
  }
}

module.exports = { OverridesStore };