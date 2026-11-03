'use strict';

const fsp = require('fs').promises;
const path = require('path');

const LOCAL_ENDPOINTS = [
  { provider: 'ollama', name: 'Ollama', probe: 'http://127.0.0.1:11434/api/tags', baseUrl: 'http://127.0.0.1:11434/v1' },
  { provider: 'lmstudio', name: 'LM Studio', probe: 'http://127.0.0.1:1234/v1/models', baseUrl: 'http://127.0.0.1:1234/v1' }
];

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchJson(url, options, ms) {
  const t = timeoutSignal(ms || 1500);
  try {
    const res = await fetch(url, { ...(options || {}), signal: t.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    t.done();
  }
}

/** 探测本机是否跑着 Ollama / LM Studio，不需要任何密钥 */
async function detectLocal() {
  const results = [];
  for (const ep of LOCAL_ENDPOINTS) {
    try {
      const r = await fetchJson(ep.probe, { method: 'GET' }, 1200);
      if (!r.ok) continue;
      let models = [];
      if (ep.provider === 'ollama') {
        models = (r.data && r.data.models ? r.data.models : []).map((m) => m.name || m.model).filter(Boolean);
      } else {
        models = (r.data && r.data.data ? r.data.data : []).map((m) => m.id).filter(Boolean);
      }
      results.push({
        provider: ep.provider,
        name: ep.name,
        baseUrl: ep.baseUrl,
        models,
        online: true
      });
    } catch {
      results.push({ provider: ep.provider, name: ep.name, baseUrl: ep.baseUrl, models: [], online: false });
    }
  }
  return results;
}

function chatEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未配置 AI 接口地址');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (!/\/v\d+$/i.test(u)) u += '/v1';
  return `${u}/chat/completions`;
}

/** 通用 OpenAI 兼容调用：Ollama / LM Studio / DeepSeek / GLM / 豆包 等都走这个格式 */
async function chat(cfg, messages, options) {
  const opts = options || {};
  const url = chatEndpoint(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const body = {
    model: cfg.model || opts.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
    stream: false
  };
  if (!body.model) delete body.model;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const t = timeoutSignal(opts.timeoutMs || 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: t.signal
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`AI 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = (data && (data.error && (data.error.message || data.error) || data.message)) || text.slice(0, 200);
      throw new Error(`AI 接口报错（HTTP ${res.status}）：${msg}`);
    }
    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error('AI 没有返回内容');
    return { content: String(content).trim(), usage: data.usage || null };
  } finally {
    t.done();
  }
}

async function readHead(filePath, maxChars) {
  try {
    const buf = await fsp.readFile(filePath);
    const limit = Math.min(buf.length, 400000);
    return buf.subarray(0, limit).toString('utf8').slice(0, maxChars || 4000);
  } catch (err) {
    throw new Error(`读取文件失败：${err.code || err.message}`);
  }
}

function fmtDate(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 一句话大白话摘要 */
async function summarize(cfg, file) {
  const head = await readHead(file.path, 4000);
  const { content } = await chat(
    cfg,
    [
      {
        role: 'system',
        content: '你是文件整理助手。只输出一句中文大白话，不超过40字，说明这个文件是做什么的、留着有什么用。不要客套，不要 Markdown。'
      },
      { role: 'user', content: `文件名：${file.name}\n\n内容：\n${head}` }
    ],
    { maxTokens: 120, temperature: 0.2 }
  );
  return content.replace(/^["「『]|["」』]$/g, '').trim();
}

const TYPE_WORD = {
  knowledge: '知识',
  'tool-common': '工具',
  'tool-onetime': '脚本',
  junk: '草稿',
  other: '文件'
};

/** 智能重命名：类型_主题_日期.ext */
async function suggestName(cfg, file) {
  const head = await readHead(file.path, 3000);
  const { content } = await chat(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是文件命名助手。根据文件内容起一个规范文件名，格式：类型_主题_日期。类型从「知识/工具/脚本/文档/数据」里选一个，主题不超过12个汉字，日期用给定日期。只输出文件名本身，不要路径、不要解释、不要引号。'
      },
      {
        role: 'user',
        content: `原文件名：${file.name}\n日期：${fmtDate(file.mtime)}\n内容：\n${head}`
      }
    ],
    { maxTokens: 80, temperature: 0.3 }
  );
  let name = content.replace(/[\\/:*?"<>|]/g, '').replace(/^["「『]|["」』]$/g, '').trim();
  const ext = file.ext || path.extname(file.name);
  if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
  return name;
}

/** 内容标签 */
async function suggestTags(cfg, file) {
  const head = await readHead(file.path, 2500);
  const { content } = await chat(
    cfg,
    [
      {
        role: 'system',
        content: '你是标签助手。给文件打 2-4 个中文内容标签，用逗号分隔，只输出标签，不要解释，不要序号。'
      },
      { role: 'user', content: `文件名：${file.name}\n内容：\n${head}` }
    ],
    { maxTokens: 60, temperature: 0.2 }
  );
  return content
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** AI 复核分类：只允许归到三大类 */
async function suggestCategory(cfg, file) {
  const head = await readHead(file.path, 3000);
  const { content } = await chat(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是文件分类助手。把文件归到且只归到以下四类之一：knowledge（知识库沉淀：长文、报告、笔记、教程）、tool-common（常用工具：可复用脚本）、tool-onetime（一次性脚本：特定场景专用）、junk（冗余可删：草稿、空文件、重复版本）。只输出一个英文分类名，不要解释。'
      },
      { role: 'user', content: `文件名：${file.name}\n内容：\n${head}` }
    ],
    { maxTokens: 20, temperature: 0 }
  );
  const key = content.trim().toLowerCase().replace(/[^a-z-]/g, '');
  const allowed = ['knowledge', 'tool-common', 'tool-onetime', 'junk'];
  return allowed.includes(key) ? key : null;
}

/** 深度比对两个版本，判断保留哪个 */
async function compareVersions(cfg, fileA, fileB) {
  const [a, b] = await Promise.all([readHead(fileA.path, 3500), readHead(fileB.path, 3500)]);
  const { content } = await chat(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是文件版本比对助手。比较两份内容，判断哪一份更完整、更值得保留。只输出 JSON：{"keep":"A"或"B","reason":"一句中文理由，不超过30字"}'
      },
      {
        role: 'user',
        content: `A（${fileA.name}）：\n${a}\n\n---\n\nB（${fileB.name}）：\n${b}`
      }
    ],
    { maxTokens: 100, temperature: 0 }
  );
  try {
    const m = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : content);
    const keep = String(parsed.keep || '').toUpperCase() === 'B' ? 'B' : 'A';
    return { keep, reason: String(parsed.reason || '').slice(0, 60) };
  } catch {
    return { keep: 'A', reason: content.slice(0, 60) };
  }
}

module.exports = {
  detectLocal,
  chat,
  summarize,
  suggestName,
  suggestTags,
  suggestCategory,
  compareVersions,
  chatEndpoint
};
