'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * 首次启动在桌面创建一个指向本程序的快捷方式。
 *
 * 设计原则：
 * - 只做一次：标记文件存在、或桌面已有同名快捷方式，都直接跳过，不重复打扰；
 * - 绝不覆盖用户改过的快捷方式（目标/图标被用户调整过，我们不该自作主张改回去）；
 * - 任何一步失败都安静返回 {ok:false, reason}，绝不阻断启动——这是锦上添花，不是核心功能；
 * - 目标路径必须来自调用方（主进程 appExePath()），本模块不猜、不拼。
 *
 * 署名：智维工作室 / Zhiwei Studio
 */

const MARKER_FILE = 'desktop-shortcut-created.json';

/** 快捷方式是否存在（同名即认为用户已有，不覆盖） */
function linkExists(desktopDir, linkName) {
  try {
    return fs.existsSync(path.join(desktopDir, linkName));
  } catch {
    return false;
  }
}

async function markerExists(userDataDir) {
  try {
    await fsp.stat(path.join(userDataDir, MARKER_FILE));
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(userDataDir, detail) {
  try {
    await fsp.mkdir(userDataDir, { recursive: true });
    const file = path.join(userDataDir, MARKER_FILE);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(
      tmp,
      JSON.stringify({ at: Date.now(), target: detail.target || '', link: detail.link || '' }, null, 2),
      'utf8'
    );
    await fsp.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试创建桌面快捷方式。
 * @param {object} opts
 * @param {string} opts.targetExe  要指向的 exe 绝对路径（主进程 appExePath()）
 * @param {string} opts.desktopDir 桌面目录（app.getPath('desktop')）
 * @param {string} opts.userDataDir 标记文件目录（app.getPath('userData')）
 * @param {object} opts.shell      electron.shell（注入，方便单测）
 * @param {string} [opts.linkName] 快捷方式文件名，默认 AI产出管家.lnk
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string}>}
 */
async function ensureDesktopShortcut(opts) {
  const o = opts || {};
  const shell = o.shell;
  const targetExe = String(o.targetExe || '').trim();
  const desktopDir = String(o.desktopDir || '').trim();
  const userDataDir = String(o.userDataDir || '').trim();
  const linkName = String(o.linkName || 'AI产出管家.lnk');

  if (!shell || typeof shell.writeShortcutLink !== 'function') {
    return { ok: false, reason: '当前环境不支持创建快捷方式' };
  }
  if (!targetExe || !desktopDir || !userDataDir) {
    return { ok: false, reason: '缺少必要路径，跳过' };
  }

  // 标记存在 = 以前已经处理过（建成功或主动跳过），不再重复
  if (await markerExists(userDataDir)) {
    return { ok: true, skipped: true, reason: '不是首次启动' };
  }

  // 桌面已有同名 = 用户自己放的那份，绝不覆盖
  if (linkExists(desktopDir, linkName)) {
    await writeMarker(userDataDir, { target: targetExe, link: linkName });
    return { ok: true, skipped: true, reason: '桌面已有同名快捷方式，未覆盖' };
  }

  // 目标 exe 必须真实存在，否则建出来是死链
  try {
    const st = await fsp.stat(targetExe);
    if (!st.isFile()) return { ok: false, reason: '目标不是可执行文件' };
  } catch {
    return { ok: false, reason: '找不到目标 exe，跳过' };
  }

  const linkPath = path.join(desktopDir, linkName);
  try {
    const ok = shell.writeShortcutLink(linkPath, 'create', {
      target: targetExe,
      cwd: path.dirname(targetExe),
      args: '',
      title: 'AI产出管家',
      description: '管理 AI 生成的文件 · 智维工作室',
      icon: targetExe,
      iconIndex: 0
    });
    if (!ok) return { ok: false, reason: '系统拒绝创建快捷方式' };
  } catch (err) {
    return { ok: false, reason: `创建失败：${(err && err.message) || err}` };
  }

  await writeMarker(userDataDir, { target: targetExe, link: linkPath });
  return { ok: true, reason: '已在桌面创建快捷方式' };
}

module.exports = { ensureDesktopShortcut, MARKER_FILE, linkExists };
