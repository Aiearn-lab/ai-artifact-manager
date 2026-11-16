'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function builtinWhitelist() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  const up = process.env.USERPROFILE || '';

  const paths = [sysRoot, pf, pf86, pd, 'C:\\$Recycle.Bin', 'C:\\System Volume Information', 'C:\\Recovery', 'C:\\PerfLogs'];
  if (up) {
    paths.push(`${up}\\AppData`, `${up}\\Application Data`, `${up}\\Local Settings`, `${up}\\Cookies`);
  }

  // 这些类型基本不可能是 AI 产出的「有用文本」，扫进来只会拖慢速度
  const exts = [
    '.exe', '.dll', '.sys', '.msi', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
    '.mp3', '.wav', '.flac', '.aac', '.mp4', '.mov', '.mkv', '.avi', '.wmv',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.pyc', '.pyo', '.class', '.o', '.obj', '.so', '.dylib', '.lib',
    '.ttf', '.otf', '.woff', '.woff2', '.eot'
  ];

  return [
    ...paths.filter(Boolean).map((v) => ({ type: 'path', value: v, builtin: true })),
    ...exts.map((v) => ({ type: 'ext', value: v, builtin: true }))
  ];
}

const DEFAULTS = {
  archiveRoot: '',
  whitelist: builtinWhitelist(), // [{ type:'path'|'ext', value:'...' }]
  includeExt: [],
  excludeExt: [],
  maxDepth: 14,
  maxFiles: 50000,
  ai: {
    provider: '', // ollama | lmstudio | openai-compatible
    baseUrl: '',
    apiKey: '',
    model: ''
  },
  mcp: {
    enabled: false,
    token: ''
  },
  ui: {
    theme: 'light',
    onboarded: false, // 首次使用引导看过没有
    autoFullScan: true // v0.8 M3 开箱即用：装机第一次打开就自动全盘扫（安全靠硬排除+可反悔，不靠缩小范围）
  },
  // 一键整理安全闸：默认只自动处理「确认 AI 产出 + 高置信」的文件，
  // 其余进待确认桶只能手动勾。关掉=回到旧行为，仅供调试，不建议。
  tidy: {
    aiOnly: true
  }
  // v0.8：pro.activated/pro.code 僵尸键已删（全仓无任何消费方）；ui.lang 保留兼容旧配置文件
  // 自动监控（watch）已整体下线：托盘那句"在盯着"是假话、默认关着还要用户选目录，价值不大。
  // 老 config.json 里若还有 watch 键，按未知键静默保留，不影响运行。
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------- 配置校验 ----------
// 外部传进来的值（渲染进程 IPC、手工改过的 config.json）一律先过闸：
// 校验器返回「规范化后的值」，返回 undefined 表示不合法、整个键丢弃（保留原值/默认值）。
// 目的不是刁难用户，是让非法值进不来——maxDepth:-5 会让扫描原地空转，
// whitelist 变成字符串会让「不扫系统目录」这条安全线直接失效。
const asStr = (v) => (typeof v === 'string' ? v : undefined);
const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
};
const asInt = (min, max) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
};
const asStrList = (v) => {
  if (!Array.isArray(v)) return undefined;
  for (const x of v) if (typeof x !== 'string') return undefined;
  return v.slice();
};
const asWhitelist = (v) => {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const it of v) {
    if (!isPlainObject(it)) return undefined;
    if (it.type !== 'path' && it.type !== 'ext') return undefined;
    if (typeof it.value !== 'string' || !it.value.trim()) return undefined;
    out.push({ type: it.type, value: it.value.trim(), builtin: !!it.builtin });
  }
  return out;
};
// AI 接口地址只接受 http(s)：file:/javascript:/data: 都不是「模型服务」，
// 让它们进来等于把本地文件读取/脚本执行的能力交给一个配置项
const asHttpUrl = (v) => {
  if (typeof v !== 'string') return undefined;
  if (!v.trim()) return '';
  return /^https?:\/\/[^\s]+$/i.test(v.trim()) ? v.trim() : undefined;
};
const asTheme = (v) => (v === 'light' || v === 'dark' ? v : undefined);

const SCHEMA = {
  archiveRoot: asStr,
  whitelist: asWhitelist,
  includeExt: asStrList,
  excludeExt: asStrList,
  maxDepth: asInt(1, 64),
  maxFiles: asInt(1, 500000),
  ai: { provider: asStr, baseUrl: asHttpUrl, apiKey: asStr, model: asStr },
  mcp: { enabled: asBool, token: asStr },
  ui: { theme: asTheme, onboarded: asBool, autoFullScan: asBool, lang: asStr },
  tidy: { aiOnly: asBool }
};

/**
 * 按 SCHEMA 过滤一个补丁对象。
 * keepUnknown=true 时保留未知键（读旧配置文件用：降级不该抹掉新版本写的键）。
 */
function sanitize(node, schema, prefix, rejected, keepUnknown) {
  const out = {};
  for (const [k, v] of Object.entries(node || {})) {
    if (FORBIDDEN_KEYS.has(k)) {
      rejected.push(`${prefix}${k}（禁止的键）`);
      continue;
    }
    const rule = schema[k];
    if (rule === undefined) {
      if (keepUnknown) out[k] = v;
      else rejected.push(`${prefix}${k}（未知配置项）`);
      continue;
    }
    if (typeof rule === 'object') {
      if (!isPlainObject(v)) {
        rejected.push(`${prefix}${k}（应为对象）`);
        continue;
      }
      out[k] = sanitize(v, rule, `${prefix}${k}.`, rejected, keepUnknown);
      continue;
    }
    const norm = rule(v);
    if (norm === undefined) {
      rejected.push(`${prefix}${k}（类型或范围不合法）`);
      continue;
    }
    out[k] = norm;
  }
  return out;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    // 防原型污染：外部传进来的配置不允许碰这三个键
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

class ConfigStore {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'config.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
  }

  async load() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const rejected = [];
      // 读的时候保留未知键（降级兼容），但已知键里的非法值一律丢回默认值——
      // 配置文件被改坏不该让程序一直带着坏值跑
      const clean = sanitize(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, SCHEMA, '', rejected, true);
      this.data = deepMerge(this.data, clean);
      this.lastRejected = rejected;
      if (rejected.length) console.warn('[config] 已忽略非法配置：', rejected.join('；'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 配置损坏时不让程序起不来：备份坏文件后用默认值
        try {
          await fsp.rename(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.data;
  }

  get() {
    return this.data;
  }

  async save() {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
    return this.data;
  }

  async patch(partial) {
    const rejected = [];
    const clean = sanitize(partial, SCHEMA, '', rejected, false);
    this.lastRejected = rejected;
    if (rejected.length) console.warn('[config] 已拒绝非法配置：', rejected.join('；'));
    this.data = deepMerge(this.data, clean);
    await this.save();
    return this.data;
  }

  /** 返回给渲染进程的配置：密钥打码，避免明文出现在界面/日志 */
  safe() {
    const copy = JSON.parse(JSON.stringify(this.data));
    if (copy.ai && copy.ai.apiKey) {
      copy.ai.hasKey = true;
      copy.ai.apiKeyMasked = copy.ai.apiKey.length > 8
        ? `${copy.ai.apiKey.slice(0, 4)}****${copy.ai.apiKey.slice(-4)}`
        : '****';
      delete copy.ai.apiKey;
    } else if (copy.ai) {
      copy.ai.hasKey = false;
    }
    return copy;
  }
}

module.exports = { ConfigStore, DEFAULTS, builtinWhitelist };
