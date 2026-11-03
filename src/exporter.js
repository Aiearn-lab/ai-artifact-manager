'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { sourceLabel } = require('./source-label');

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function header() {
  return [
    '# AI 工件清单',
    '',
    `> 由 AI工件管家 导出 · 智维工作室 Zhiwei Studio · https://www.zhiweistudio.com.cn`,
    `> 导出时间：${fmtTime(Date.now())}`,
    ''
  ].join('\n');
}

function summaryBlock(summary) {
  if (!summary) return '';
  const lines = [];
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 文件总数 | ${summary.files} |`);
  lines.push(`| 占用空间 | ${fmtSize(summary.size)} |`);
  lines.push(`| 预估可清理 | ${fmtSize(summary.cleanableSize)} |`);
  lines.push(`| 重复可释放 | ${fmtSize(summary.duplicateSize)} |`);
  lines.push('');
  if (summary.byCategory && summary.byCategory.length) {
    lines.push('### 分类分布');
    lines.push('');
    lines.push('| 分类 | 文件数 | 占用 |');
    lines.push('| --- | ---: | --- |');
    for (const c of summary.byCategory) {
      lines.push(`| ${c.label} | ${c.count} | ${fmtSize(c.size)} |`);
    }
    lines.push('');
  }
  if (summary.bySource && summary.bySource.length) {
    lines.push('### AI 来源分布');
    lines.push('');
    lines.push('| 来源 | 文件数 | 占用 |');
    lines.push('| --- | ---: | --- |');
    for (const s of summary.bySource) {
      lines.push(`| ${s.name} | ${s.count} | ${fmtSize(s.size)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escapeCell(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function toMarkdown(files, summary) {
  const lines = [header(), summaryBlock(summary)];
  lines.push('## 文件清单');
  lines.push('');
  lines.push('| 文件名 | AI 来源 | 分类 | 留存建议 | 大小 | 修改时间 | 路径 | AI 摘要 |');
  lines.push('| --- | --- | --- | --- | ---: | --- | --- | --- |');
  for (const f of files) {
    lines.push(
      [
        escapeCell(f.name),
        escapeCell(sourceLabel(f.source)),
        escapeCell(f.category && f.category.label),
        escapeCell(f.category && f.category.retention),
        fmtSize(f.size),
        fmtTime(f.mtime),
        escapeCell(f.path),
        escapeCell(f.aiSummary || '')
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('本清单由 AI工件管家 生成，仅在本地运行。');
  return lines.join('\n');
}

function csvCell(value) {
  let s = String(value == null ? '' : value);
  // 防 Excel 公式注入：以 = + - @ 或制表符开头的值加前导单引号
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(files) {
  const cols = ['文件名', 'AI来源', '分类', '留存建议', '大小(字节)', '修改时间', '标签', '留存说明', 'AI摘要', '路径'];
  const rows = [cols.join(',')];
  for (const f of files) {
    rows.push(
      [
        csvCell(f.name),
        csvCell(sourceLabel(f.source)),
        csvCell(f.category && f.category.label),
        csvCell(f.category && f.category.retention),
        csvCell(f.size),
        csvCell(fmtTime(f.mtime)),
        csvCell(f.category && f.category.tags ? f.category.tags.join(' / ') : ''),
        csvCell(f.category && f.category.reason),
        csvCell(f.aiSummary || ''),
        csvCell(f.path)
      ].join(',')
    );
  }
  // BOM：让 Excel 正确识别 UTF-8
  return '\ufeff' + rows.join('\r\n');
}

async function writeFile(outPath, content) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, content, 'utf8');
  return outPath;
}

async function exportMarkdown(outPath, files, summary) {
  return writeFile(outPath, toMarkdown(files, summary));
}

async function exportCsv(outPath, files) {
  return writeFile(outPath, toCsv(files));
}

module.exports = { exportMarkdown, exportCsv, toMarkdown, toCsv, fmtSize, fmtTime };
