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
  archiveMode: 'move',
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
    onboarded: false // 首次使用引导看过没有
  },
  pro: {
    activated: false,
    code: ''
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
      this.data = deepMerge(this.data, parsed && typeof parsed === 'object' ? parsed : {});
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
    this.data = deepMerge(this.data, partial || {});
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
