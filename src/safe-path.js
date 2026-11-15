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
  // \x00-\x1f 全段控制字符都要清：NUL 会被 Win32 截断（"a\x00.md" 实际落盘成 "a"），
  // \r\n 会把日志/CSV 断行，其余控制字符在资源管理器里表现为乱码
  name = name.replace(/\\/g, '/').split('/').pop() || '';
  name = name.replace(/[\x00-\x1f\\/:*?"<>|]/g, '');
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

// 盘符根下这些顶层目录一律不写：写进去不是用户想要的结果，且多半等于提权/持久化
const SYSTEM_TOP = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'perflogs',
  'boot',
  'config.msi',
  '$windows.~bt',
  '$windows.~ws'
]);

/**
 * 受保护路径：程序绝不主动写入的位置（系统目录、盘符根本身）。
 * 用于「撤销归档」「放回回收箱」这类要把文件搬回任意原路径的动作——
 * 账本一旦被本机其他程序改写，这里是最后一道闸。
 */
function isProtectedPath(target) {
  const raw = String(target == null ? '' : target);
  if (!raw) return true;
  const t = path.resolve(raw);
  const root = path.parse(t).root;
  const parts = t.slice(root.length).split(path.sep).filter(Boolean);
  if (!parts.length) return true; // 盘符根本身
  if (SYSTEM_TOP.has(parts[0].toLowerCase())) return true;
  const sysRoot = process.env.SystemRoot || process.env.windir || '';
  if (sysRoot) {
    const sr = path.resolve(sysRoot).toLowerCase();
    if (t.toLowerCase() === sr || t.toLowerCase().startsWith(sr + path.sep)) return true;
  }
  return false;
}

module.exports = { safeFileName, isInside, isProtectedPath, RESERVED };
