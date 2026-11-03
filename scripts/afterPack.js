'use strict';

/**
 * 打包钩子：在 electron-builder 生成 portable 外壳之前，给内部 exe 写图标和版本信息。
 *
 * 为什么不用 electron-builder 自带的 resEdit：
 * 这个环境里它写 246MB 的 exe 会报 UNKNOWN error（写不进去），
 * 所以统一走 build.win.signAndEditExecutable=false + 这个钩子。
 *
 * 注意：只能用 rcedit 改「标准 Electron exe」（win-unpacked 里的那个）。
 * 不能拿它改已经打好的 portable 外壳——那是 NSIS 自解压格式，
 * 主体数据挂在 PE 后面，rcedit 重写 PE 会把那部分丢掉（100MB 变 60KB）。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName || (context.packager && context.packager.platform && context.packager.platform.name);
  if (platform !== 'win32' && platform !== 'win') return;

  const appOutDir = context.appOutDir;
  const root = path.resolve(__dirname, '..');
  const icon = path.join(root, 'assets', 'icon.ico');
  const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

  if (!fs.existsSync(icon) || !fs.existsSync(rcedit)) {
    console.warn('[afterPack] 跳过写图标：找不到 icon.ico 或 rcedit.exe');
    return;
  }

  const exeName = fs.readdirSync(appOutDir).find((f) => f.toLowerCase().endsWith('.exe'));
  if (!exeName) {
    console.warn('[afterPack] 跳过写图标：没有找到 exe');
    return;
  }

  const exe = path.join(appOutDir, exeName);
  const before = fs.statSync(exe).size;

  // rcedit 的可执行文件路径和参数都不能带中文（会报 Unable to load file）。
  // 解决：把 rcedit 复制到临时目录（纯英文路径）来调，参数只传相对项目根的路径。
  const os = require('os');
  const rceditTmp = path.join(os.tmpdir(), 'aiam-rcedit.exe');
  try {
    fs.copyFileSync(rcedit, rceditTmp);
  } catch (e) {
    throw new Error(`复制 rcedit 到临时目录失败：${e.message}`);
  }
  const exeRel = path.relative(root, exe);
  const iconRel = path.relative(root, icon);

  execFileSync(rceditTmp, [
    exeRel,
    '--set-icon', iconRel,
    '--set-file-version', '0.4.0.0',
    '--set-product-version', '0.4.0.0',
    '--set-version-string', 'ProductName', 'AI产出管家',
    '--set-version-string', 'FileDescription', 'AI产出管家 - 专门管理 AI 生成的文件',
    '--set-version-string', 'CompanyName', '智维工作室 Zhiwei Studio',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026 智维工作室'
  ], { cwd: root, stdio: 'pipe' });

  const after = fs.statSync(exe).size;
  // 资源替换会让文件略微变小或变大，但绝不该出现数量级缩水
  if (after < before * 0.9) {
    throw new Error(`写图标后 exe 异常缩水：${before} -> ${after}，已中止打包`);
  }
  console.log(`[afterPack] 图标与版本信息已写入 ${exeName}（${before} -> ${after} 字节）`);
};
