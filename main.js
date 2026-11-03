'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { execFile } = require('child_process');

const scanner = require('./src/scanner');
const classifier = require('./src/classifier');
const dedupe = require('./src/dedupe');
const archiver = require('./src/archiver');
const exporter = require('./src/exporter');
const ai = require('./src/ai');
const { ConfigStore } = require('./src/config-store');
const { createMcpHttpServer } = require('./src/mcp-http');
const { safeFileName } = require('./src/safe-path');

const APP_NAME = 'AI产出管家';
const VERSION = require('./package.json').version;

let mainWindow = null;
let configStore = null;
let mcpServer = null;
let lastScan = null;
let autoScanDir = null;
let scanAbort = false;

/** portable 版启动时 process.execPath 指向临时解压目录，必须拿真实 exe 路径 */
function appExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
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

/** 预览/打开/定位只允许操作本次扫描结果里的文件，防止渲染进程传任意路径 */
function assertKnownFile(filePath) {
  const f = findFile(filePath);
  if (!f) throw new Error('这个文件不在本次扫描结果里，先扫描一次');
  return f;
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
    homepage: 'https://www.zhiweistudio.com.cn'
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

  ipcMain.handle('config:get', () => ({
    ...configStore.safe(),
    app: { name: APP_NAME, version: VERSION, homepage: 'https://www.zhiweistudio.com.cn' }
  }));

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
    await writeIndex();
    await saveLastScan();
    return { ok: true, category: f.category };
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

  ipcMain.handle('trash:open', async () => {
    const dir = path.join(app.getPath('userData'), 'trash');
    await fsp.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('trash:list', async () => {
    const root = path.join(app.getPath('userData'), 'trash');
    let dirs = [];
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const batches = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      try {
        const m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
        batches.push({
          id: d.name,
          createdAt: m.createdAt || Number(d.name) || 0,
          files: (m.files || []).filter((f) => !f.restoredAt)
        });
      } catch {
        /* 没有 manifest 的旧批次跳过，文件仍在文件夹里可取回 */
      }
    }
    return batches.filter((b) => b.files.length).sort((a, b) => b.createdAt - a.createdAt);
  });

  ipcMain.handle('trash:restore', async (e, payload) => {
    const p = payload || {};
    const batchId = String(p.batch || '');
    const trashedPath = String(p.trashedPath || '');
    if (!batchId || !trashedPath) throw new Error('参数不完整');

    const root = path.resolve(path.join(app.getPath('userData'), 'trash'));
    const dir = path.resolve(path.join(root, batchId));
    // 防目录穿越：批次目录必须在回收站根目录下
    if (!dir.startsWith(root + path.sep)) throw new Error('非法批次');

    return archiver.restoreFromTrash(dir, trashedPath);
  });

  ipcMain.handle('archive:run', async (e, payload) => {
    const p = payload || {};
    const files = pickFiles(p.paths);
    if (!files.length) throw new Error('没有选中任何文件');
    const root = p.targetDir || configStore.get().archiveRoot;
    if (!root) throw new Error('请先设置归档目录（设置 → 默认归档路径）');
    return archiver.archive(files, root, { mode: p.mode === 'move' ? 'move' : 'copy' });
  });

  ipcMain.handle('duplicate:remove', async (e, payload) => {
    const p = payload || {};
    const files = pickFiles(p.paths).filter((f) => f.duplicate && f.duplicate.isDuplicate);
    if (!files.length) return { ok: 0, failed: [], skipped: [{ reason: '没有可删除的重复文件' }] };
    const trashDir = path.join(app.getPath('userData'), 'trash', String(Date.now()));
    return archiver.removeDuplicates(files, { toTrash: p.toTrash !== false, trashDir });
  });

  ipcMain.handle('cleanup:trash', async (e, payload) => {
    const p = payload || {};
    const files = pickFiles(p.paths);
    if (!files.length) return { ok: 0, failed: [], skipped: [], done: [] };
    const trashDir = path.join(app.getPath('userData'), 'trash', String(Date.now()));
    return archiver.moveToTrash(files, trashDir);
  });

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
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'apiKey') && cfg.apiKey === undefined) {
      next.apiKey = cur.apiKey;
    }
    await configStore.patch({ ai: next });
    return configStore.safe().ai;
  });

  ipcMain.handle('ai:test', async (e, override) => {
    const cur = configStore.get().ai;
    const cfg = { ...cur, ...(override || {}) };
    if (!cfg.apiKey) cfg.apiKey = cur.apiKey;
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
    const summary = await ai.summarize(configStore.get().ai, f);
    f.aiSummary = summary;
    await writeIndex();
    return { path: f.path, summary };
  });

  ipcMain.handle('ai:rename', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const name = await ai.suggestName(configStore.get().ai, f);
    return { path: f.path, name };
  });

  ipcMain.handle('ai:tags', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const tags = await ai.suggestTags(configStore.get().ai, f);
    return { path: f.path, tags };
  });

  ipcMain.handle('ai:category', async (e, payload) => {
    const f = findFile(payload && payload.path);
    if (!f) throw new Error('文件不在本次扫描结果里');
    const key = await ai.suggestCategory(configStore.get().ai, f);
    return { path: f.path, category: key };
  });

  ipcMain.handle('ai:compare', async (e, payload) => {
    const a = findFile(payload && payload.a);
    const b = findFile(payload && payload.b);
    if (!a || !b) throw new Error('两个文件都要在扫描结果里');
    return ai.compareVersions(configStore.get().ai, a, b);
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
          }
          const apiOk = await mainWindow.webContents.executeJavaScript(
            '!!window.api && typeof window.api.scan === "function" && typeof window.api.trashRestore === "function"'
          );
          console.log('[shot] window.api available:', apiOk);
          const img = await mainWindow.capturePage();
          await fsp.writeFile(process.env.AI_AM_SHOT, img.toPNG());
        } catch {
          /* ignore */
        }
        app.quit();
      }, 3500);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function init() {
  app.setAppUserModelId('com.zhiweistudio.aiartifactmanager');
  Menu.setApplicationMenu(null);

  configStore = new ConfigStore(app.getPath('userData'));
  await configStore.load();

  registerIpc();
  createWindow();

  if (configStore.get().mcp && configStore.get().mcp.enabled) {
    try {
      await ensureMcp();
    } catch {
      /* 端口被占用时不阻断启动，用户可在界面里重开 */
    }
  }

  autoScanDir = process.env.AI_AM_AUTOSCAN || parseScanArg(process.argv);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    if (mainWindow) {
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
  app.quit();
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
