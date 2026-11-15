'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { decodeBuffer } = require('./scanner');

/**
 * AI 建议层（2026-11-06 定案）：一个包两层，这是可插拔的第二层。
 *
 * 三条铁律：
 * 1. AI 只产出「建议」，写进独立的 aiAdvice 字段——永远不碰 category，
 *    更不拿执行权。整理闸门（src/tidy.js）只认规则分类，AI 说什么都不会自动动文件。
 * 2. 按内容哈希缓存：同一份内容判过就不再问模型；中断后接着跑，不重复烧时间。
 * 3. 没配模型时这一层整个不存在，离线基层照常工作。
 *
 * 批量 + 断点续跑：每 5 个文件一批问一次（本地小模型也扛得住），
 * 每批落一次缓存，随时可取消，取消不丢已判的。
 */

const BATCH_SIZE = 5;
const HEAD_CHARS = 600; // 每个文件只喂开头一小段，省 token 也省本地模型时间
const MAX_CACHE = 5000;
const VERDICTS = new Set(['keep', 'clean', 'unsure']);

function cacheKey(f) {
  // 哈希优先（内容没变就不重判）；没哈希退回 路径+修改时间+大小
  return f.hash ? `h:${f.hash}` : `p:${String(f.path).toLowerCase()}|${f.mtime}|${f.size}`;
}

class AdviceCache {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'ai-advice-cache.json');
    this.map = new Map();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
      this.map = new Map(entries.slice(-MAX_CACHE));
    } catch {
      this.map = new Map();
    }
  }

  get(key) {
    return this.map.get(key) || null;
  }

  set(key, advice) {
    this.map.set(key, advice);
    if (this.map.size > MAX_CACHE) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }

  async save() {
    const obj = Object.fromEntries(this.map);
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fsp.rename(tmp, this.file);
  }
}

async function readHeadText(filePath, maxChars) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    // 走扫描层同一套编码探测，GBK 老文件不会喂给模型一堆乱码
    return decodeBuffer(buf.subarray(0, bytesRead)).slice(0, maxChars || HEAD_CHARS);
  } finally {
    await fh.close();
  }
}

const SYSTEM_PROMPT =
  '你是文件整理顾问，只给建议不做决定。对每个文件输出一个判断：' +
  'keep（值得留存：有复用价值的知识/工具）、clean（可清理：一次性已用完/草稿/无信息量）、unsure（看不准）。' +
  '只输出 JSON 数组，每个元素形如 {"i":序号,"v":"keep|clean|unsure","r":"一句中文理由不超过25字"}。' +
  '不要输出任何其他文字。拿不准一律 unsure，宁可保守。';

/** 解析模型回复；解析失败返回 null（调用方降级为 unsure，且不写缓存以便重试） */
function parseBatchReply(content, count) {
  const m = String(content).match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = new Array(count).fill(null);
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const i = Number(item.i);
    if (!Number.isInteger(i) || i < 0 || i >= count) continue;
    const v = VERDICTS.has(item.v) ? item.v : 'unsure';
    out[i] = { v, r: String(item.r || '').slice(0, 60) };
  }
  return out;
}

/**
 * 批量给建议。
 * cfg      —— AI 配置（baseUrl/model/apiKey）
 * files    —— 文件对象数组（会读 f.aiAdvice 写入建议，绝不碰 f.category）
 * opts.cache    —— AdviceCache 实例（必传，断点续跑靠它）
 * opts.chatFn   —— 注入用，默认 ai.chat；单测拿假模型跑
 * opts.onItem   —— 每判完一个回调 { done, total, file, advice, fromCache }
 * opts.shouldStop —— 返回 true 即停（已判的都在缓存里）
 * 返回 { judged, cached, failed, stopped }
 */
async function judgeBatch(cfg, files, opts) {
  const o = opts || {};
  const cache = o.cache;
  if (!cache) throw new Error('缺少建议缓存');
  const chatFn = o.chatFn || require('./ai').chat;
  const list = files || [];
  const result = { judged: 0, cached: 0, failed: 0, stopped: false };
  let done = 0;

  // 先把缓存命中的发出去，不花模型一分钱
  const pending = [];
  for (const f of list) {
    const hit = cache.get(cacheKey(f));
    if (hit) {
      f.aiAdvice = { ...hit, fromCache: true };
      result.cached += 1;
      done += 1;
      if (o.onItem) o.onItem({ done, total: list.length, file: f, advice: f.aiAdvice, fromCache: true });
    } else {
      pending.push(f);
    }
  }

  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    if (o.shouldStop && o.shouldStop()) {
      result.stopped = true;
      break;
    }
    const batch = pending.slice(start, start + BATCH_SIZE);
    const heads = [];
    for (const f of batch) {
      try {
        heads.push(await readHeadText(f.path, HEAD_CHARS));
      } catch {
        heads.push('');
      }
    }
    const userContent = batch
      .map((f, i) => `【${i}】文件名：${f.name}\n内容开头：\n${heads[i] || '(读不到内容)'}`)
      .join('\n\n');

    let parsed = null;
    try {
      const { content } = await chatFn(
        cfg,
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        { maxTokens: 120 * batch.length, temperature: 0, timeoutMs: 120000 }
      );
      parsed = parseBatchReply(content, batch.length);
    } catch {
      parsed = null; // 网络/模型出错：这批标 unsure，不写缓存，下次可重试
    }

    for (let i = 0; i < batch.length; i += 1) {
      const f = batch[i];
      const p = parsed && parsed[i];
      if (p) {
        const advice = { v: p.v, r: p.r, at: Date.now(), model: cfg.model || '' };
        cache.set(cacheKey(f), advice);
        f.aiAdvice = advice;
        result.judged += 1;
      } else {
        f.aiAdvice = { v: 'unsure', r: 'AI 没给出可用判断，可重试', at: Date.now(), transient: true };
        result.failed += 1;
      }
      done += 1;
      if (o.onItem) o.onItem({ done, total: list.length, file: f, advice: f.aiAdvice, fromCache: false });
    }
    // 每批落盘：中途关掉/断网，已判的都不丢
    try {
      await cache.save();
    } catch {
      /* 缓存写失败不影响本次建议已经给出 */
    }
  }

  return result;
}

module.exports = { AdviceCache, judgeBatch, parseBatchReply, cacheKey, BATCH_SIZE };