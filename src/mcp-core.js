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
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b < 1024 * 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(b / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`;
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

// ---- 磁盘体检结果的 AI 可读格式化 ----
const GRADE_NAME = { safe: '能安全清掉', careful: '占地方的大件', keep: '不用管' };

function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatItems(items, limit) {
  const list = Array.isArray(items) ? items.slice(0, limit || 20) : [];
  if (!list.length) return '（这一档没有条目）';
  return list
    .map((it, i) => {
      const tag = it.inProject ? ' [项目依赖，不会清]' : '';
      return `${i + 1}. ${it.name || it.path} — ${fmtSize(it.size)}${tag}\n   ${it.path}`;
    })
    .join('\n');
}

function formatDiskStatus(s) {
  if (!s) {
    return '还没有体检结果。请让用户在软件里点一下「体检这块盘」，或者调用 disk_scan 触发一次。';
  }
  const g = s.grades || {};
  const line = (k) => {
    const x = g[k] || {};
    return `  ${GRADE_NAME[k] || k}：${fmtSize(x.size)} · ${x.count || 0} 处`;
  };
  const recycle = s.recycleBin && Number(s.recycleBin.size) ? `\n回收站里压着：${fmtSize(s.recycleBin.size)}` : '';
  return [
    `磁盘体检结果（${fmtTime(s.at)}）`,
    `体检范围：${s.root}`,
    `整盘占用：${fmtSize(s.totalSize)}（${s.totalFiles || 0} 个文件）`,
    '三档相加正好等于整盘占用：',
    line('safe'),
    line('careful'),
    line('keep') + recycle,
    '',
    '「能安全清掉」明细（前 20 条）：',
    formatItems(g.safe && g.safe.items, 20),
    '',
    '「占地方的大件」明细（前 20 条，不给清理建议，只帮定位）：',
    formatItems(g.careful && g.careful.items, 20),
    '',
    '下一步：想看某块目录里到底是什么，用 disk_peek；想清理，用 disk_cleanup（默认只预演，不会直接删）。'
  ].join('\n');
}

function formatDiskScan(s) {
  const g = s.grades || {};
  const line = (k) => `  ${GRADE_NAME[k] || k}：${fmtSize((g[k] || {}).size)} · ${(g[k] || {}).count || 0} 处`;
  return [
    `体检完成：${s.root}`,
    `整盘占用：${fmtSize(s.totalSize)}（${s.totalFiles || 0} 个文件，耗时 ${Math.round((s.durationMs || 0) / 1000)} 秒）`,
    line('safe'),
    line('careful'),
    line('keep'),
    '',
    '完整的目录明细用 disk_status 读取。想看某块占空间的是什么，用 disk_peek。'
  ].join('\n');
}

function formatDiskPeek(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  const dirs = Array.isArray(r.dirs) ? r.dirs : [];
  const fileLines = files.length
    ? files.map((f, i) => `  ${i + 1}. ${f.name} — ${fmtSize(f.size)}`).join('\n')
    : '  （这一层没有文件）';
  const dirLines = dirs.length ? dirs.map((d) => `  - ${d.name}`).join('\n') : '  （没有子文件夹）';
  return [
    `目录：${r.path}`,
    `这一层：${r.fileCount} 个文件（共 ${fmtSize(r.fileBytes)}），${r.dirCount} 个子文件夹`,
    '',
    '最大的文件：',
    fileLines,
    '',
    '子文件夹：',
    dirLines,
    '',
    '想看子文件夹里是什么，对它再调用一次 disk_peek（只列一层，很快）。'
  ].join('\n');
}

// MCP Tool Annotations：四个提示全部显式声明为布尔值，且与各 handler 的实际行为一致。
// 缺省时 MCP 主机会把工具当成「可写、破坏性、非幂等、开放世界」，OpenAI 目录会直接拒收。
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
    },
    annotations: {
      readOnlyHint: true,       // 只读索引，不改动任何文件
      destructiveHint: false,
      idempotentHint: true,     // 同样参数重复调用结果一致
      openWorldHint: false      // 只访问本机索引，不联网
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
    },
    annotations: {
      readOnlyHint: true,       // 只读取文件内容开头
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
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
    },
    annotations: {
      readOnlyHint: true,       // 只列举，不改动
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
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
    },
    annotations: {
      readOnlyHint: false,      // 会移动文件，改变磁盘状态
      destructiveHint: true,    // 剪切操作，原位置不再保留
      idempotentHint: false,    // 重复调用结果不同（文件已不在原位）
      openWorldHint: false      // 只动本机文件，不联网
    }
  },
  {
    name: 'disk_status',
    description: '读取当前磁盘体检结果：整盘占用、「能安全清掉 / 占地方的大件 / 不用管」三档各占多少、具体有哪些目录、回收站压了多少空间。这是磁盘类任务的推荐第一步——用户通常已经在软件里点过体检。只读，一个文件都不动。',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'disk_scan',
    description: '触发一次磁盘体检（只统计体积，一个文件都不动）。root 传盘符（如 E:\\）或某个文件夹的完整路径。大硬盘可能要十几秒到几十秒，优先用 disk_status 读现成结果。',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '要体检的盘符或文件夹完整路径，例如 E:\\' },
        maxDepth: { type: 'number', description: '统计到第几层，默认 6' }
      },
      required: ['root']
    },
    annotations: {
      readOnlyHint: true,       // 只统计体积，不改任何文件
      destructiveHint: false,
      idempotentHint: false,    // 每次扫到的结果会随时间变
      openWorldHint: false
    }
  },
  {
    name: 'disk_peek',
    description: '查看某个大目录里到底有什么：这一层最大的 10 个文件 + 有哪些子文件夹。只列一层、不递归，几十毫秒返回。路径要来自 disk_status / disk_scan 结果里体检范围内的目录。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要查看的目录完整路径（必须在体检范围内）' }
      },
      required: ['path']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'disk_cleanup',
    description: '清理「能安全清掉」那一档（缓存、依赖、构建产物）。默认只预演、不删：先返回将要清的条目和能腾出的空间，让用户看清楚。只有 confirm=true 才真正执行：删除进 Windows 回收站（可还原），项目依赖自动跳过，第一层大目录不自动清。AI 应先把预演结果给用户看，得到同意后再 confirm=true。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要清的具体路径；不传则清「能安全清掉」这一档里所有非项目依赖的条目' },
        confirm: { type: 'boolean', description: 'true 才真正执行删除；默认 false 只预演' }
      }
    },
    annotations: {
      readOnlyHint: false,      // confirm=true 会删文件
      destructiveHint: true,    // 进回收站，仍是可还原的破坏性操作
      idempotentHint: false,
      openWorldHint: false
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
  const disk = opts.disk || null;
  const needDisk = () => (disk
    ? null
    : errorResult('磁盘工具需要软件主进程支持：请用软件里「开启 MCP」生成的 HTTP 配置连接（stdio 模式不支持磁盘体检）。'));

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

      // 参数一律先过类型闸：AI 客户端什么形状都可能传（对象/数组/带 toString 的对象），
      // String({toString:'x'}) 会直接抛 "Cannot convert object to primitive value"，
      // 一个烂参数就能把整个调用打成 500——这不是错误处理，是缺校验。
      const str = (v) => (typeof v === 'string' ? v : '');

      if (name === 'search_files') {
        const q = str(args.query).trim().toLowerCase();
        if (!q) return errorResult('query 不能为空（需要字符串）');
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
        const hits = index.files.filter((f) => matchFile(f, q)).slice(0, limit);
        if (!hits.length) return textResult(`没有找到包含「${args.query}」的文件。索引共 ${index.files.length} 个文件。`);
        return textResult(
          `找到 ${hits.length} 个结果（索引共 ${index.files.length} 个文件）：\n\n` +
            hits.map((f, i) => `${i + 1}. ${describe(f)}`).join('\n\n')
        );
      }

      if (name === 'get_file_summary') {
        const target = str(args.path);
        if (!target) return errorResult('path 不能为空（需要字符串）');
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
        const cat = str(args.category) || 'all';
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
        const paths = (Array.isArray(args.paths) ? args.paths : []).filter((x) => typeof x === 'string' && x.trim());
        if (!paths.length) return errorResult('paths 不能为空（需要字符串路径数组）');
        const root = String(getDefaultArchiveRoot() || '').trim();
        if (!root) return errorResult('没有归档目录：请先在软件设置里配置默认归档路径。');
        // targetDir 只接受字符串：非字符串直接拒绝，不做隐式转换
        if (args.targetDir !== undefined && args.targetDir !== null && typeof args.targetDir !== 'string') {
          return errorResult('targetDir 必须是字符串路径');
        }
        const targetDir = typeof args.targetDir === 'string' ? args.targetDir.trim() : '';
        if (targetDir && path.resolve(targetDir) !== path.resolve(root)) {
          return errorResult(`出于安全考虑，MCP 只能归档到软件里配置的目录：${root}`);
        }

        const picked = [];
        const missing = [];
        for (const pth of paths) {
          const f = index.files.find((x) => path.resolve(String(x.path)) === path.resolve(pth));
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

      // ---- 磁盘体检：AI 接手清盘的四步 ----
      if (name === 'disk_status') {
        const guard = needDisk();
        if (guard) return guard;
        return textResult(formatDiskStatus(disk.status()));
      }

      if (name === 'disk_scan') {
        const guard = needDisk();
        if (guard) return guard;
        const root = str(args.root).trim();
        if (!root) return errorResult('root 不能为空：要体检的盘符或文件夹完整路径，例如 E:\\');
        const maxDepth = Math.min(Math.max(Number(args.maxDepth) || 6, 1), 10);
        let s;
        try {
          s = await disk.scan({ root, maxDepth, withRecycle: true });
        } catch (err) {
          return errorResult(`体检失败：${(err && err.message) || err}`);
        }
        return textResult(formatDiskScan(s));
      }

      if (name === 'disk_peek') {
        const guard = needDisk();
        if (guard) return guard;
        const target = str(args.path).trim();
        if (!target) return errorResult('path 不能为空：要查看的目录完整路径');
        let r;
        try {
          r = await disk.peek(target);
        } catch (err) {
          return errorResult(`看不了这个目录：${(err && err.message) || err}`);
        }
        return textResult(formatDiskPeek(r));
      }

      if (name === 'disk_cleanup') {
        const guard = needDisk();
        if (guard) return guard;
        const status = disk.status();
        if (!status || !status.grades || !status.grades.safe) {
          return errorResult('还没有体检结果，没有可清的清单。请让用户点「体检这块盘」，或先调用 disk_scan。');
        }
        const safe = status.grades.safe;
        const allow = new Map();
        for (const it of (safe.items || [])) {
          if (it && it.path) allow.set(path.resolve(it.path), it);
        }
        const askedRaw = (Array.isArray(args.paths) ? args.paths : []).filter((x) => typeof x === 'string' && x.trim());
        const picked = askedRaw.length
          ? askedRaw.map((x) => ({ p: path.resolve(x), rec: allow.get(path.resolve(x)) }))
          : (safe.items || [])
              .filter((it) => it && it.path && !it.inProject)
              .map((it) => ({ p: path.resolve(it.path), rec: it }));
        // 和界面「清掉这一档」保持同一条规矩：项目依赖永远不进可清名单。
        const valid = picked.filter((x) => x.rec && !x.rec.inProject);
        const invalid = picked.filter((x) => !x.rec || x.rec.inProject);
        if (!valid.length) return errorResult('没有可清的条目：传入的路径都不在「能安全清掉」清单里，或属于项目依赖。');

        const totalSize = valid.reduce((n, x) => n + (Number((x.rec && x.rec.size) || 0)), 0);
        if (args.confirm !== true) {
          return textResult(
            [
              '【预演，没有删除任何文件】',
              `将清掉「能安全清掉」档的 ${valid.length} 处，预计腾出 ${fmtSize(totalSize)}。`,
              `名单（前 20 条）：\n${formatItems(valid.map((x) => x.rec), 20)}`,
              invalid.length ? `另有 ${invalid.length} 条不在可清清单里或属于项目依赖，已忽略。` : '',
              '',
              '确认无误后，用 confirm=true 再调用一次 disk_cleanup 才会真正执行。删除进 Windows 回收站，可还原；项目依赖会自动跳过。'
            ]
              .filter(Boolean)
              .join('\n')
          );
        }

        // 真删仍走主进程白名单 + 逐条 inspect 复核，AI 传什么路径都绕不过去
        let result;
        try {
          result = await disk.clean({ paths: valid.map((x) => x.p) });
        } catch (err) {
          return errorResult(`清理失败：${(err && err.message) || err}`);
        }
        return textResult(
          `清理完成：成功 ${result.done.length} 处，跳过 ${result.skipped.length} 处，失败 ${result.failed.length} 处，腾出 ${fmtSize(result.freed)}。\n` +
            '删除的文件都在 Windows 回收站里，可以还原。' +
            (result.skipped.length
              ? `\n跳过原因（前 5 条）：${result.skipped.slice(0, 5).map((x) => `${x.name || x.path}（${x.reason}）`).join('；')}`
              : '') +
            (result.failed.length
              ? `\n失败明细（前 5 条）：${result.failed.slice(0, 5).map((x) => `${x.path}（${x.error}）`).join('；')}`
              : '')
        );
      }

      return errorResult(`未知工具：${name}`);
    }

    throw new Error(`不支持的方法：${method}`);
  };
}

module.exports = { createHandler, TOOLS, SERVER_INFO, PROTOCOL_VERSION, loadIndex };
