'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('./archiver');
const { sourceLabel } = require('./source-label');

const SERVER_INFO = { name: 'ai-artifact-manager', version: require('../package.json').version };
const PROTOCOL_VERSION = '2024-11-05';

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function loadIndex(indexPath) {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return { root: '', updatedAt: 0, files: [], summary: null };
    return data;
  } catch {
    return { root: '', updatedAt: 0, files: [], summary: null };
  }
}

function matchFile(f, q) {
  const hay = [
    f.name,
    f.path,
    f.summary || '',
    (f.category && f.category.label) || '',
    (f.category && f.category.reason) || '',
    (f.category && Array.isArray(f.category.tags) ? f.category.tags.join(' ') : ''),
    sourceLabel(f.source)
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function describe(f) {
  const lines = [];
  lines.push(`文件：${f.name}`);
  lines.push(`路径：${f.path}`);
  lines.push(`大小：${fmtSize(f.size)}${f.chars ? ` · 约 ${f.chars} 字` : ''}`);
  lines.push(`AI 来源：${sourceLabel(f.source)}`);
  lines.push(`分类：${(f.category && f.category.label) || '未分类'}`);
  lines.push(`留存建议：${(f.category && f.category.retention) || '-'}`);
  if (f.category && f.category.reason) lines.push(`说明：${f.category.reason}`);
  if (f.category && f.category.tags && f.category.tags.length) lines.push(`标签：${f.category.tags.join('、')}`);
  if (f.summary) lines.push(`摘要：${f.summary}`);
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'search_files',
    description: '在用户本地的 AI 工件索引里搜索文件（按文件名、路径、标签、摘要、分类、来源匹配）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，中文或英文' },
        limit: { type: 'number', description: '最多返回条数，默认 20' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_file_summary',
    description: '获取某个文件的详细信息与内容开头（用于快速了解文件讲什么）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的完整路径（必须在已扫描索引内）' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_by_category',
    description: '按分类列出文件：knowledge=知识库沉淀，tool=工具脚本，junk=冗余可删，all=全部。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['knowledge', 'tool', 'junk', 'all'], description: '分类' },
        limit: { type: 'number', description: '最多返回条数，默认 50' }
      },
      required: ['category']
    }
  },
  {
    name: 'archive_files',
    description: '把指定文件按分类移动到统一归档目录（剪切，原位置不再保留）。本产品没有复制归档。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要归档的文件完整路径列表' },
        targetDir: { type: 'string', description: '归档目标根目录，不填则用软件里配置的默认归档目录' }
      },
      required: ['paths']
    }
  }
];

/**
 * 创建 MCP 请求处理器。stdio / HTTP 两个入口共用。
 */
function createHandler(options) {
  const opts = options || {};
  const indexPath = opts.indexPath;
  const getDefaultArchiveRoot = opts.getDefaultArchiveRoot || (() => '');

  return async function handle(method, params) {
    const p = params || {};

    if (method === 'initialize') {
      return {
        protocolVersion: p.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      };
    }

    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'ping') return {};

    if (method === 'tools/list') return { tools: TOOLS };

    if (method === 'tools/call') {
      const name = p.name;
      const args = p.arguments || {};
      const index = loadIndex(indexPath);

      if (name === 'search_files') {
        const q = String(args.query || '').trim().toLowerCase();
        if (!q) return errorResult('query 不能为空');
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
        const hits = index.files.filter((f) => matchFile(f, q)).slice(0, limit);
        if (!hits.length) return textResult(`没有找到包含「${args.query}」的文件。索引共 ${index.files.length} 个文件。`);
        return textResult(
          `找到 ${hits.length} 个结果（索引共 ${index.files.length} 个文件）：\n\n` +
            hits.map((f, i) => `${i + 1}. ${describe(f)}`).join('\n\n')
        );
      }

      if (name === 'get_file_summary') {
        const target = String(args.path || '');
        if (!target) return errorResult('path 不能为空');
        const f = index.files.find((x) => path.resolve(x.path) === path.resolve(target));
        if (!f) return errorResult('这个文件不在当前索引里。请先在软件里扫描一次，或确认路径是否正确。');
        let head = '';
        try {
          const buf = await fsp.readFile(f.path);
          head = buf.subarray(0, Math.min(buf.length, 8000)).toString('utf8').slice(0, 2000);
        } catch (err) {
          head = `（读取失败：${err.code || err.message}）`;
        }
        return textResult(`${describe(f)}\n\n--- 内容开头 ---\n${head}`);
      }

      if (name === 'list_by_category') {
        const cat = String(args.category || 'all');
        // 传错分类名不能静默返回全部文件——那是误导，直接报错
        if (!['knowledge', 'tool', 'junk', 'all'].includes(cat)) {
          return errorResult(`未知分类：${cat}。可用值：knowledge / tool / junk / all`);
        }
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
        let list = index.files;
        if (cat === 'knowledge') list = index.files.filter((f) => (f.category && f.category.group === 'knowledge') || (f.category && f.category.key === 'knowledge'));
        else if (cat === 'tool') list = index.files.filter((f) => f.category && f.category.group === 'tool');
        else if (cat === 'junk') list = index.files.filter((f) => f.category && f.category.group === 'junk');
        const hits = list.slice(0, limit);
        if (!hits.length) return textResult(`「${cat}」分类下没有文件。`);
        return textResult(
          `「${cat}」共 ${list.length} 个文件，列出前 ${hits.length} 个：\n\n` +
            hits.map((f, i) => `${i + 1}. ${f.name} · ${fmtSize(f.size)} · ${(f.category && f.category.label) || ''}\n   ${f.path}`).join('\n')
        );
      }

      if (name === 'archive_files') {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        if (!paths.length) return errorResult('paths 不能为空');
        const root = String(getDefaultArchiveRoot() || '').trim();
        if (!root) return errorResult('没有归档目录：请先在软件设置里配置默认归档路径。');
        if (args.targetDir && path.resolve(String(args.targetDir)) !== path.resolve(root)) {
          return errorResult(`出于安全考虑，MCP 只能归档到软件里配置的目录：${root}`);
        }

        const picked = [];
        const missing = [];
        for (const pth of paths) {
          const f = index.files.find((x) => path.resolve(x.path) === path.resolve(String(pth)));
          if (f) picked.push(f);
          else missing.push(pth);
        }
        if (!picked.length) return errorResult('传入的路径都不在索引里，未执行归档。');

        // 本产品没有复制归档：一律移动，防止「越清越多」
        const result = await archiver.archive(picked, root);
        return textResult(
          `归档完成：成功 ${result.ok} 个，失败 ${result.failed.length} 个，跳过 ${result.skipped.length} 个。\n目标目录：${result.target}` +
            (result.failed.length ? `\n失败明细：${result.failed.map((x) => `${x.path}（${x.error}）`).join('；')}` : '') +
            (missing.length ? `\n以下路径不在索引里，已忽略：${missing.join('；')}` : '')
        );
      }

      return errorResult(`未知工具：${name}`);
    }

    throw new Error(`不支持的方法：${method}`);
  };
}

module.exports = { createHandler, TOOLS, SERVER_INFO, PROTOCOL_VERSION, loadIndex };
