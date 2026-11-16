'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, Tray, nativeImage } = require('electron');
const path = require('path');
const fsSync = require('fs');
const fsp = fsSync.promises;
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const scanner = require('./src/scanner');
const classifier = require('./src/classifier');
const dedupe = require('./src/dedupe');
const archiver = require('./src/archiver');
const exporter = require('./src/exporter');
const ai = require('./src/ai');
const { ConfigStore } = require('./src/config-store');
const { OverridesStore } = require('./src/overrides');
const tidy = require('./src/tidy');
const { Stash } = require('./src/stash');
const { findVersionChains } = require('./src/versionchain');
const tiers = require('./src/tiers');
const digest = require('./src/digest');
const { AdviceCache, judgeBatch, cacheKey } = require('./src/ai-advice');
const { createMcpHttpServer } = require('./src/mcp-http');
const diskScan = require('./src/disk-scan');
const diskClassify = require('./src/disk-classify');
const { safeFileName } = require('./src/safe-path');
const { sourceLabel } = require('./src/source-label');

const APP_NAME = 'AI产出管家';
const VERSION = require('./package.json').version;

let mainWindow = null;
let configStore = null;
let overridesStore = null;
let adviceCache = null;
let stashStore = null; // 回收箱（三档责任·第三档），init 里建
let adviseAbort = false;
let mcpServer = null;
let lastScan = null;
let autoScanDir = null;
let scanAbort = false;
let tray = null; // v0.8 M3：托盘常驻周报，e2e 下不建
let quitting = false; // 只有托盘菜单/真正退出动作才置真，关窗口≠退出
// 回归/截图判定：argv 走 _test/ 的（e2e、run_watch…）和自设 AI_AM_E2E 的（截图脚本）都不许偷偷自动全盘扫
const isE2E =
  (process.argv[1] && String(process.argv[1]).includes('_test')) || process.env.AI_AM_E2E === '1';

/** portable 版启动时 process.execPath 指向临时解压目录，必须拿真实 exe 路径 */
function appExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

/** API 密钥用系统密钥库（Windows DPAPI）加密后落盘，明文只在内存里出现 */
function encryptSecret(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(String(plain)).toString('base64')}`;
    }
  } catch {
    /* 系统密钥库不可用时退回明文 */
  }
  return String(plain);
}

function decryptSecret(stored) {
  if (!stored) return '';
  const s = String(stored);
  if (!s.startsWith('enc:')) return s;
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  } catch {
    return '';
  }
}

function aiConfigPlain() {
  const ai = configStore.get().ai;
  return { ...ai, apiKey: decryptSecret(ai.apiKey) };
}

// portable 版：配置放在 exe 同目录，跟着 U 盘/文件夹走（目录不可写时回退默认）
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'AI产出管家数据'));
  } catch {
    /* 只读目录就退回默认 AppData */
  }
}

function parseScanArg(argv) {
  const i = argv.indexOf('--scan');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith('--scan='));
  return pref ? pref.slice('--scan='.length) : null;
}

// ---------- MCP stdio 模式（由 Cursor / Claude Desktop 拉起，不建窗口） ----------
if (process.argv.includes('--mcp-stdio')) {
  const idx = process.argv.indexOf('--mcp-stdio');
  if (process.argv[idx + 1]) process.env.AI_ARTIFACT_INDEX = process.argv[idx + 1];
  require('./src/mcp-stdio.js');
  return;
}

function sendProgress(phase, done, total) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scan:progress', { phase, done, total });
  }
}

function sendAutoScan(dir) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:autoScan', dir);
  }
}

function toPublic(scan) {
  if (!scan) return null;
  return {
    root: scan.root,
    roots: scan.roots || [scan.root],
    scannedAt: scan.scannedAt,
    durationMs: scan.durationMs,
    truncated: scan.truncated,
    summary: scan.summary,
    errors: (scan.errors || []).slice(0, 50),
    files: scan.files.map((f) => ({
      id: f.id,
      path: f.path,
      name: f.name,
      ext: f.ext,
      size: f.size,
      mtime: f.mtime,
      chars: f.chars,
      lines: f.lines,
      source: f.source,
      category: f.category,
      duplicate: f.duplicate,
      inProject: !!f.inProject,
      mine: !!f.mine,
      aiAdvice: f.aiAdvice || null,
      aiSummary: f.aiSummary || ''
    }))
  };
}

function findFile(filePath) {
  if (!lastScan) return null;
  return lastScan.files.find((f) => path.resolve(f.path) === path.resolve(filePath)) || null;
}

function pickFiles(paths) {
  if (!Array.isArray(paths) || !paths.length) return [];
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (lastScan ? lastScan.files : []).filter((f) => set.has(path.resolve(f.path)));
}

/**
 * 系统回收站是否被组策略禁用。
 * 禁用时 Windows 会把「删除」当成永久删除，那样就没有后悔药了，
 * 所以这种情况管家直接拒绝执行，绝不自己造一个删除路径。
 */
let recycleDisabledCache = null;
function recycleBinDisabled() {
  if (recycleDisabledCache !== null) return recycleDisabledCache;
  recycleDisabledCache = false;
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'NoRecycleFiles'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (/NoRecycleFiles\s+REG_DWORD\s+0x1/i.test(out)) {
        recycleDisabledCache = true;
        break;
      }
    } catch {
      /* 键不存在 = 没有禁用 */
    }
  }
  return recycleDisabledCache;
}

/** 清理记录：只记「我删过什么、原来在哪」，方便用户回头找，不存文件本体 */
function trashLogPath() {
  return path.join(app.getPath('userData'), 'trash-log.json');
}

async function appendTrashLog(items) {
  const file = trashLogPath();
  let log = [];
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) log = parsed;
  } catch {
    log = [];
  }
  log.unshift({
    at: Date.now(),
    files: items.map((i) => ({ path: i.path, name: i.name, size: i.size || 0 }))
  });
  try {
    await fsp.writeFile(file, JSON.stringify(log.slice(0, 30), null, 2), 'utf8');
  } catch {
    /* 记录写不进去不影响文件已经进了回收站 */
  }
}

/** 归档批次清单：记下「从哪搬到哪」，支持一键撤销。只记路径，不存文件本体 */
function archiveManifestPath() {
  return path.join(app.getPath('userData'), 'archive-manifests.json');
}

async function loadArchiveManifests() {
  try {
    const raw = await fsp.readFile(archiveManifestPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendArchiveManifest(batch) {
  if (!batch || !batch.items || !batch.items.length) return;
  const list = await loadArchiveManifests();
  list.unshift(batch);
  try {
    const tmp = `${archiveManifestPath()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list.slice(0, 30), null, 2), 'utf8');
    await fsp.rename(tmp, archiveManifestPath());
  } catch {
    /* 记录写不进去不影响文件已经归档 */
  }
}

/**
 * v0.8 M3 本地事件流水（月报的「放回」账本）。
 * 回收箱放回后条目会从索引里消失，没有别的地方留痕，所以放这一本只追加的账：
 * 全部落在本机 userData，永不上传（零遥测写死在关于页）。
 */
function digestEventsPath() {
  return path.join(app.getPath('userData'), 'digest-events.json');
}

async function loadDigestEvents() {
  try {
    const raw = await fsp.readFile(digestEventsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendDigestEvent(ev) {
  if (!ev || !ev.kind) return;
  const list = await loadDigestEvents();
  list.unshift({ at: Date.now(), kind: ev.kind, count: Number(ev.count) || 0 });
  try {
    const tmp = `${digestEventsPath()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list.slice(0, 500), null, 2), 'utf8');
    await fsp.rename(tmp, digestEventsPath());
  } catch {
    /* 记不上账不影响文件已经放好 */
  }
}

/**
 * 把一批文件送进 Windows 系统回收站——和用户自己右键删除完全一样。
 * 用户能在系统回收站里右键「还原」，也能自己清空，管家不另建任何文件夹。
 */
async function trashFiles(files) {
  if (recycleBinDisabled()) {
    throw new Error(
      '这台电脑被设置成了「删除时不进回收站」，删掉就真找不回来了。为了安全，管家不做这个操作。'
    );
  }
  const result = { ok: 0, failed: [], skipped: [], done: [], mode: 'system' };
  for (const file of files) {
    try {
      await shell.trashItem(file.path);
      result.ok += 1;
      result.done.push({ path: file.path, name: file.name, size: file.size || 0 });
    } catch (err) {
      result.failed.push({ path: file.path, error: err.code || err.message });
    }
  }
  if (result.done.length) await appendTrashLog(result.done);
  return result;
}

/* ============ v0.8 M3 托盘常驻：一句话周报，不弹窗不遥测 ============ */

async function computeDigest() {
  let trashLog = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(trashLogPath(), 'utf8'));
    if (Array.isArray(parsed)) trashLog = parsed;
  } catch {
    /* 没记录＝没删过 */
  }
  const manifests = await loadArchiveManifests();
  const events = await loadDigestEvents();
  const week = digest.weeklySummary(lastScan ? lastScan.files : []);
  const stashMoved = stashStore ? stashStore.list() : [];
  const month = digest.monthlyReport({
    stashMoved,
    stashRestored: events.flatMap((ev) =>
      ev && ev.kind === 'stash-restore' ? Array.from({ length: ev.count || 0 }, () => ({ at: ev.at })) : []
    ),
    archived: manifests
      .filter((b) => b && Array.isArray(b.items) && b.items.length && !b.undoneAt)
      .map((b) => ({ at: b.at, count: b.items.length })),
    trashed: trashLog.flatMap((b) =>
      (b && Array.isArray(b.files) ? b.files : []).map((x) => ({ at: b.at, size: x.size || 0 }))
    )
  });
  return { week, month, trayLine: digest.trayLine(week), monthLine: digest.monthLine(month) };
}

/** 托盘 tooltip 刷成最新一句话；没托盘就什么都不做 */
async function refreshTray() {
  if (!tray) return;
  try {
    const d = await computeDigest();
    tray.setToolTip(d.trayLine);
  } catch {
    /* 刷不动就留着上一句 */
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function createTray() {
  if (tray || isE2E) return; // 回归测试不常驻托盘，进程要能干净退出
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    if (img.isEmpty()) return;
    tray = new Tray(img);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${APP_NAME} v${VERSION}`, enabled: false },
        { label: '打开管家', click: showMainWindow },
        { type: 'separator' },
        {
          label: '退出管家',
          click: () => {
            quitting = true;
            app.quit();
          }
        }
      ])
    );
    tray.on('click', showMainWindow);
    refreshTray();
    setInterval(() => {
      refreshTray();
    }, 60 * 60 * 1000); // 每小时兜底刷一次（扫描完成时也会刷）
  } catch {
    /* 这台机器不支持托盘就照常运行，不报错打扰 */
    tray = null;
  }
}

/** 预览/打开/定位只允许操作本次扫描结果里的文件，防止渲染进程传任意路径 */
function assertKnownFile(filePath) {
  const f = findFile(filePath);
  if (!f) throw new Error('这个文件不在本次扫描结果里，先扫描一次');
  return f;
}

/**
 * 全文搜索：按需读文件开头一段，带内存缓存。
 * 「只记得内容不记得文件名」是这个工具最该解决的问题，
 * 所以搜索必须能钻进正文，不能只比文件名。
 */
const textSearchCache = new Map();
const SEARCH_READ_BYTES = 65536; // 只读开头 64KB，正文搜索够用且不拖慢
const SEARCH_CONCURRENCY = 8; // 同时读 8 个，兼顾速度和磁盘
const SEARCH_TIME_BUDGET = 12000; // 12 秒还没搜完就先返回已有结果

async function readSearchText(f) {
  const cached = textSearchCache.get(f.path);
  if (cached && cached.mtime === f.mtime) return cached.text;
  try {
    const fh = await fsp.open(f.path, 'r');
    try {
      const len = Math.min(f.size || SEARCH_READ_BYTES, SEARCH_READ_BYTES);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      let text = buf.subarray(0, bytesRead).toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (textSearchCache.size > 4000) textSearchCache.clear(); // 别无限涨
      textSearchCache.set(f.path, { mtime: f.mtime, text });
      return text;
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/** 截一段包含关键词的上下文，给列表里显示（前面少留点，关键词得能看见） */
function makeSnippet(text, needle) {
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return '';
  const start = Math.max(0, i - 12);
  const end = Math.min(text.length, i + needle.length + 48);
  const piece = text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .replace(/\*\*|__/g, '') // 去 markdown 加粗，片段读起来干净些
    .replace(/^[#>\-\s]+/, '')
    .trim();
  return `${start > 0 ? '…' : ''}${piece}${end < text.length ? '…' : ''}`;
}

/* ---------------- 自动监控：盯着几个文件夹，出现新文件就分好类告诉用户 ---------------- */
// 只发现、只分类、只提示，绝不自己动文件——要不要归档永远由用户决定
const watchState = {
  enabled: false,
  dirs: [],
  watchers: [],
  debounce: new Map(),
  known: new Map(), // path -> `mtime:size`
  recent: [],
  priming: false
};

function watchKey(f) {
  return `${f.mtime}:${f.size}`;
}

async function watchScanOnce(dir) {
  if (!dir) return { added: 0 };
  const cfg = configStore.safe();
  let r;
  try {
    r = await scanner.scan(dir, {
      whitelist: cfg.whitelist,
      maxDepth: cfg.maxDepth || 14,
      maxFiles: 20000
    });
  } catch {
    return { added: 0 };
  }

  const fresh = [];
  for (const f of r.files) {
    const k = watchKey(f);
    const prev = watchState.known.get(f.path);
    watchState.known.set(f.path, k);
    if (prev === undefined) fresh.push(f); // 第一次见到才算新文件
  }
  if (!fresh.length || watchState.priming) return { added: 0 };

  classifier.classifyAll(fresh);
  if (overridesStore) overridesStore.apply(fresh);
  const items = fresh.map((f) => ({
    path: f.path,
    name: f.name,
    size: f.size,
    source: sourceLabel(f.source),
    category: (f.category && f.category.label) || '其他',
    retention: (f.category && f.category.retention) || ''
  }));

  const entry = { at: Date.now(), dir, count: items.length, items: items.slice(0, 30) };
  watchState.recent.unshift(entry);
  watchState.recent = watchState.recent.slice(0, 30);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('watch:found', entry);
  }
  return { added: items.length, entry };
}

async function startWatch(dirs) {
  stopWatch();
  const list = Array.from(new Set((dirs || []).filter((d) => typeof d === 'string' && d.trim())));
  if (!list.length) return { ok: false, error: '先选一个要盯的文件夹' };

  for (const dir of list) {
    try {
      const w = fsSync.watch(dir, { recursive: true }, () => {
        const prev = watchState.debounce.get(dir);
        if (prev) clearTimeout(prev);
        watchState.debounce.set(
          dir,
          setTimeout(() => {
            watchState.debounce.delete(dir);
            watchScanOnce(dir);
          }, 2500)
        );
      });
      watchState.watchers.push(w);
    } catch (err) {
      stopWatch();
      return { ok: false, error: `盯不住「${dir}」：${err.message}` };
    }
  }

  watchState.enabled = true;
  watchState.dirs = list;

  // 先静默扫一遍把现有文件记为已知，免得一开监控就报几百个"新文件"
  watchState.priming = true;
  for (const dir of list) await watchScanOnce(dir);
  watchState.priming = false;

  await configStore.patch({ watch: { enabled: true, dirs: list } });
  return { ok: true, dirs: list };
}

function stopWatch() {
  for (const w of watchState.watchers) {
    try {
      w.close();
    } catch {
      /* 关不掉也不影响 */
    }
  }
  for (const t of watchState.debounce.values()) clearTimeout(t);
  watchState.watchers = [];
  watchState.debounce.clear();
  watchState.enabled = false;
  watchState.dirs = [];
  watchState.known.clear();
}

async function writeIndex() {
  if (!lastScan) return;
  const indexPath = path.join(app.getPath('userData'), 'mcp-index.json');
  const data = {
    root: lastScan.root,
    updatedAt: Date.now(),
    summary: lastScan.summary,
    files: lastScan.files.map((f) => ({
      path: f.path,
      name: f.name,
      ext: f.ext,
      size: f.size,
      mtime: f.mtime,
      chars: f.chars,
      source: f.source,
      category: f.category,
      summary: f.aiSummary || ''
    }))
  };
  const tmp = `${indexPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, indexPath);
}

/** 上次扫描结果落盘：关掉软件再打开还能看到，不用每次重扫 */
async function saveLastScan() {
  if (!lastScan) return;
  const file = path.join(app.getPath('userData'), 'last-scan.json');
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(toPublic(lastScan)), 'utf8');
  await fsp.rename(tmp, file);
}

async function loadLastScan() {
  try {
    const file = path.join(app.getPath('userData'), 'last-scan.json');
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.files)) return null;
    return { ...data, files: data.files.map((f) => ({ ...f, head: '', hash: null })) };
  } catch {
    return null;
  }
}

async function ensureMcp() {
  if (!mcpServer) {
    const cfg = configStore.get();
    let token = (cfg.mcp && cfg.mcp.token) || '';
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      await configStore.patch({ mcp: { token } });
    }
    mcpServer = createMcpHttpServer({
      indexPath: path.join(app.getPath('userData'), 'mcp-index.json'),
      getDefaultArchiveRoot: () => configStore.get().archiveRoot,
      token
    });
  }
  return mcpServer.start(3927);
}

function mcpConfigPayload() {
  const indexPath = path.join(app.getPath('userData'), 'mcp-index.json');
  const archive = configStore.get().archiveRoot || '';
  const token = (configStore.get().mcp && configStore.get().mcp.token) || '';
  const info = mcpServer ? mcpServer.info() : { running: false, port: 0, endpoint: '' };
  const port = info.port || 3927;
  return {
    http: {
      mcpServers: {
        'ai-artifact-manager': {
          url: `http://127.0.0.1:${port}/mcp${token ? `?token=${token}` : ''}`
        }
      }
    },
    stdio: {
      mcpServers: {
        'ai-artifact-manager': {
          command: appExePath(),
          args: ['--mcp-stdio', indexPath, archive],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        }
      }
    },
    indexPath,
    archive
  };
}

function runReg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim()));
      else resolve((stdout || '').toString());
    });
  });
}

function exeCommand() {
  if (app.isPackaged) return `"${appExePath()}"`;
  return `"${process.execPath}" "${app.getAppPath()}"`;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: VERSION,
    userData: app.getPath('userData'),
    electron: process.versions.electron,
    node: process.versions.node,
    homepage: 'https://www.zhiweistudio.com.cn',
    e2e: isE2E // 回归测试里不许偷偷自动全盘扫
  }));

  ipcMain.handle('disks:list', async () => {
    const out = [];
    for (let c = 67; c <= 90; c += 1) {
      const letter = String.fromCharCode(c);
      const root = `${letter}:\\`;
      try {
        await fsp.access(root);
        let total = 0;
        let free = 0;
        try {
          const st = await fsp.statfs(root);
          total = Number(st.bsize) * Number(st.blocks);
          free = Number(st.bsize) * Number(st.bavail);
        } catch {
          /* 取不到容量就只显示盘符 */
        }
        out.push({ letter, root, total, free });
      } catch {
        /* 盘符不存在 */
      }
    }
    return out;
  });

  ipcMain.handle('app:paths', () => ({
    desktop: app.getPath('desktop'),
    downloads: app.getPath('downloads'),
    documents: app.getPath('documents'),
    home: app.getPath('home')
  }));

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要扫描的文件夹',
      properties: ['openDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickSave', async (e, options) => {
    const o = options || {};
    const r = await dialog.showSaveDialog(mainWindow, {
      title: o.title || '保存',
      defaultPath: o.defaultName || 'ai-artifacts',
      filters: o.filters || []
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('config:get', () => {
    const safe = configStore.safe();
    const plain = decryptSecret(configStore.get().ai.apiKey);
    if (safe.ai) {
      safe.ai.hasKey = !!plain;
      safe.ai.apiKeyMasked = plain
        ? plain.length > 8
          ? `${plain.slice(0, 4)}****${plain.slice(-4)}`
          : '****'
        : '';
    }
    return {
      ...safe,
      app: { name: APP_NAME, version: VERSION, homepage: 'https://www.zhiweistudio.com.cn' }
    };
  });

  ipcMain.handle('config:patch', async (e, patch) => {
    await configStore.patch(patch || {});
    return configStore.safe();
  });

  ipcMain.handle('scan:start', async (e, payload) => {
    const p = payload || {};
    const roots = (Array.isArray(p.roots) && p.roots.length ? p.roots : [p.root]).filter(Boolean);
    if (!roots.length) throw new Error('请先选择要扫描的位置');

    const cfg = configStore.get();
    sendProgress('scanning', 0, 0);
    scanAbort = false;

    // 归档目录永远不参与扫描，否则整理完再扫一遍会把自己归档的文件重新扫出来
    const whitelist = (Array.isArray(p.whitelist) ? p.whitelist : cfg.whitelist || []).slice();
    if (cfg.archiveRoot) whitelist.push({ type: 'path', value: cfg.archiveRoot });

    const merged = [];
    const errors = [];
    let truncated = false;
    let cancelled = false;
    let durationMs = 0;
    let scannedAt = Date.now();

    for (const root of roots) {
      const r = await scanner.scan(root, {
        whitelist,
        maxDepth: p.maxDepth || cfg.maxDepth,
        maxFiles: p.maxFiles || cfg.maxFiles,
        includeExt: Array.isArray(p.includeExt) ? p.includeExt : cfg.includeExt,
        excludeExt: Array.isArray(p.excludeExt) ? p.excludeExt : cfg.excludeExt,
        onProgress: (n) => sendProgress('scanning', n, 0),
        shouldStop: () => scanAbort
      });
      merged.push(...r.files);
      errors.push(...r.errors);
      truncated = truncated || r.truncated;
      cancelled = cancelled || r.cancelled;
      durationMs += r.durationMs;
      scannedAt = r.scannedAt || scannedAt;
      if (cancelled) break;
    }

    // 多根之间可能有重叠（比如同时选了桌面和用户目录），按路径去重
    const seen = new Set();
    const files = [];
    for (const f of merged) {
      const key = path.resolve(f.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(f);
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < files.length; i += 1) files[i].id = `f${i}`;

    sendProgress('classifying', files.length, files.length);
    classifier.classifyAll(files);

    sendProgress('deduping', 0, files.length);
    let dupe = { groups: [], stats: { groups: 0, exactFiles: 0, similarFiles: 0, freeableSize: 0 } };
    try {
      dupe = await dedupe.detect(files);
    } catch (err) {
      dupe.stats.error = err.message;
    }

    for (const f of files) {
      if (f.duplicate && f.duplicate.isDuplicate) {
        f.category = classifier.applyDuplicate(f, f.duplicate);
      }
    }

    // 人工/AI 复核过的判定盖回去（含「这是我写的」负样本）——重扫不抹，别让用户反复兜底
    if (overridesStore) overridesStore.apply(files);
    // AI 建议按哈希认亲：内容没变，上次的建议直接带回来，不重问模型
    if (adviceCache) {
      for (const f of files) {
        const hit = adviceCache.get(cacheKey(f));
        if (hit) f.aiAdvice = { ...hit, fromCache: true };
      }
    }

    const summary = classifier.summarize(files);
    summary.duplicateStats = dupe.stats;
    summary.cancelled = cancelled;
    summary.groups = dupe.groups.map((g) => ({
      kind: g.kind,
      similarity: g.similarity,
      keeperName: g.keeperName,
      keeperPath: g.keeperPath,
      count: g.members.length,
      size: g.members.reduce((s, m) => s + (m.size || 0), 0)
    }));

    lastScan = {
      root: roots.join('  +  '),
      roots,
      scannedAt,
      durationMs,
      truncated,
      files,
      errors,
      summary
    };

    await writeIndex();
    await saveLastScan();
    sendProgress('done', files.length, files.length);
    refreshTray(); // v0.8 M3：扫完顺手把托盘那句周报刷成最新的
    return toPublic(lastScan);
  });

  ipcMain.handle('scan:last', async () => {
    if (!lastScan) {
      const cached = await loadLastScan();
      if (cached) lastScan = cached;
    }
    return toPublic(lastScan);
  });

  ipcMain.handle('scan:cancel', () => {
    scanAbort = true;
    return true;
  });

  // 全文搜索：只搜文本类文件，最多跑 12 秒，没搜完也先返回已找到的
  ipcMain.handle('search:content', async (e, payload) => {
    const q = String((payload && payload.q) || '').trim();
    if (q.length < 2) return { ok: true, hits: [], scanned: 0, elapsed: 0, partial: false };
    if (!lastScan) return { ok: false, error: '还没有扫描结果' };

    const needle = q.toLowerCase();
    const files = lastScan.files.filter((f) => scanner.TEXT_EXT.has(f.ext));
    const hits = [];
    let cursor = 0;
    let partial = false;
    const started = Date.now();

    async function worker() {
      while (cursor < files.length) {
        if (Date.now() - started > SEARCH_TIME_BUDGET) {
          partial = true;
          return;
        }
        const f = files[cursor];
        cursor += 1;
        const text = await readSearchText(f);
        if (!text) continue;
        const lower = text.toLowerCase();
        if (!lower.includes(needle)) continue;
        let count = 0;
        let idx = 0;
        for (;;) {
          idx = lower.indexOf(needle, idx);
          if (idx === -1) break;
          count += 1;
          idx += needle.length;
        }
        hits.push({ path: f.path, count, snippet: makeSnippet(text, needle) });
      }
    }

    await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, files.length) }, worker));
    return { ok: true, hits, scanned: files.length, elapsed: Date.now() - started, partial };
  });

  // ---------- 自动监控 ----------
  ipcMain.handle('watch:start', async (e, dirs) => startWatch(dirs));
  ipcMain.handle('watch:stop', async () => {
    stopWatch();
    await configStore.patch({ watch: { enabled: false, dirs: [] } });
    return { ok: true };
  });
  ipcMain.handle('watch:status', () => ({
    enabled: watchState.enabled,
    dirs: watchState.dirs,
    recent: watchState.recent
  }));
  ipcMain.handle('watch:scanNow', async (e, dir) => {
    const target = dir || watchState.dirs[0];
    if (!target) return { ok: false, error: '还没设置要盯的文件夹' };
    const r = await watchScanOnce(target);
    return { ok: true, added: r.added || 0 };
  });
  ipcMain.handle('watch:pickDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    return { ok: true, dir: r.filePaths[0] };
  });

  ipcMain.handle('file:preview', async (e, filePath) => {
    try {
      assertKnownFile(filePath);
      const stat = await fsp.stat(filePath);
      if (stat.size > 2 * 1024 * 1024) {
        return { ok: false, error: '文件超过 2MB，暂不预览。可点「打开」用系统软件查看。' };
      }
      const buf = await fsp.readFile(filePath);
      if (buf.includes(0)) {
        return { ok: false, error: '看起来是二进制文件，暂不支持预览。' };
      }
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return { ok: true, text: text.slice(0, 300000), truncated: text.length > 300000, size: stat.size };
    } catch (err) {
      return { ok: false, error: `读取失败：${err.code || err.message}` };
    }
  });

  ipcMain.handle('file:open', (e, filePath) => {
    assertKnownFile(filePath);
    return shell.openPath(filePath);
  });
  ipcMain.handle('file:reveal', (e, filePath) => {
    assertKnownFile(filePath);
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('file:rename', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const name = safeFileName(payload && payload.name, f.ext);
    if (!name) throw new Error('新文件名不合法');
    const target = path.join(path.dirname(f.path), name);
    if (path.resolve(target) === path.resolve(f.path)) {
      return { ok: true, path: f.path, name: f.name, unchanged: true };
    }
    try {
      await fsp.access(target);
      throw new Error('同目录已经有同名文件，换一个名字');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await fsp.rename(f.path, target);
    f.path = target;
    f.name = name;
    f.ext = path.extname(name).toLowerCase();
    await writeIndex();
    await saveLastScan();
    return { ok: true, path: target, name };
  });

  const AI_CATEGORY = {
    knowledge: { key: 'knowledge', group: 'knowledge', label: '知识库沉淀', retention: '建议长期留存', reason: 'AI 复核后归入知识库' },
    'tool-common': { key: 'tool-common', group: 'tool', label: '常用工具', retention: '建议留存到工具库', reason: 'AI 复核后归入常用工具' },
    'tool-onetime': { key: 'tool-onetime', group: 'tool', label: '一次性脚本', retention: '可归档或清理', reason: 'AI 复核后归入一次性脚本' },
    junk: { key: 'junk', group: 'junk', label: '冗余可删', retention: '建议清理', reason: 'AI 复核后建议清理' }
  };

  ipcMain.handle('ai:applyCategory', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const base = AI_CATEGORY[payload && payload.category];
    if (!base) throw new Error('未知分类');
    f.category = { ...base, tags: (f.category && f.category.tags) || [], confidence: 'high', by: 'ai' };
    if (overridesStore) await overridesStore.setCategory(f.path, f.hash, f.category, 'ai');
    await writeIndex();
    await saveLastScan();
    return { ok: true, category: f.category };
  });

  /**
   * 「这是我写的」负样本：用户一句话，工具永远不再自动碰这个文件。
   * 按路径+哈希持久化，改名/重扫都认得（见 src/overrides.js）。
   */
  ipcMain.handle('file:markMine', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const on = !(payload && payload.mine === false);
    f.mine = on;
    if (overridesStore) await overridesStore.setMine(f.path, f.hash, on);
    await saveLastScan();
    return { ok: true, mine: on };
  });

  ipcMain.handle('ai:applyTags', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const tags = Array.isArray(payload && payload.tags)
      ? payload.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
      : [];
    if (!f.category) {
      f.category = { key: 'other', group: 'other', label: '其他文件', retention: '按需留存', reason: '', tags: [] };
    }
    f.category.tags = tags;
    await writeIndex();
    await saveLastScan();
    return { ok: true, tags };
  });

  /**
   * AI 批量建议：只往 aiAdvice 字段写建议，绝不改分类、更不动文件。
   * 哈希缓存+分批+可取消，本地小模型也跑得动；没配 AI 时界面不显示这个入口。
   */
  ipcMain.handle('ai:advise', async (e, payload) => {
    if (!lastScan) throw new Error('还没有扫描结果');
    const cfg = aiConfigPlain();
    if (!cfg.baseUrl) throw new Error('先在设置里配置 AI（本机 Ollama / LM Studio 或兼容接口）');
    const p = payload || {};
    const files = Array.isArray(p.paths) && p.paths.length ? pickFiles(p.paths) : lastScan.files;
    if (!files.length) throw new Error('没有可判定的文件');
    adviseAbort = false;
    const adviceOut = [];
    const r = await judgeBatch(cfg, files, {
      cache: adviceCache,
      shouldStop: () => adviseAbort,
      onItem: ({ done, total, file }) => {
        adviceOut.push({ path: file.path, advice: file.aiAdvice });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ai:adviceProgress', { done, total, path: file.path });
        }
      }
    });
    await saveLastScan();
    return { ...r, advice: adviceOut };
  });

  ipcMain.handle('ai:adviseCancel', () => {
    adviseAbort = true;
    return true;
  });

  // 打开 Windows 自己的回收站，还原/清空都在系统里做，管家不插手
  ipcMain.handle('trash:open', async () => {
    const msg = await shell.openPath('shell:RecycleBinFolder');
    if (msg) throw new Error(`打不开回收站：${msg}`);
    return true;
  });

  ipcMain.handle('trash:list', async () => {
    try {
      const raw = await fsp.readFile(trashLogPath(), 'utf8');
      const log = JSON.parse(raw);
      return Array.isArray(log) ? log : [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('trash:clearLog', async () => {
    try {
      await fsp.unlink(trashLogPath());
    } catch {
      /* 没有就算了 */
    }
    return true;
  });

  /** 项目内代码只盘点不搬删：所有移动/删除入口共用的硬闸 */  function splitProjectGuard(files) {
    const allowed = [];
    const skipped = [];
    for (const f of files) {
      if (f.inProject) skipped.push({ path: f.path, reason: '项目内代码只盘点不搬删（搬走会断掉项目依赖）' });
      else allowed.push(f);
    }
    return { allowed, skipped };
  }

  ipcMain.handle('archive:run', async (e, payload) => {
    const p = payload || {};
    const picked = pickFiles(p.paths);
    if (!picked.length) throw new Error('没有选中任何文件');
    const root = p.targetDir || configStore.get().archiveRoot;
    if (!root) throw new Error('请先设置归档目录（设置 → 默认归档路径）');
    const { allowed, skipped } = splitProjectGuard(picked);
    if (!allowed.length) return { ok: 0, failed: [], skipped, done: [], target: root, mode: 'move', byDir: {} };
    // 本产品没有复制归档：整理=移动，防止越清越多
    const r = await archiver.archive(allowed, root);
    r.skipped = [...skipped, ...r.skipped];
    // 批次清单：从哪搬到哪，支持「撤销上次归档」
    await appendArchiveManifest({
      at: Date.now(),
      root,
      items: r.done.map((d) => ({ from: d.path, to: d.target, name: path.basename(d.path) }))
    });
    if (r.done.length) await appendDigestEvent({ kind: 'archive', count: r.done.length });
    return r;
  });

  /** 撤销最近一次归档：把整批搬回原位置（原位置被占就加序号，绝不覆盖） */
  ipcMain.handle('archive:undo', async () => {
    const list = await loadArchiveManifests();
    const idx = list.findIndex((b) => b && Array.isArray(b.items) && b.items.length && !b.undoneAt);
    if (idx < 0) return { ok: 0, failed: [], skipped: [], done: [], empty: true };
    const batch = list[idx];
    const r = await archiver.restoreArchived(batch.items);
    batch.undoneAt = Date.now();
    batch.restored = r.ok;
    try {
      const tmp = `${archiveManifestPath()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(list.slice(0, 30), null, 2), 'utf8');
      await fsp.rename(tmp, archiveManifestPath());
    } catch {
      /* 标记失败不影响文件已还原 */
    }
    return r;
  });

  ipcMain.handle('duplicate:remove', async (e, payload) => {
    const p = payload || {};
    const picked = pickFiles(p.paths).filter(
      (f) =>
        f.duplicate &&
        f.duplicate.isDuplicate &&
        !(f.duplicate.withPath && path.resolve(f.path) === path.resolve(f.duplicate.withPath))
    );
    const { allowed, skipped } = splitProjectGuard(picked);
    if (!allowed.length) return { ok: 0, failed: [], skipped: skipped.length ? skipped : [{ reason: '没有可删除的重复文件' }], done: [] };
    const r = await trashFiles(allowed);
    r.skipped = [...skipped, ...r.skipped];
    return r;
  });

  ipcMain.handle('cleanup:trash', async (e, payload) => {
    const p = payload || {};
    const picked = pickFiles(p.paths);
    if (!picked.length) return { ok: 0, failed: [], skipped: [], done: [] };
    // 手动勾选是用户的明确决定，来源闸不拦；但项目内代码照样硬保护
    const { allowed, skipped } = splitProjectGuard(picked);
    if (!allowed.length) return { ok: 0, failed: [], skipped, done: [] };
    const r = await trashFiles(allowed);
    r.skipped = [...skipped, ...r.skipped];
    return r;
  });

  /**
   * 一键整理预案：主进程算，渲染进程只负责展示和确认。
   * 来源闸+置信分级见 src/tidy.js；待确认桶只能用户手动勾。
   */
  ipcMain.handle('tidy:plan', async () => {
    if (!lastScan) throw new Error('还没有扫描结果');
    const cfg = configStore.get();
    const aiOnly = !cfg.tidy || cfg.tidy.aiOnly !== false;
    return tidy.buildPlan(lastScan.files, { aiOnly });
  });

  /**
   * 执行整理。渲染进程把用户确认过的清单传回来，这里逐条重新过闸——
   * 就算界面被绕过，主进程也不会自动碰未识别/低置信/项目内/我写的文件。
   */
  ipcMain.handle('tidy:run', async (e, payload) => {
    const p = payload || {};
    if (!lastScan) throw new Error('还没有扫描结果');
    const cfg = configStore.get();
    const aiOnly = !cfg.tidy || cfg.tidy.aiOnly !== false;
    const root = p.targetDir || cfg.archiveRoot;

    const revalidate = (paths, wantAction) => {
      const okFiles = [];
      const skipped = [];
      for (const f of pickFiles(paths)) {
        if (tidy.actionFor(f) !== wantAction) {
          skipped.push({ path: f.path, reason: '分类已变化，请重新生成预案' });
          continue;
        }
        const gate = tidy.autoEligible(f, aiOnly);
        if (!gate.ok) {
          skipped.push({ path: f.path, reason: `安全闸拦截（${gate.why}）` });
          continue;
        }
        okFiles.push(f);
      }
      return { okFiles, skipped };
    };

    const keep = revalidate(p.keepPaths, 'keep');
    const trash = revalidate(p.trashPaths, 'trash');
    const out = { archived: 0, trashed: 0, failed: [], skipped: [...keep.skipped, ...trash.skipped], done: [] };

    if (keep.okFiles.length) {
      if (!root) throw new Error('请先设置归档目录（设置 → 默认归档路径）');
      const r = await archiver.archive(keep.okFiles, root);
      out.archived = r.ok;
      out.failed.push(...r.failed);
      out.skipped.push(...r.skipped);
      out.done.push(...r.done);
      await appendArchiveManifest({
        at: Date.now(),
        root,
        items: r.done.map((d) => ({ from: d.path, to: d.target, name: path.basename(d.path) }))
      });
    }
    if (trash.okFiles.length) {
      const r = await trashFiles(trash.okFiles);
      out.trashed = r.ok;
      out.failed.push(...r.failed);
      out.skipped.push(...r.skipped);
      out.done.push(...r.done);
    }
    return out;
  });

  /* ============ v0.8 小白模式：三档责任预案与执行（见 src/tiers.js） ============ */

  const slim = (f) => ({
    id: f.id,
    path: f.path,
    name: f.name,
    size: f.size,
    mtime: f.mtime,
    withPath: f.duplicate ? f.duplicate.withPath : undefined,
    family: f.family,
    dir: path.dirname(f.path)
  });

  /** 三档预案：一档静默删的副本 / 二档按组点头的版本卡 / 三档只收不删的回收箱候选 */
  /* ============ v0.9 磁盘体检：先回答「空间去哪了」，再谈删不删 ============ */
  let diskAbort = false;
  let lastDisk = null;

  /** 各盘容量：只读 statfs，不动任何文件 */
  async function diskUsageList() {
    const out = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      try {
        const st = await fsp.statfs(root);
        const total = st.blocks * st.bsize;
        if (!total) continue;
        const free = st.bfree * st.bsize;
        out.push({ letter, root, total, free, used: total - free });
      } catch {
        /* 没这个盘，跳过 */
      }
    }
    return out;
  }

  ipcMain.handle('disk:scan', async (e, payload) => {
    const p = payload || {};
    const root = String(p.root || '').trim();
    if (!root) throw new Error('先选一个盘或文件夹');
    diskAbort = false;
    sendProgress('diskScan', 0, 0);
    const tree = await diskScan.measure(root, {
      maxDepth: Number(p.maxDepth) || 6,
      keepTree: true,
      onProgress: (n) => sendProgress('diskScan', n, 0),
      shouldStop: () => diskAbort
    });
    const grades = diskClassify.collectGrades(tree, { maxDepth: 6 });
    let recycleBin = null;
    if (p.withRecycle !== false) {
      try {
        recycleBin = await diskScan.measureRecycleBin(root);
      } catch {
        recycleBin = null;
      }
    }
    const disks = await diskUsageList();
    lastDisk = {
      root,
      at: Date.now(),
      durationMs: tree.durationMs,
      stopped: !!tree.stopped,
      totalSize: tree.size,
      totalFiles: tree.files,
      grades,
      recycleBin,
      disks
    };
    sendProgress('diskScan', tree.files, tree.files);
    return lastDisk;
  });

  ipcMain.handle('disk:cancel', () => {
    diskAbort = true;
    return { cancelled: true };
  });

  ipcMain.handle('disk:last', () => lastDisk);

  // 体检结果里点一行直接看目录内容。只放行本次体检根目录底下的路径，
  // 界面被绕过也打不开别的地方。
  ipcMain.handle('disk:reveal', async (e, dirPath) => {
    const p = String(dirPath || '').trim();
    if (!p) throw new Error('没有指定目录');
    if (!lastDisk || !lastDisk.root) throw new Error('先做一次体检');
    const root = path.resolve(lastDisk.root);
    const target = path.resolve(p);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (target !== root && !target.startsWith(prefix)) throw new Error('只能打开本次体检范围内的目录');
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });

  // 把体检结果存成一份人能看的 Markdown（用户自己留档、或转给别人看）
  ipcMain.handle('disk:export', async (e, payload) => {
    const text = String((payload && payload.text) || '');
    if (!text) throw new Error('没有可保存的内容');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '保存体检结果',
      defaultPath: `磁盘体检_${new Date().toISOString().slice(0, 10)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }]
    });
    if (r.canceled || !r.filePath) return { saved: false };
    await fsp.writeFile(r.filePath, text, 'utf8');
    return { saved: true, path: r.filePath };
  });

  ipcMain.handle('tier:plan', async () => {
    if (!lastScan) throw new Error('还没有扫描结果');
    const plan = tiers.buildTierPlan(lastScan.files);
    return {
      silentDupes: plan.silentDupes.map(slim),
      chains: plan.chains.map((c) => ({
        family: c.family,
        ext: c.ext,
        memberCount: c.members.length,
        keeper: slim(c.keeper),
        older: c.older.map(slim)
      })),
      stash: plan.stash.map(slim),
      stats: plan.stats,
      stashStats: stashStore ? stashStore.stats() : { count: 0, size: 0 }
    };
  });

  /**
   * 执行三档。payload.approvedChains＝用户点头过的版本卡组（按 family+ext 认，主进程重算防篡改）。
   * 规矩：一档删进系统回收站（正本还在才删）；二档只删被点头组的旧版本；三档搬进回收箱不销毁。
   * 逐条重新过闸——界面被绕过也碰不到未识别/项目内/我写的文件。
   */
  ipcMain.handle('tier:run', async (e, payload) => {
    const p = payload || {};
    if (!lastScan) throw new Error('还没有扫描结果');
    const approved = new Set((p.approvedChains || []).map((k) => String(k)));
    const plan = tiers.buildTierPlan(lastScan.files);
    const out = {
      dupTrashed: 0,
      chainTrashed: 0,
      stashed: 0,
      failed: [],
      skipped: [],
      done: []
    };

    // 第一档：静默删，但必须当场复核「正本此刻还在」——预案生成后正本被人删了，副本就不再冗余
    const dupTargets = [];
    for (const f of plan.silentDupes) {
      const keeperPath = f.duplicate && f.duplicate.withPath;
      if (!keeperPath || !fsSync.existsSync(keeperPath)) {
        out.skipped.push({ path: f.path, reason: '正本已经不在了，副本不敢当冗余删' });
        continue;
      }
      dupTargets.push(f);
    }
    if (dupTargets.length) {
      const r = await trashFiles(dupTargets);
      out.dupTrashed = r.ok;
      out.failed.push(...r.failed.map((x) => ({ ...x, tier: 'dup' })));
      out.skipped.push(...r.skipped);
      out.done.push(...r.done.map((d) => ({ ...d, tier: 'dup' })));
    }

    // 第二档：只处理用户点过头的组；主进程重算认亲结果，按 family|ext 对齐
    const chainFiles = [];
    for (const c of plan.chains) {
      const key = `${c.family}|${c.ext}`;
      if (!approved.has(key)) continue;
      for (const f of c.older) chainFiles.push(f);
    }
    if (chainFiles.length) {
      const guard = splitProjectGuard(chainFiles);
      out.skipped.push(...guard.skipped);
      const r = await trashFiles(guard.allowed);
      out.chainTrashed = r.ok;
      out.failed.push(...r.failed.map((x) => ({ ...x, tier: 'chain' })));
      out.skipped.push(...r.skipped);
      out.done.push(...r.done.map((d) => ({ ...d, tier: 'chain' })));
    }

    // 第三档：搬进回收箱（只搬不毁，项目内/我写的已在预案层挡掉，这里再过一遍项目闸）
    if (plan.stash.length) {
      const guard = splitProjectGuard(plan.stash);
      out.skipped.push(...guard.skipped);
      const sr = await stashStore.stash(guard.allowed.map((f) => ({ path: f.path, hash: f.hash })));
      out.stashed = sr.ok;
      out.failed.push(...sr.failed.map((x) => ({ ...x, tier: 'stash' })));
      for (const m of sr.moved) out.done.push({ path: m.from, name: m.name, tier: 'stash', to: m.to });
    }

    // 从本次扫描结果里摘掉已处理项，界面列表保持真实
    const donePaths = new Set(out.done.map((d) => path.resolve(d.path).toLowerCase()));
    if (donePaths.size) {
      lastScan.files = lastScan.files.filter((f) => !donePaths.has(path.resolve(f.path).toLowerCase()));
      await saveLastScan();
    }
    out.stashStats = stashStore.stats();
    return out;
  });

  /** 回收箱：列表 / 一键放回 / 清空（清空＝用户主动动作，文件进系统回收站） */
  ipcMain.handle('stash:list', async () => {
    if (!stashStore) return { items: [], stats: { count: 0, size: 0 } };
    return { items: stashStore.list(), stats: stashStore.stats() };
  });

  ipcMain.handle('stash:restore', async (e, payload) => {
    const ids = payload && payload.ids;
    const r = await stashStore.restore(Array.isArray(ids) ? ids : undefined);
    if (r.restored.length) {
      // 放回的件重新进本次扫描结果（原位路径），否则用户看着它「消失了」
      const known = new Set(lastScan ? lastScan.files.map((f) => path.resolve(f.path).toLowerCase()) : []);
      for (const it of r.restored) {
        if (known.has(path.resolve(it.to).toLowerCase())) continue;
        try {
          const st = await fsp.stat(it.to);
          if (!lastScan) break;
          lastScan.files.push({
            id: `restored-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            path: it.to,
            name: path.basename(it.to),
            ext: path.extname(it.to).toLowerCase(),
            size: st.size,
            mtime: st.mtimeMs,
            mtimeMs: st.mtimeMs,
            source: { id: 'unknown' },
            category: { key: 'other', group: 'other', label: '其他文件', confidence: 'low' },
            duplicate: null,
            inProject: false,
            mine: false,
            hash: null,
            aiAdvice: null
          });
        } catch {
          /* 放回失败不记账 */
        }
      }
      await saveLastScan();
      // 月报的「放回」只能靠这本账：条目从回收箱索引里消失了，事件流水留着
      await appendDigestEvent({ kind: 'stash-restore', count: r.restored.length });
    }
    return r;
  });

  ipcMain.handle('stash:empty', async () => {
    const pend = stashStore.pendingForRemoval();
    if (!pend.length) return { ok: 0, failed: [], skipped: [] };
    const r = await trashFiles(pend.map((it) => ({ path: it.path, name: it.name })));
    if (r.ok) await stashStore.drop(pend.filter((it) => !r.failed.some((x) => x.path === it.path)).map((it) => it.id));
    return r;
  });

  /** v0.8 M3 小报：周报数字＋月报四个数字＋两句话术，全部现算自本机记录，零上报 */
  ipcMain.handle('digest:get', async () => computeDigest());

  ipcMain.handle('export:run', async (e, payload) => {
    const p = payload || {};
    if (!lastScan) throw new Error('还没有扫描结果');
    const files = p.paths && p.paths.length ? pickFiles(p.paths) : lastScan.files;
    const summary = classifier.summarize(files);
    const out = p.outPath;
    if (!out) throw new Error('请选择保存位置');
    if (p.format === 'md') return exporter.exportMarkdown(out, files, summary);
    return exporter.exportCsv(out, files);
  });

  // ---------- AI ----------
  ipcMain.handle('ai:detectLocal', () => ai.detectLocal());

  ipcMain.handle('ai:save', async (e, cfg) => {
    const cur = configStore.get().ai;
    const next = { ...cur, ...(cfg || {}) };
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'apiKey') && cfg.apiKey !== undefined) {
      next.apiKey = cfg.apiKey ? encryptSecret(cfg.apiKey) : '';
    }
    await configStore.patch({ ai: next });
    return configStore.safe().ai;
  });

  ipcMain.handle('ai:test', async (e, override) => {
    const cfg = { ...aiConfigPlain(), ...(override || {}) };
    const r = await ai.chat(cfg, [{ role: 'user', content: '只回复 OK 两个字母' }], {
      maxTokens: 12,
      timeoutMs: 20000,
      temperature: 0
    });
    return { ok: true, reply: r.content.slice(0, 80), usage: r.usage };
  });

  ipcMain.handle('ai:summarize', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const summary = await ai.summarize(aiConfigPlain(), f);
    f.aiSummary = summary;
    await writeIndex();
    return { path: f.path, summary };
  });

  ipcMain.handle('ai:rename', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const name = await ai.suggestName(aiConfigPlain(), f);
    return { path: f.path, name };
  });

  ipcMain.handle('ai:tags', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const tags = await ai.suggestTags(aiConfigPlain(), f);
    return { path: f.path, tags };
  });

  ipcMain.handle('ai:category', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const key = await ai.suggestCategory(aiConfigPlain(), f);
    return { path: f.path, category: key };
  });

  ipcMain.handle('ai:compare', async (e, payload) => {
    const a = findFile(payload && payload.a);
    const b = findFile(payload && payload.b);
    if (!a || !b) throw new Error('两个文件都要在扫描结果里');
    return ai.compareVersions(aiConfigPlain(), a, b);
  });

  // ---------- MCP ----------
  ipcMain.handle('mcp:info', () => ({
    ...(mcpServer ? mcpServer.info() : { running: false, port: 0, endpoint: '' }),
    config: mcpConfigPayload()
  }));

  ipcMain.handle('mcp:start', async () => {
    const r = await ensureMcp();
    await configStore.patch({ mcp: { enabled: true } });
    return {
      ...mcpServer.info(),
      ...r,
      config: mcpConfigPayload()
    };
  });

  ipcMain.handle('mcp:stop', async () => {
    if (mcpServer) await mcpServer.stop();
    await configStore.patch({ mcp: { enabled: false } });
    return { running: false, port: 0, endpoint: '', config: mcpConfigPayload() };
  });

  ipcMain.handle('mcp:config', () => mcpConfigPayload());

  // ---------- Windows 右键菜单 ----------
  ipcMain.handle('contextmenu:status', async () => {
    try {
      await runReg(['query', 'HKCU\\Software\\Classes\\Directory\\shell\\AIArtifactManager', '/ve']);
      return { installed: true };
    } catch {
      return { installed: false };
    }
  });

  ipcMain.handle('contextmenu:install', async () => {
    const key = 'HKCU\\Software\\Classes\\Directory\\shell\\AIArtifactManager';
    await runReg(['add', key, '/ve', '/d', '用 AI产出管家 扫描', '/f']);
    await runReg(['add', key, '/v', 'Icon', '/d', `${appExePath()},0`, '/f']);
    await runReg(['add', `${key}\\command`, '/ve', '/d', `${exeCommand()} --scan "%1"`, '/f']);
    return { installed: true };
  });

  ipcMain.handle('contextmenu:uninstall', async () => {
    try {
      await runReg(['delete', 'HKCU\\Software\\Classes\\Directory\\shell\\AIArtifactManager', '/f']);
    } catch {
      /* 本来就没装 */
    }
    return { installed: false };
  });

  ipcMain.handle('shell:openUrl', async (e, url) => {
    if (/^https?:\/\//i.test(String(url || ''))) await shell.openExternal(url);
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#f4f6fb',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (autoScanDir) {
      const dir = autoScanDir;
      autoScanDir = null;
      setTimeout(() => sendAutoScan(dir), 600);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  // 仅回归测试用：AI_AM_SHOT 指定路径时，加载完自动截图并退出
  if (process.env.AI_AM_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const action = process.env.AI_AM_SHOT_ACTION;
          // 截图专用：强制界面语言，不受本机上次选择影响
          if (process.env.AI_AM_SHOT_LANG) {
            await mainWindow.webContents.executeJavaScript(
              `typeof setLang === 'function' && setLang(${JSON.stringify(process.env.AI_AM_SHOT_LANG)}); true`
            );
            await new Promise((r) => setTimeout(r, 900));
          }
          // 截图专用：收起首次使用提示，让画面干净
          if (process.env.AI_AM_SHOT_CLEAN) {
            await mainWindow.webContents.executeJavaScript(
              "(() => { const b = document.querySelector('#btnOnboardOk'); if (b && b.offsetParent) b.click(); return true; })()"
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          if (action === 'select') {
            await mainWindow.webContents.executeJavaScript("document.querySelector('.file-row') && document.querySelector('.file-row').click(); true");
            await new Promise((r) => setTimeout(r, 1400));
          } else if (action === 'settings') {
            await mainWindow.webContents.executeJavaScript("document.querySelector('#btnSettings') && document.querySelector('#btnSettings').click(); true");
            await new Promise((r) => setTimeout(r, 600));
          } else if (action === 'ai') {
            await mainWindow.webContents.executeJavaScript(
              "document.querySelector('#btnSettings').click(); document.querySelector('#settingsTabs button[data-tab=\"ai\"]').click(); true"
            );
            await new Promise((r) => setTimeout(r, 600));
          } else if (action === 'langsettings') {
            await mainWindow.webContents.executeJavaScript("typeof setLang === 'function' && setLang('en'); true");
            await new Promise((r) => setTimeout(r, 900));
            await mainWindow.webContents.executeJavaScript("document.querySelector('#btnSettings').click(); true");
            await new Promise((r) => setTimeout(r, 800));
          } else if (action === 'langsearch') {
            const kw2 = String(process.env.AI_AM_SHOT_Q || '');
            await mainWindow.webContents.executeJavaScript("typeof setLang === 'function' && setLang('en'); true");
            await new Promise((r) => setTimeout(r, 900));
            await mainWindow.webContents.executeJavaScript(`(() => { const i = document.querySelector('#searchInput'); if (i) { i.value = ${JSON.stringify(kw2)}; i.dispatchEvent(new Event('input')); } return true; })()`);
            await new Promise((r) => setTimeout(r, 2400));
            await mainWindow.webContents.executeJavaScript("document.querySelector('.file-row') && document.querySelector('.file-row').click(); true");
            await new Promise((r) => setTimeout(r, 1400));
          } else if (action === 'langen') {
            await mainWindow.webContents.executeJavaScript("typeof setLang === 'function' && setLang('en'); true");
            await new Promise((r) => setTimeout(r, 1500));
          } else if (action === 'disks') {
            await mainWindow.webContents.executeJavaScript("document.querySelector('#btnScanScope').click(); true");
            await new Promise((r) => setTimeout(r, 900));
          } else if (action === 'knowledge' || action === 'tools' || action === 'duplicates') {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('.nav-tab[data-view="${action}"]').click(); true`
            );
            await new Promise((r) => setTimeout(r, 600));
          } else if (action === 'stats') {
            await mainWindow.webContents.executeJavaScript("document.querySelector('#btnStats').click(); true");
            await new Promise((r) => setTimeout(r, 600));
          } else if (action === 'langstats') {
            await mainWindow.webContents.executeJavaScript("typeof setLang === 'function' && setLang('en'); true");
            await new Promise((r) => setTimeout(r, 1200));
            await mainWindow.webContents.executeJavaScript("document.querySelector('#btnStats').click(); true");
            await new Promise((r) => setTimeout(r, 700));
          } else if (action === 'trash') {
            await mainWindow.webContents.executeJavaScript("document.querySelector('#btnOpenTrash').click(); true");
            await new Promise((r) => setTimeout(r, 800));
          } else if (action === 'search') {
            const kw = String(process.env.AI_AM_SHOT_Q || '');
            await mainWindow.webContents.executeJavaScript(
              `(() => { const i = document.querySelector('#searchInput'); if (i) { i.value = ${JSON.stringify(
                kw
              )}; i.dispatchEvent(new Event('input')); } return true; })()`
            );
            await new Promise((r) => setTimeout(r, 2400));
            // 顺手点开第一个结果，展示「打开就跳到命中位置」
            await mainWindow.webContents.executeJavaScript(
              "document.querySelector('.file-row') && document.querySelector('.file-row').click(); true"
            );
            await new Promise((r) => setTimeout(r, 1400));
          }
          const apiOk = await mainWindow.webContents.executeJavaScript(
            '!!window.api && typeof window.api.scan === "function" && typeof window.api.trashList === "function"'
          );
          console.log('[shot] window.api available:', apiOk);
          const img = await mainWindow.capturePage();
          await fsp.writeFile(process.env.AI_AM_SHOT, img.toPNG());
        } catch {
          /* ignore */
        }
        app.quit();
      }, 5200);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // v0.8 M3：有托盘时点 × 只是收进托盘——周报常驻的意思就是「人走了，管家还在盯着」
  mainWindow.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

async function init() {
  app.setAppUserModelId('com.zhiweistudio.aiartifactmanager');
  Menu.setApplicationMenu(null);

  configStore = new ConfigStore(app.getPath('userData'));
  await configStore.load();
  overridesStore = new OverridesStore(app.getPath('userData'));
  await overridesStore.load();
  adviceCache = new AdviceCache(app.getPath('userData'));
  await adviceCache.load();
  stashStore = new Stash(app.getPath('userData'));
  await stashStore.load();

  // 旧版本明文存的密钥，启动时自动加密迁移（迁移失败不阻断启动）
  const aiCfg = configStore.get().ai;
  if (aiCfg && aiCfg.apiKey && !String(aiCfg.apiKey).startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
    try {
      await configStore.patch({ ai: { apiKey: encryptSecret(aiCfg.apiKey) } });
    } catch {
      /* ignore */
    }
  }

  registerIpc();
  createWindow();
  createTray();

  if (configStore.get().mcp && configStore.get().mcp.enabled) {
    try {
      await ensureMcp();
    } catch {
      /* 端口被占用时不阻断启动，用户可在界面里重开 */
    }
  }

  // 上次开着自动监控的，启动时接着盯（先等窗口就绪，免得事件发不出去）
  const wcfg = configStore.get().watch;
  if (wcfg && wcfg.enabled && Array.isArray(wcfg.dirs) && wcfg.dirs.length) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        startWatch(wcfg.dirs).catch(() => {
          /* 目录没了就安静放弃，不打扰用户 */
        });
      }, 1200);
    });
  }

  autoScanDir = process.env.AI_AM_AUTOSCAN || parseScanArg(process.argv);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show(); // 收进托盘时双击图标要能唤回
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const dir = parseScanArg(argv);
    if (dir) {
      if (mainWindow && mainWindow.webContents) sendAutoScan(dir);
      else autoScanDir = dir;
    }
  });

  app.whenReady().then(init).catch((err) => {
    dialog.showErrorBox('启动失败', String((err && err.stack) || err));
    app.quit();
  });
}

app.on('window-all-closed', () => {
  // 托盘还在＝用户没说要退出，进程留着继续盯周报；托盘建不起来则退回旧行为
  if (quitting || !tray) app.quit();
});

app.on('before-quit', () => {
  quitting = true; // app.quit()/系统注销等正规退出路径，别让 close 再拦
});

app.on('before-quit', async () => {
  if (mcpServer) {
    try {
      await mcpServer.stop();
    } catch {
      /* ignore */
    }
  }
});
