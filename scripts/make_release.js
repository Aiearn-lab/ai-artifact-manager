'use strict';

/**
 * 免安装发布包（v0.8 M4 打包门面）
 * ------------------------------------------------------------------
 * 干什么：把 electron-builder 产出的 portable exe 打成「AI产出管家-<版本>-免安装.zip」，
 * 包里塞一张「装机须知.txt」，再把三个产物（免安装 zip / portable exe / 安装器）
 * 一起拷进 release/，并生成 SHA256SUMS.txt。
 *
 * 为什么要脚本而不是手点：
 * 版本号每轮都变，手点必然出现「zip 里装的是上一版 exe」这种事故；
 * 校验和写在 release 里，用户拿到包能自己核对是不是同一个文件。
 *
 * 零依赖：压缩调 Windows 自带的 PowerShell Compress-Archive，哈希用 Node 的 crypto。
 *
 * 用法：node scripts/make_release.js
 * 前置：先跑 npm run dist（产物在 dist/）
 * 署名：智维工作室 / Zhiwei Studio
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 装机须知：只写「被拦那一下怎么办」，细则在官网指引页，别在两处各写一套 */
function readmeText(version) {
  return [
    `AI 产出管家 ${version} · 免安装版`,
    '',
    '装：',
    '  1. 把本 zip 解压到一个你以后不会挪动的文件夹（别在压缩包里直接双击运行）；',
    `  2. 双击 AI产出管家-${version}-portable.exe。`,
    '',
    '第一次打开被 Windows 拦（程序没买签名证书，这是预期内的）：',
    '  蓝色弹窗「Windows 已保护你的电脑」→ 点右下角「更多信息」→ 点「仍要运行」。',
    '  放行只需一次；换了新版本会再问一遍。',
    '',
    '数据在哪：',
    `  和 exe 同目录的「AI产出管家数据」文件夹（设置、扫描记录、回收箱都在里面）。`,
    '  换电脑时把这个文件夹一起拷走，账就跟着走。',
    '',
    '卸载：',
    '  删掉 exe 和「AI产出管家数据」即可。但请先打开回收箱看一眼——',
    '  里面还有你要的文件时删掉数据文件夹，等于自己把东西清了。',
    '  回收箱和整理目录里各有一张「卸载后请看.txt」，写着怎么放回去。',
    '',
    '图文版（含杀软白名单、双击没反应、企业电脑装不上）：',
    '  https://www.zhiweistudio.com.cn/install-guide',
    '',
    '—— 智维工作室 / Zhiwei Studio'
  ].join('\r\n');
}

(async () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const version = pkg.version;

  const portable = path.join(DIST, `AI产出管家-${version}-portable.exe`);
  const setup = path.join(DIST, `AI产出管家-${version}-setup.exe`);
  if (!fs.existsSync(portable)) {
    console.error(`✗ 没找到 ${path.relative(ROOT, portable)}，请先跑 npm run dist`);
    process.exit(1);
  }

  console.log(`=== AI产出管家 ${version} 发布包 ===`);

  // 1) 组包：exe + 装机须知（临时目录，纯英文路径，免得 Compress-Archive 踩中文坑）
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'aam-zip-'));
  const exeName = path.basename(portable);
  await fsp.copyFile(portable, path.join(stage, exeName));
  await fsp.writeFile(path.join(stage, '装机须知.txt'), readmeText(version), 'utf8');

  const zipName = `AI产出管家-${version}-免安装.zip`;
  const zipOut = path.join(DIST, zipName);
  if (fs.existsSync(zipOut)) await fsp.unlink(zipOut);

  // 路径一律走环境变量传给 PowerShell：-Command + param() 绑不上值（实测 $src 为 null），
  // 而把中文路径拼进命令字符串又要操心中引号。env 两条坑都不踩。
  const psEnv = (extra) => ({ ...process.env, ...extra });
  // 压缩用 .NET 的 CreateFromDirectory（流式、不逐个开文件句柄）。
  // 为什么带重试：刚拷出来的 100MB exe 会被 Defender 抓住扫，Compress-Archive 直接
  // 报「文件正由另一进程使用」并产出半截 zip——上一轮就差点把只有须知没有 exe 的包发出去。
  // 所以这里重试，并且失败即删半截 zip，绝不让残缺产物留在盘上。
  const compressCmd =
    "$src=$env:AAM_SRC; $dst=$env:AAM_DST;" +
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;" +
    "[System.IO.Compression.ZipFile]::CreateFromDirectory($src,$dst,[System.IO.Compression.CompressionLevel]::Optimal,$false)";
  let zipped = false;
  let lastErr = '';
  for (let attempt = 1; attempt <= 4 && !zipped; attempt += 1) {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', compressCmd
      ], { stdio: 'pipe', env: psEnv({ AAM_SRC: stage, AAM_DST: zipOut }) });
      zipped = fs.existsSync(zipOut);
    } catch (e) {
      lastErr = String(e.stderr || e.message || e).slice(0, 200).replace(/\s+/g, ' ');
    }
    if (!zipped) {
      try { await fsp.unlink(zipOut); } catch { /* 半截 zip 删不掉也继续试 */ }
      if (attempt < 4) {
        console.log(`  第 ${attempt} 次压缩没成就（文件被占用是常态），3 秒后重试…`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  if (!zipped) {
    console.error(`✗ 压缩四次都没成功，最后一段报错：${lastErr}`);
    process.exit(1);
  }

  // 2) 把 zip 解回临时目录，逐字节核对里面那个 exe 就是刚构建的这个。
  //    为什么不列文件名比字符串：控制台编码会把中文名变成乱码，比对结果不可信；
  //    而「解出来的 exe 与源文件同哈希」这条判据跟文件名无关，中文名照样验得实。
  const verify = await fsp.mkdtemp(path.join(os.tmpdir(), 'aam-verify-'));
  const expandCmd =
    "$zip=$env:AAM_ZIP; $out=$env:AAM_OUT;" +
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;" +
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($zip,$out)";
  let unzipped = false;
  for (let attempt = 1; attempt <= 3 && !unzipped; attempt += 1) {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', expandCmd
      ], { stdio: 'pipe', env: psEnv({ AAM_ZIP: zipOut, AAM_OUT: verify }) });
      unzipped = fs.readdirSync(verify).length > 0;
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!unzipped) {
    console.error('✗ zip 解不开（写出去的那一步没成，包本身不可信），已中止');
    process.exit(1);
  }

  const back = fs.readdirSync(verify);
  const backExe = back.find((f) => f.toLowerCase().endsWith('.exe'));
  const hasReadme = back.includes('装机须知.txt');
  console.log(`  zip 解出 ${back.length} 个文件：${back.join(' / ')}`);
  if (!backExe || sha256(path.join(verify, backExe)) !== sha256(portable)) {
    console.error('✗ zip 里的 exe 与本次构建的 portable 不一致，已中止（八成是打到了旧包）');
    process.exit(1);
  }
  if (!hasReadme) {
    console.error('✗ zip 里没有「装机须知.txt」，用户拿到的是裸 exe，已中止');
    process.exit(1);
  }
  if (back.length !== 2) {
    console.error(`✗ zip 里应有 2 个文件（exe + 须知），实际 ${back.length} 个：${back.join(', ')}`);
    process.exit(1);
  }
  await fsp.rm(verify, { recursive: true, force: true });

  // 3) 拷进 release + 写校验和
  await fsp.mkdir(RELEASE, { recursive: true });
  const items = [[zipOut, zipName], [portable, path.basename(portable)]];
  if (fs.existsSync(setup)) items.push([setup, path.basename(setup)]);

  const lines = [`# AI产出管家 ${version} 产物校验（SHA-256）`, `# 生成时间：${new Date().toISOString()}`, ''];
  for (const [src, name] of items) {
    const dst = path.join(RELEASE, name);
    await fsp.copyFile(src, dst);
    const h = sha256(dst);
    const mb = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
    lines.push(`${h}  ${name}  (${mb} MB)`);
    console.log(`  ✓ ${name}  ${mb} MB`);
    console.log(`      ${h}`);
  }
  await fsp.writeFile(path.join(RELEASE, 'SHA256SUMS.txt'), lines.join('\r\n') + '\r\n', 'utf8');
  await fsp.rm(stage, { recursive: true, force: true });

  console.log(`\n=== 结果 === 发布包与校验和已落到 release/ ✅`);
})().catch((e) => {
  console.error('发布包脚本自身炸了：', e);
  process.exit(1);
});
