'use strict';

/**
 * 来源只对外分两类：AI 工具产出的、看不出来的。
 *
 * 底层仍然按规则猜到了具体是哪家（scanner.SOURCE_RULES），但全世界 AI 工具太多，
 * 猜错一个就把「专业」变成「瞎猜」，所以导出、MCP、通知一律只说这两类。
 * 想恢复细分，只改这一个函数即可。
 */
function sourceLabel(source) {
  const id = source && source.id;
  return id && id !== 'unknown' ? 'AI 工具' : '未识别';
}

module.exports = { sourceLabel };
