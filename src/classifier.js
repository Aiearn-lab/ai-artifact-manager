'use strict';

const {
  isCodeExt,
  DRAFT_NAME_PATTERNS,
  KNOWLEDGE_NAME_HINTS,
  COMMON_TOOL_HINTS,
  ONETIME_HINTS
} = require('./scanner');

const KNOWLEDGE_EXT = new Set(['.md', '.markdown', '.rst', '.txt', '.log']);
const CONFIG_EXT = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env']);

const THEME_WORDS = [
  '报告', '调研', '方案', '教程', '笔记', '分析', '总结', '复盘', '设计', '计划',
  '数据', '代码', '脚本', '爬虫', '自动化', 'API', '文档', '测试', '部署', '配置',
  '工具', '知识', '手册', '指南', '清单', '模板', '写作', '运营', '产品', '财务'
];

function codeSignals(head) {
  return {
    func: /(^\s*(async\s+)?function\s+\w+|^\s*def\s+\w+|^\s*class\s+\w+|=>\s*\{|^\s*func\s+\w+)/m.test(head),
    cli: /(process\.argv|argparse|sys\.argv|#!\/usr\/bin\/env|if\s+__name__\s*==)/.test(head),
    exported: /(module\.exports|export\s+(default|const|function|class)|\bexports\.)/.test(head),
    commented: /(^\s*(\/\/|#|\/\*|\*)|"""|''')/m.test(head),
    hardPath: /([A-Za-z]:\\|Users[\\/]|\/home\/[A-Za-z])/.test(head),
    imported: /(import\s+.*from|require\(|#include\s*<)/.test(head)
  };
}

function extractTags(file) {
  const tags = new Set();
  const base = file.name.replace(/\.[^.]+$/, '');

  if (base.length >= 2 && base.length <= 12) tags.add(base);

  const heading = (file.head.match(/^#{1,3}\s+(.+)$/m) || [])[1];
  if (heading) {
    const clean = heading.replace(/[#*`>\[\]]/g, '').trim();
    if (clean.length >= 2 && clean.length <= 16) tags.add(clean);
  }

  for (const word of THEME_WORDS) {
    if (base.includes(word) || (file.head && file.head.includes(word))) tags.add(word);
  }

  return Array.from(tags).slice(0, 3);
}

function junk(reason, tags, confidence) {
  return {
    key: 'junk',
    group: 'junk',
    label: '冗余可删',
    retention: '建议清理',
    reason,
    tags: tags || [],
    confidence: confidence || 'medium'
  };
}

function knowledge(reason, tags, confidence) {
  return {
    key: 'knowledge',
    group: 'knowledge',
    label: '知识库沉淀',
    retention: '建议长期留存',
    reason,
    tags: tags || [],
    confidence: confidence || 'medium'
  };
}

function tool(common, reason, tags, confidence) {
  return {
    key: common ? 'tool-common' : 'tool-onetime',
    group: 'tool',
    label: common ? '常用工具' : '一次性脚本',
    retention: common ? '建议留存到工具库' : '可归档或清理',
    reason,
    tags: tags || [],
    confidence: confidence || 'medium'
  };
}

/**
 * 纯规则分类：知识库沉淀 / 工具脚本（常用|一次性）/ 冗余可删 / 其他
 * 不调用任何模型，所有判断可解释。
 */
function classify(file) {
  const name = file.name;
  const ext = file.ext;
  const chars = Number(file.chars) || 0;
  const head = file.head || '';
  const lines = Number(file.lines) || 0;
  const tags = extractTags(file);

  const draftName = DRAFT_NAME_PATTERNS.some((re) => re.test(name));
  const veryShort = chars > 0 && chars < 200;
  const nearEmpty = chars < 80;

  // 1) 冗余：乱命名草稿 + 内容很短（代码文件交给下面的脚本逻辑判断，别把 tmp_xxx.py 误杀）
  if (draftName && veryShort && !isCodeExt(ext)) {
    return junk('文件名像临时草稿、内容很短，通常是 AI 随手生成后没再用', tags, 'high');
  }

  // 2) 冗余：内容近乎为空（代码文件除外，短脚本可能是有用的）
  if (nearEmpty && !isCodeExt(ext)) {
    return junk('内容近乎为空，没有可复用的信息', tags, 'high');
  }

  // 3) 工具脚本
  if (isCodeExt(ext)) {
    const s = codeSignals(head);
    let commonScore = 0;
    let oneoffScore = 0;
    const commonReasons = [];
    const oneoffReasons = [];

    if (s.func) { commonScore += 2; commonReasons.push('含函数/类'); }
    if (s.cli) { commonScore += 3; commonReasons.push('带命令行入口'); }
    if (s.exported) { commonScore += 2; commonReasons.push('模块化可复用'); }
    if (s.commented) { commonScore += 1; commonReasons.push('有注释/文档串'); }
    if (s.imported) { commonScore += 1; }
    if (COMMON_TOOL_HINTS.test(name)) { commonScore += 2; commonReasons.push('命名像通用工具'); }
    if (lines > 80) { commonScore += 1; commonReasons.push('代码量较完整'); }

    if (s.hardPath) { oneoffScore += 2; oneoffReasons.push('硬编码本机路径'); }
    if (lines > 0 && lines < 40) { oneoffScore += 2; oneoffReasons.push('代码很短'); }
    if (ONETIME_HINTS.test(name)) { oneoffScore += 3; oneoffReasons.push('命名像临时/测试脚本'); }
    if (!s.func && !s.cli && !s.exported) { oneoffScore += 1; oneoffReasons.push('无函数/入口/导出'); }

    if (commonScore >= oneoffScore) {
      const why = commonReasons.length ? commonReasons.join('、') : '有一定结构';
      return tool(true, `可复用脚本：${why}，适合收进工具库以后再用`, tags, commonScore >= 4 ? 'high' : 'medium');
    }
    const why = oneoffReasons.length ? oneoffReasons.join('、') : '依赖特定场景';
    return tool(false, `一次性脚本：${why}，换个场景大概率要重写`, tags, oneoffScore >= 4 ? 'high' : 'medium');
  }

  // 4) 知识库沉淀
  if (KNOWLEDGE_EXT.has(ext)) {
    const hasHeading = /^#{1,6}\s+\S/m.test(head);
    const nameHint = KNOWLEDGE_NAME_HINTS.test(name);

    if (chars >= 600 || (hasHeading && chars >= 200) || (nameHint && chars >= 200)) {
      const bits = [];
      if (chars >= 600) bits.push('篇幅完整');
      if (hasHeading) bits.push('有标题结构');
      if (nameHint) bits.push('命名指向文档类');
      return knowledge(`可沉淀的长文：${bits.join('、')}，以后能直接查用`, tags, chars >= 1500 ? 'high' : 'medium');
    }

    if (chars < 200) {
      return junk('短文本且没有结构，更像随手记的碎片', tags, 'medium');
    }
    return knowledge('有一定信息量的文本，建议先留存观察', tags, 'low');
  }

  // 5) 配置/数据文件
  if (CONFIG_EXT.has(ext)) {
    return {
      key: 'other',
      group: 'other',
      label: '配置/数据',
      retention: '按需留存',
      reason: '配置或数据文件，是否保留取决于对应项目是否还在用',
      tags,
      confidence: 'low'
    };
  }

  return {
    key: 'other',
    group: 'other',
    label: '其他文件',
    retention: '按需留存',
    reason: '规则未覆盖的类型，建议人工确认',
    tags,
    confidence: 'low'
  };
}

/**
 * 重复检测完成后，把「重复版本」标成冗余，覆盖原分类。
 */
function applyDuplicate(file, dup) {
  if (!dup || !dup.isDuplicate) return file.category;
  const isExact = dup.kind === 'exact';
  return {
    key: 'junk',
    group: 'junk',
    label: '冗余可删',
    retention: '建议清理',
    reason: isExact
      ? `与「${dup.withName}」内容完全重复，保留一份即可`
      : `与「${dup.withName}」内容高度相似（${Math.round(dup.similarity * 100)}%），属于冗余版本，建议保留最新/最完整那份`,
    tags: file.category ? file.category.tags : [],
    confidence: 'high',
    duplicateOf: dup.withPath
  };
}

function classifyAll(files) {
  for (const f of files) f.category = classify(f);
  return files;
}

function summarize(files) {
  const bySource = {};
  const byCategory = {};
  let totalSize = 0;
  let cleanableSize = 0;
  let duplicateSize = 0;

  for (const f of files) {
    totalSize += f.size;

    const sid = (f.source && f.source.id) || 'unknown';
    if (!bySource[sid]) {
      bySource[sid] = {
        id: sid,
        name: (f.source && f.source.name) || '未识别',
        color: (f.source && f.source.color) || '#94a3b8',
        count: 0,
        size: 0
      };
    }
    bySource[sid].count += 1;
    bySource[sid].size += f.size;

    const ckey = (f.category && f.category.key) || 'other';
    if (!byCategory[ckey]) {
      byCategory[ckey] = {
        key: ckey,
        label: (f.category && f.category.label) || '其他',
        count: 0,
        size: 0
      };
    }
    byCategory[ckey].count += 1;
    byCategory[ckey].size += f.size;

    if (ckey === 'junk') cleanableSize += f.size;
    if (f.duplicate && f.duplicate.isDuplicate) duplicateSize += f.size;
  }

  return {
    files: files.length,
    size: totalSize,
    cleanableSize,
    duplicateSize,
    bySource: Object.values(bySource).sort((a, b) => b.size - a.size),
    byCategory: Object.values(byCategory).sort((a, b) => b.size - a.size)
  };
}

module.exports = {
  classify,
  classifyAll,
  applyDuplicate,
  summarize,
  extractTags
};
