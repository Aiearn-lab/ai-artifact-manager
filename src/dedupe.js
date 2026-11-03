'use strict';

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { DRAFT_NAME_PATTERNS } = require('./scanner');

const MAX_READ = 1024 * 1024; // 单文件最多读 1MB 做比对
const SIMILARITY_THRESHOLD = 0.82;
const SHINGLE_SIZE = 3;
const MAX_SHINGLES = 2500;
const NEIGHBOR_WINDOW = 12; // 每个文件只和附近 12 个比，避免 O(n²)

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\r\n/g, '\n')
    .replace(/[#*`>_~\-[\](){}|]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200000);
}

function shingleSet(text) {
  const s = normalize(text);
  const set = new Set();
  if (!s) return set;
  if (s.length < SHINGLE_SIZE) {
    set.add(s);
    return set;
  }
  const span = s.length - SHINGLE_SIZE;
  const step = Math.max(1, Math.floor(span / MAX_SHINGLES));
  for (let i = 0; i <= span; i += step) {
    set.add(s.slice(i, i + SHINGLE_SIZE));
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const v of small) if (large.has(v)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function keeperScore(f) {
  let score = 0;
  score += Math.min(Number(f.chars) || 0, 30000) / 200; // 内容更完整优先
  score += Number(f.size || 0) / 50000;
  const draft = DRAFT_NAME_PATTERNS.some((re) => re.test(f.name));
  if (!draft) score += 60;
  if (f.name.length <= 40) score += 8;
  if (!/\(\d+\)/.test(f.name)) score += 20;
  return score;
}

function pickKeeper(group) {
  return group.slice().sort((a, b) => {
    const diff = keeperScore(b) - keeperScore(a);
    if (Math.abs(diff) > 0.001) return diff;
    return (b.mtime || 0) - (a.mtime || 0);
  })[0];
}

async function readForCompare(file) {
  try {
    const limit = Math.min(Number(file.size) || 0, MAX_READ);
    if (limit <= 0) return { buf: Buffer.alloc(0), text: '' };
    const fd = await fsp.open(file.path, 'r');
    let buf;
    try {
      buf = Buffer.alloc(limit);
      const { bytesRead } = await fd.read(buf, 0, limit, 0);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
    return { buf, text: buf.toString('utf8') };
  } catch (err) {
    return { buf: null, text: '', error: err.code || err.message };
  }
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * 重复/相似检测。
 * 返回 { groups, stats }，并直接写入 file.duplicate。
 */
async function detect(files, options) {
  const opts = options || {};
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : SIMILARITY_THRESHOLD;

  const target = files.filter((f) => !f.readError && Number(f.chars) >= 30);
  const contents = new Map();
  const hashes = new Map();
  let cursor = 0;
  const concurrency = 8;

  async function worker() {
    while (cursor < target.length) {
      const f = target[cursor++];
      const r = await readForCompare(f);
      if (!r.buf) continue;
      contents.set(f.id, r.text);
      const h = sha256(r.buf);
      f.hash = h;
      if (!hashes.has(h)) hashes.set(h, []);
      hashes.get(h).push(f);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, target.length || 1) }, () => worker()));

  const groups = [];
  const exactIds = new Set();

  // 1) 完全重复
  for (const [hash, group] of hashes.entries()) {
    if (group.length < 2) continue;
    const keeper = pickKeeper(group);
    const members = group.map((f) => ({
      id: f.id,
      path: f.path,
      name: f.name,
      size: f.size,
      mtime: f.mtime
    }));
    groups.push({
      kind: 'exact',
      hash,
      similarity: 1,
      keeperPath: keeper.path,
      keeperName: keeper.name,
      members
    });
    for (const f of group) {
      exactIds.add(f.id);
      if (f.id === keeper.id) {
        f.duplicate = {
          isDuplicate: false,
          isKeeper: true,
          kind: 'exact',
          groupSize: group.length,
          withPath: null,
          withName: null,
          similarity: 1
        };
      } else {
        f.duplicate = {
          isDuplicate: true,
          isKeeper: false,
          kind: 'exact',
          groupSize: group.length,
          withPath: keeper.path,
          withName: keeper.name,
          similarity: 1
        };
      }
    }
  }

  // 2) 相似（只在同扩展名 + 体量接近的邻域内比）
  const byExt = new Map();
  for (const f of target) {
    if (exactIds.has(f.id)) continue;
    if (!contents.has(f.id)) continue;
    const ext = f.ext || '(none)';
    if (!byExt.has(ext)) byExt.set(ext, []);
    byExt.get(ext).push(f);
  }

  const uf = new UnionFind();
  const pairSimilarity = new Map();
  const shingleCache = new Map();

  for (const list of byExt.values()) {
    list.sort((a, b) => Number(a.chars) - Number(b.chars));
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      const aChars = Math.max(Number(a.chars) || 0, 1);
      for (let j = i + 1; j < Math.min(list.length, i + 1 + NEIGHBOR_WINDOW); j += 1) {
        const b = list[j];
        const bChars = Math.max(Number(b.chars) || 0, 1);
        const ratio = Math.min(aChars, bChars) / Math.max(aChars, bChars);
        if (ratio < 0.72) break; // 体量差太远，后面的只会更远
        if (!shingleCache.has(a.id)) shingleCache.set(a.id, shingleSet(contents.get(a.id)));
        if (!shingleCache.has(b.id)) shingleCache.set(b.id, shingleSet(contents.get(b.id)));
        const sim = jaccard(shingleCache.get(a.id), shingleCache.get(b.id));
        if (sim >= threshold) {
          uf.union(a.id, b.id);
          const key = `${a.id}|${b.id}`;
          pairSimilarity.set(key, sim);
        }
      }
    }
    // 这一组比完就释放分片缓存，避免上万文件时内存一直涨
    for (const f of list) shingleCache.delete(f.id);
  }

  const simGroups = new Map();
  for (const f of target) {
    if (exactIds.has(f.id)) continue;
    if (!contents.has(f.id)) continue;
    const root = uf.find(f.id);
    if (!simGroups.has(root)) simGroups.set(root, []);
    simGroups.get(root).push(f);
  }

  for (const group of simGroups.values()) {
    if (group.length < 2) continue;
    const keeper = pickKeeper(group);
    const members = group.map((f) => ({
      id: f.id,
      path: f.path,
      name: f.name,
      size: f.size,
      mtime: f.mtime
    }));
    // 组内平均相似度（相对 keeper）
    let sim = 0;
    let n = 0;
    for (const f of group) {
      if (f.id === keeper.id) continue;
      const key1 = `${keeper.id}|${f.id}`;
      const key2 = `${f.id}|${keeper.id}`;
      sim += pairSimilarity.get(key1) || pairSimilarity.get(key2) || threshold;
      n += 1;
    }
    groups.push({
      kind: 'similar',
      hash: null,
      similarity: n ? sim / n : threshold,
      keeperPath: keeper.path,
      keeperName: keeper.name,
      members
    });

    for (const f of group) {
      if (f.id === keeper.id) {
        f.duplicate = {
          isDuplicate: false,
          isKeeper: true,
          kind: 'similar',
          groupSize: group.length,
          withPath: null,
          withName: null,
          similarity: 1
        };
      } else {
        const key1 = `${keeper.id}|${f.id}`;
        const key2 = `${f.id}|${keeper.id}`;
        f.duplicate = {
          isDuplicate: true,
          isKeeper: false,
          kind: 'similar',
          groupSize: group.length,
          withPath: keeper.path,
          withName: keeper.name,
          similarity: pairSimilarity.get(key1) || pairSimilarity.get(key2) || threshold
        };
      }
    }
  }

  // 没进任何组的，清空 duplicate
  for (const f of files) {
    if (!f.duplicate) f.duplicate = null;
  }

  const exactCount = groups.filter((g) => g.kind === 'exact').reduce((s, g) => s + g.members.length, 0);
  const similarCount = groups.filter((g) => g.kind === 'similar').reduce((s, g) => s + g.members.length, 0);
  const freeable = files.reduce(
    (s, f) => s + (f.duplicate && f.duplicate.isDuplicate ? f.size : 0),
    0
  );

  return {
    groups: groups.sort((a, b) => b.members.length - a.members.length),
    stats: {
      groups: groups.length,
      exactFiles: exactCount,
      similarFiles: similarCount,
      freeableSize: freeable,
      threshold
    }
  };
}

module.exports = { detect, sha256, normalize, shingleSet, jaccard };
