'use strict';

const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 把用户（或 AI）给的文件名清洗成安全文件名：
 * - 去掉路径分隔符和 Windows 非法字符，防目录穿越
 * - 去掉开头/结尾的点与空格
 * - 避开 Windows 保留设备名
 * - 限制长度
 * 返回 null 表示清洗后为空、不可用。
 */
function safeFileName(input, fallbackExt) {
  let name = String(input == null ? '' : input).trim();
  if (!name) return null;

  // 先按路径拆出最后一段（Windows 的 \ 和 Unix 的 / 都认），再做字符清洗
  name = name.replace(/\\/g, '/').split('/').pop() || '';
  name = name.replace(/[\\/:*?"<>|\r\n\t]/g, '');
  name = name.replace(/^\.+/, '');
  name = name.replace(/[. ]+$/g, '');
  name = name.slice(0, 120);

  if (!name) return null;
  if (RESERVED.test(name)) name = `_${name}`;

  const ext = String(fallbackExt || '').toLowerCase();
  if (ext && !new RegExp(`${ext.replace('.', '\\.')}$`, 'i').test(name)) {
    // 已经有别的扩展名就不硬塞，避免 a.py 被改成 a.py.md
    if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += fallbackExt;
  }

  return name;
}

/** 归档目标目录必须在允许的根目录之下，防 AI/参数把文件挪到系统目录 */
function isInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

module.exports = { safeFileName, isInside, RESERVED };
