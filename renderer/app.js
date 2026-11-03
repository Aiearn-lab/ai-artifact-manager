'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const MAX_RENDER = 800;

const CAT_COLORS = {
  knowledge: '#2563eb',
  'tool-common': '#059669',
  'tool-onetime': '#d97706',
  junk: '#dc2626',
  other: '#94a3b8'
};

const VIEW_COLUMNS = {
  files: () => ['', t('list.fileName'), t('list.source'), t('list.category'), t('list.size'), t('list.path')],
  knowledge: () => ['', t('list.fileName'), t('list.topicTag'), t('list.charsLabel'), t('list.size'), t('list.path')],
  tools: () => ['', t('list.fileName'), t('list.category'), 'Lang', t('list.size'), t('list.path')],
  duplicates: () => ['', t('list.fileName'), t('list.dupRatio'), t('list.keepWhich'), t('list.size'), t('list.path')],
  trash: () => ['', t('list.fileName'), t('list.time'), t('list.action'), t('list.size'), t('list.path')]
};
const DEFAULT_COLUMNS = () => ['', t('list.fileName'), t('list.source'), t('list.category'), t('list.size'), t('list.path')];

const LANG_MAP = {
  '.py': 'Python', '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.sh': 'Shell', '.bat': 'Batch', '.cmd': 'Batch', '.ps1': 'PowerShell',
  '.html': 'HTML', '.htm': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.sql': 'SQL', '.java': 'Java', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby',
  '.php': 'PHP', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++', '.vue': 'Vue', '.svelte': 'Svelte'
};

const state = {
  config: null,
  scan: null,
  files: [],
  filtered: [],
  filter: { cat: 'all', source: 'all', q: '', sort: 'mtime' },
  view: 'files',
  selection: new Set(),
  currentId: null,
  localAi: [],
  mcp: null,
  disks: [],
  appPaths: {},
  busy: false,
  // 全文搜索：内容命中的文件（path -> { count, snippet }），和元数据搜索分开管
  contentHits: new Map(),
  contentSearching: false,
  contentScanned: 0,
  contentPartial: false,
  // 自动监控状态
  watch: { enabled: false, dirs: [], recent: [] }
};

/* ---------------- 多语言 ---------------- */
// 默认跟系统语言走；用户在设置里选过就用存的
let LANG = 'zh';

function t(key, vars) {
  const dict = (window.I18N && window.I18N[LANG]) || {};
  let str = dict[key];
  if (str === undefined) {
    // 没翻到的先用中文兜底，方便一眼看出哪里漏了
    str = (window.I18N && window.I18N.zh && window.I18N.zh[key]) || key;
  }
  if (vars) {
    for (const k of Object.keys(vars)) {
      str = str.split('{' + k + '}').join(String(vars[k]));
    }
  }
  return str;
}

function detectLang() {
  const saved = state.config && state.config.ui && state.config.ui.lang;
  if (saved === 'zh' || saved === 'en') return saved;
  const sys = String(navigator.language || 'zh').toLowerCase();
  return sys.startsWith('zh') ? 'zh' : 'en';
}

/** 把页面上所有打了标记的文案换成当前语言 */
function applyLang() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.name');

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}

async function setLang(lang) {
  LANG = lang === 'en' ? 'en' : 'zh';
  try {
    state.config = await window.api.configPatch({ ui: { lang: LANG } });
  } catch {
    /* 存不下也能用，只是下次启动回到自动判断 */
  }
  applyLang();
  renderAll();
}

/* ---------------- 基础工具 ---------------- */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

function setBusy(v) {
  state.busy = v;
  ['#btnQuickScan', '#btnPickFolder', '#btnEmptyScan', '#btnEmptyFolder'].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = v;
  });
  const scope = $('#btnScanScope');
  if (scope) {
    scope.textContent = v ? t('nav.stopScan') : t('nav.scanAll');
    scope.classList.toggle('btn-primary', !v);
    scope.classList.toggle('btn-danger-ghost', v);
  }
}

function langOf(ext) {
  if (!ext) return '—';
  return LANG_MAP[String(ext).toLowerCase()] || String(ext).replace('.', '').toUpperCase();
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bindEvents();

  try {
    state.config = await window.api.configGet();
  } catch {
    /* 配置读不到也能用默认值 */
  }

  // 语言：用户选过就用选的，没选过跟系统
  LANG = detectLang();
  applyLang();

  try {
    state.appPaths = await window.api.appPaths();
  } catch {
    state.appPaths = {};
  }

  try {
    const info = await window.api.appInfo();
    $('#statusVersion').textContent = `v${info.version}`;
    $('#aboutVersion').textContent = `v${info.version}`;
  } catch {
    /* ignore */
  }

  try {
    const last = await window.api.lastScan();
    if (last && last.files && last.files.length) applyScan(last);
  } catch {
    /* ignore */
  }

  renderAll();

  window.api.onProgress((p) => {
    const bar = $('#progressBar');
    const fill = $('#progressFill');
    if (!p || p.phase === 'done') {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const ratio = p.total ? Math.min(1, p.done / p.total) : 0.15;
    fill.style.width = `${Math.max(8, ratio * 100)}%`;
    const label = {
      scanning: t('prog.scanning'),
      classifying: t('prog.classifying'),
      deduping: t('prog.deduping')
    }[p.phase] || t('prog.working');
    $('#statusText').textContent = p.phase === 'scanning' && p.done ? t('prog.scanned', { n: p.done }) : label;
  });

  window.api.onAutoScan((dir) => {
    if (!dir) return;
    scanRoots([dir], t('label.picked'));
  });

  // 监控状态与「发现新文件」推送
  await loadWatchStatus();
  window.api.onWatchFound(async (entry) => {
    await loadWatchStatus();
    if (entry && entry.count) {
      toast(t('msg.watchFound', { n: entry.count }));
    }
  });

  // 初始化完成，启动画面淡出（.out 有 320ms 过渡，之后再移除节点）
  const splash = $('#splash');
  if (splash) {
    setTimeout(() => {
      splash.classList.add('out');
      setTimeout(() => splash.remove(), 380);
    }, 260);
  }
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  $('#btnScanScope').addEventListener('click', () => {
    if (state.busy) {
      window.api.cancelScan();
      $('#statusText').textContent = t('prog.stopping');
      return;
    }
    openDiskModal();
  });
  $('#btnQuickScan').addEventListener('click', quickScan);
  $('#btnPickFolder').addEventListener('click', pickFolder);
  $('#btnEmptyScan').addEventListener('click', quickScan);
  $('#btnEmptyFolder').addEventListener('click', pickFolder);

  $('#btnCloseDisk').addEventListener('click', closeDiskModal);
  $('#diskModal').addEventListener('click', (e) => {
    if (e.target === $('#diskModal')) closeDiskModal();
  });
  $('#btnPickFolderFromModal').addEventListener('click', async () => {
    closeDiskModal();
    await pickFolder();
  });
  $('#diskList').addEventListener('click', (e) => {
    const item = e.target.closest('.disk-item');
    if (!item) return;
    const root = item.dataset.root;
    closeDiskModal();
    scanRoots([root], `${root}${LANG === 'zh' ? ' 全盘' : ' (whole drive)'}`);
  });

  $('#navTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-tab');
    if (!btn) return;
    setView(btn.dataset.view);
  });

  $('#btnStats').addEventListener('click', openStats);
  $('#btnCloseStats').addEventListener('click', closeStats);
  $('#statsModal').addEventListener('click', (e) => {
    if (e.target === $('#statsModal')) closeStats();
  });

  $('#searchInput').addEventListener('input', (e) => {
    state.filter.q = e.target.value.trim();
    renderList(); // 先按文件名/标签出结果，正文结果稍后补进来
    scheduleContentSearch(state.filter.q);
  });
  $('#setLang').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v) await setLang(v);
    else {
      const auto = detectLang();
      await setLang(auto);
    }
  });
  $('#btnWatchAdd').addEventListener('click', addWatchDir);
  $('#btnWatchToggle').addEventListener('click', toggleWatch);
  $('#watchDirs').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    state.watch.dirs.splice(Number(btn.dataset.i), 1);
    refreshWatchUI();
    if (state.watch.enabled && state.watch.dirs.length) {
      await window.api.watchStart(state.watch.dirs);
    } else if (state.watch.enabled && !state.watch.dirs.length) {
      await window.api.watchStop();
    }
    await loadWatchStatus();
  });
  $('#btnWatchShow').addEventListener('click', () => {
    const last = (state.watch.recent || [])[0];
    if (!last) return;
    // 新文件就在刚才盯的目录里，点一下直接扫它
    scanRoots([last.dir], t('label.fromWatch'));
  });

  $('#btnOnboardOk').addEventListener('click', async () => {
    $('#onboardTip').classList.add('hidden');
    try {
      state.config = await window.api.configPatch({ ui: { onboarded: true } });
    } catch {
      /* 存不下就下次再说，不影响用 */
    }
  });
  $('#settingsHomepage').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openUrl('https://www.zhiweistudio.com.cn');
  });
  $('#sourceFilter').addEventListener('change', (e) => {
    state.filter.source = e.target.value;
    renderList();
  });
  $('#sortSelect').addEventListener('change', (e) => {
    state.filter.sort = e.target.value;
    renderList();
  });

  $('#categoryTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.filter.cat = tab.dataset.cat;
    $$('#categoryTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderList();
  });

  $('#selectAll').addEventListener('change', (e) => {
    if (e.target.checked) for (const f of state.filtered) state.selection.add(f.id);
    else state.selection.clear();
    renderList();
  });

  const list = $('#fileList');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) return;
    if (e.target.matches('input[type="checkbox"]')) return;
    selectFile(row.dataset.id);
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) return;
    const f = state.files.find((x) => x.id === row.dataset.id);
    if (f) window.api.openFile(f.path).catch((err) => toast(err.message, true));
  });
  list.addEventListener('change', (e) => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    const id = e.target.dataset.id;
    if (e.target.checked) state.selection.add(id);
    else state.selection.delete(id);
    const row = e.target.closest('.file-row');
    if (row) row.classList.toggle('checked', e.target.checked);
    updateSelectionUI();
  });

  $('#btnOneClick').addEventListener('click', doOneClickOrganize);
  $('#btnArchive').addEventListener('click', doArchive);
  $('#btnExport').addEventListener('click', doExport);
  $('#btnCleanDup').addEventListener('click', doCleanDuplicates);
  $('#btnOpenTrash').addEventListener('click', openTrash);
  $('#btnCloseTrash').addEventListener('click', () => $('#trashModal').classList.add('hidden'));
  $('#trashModal').addEventListener('click', (e) => {
    if (e.target === $('#trashModal')) $('#trashModal').classList.add('hidden');
  });
  $('#btnOpenTrashFolder').addEventListener('click', async () => {
    try {
      await window.api.openTrash();
    } catch (err) {
      toast(t('msg.openFail', { msg: err.message }), true);
    }
  });
  $('#btnClearTrashLog').addEventListener('click', async () => {
    if (!window.confirm(t('msg.confirmClearLog'))) return;
    await window.api.trashClearLog();
    await renderTrash();
    toast(t('msg.trashLogCleared'));
  });

  $('#btnPreviewOpen').addEventListener('click', () => {
    const f = currentFile();
    if (f) window.api.openFile(f.path).catch((err) => toast(err.message, true));
  });
  $('#btnPreviewReveal').addEventListener('click', () => {
    const f = currentFile();
    if (f) window.api.reveal(f.path).catch((err) => toast(err.message, true));
  });
  $('#btnPreviewArchive').addEventListener('click', () => archiveCurrent());
  $('#btnAiSummary').addEventListener('click', () => runAi('summary'));
  $('#btnAiRename').addEventListener('click', () => runAi('rename'));
  $('#btnAiTags').addEventListener('click', () => runAi('tags'));
  $('#btnAiCategory').addEventListener('click', () => runAi('category'));

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) closeSettings();
  });
  $('#settingsTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    $$('#settingsTabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.settings-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
    if (btn.dataset.tab === 'mcp') refreshMcp();
  });

  $('#btnPickArchiveRoot').addEventListener('click', async () => {
    const dir = await window.api.pickFolder();
    if (dir) $('#setArchiveRoot').value = dir;
  });
  $('#btnSaveGeneral').addEventListener('click', saveGeneral);
  $('#btnCtxInstall').addEventListener('click', () => setContextMenu(true));
  $('#btnCtxUninstall').addEventListener('click', () => setContextMenu(false));

  $('#btnDetectLocal').addEventListener('click', detectLocalAi);
  $('#btnSaveAi').addEventListener('click', saveAi);
  $('#btnTestAi').addEventListener('click', testAi);

  $('#btnMcpToggle').addEventListener('click', toggleMcp);
  $('#btnCopyMcp').addEventListener('click', copyMcpConfig);

  $('#aiResult').addEventListener('click', onAiAction);

  $('#linkHomepage').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openUrl('https://www.zhiweistudio.com.cn');
  });
  $('#aboutHomepage').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openUrl('https://www.zhiweistudio.com.cn');
  });
  $('#btnOpenSite').addEventListener('click', () => window.api.openUrl('https://www.zhiweistudio.com.cn'));
}

/* ---------------- 扫描 ---------------- */
async function openDiskModal() {
  $('#diskModal').classList.remove('hidden');
  $('#diskList').innerHTML = `<div class="disk-empty">${t('disk.reading')}</div>`;
  try {
    const disks = await window.api.listDisks();
    state.disks = disks;
    renderDiskList(disks);
  } catch (err) {
    $('#diskList').innerHTML = `<div class="disk-empty">${t('disk.readFail', { msg: esc(err.message) })}</div>`;
  }
}

function closeDiskModal() {
  $('#diskModal').classList.add('hidden');
}

function renderDiskList(disks) {
  if (!disks.length) {
    $('#diskList').innerHTML = `<div class="disk-empty">${t('disk.none')}</div>`;
    return;
  }
  $('#diskList').innerHTML = disks
    .map((d) => {
      const used = d.total ? Math.max(2, Math.round(((d.total - d.free) / d.total) * 100)) : 0;
      const sys = d.letter.toUpperCase() === 'C' ? (LANG === 'zh' ? '（系统盘）' : ' (system)') : '';
      const sizeText = d.total ? t('disk.size', { total: fmtSize(d.total), free: fmtSize(d.free) }) : t('disk.unknown');
      return `<button class="disk-item" data-root="${esc(d.root)}" type="button">
        <span class="disk-icon">${esc(d.letter)}:</span>
        <span class="disk-info">
          <span class="disk-name">${esc(d.letter)}:${LANG === 'zh' ? ' 盘' : ' drive'}${sys}</span>
          <span class="disk-meta">${sizeText}</span>
          <span class="disk-bar"><span style="width:${used}%"></span></span>
        </span>
        <span class="btn btn-primary btn-sm">${t('disk.scanThis')}</span>
      </button>`;
    })
    .join('');
}

async function quickScan() {
  let p = state.appPaths;
  if (!p || !p.desktop) {
    try {
      p = await window.api.appPaths();
      state.appPaths = p;
    } catch {
      p = {};
    }
  }
  const roots = [p.desktop, p.downloads, p.documents].filter(Boolean);
  if (!roots.length) return toast(t('msg.noCommon'), true);
  await scanRoots(roots, t('label.common'));
}

async function pickFolder() {
  const dir = await window.api.pickFolder();
  if (!dir) return;
  await scanRoots([dir], t('label.picked'));
}

async function scanRoots(roots, label) {
  if (state.busy) return;
  setBusy(true);
  $('#statusText').textContent = t('prog.scanningAt', { where: label });
  try {
    const scan = await window.api.scan({ roots });
    applyScan(scan);
    const s = scan.summary || {};
    if (s.cancelled) {
      toast(t('msg.scanStopped', { n: s.files || 0 }));
    } else {
      toast(t('msg.scanDone', { n: s.files || 0, sec: ((scan.durationMs || 0) / 1000).toFixed(1) }));
    }
    if (scan.truncated) toast(t('msg.tooMany'), true);
  } catch (err) {
    toast(t('msg.scanFail', { msg: err.message }), true);
    $('#statusText').textContent = t('prog.scanFailed');
  } finally {
    setBusy(false);
    $('#progressBar').classList.add('hidden');
  }
}

function applyScan(scan) {
  state.scan = scan;
  state.files = scan.files || [];
  state.selection.clear();
  state.currentId = null;
  // 换了扫描结果，上一次的正文搜索结果就作废了
  state.contentHits = new Map();
  state.contentSearching = false;
  state.contentScanned = 0;
  state.contentPartial = false;
  renderAll();
}

/* ---------------- 渲染 ---------------- */
function renderAll() {
  renderNavStats();
  renderViewSummary();
  renderTabsCounts();
  renderSourceFilter();
  renderTableHead();
  renderList();
  renderCharts();
  renderPreviewEmpty();
  maybeShowOnboard();
}

/** 首次扫描完给一条三步引导，点一次「明白了」就记住不再烦 */
function maybeShowOnboard() {
  const box = $('#onboardTip');
  if (!box) return;
  const seen = !!(state.config && state.config.ui && state.config.ui.onboarded);
  const show = !seen && state.files.length > 0 && state.view === 'files';
  box.classList.toggle('hidden', !show);
}

function renderNavStats() {
  const s = state.scan && state.scan.summary;
  if (!s) {
    $('#navStats').textContent = t('ov.notScanned');
    return;
  }
  $('#navStats').textContent = `${s.files} · ${fmtSize(s.size)}`;
}

function baseViewFiles() {
  // 知识库和工具库不收重复副本：那些是「同一份东西的多余拷贝」，
  // 该去「重复文件」页处理，混在资料里只会让人以为资料很多
  const notDup = (f) => !(f.duplicate && f.duplicate.isDuplicate);
  if (state.view === 'knowledge') {
    return state.files.filter((f) => (f.category && f.category.group) === 'knowledge' && notDup(f));
  }
  if (state.view === 'tools') {
    return state.files.filter((f) => (f.category && f.category.group) === 'tool' && notDup(f));
  }
  if (state.view === 'duplicates') return state.files.filter((f) => f.duplicate && f.duplicate.isDuplicate);
  return state.files;
}

function topTags(list, n) {
  const counts = new Map();
  for (const f of list) {
    const tags = (f.category && f.category.tags) || [];
    for (const t of tags) {
      if (String(t).length > 10) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n || 5)
    .map(([t]) => t);
}

function renderViewSummary() {
  const el = $('#viewSummary');
  const s = state.scan && state.scan.summary;
  const all = state.files;

  if (state.view === 'files') {
    const keep = all.filter((f) => f.category && (f.category.group === 'knowledge' || f.category.group === 'tool')).length;
    const clean = all.filter((f) => f.category && f.category.key === 'junk').length;
    const groups = (s && s.duplicateStats && s.duplicateStats.groups) || 0;
    el.innerHTML = `<div class="overview-strip">
      <div class="mini-stats">
        <div class="mini-stat"><span class="ms-label">${t('ov.files')}</span><span class="ms-value">${
          s ? all.length : 0
        }</span><span class="ms-sub">${s ? t('ov.keepHint', { keep, clean }) : t('ov.notScanned')}</span></div>
        <div class="mini-stat"><span class="ms-label">${t('ov.size')}</span><span class="ms-value">${
          s ? fmtSize(s.size) : '—'
        }</span><span class="ms-sub">${t('ov.aiTotal')}</span></div>
        <div class="mini-stat"><span class="ms-label">${t('ov.cleanable')}</span><span class="ms-value warn">${
          s ? fmtSize(s.cleanableSize) : '—'
        }</span><span class="ms-sub">${t('ov.cleanSub')}</span></div>
        <div class="mini-stat"><span class="ms-label">${t('ov.dupFree')}</span><span class="ms-value warn">${
          s ? fmtSize(s.duplicateSize || 0) : '—'
        }</span><span class="ms-sub">${t('ov.dupGroups', { n: groups })}</span></div>
      </div>
      <div class="mini-chart" id="miniChart"></div>
    </div>`;
    renderMiniChart();
    return;
  }

  if (!s) {
    el.innerHTML = t('ov.firstHint');
    return;
  }

  if (state.view === 'knowledge') {
    const list = baseViewFiles();
    const chars = list.reduce((n, f) => n + (f.chars || 0), 0);
    const tags = topTags(list, 5);
    // 重复副本会被判成「可删」，分类已经变了，所以这里按重复标记统计
    const hiddenDup = state.files.filter((f) => f.duplicate && f.duplicate.isDuplicate).length;
    const dupNote = hiddenDup
      ? LANG === 'zh'
        ? `　另有 <b>${hiddenDup}</b> 个重复副本没列在这里，去「重复文件」页能统一处理`
        : `　<b>${hiddenDup}</b> duplicate copies are not listed here — handle them in the Duplicates tab`
      : '';
    const tagText = tags.length
      ? LANG === 'zh'
        ? `。常见主题：<b>${tags.map(esc).join('、')}</b>`
        : `. Common topics: <b>${tags.map(esc).join(', ')}</b>`
      : '';
    el.innerHTML =
      LANG === 'zh'
        ? `知识库里已经有 <b>${list.length}</b> 份资料，共约 <b>${chars.toLocaleString()}</b> 字${tagText}。${dupNote}`
        : `Knowledge has <b>${list.length}</b> documents, about <b>${chars.toLocaleString()}</b> characters${tagText}.${dupNote}`;
    return;
  }

  if (state.view === 'tools') {
    const list = baseViewFiles();
    const common = list.filter((f) => f.category && f.category.key === 'tool-common').length;
    const onetime = list.filter((f) => f.category && f.category.key === 'tool-onetime').length;
    const hiddenDup = state.files.filter((f) => f.duplicate && f.duplicate.isDuplicate).length;
    const langs = new Map();
    for (const f of list) {
      const l = langOf(f.ext);
      langs.set(l, (langs.get(l) || 0) + 1);
    }
    const langText = Array.from(langs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([l, c]) => `${l} ${c}`)
      .join(' · ');
    el.innerHTML =
      LANG === 'zh'
        ? `工具库里 <b>${list.length}</b> 个脚本：常用 <span class="ok">${common}</span> 个、一次性 <span class="warn">${onetime}</span> 个${
            langText ? `。语言：${esc(langText)}` : ''
          }。${hiddenDup ? `　另有 <b>${hiddenDup}</b> 个重复副本没列在这里` : ''}`
        : `<b>${list.length}</b> scripts: <span class="ok">${common}</span> reusable, <span class="warn">${onetime}</span> one-off${
            langText ? `. Languages: ${esc(langText)}` : ''
          }.${hiddenDup ? `　<b>${hiddenDup}</b> duplicates are not listed here` : ''}`;
    return;
  }

  if (state.view === 'duplicates') {
    const list = baseViewFiles();
    const free = list.reduce((n, f) => n + (f.size || 0), 0);
    const groups = (s.duplicateStats && s.duplicateStats.groups) || 0;
    el.innerHTML =
      LANG === 'zh'
        ? `发现 <b>${groups}</b> 组重复，共 <b>${list.length}</b> 个多余文件，处理掉能腾出 <span class="warn">${fmtSize(free)}</span>。`
        : `<b>${groups}</b> duplicate groups, <b>${list.length}</b> redundant files — cleaning them frees <span class="warn">${fmtSize(
            free
          )}</span>.`;
  }
}

function renderMiniChart() {
  const box = document.getElementById('miniChart');
  if (!box) return;
  const s = state.scan && state.scan.summary;

  if (!s || !s.bySource || !s.bySource.length) {
    box.innerHTML = `<svg viewBox="0 0 60 60" width="56" height="56" class="mini-donut"><circle cx="30" cy="30" r="23" fill="none" stroke="#e6ebf5" stroke-width="10"/></svg>
      <div class="mini-legend"><span class="mini-legend-empty">${t('chart.afterScan')}<br>${t('chart.sourceDist')}</span></div>`;
    return;
  }

  const items = aiSourceBuckets(s.bySource);
  const total = items.reduce((n, x) => n + x.count, 0) || 1;
  const R = 23;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segs = items
    .map((it) => {
      const frac = it.count / total;
      const dash = frac * C;
      const seg = `<circle cx="30" cy="30" r="${R}" fill="none" stroke="${it.color || '#94a3b8'}" stroke-width="10" stroke-dasharray="${dash.toFixed(
        1
      )} ${(C - dash).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(
        1
      )}" transform="rotate(-90 30 30)"/>`;
      offset += dash;
      return seg;
    })
    .join('');

  const legend = items
    .map(
      (it) =>
        `<span class="mini-legend-item"><span class="source-dot" style="background:${
          it.color || '#94a3b8'
        }"></span><span class="mini-legend-name">${esc(it.label)}</span><span class="mini-legend-val">${it.count}</span></span>`
    )
    .join('');

  box.innerHTML = `<svg viewBox="0 0 60 60" width="56" height="56" class="mini-donut">${segs}<text x="30" y="33" text-anchor="middle" class="mini-donut-num">${total}</text></svg>
    <div class="mini-legend">${legend}</div>`;
}

function setView(view) {
  state.view = view;
  $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#categoryTabs').classList.toggle('hidden', view !== 'files');
  if (view !== 'files') {
    state.filter.cat = 'all';
    $$('#categoryTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === 'all'));
  }
  renderAll();
}

function catMatch(file, cat) {
  if (cat === 'all') return true;
  if (cat === 'dup') return !!(file.duplicate && file.duplicate.isDuplicate);
  const group = (file.category && file.category.group) || 'other';
  return group === cat;
}

function renderTabsCounts() {
  const files = state.files;
  const count = (g) => files.filter((f) => ((f.category && f.category.group) || 'other') === g).length;
  const dupCount = files.filter((f) => f.duplicate && f.duplicate.isDuplicate).length;
  $('#tabCountAll').textContent = files.length;
  $('#tabCountKnowledge').textContent = count('knowledge');
  $('#tabCountTool').textContent = count('tool');
  $('#tabCountJunk').textContent = count('junk');
  $('#tabCountDup').textContent = dupCount;
  $('#tabCountOther').textContent = count('other');
}

function renderSourceFilter() {
  const sel = $('#sourceFilter');
  const s = state.scan && state.scan.summary;
  if (!s) {
    sel.innerHTML = `<option value="all">${t('tb.allSources')}</option>`;
    return;
  }
  const aiCount = (s.bySource || []).filter((x) => x.id !== 'unknown').reduce((n2, x) => n2 + x.count, 0);
  const unkCount = (s.bySource || []).filter((x) => x.id === 'unknown').reduce((n2, x) => n2 + x.count, 0);
  const opts = [
    `<option value="all">${t('tb.allSources')}</option>`,
    `<option value="ai">${t('src.aiTool')} (${aiCount})</option>`,
    `<option value="unknown">${t('src.unknown')} (${unkCount})</option>`
  ];
  sel.innerHTML = opts.join('');
  sel.value = state.filter.source;
}

function renderTableHead() {
  const make = VIEW_COLUMNS[state.view] || DEFAULT_COLUMNS;
  const cols = make();
  $('#tableHead').innerHTML = cols.map((c) => `<span>${esc(c)}</span>`).join('');
}

function computeFiltered() {
  let list = baseViewFiles();
  if (state.view === 'files' && state.filter.cat !== 'all') {
    list = list.filter((f) => catMatch(f, state.filter.cat));
  }
  if (state.filter.source !== 'all') {
    const wantUnknown = state.filter.source === 'unknown';
    list = list.filter((f) => isUnknownSource(f) === wantUnknown);
  }
  if (state.filter.q) {
    const needle = state.filter.q.toLowerCase();
    list = list.filter((f) => {
      // 文件名 / 路径 / 标签命中，或者正文里搜到了（contentHits）
      if (state.contentHits.has(f.path)) return true;
      const hay = [
        f.name,
        f.path,
        f.aiSummary || '',
        f.category ? f.category.reason : '',
        f.category && f.category.tags ? f.category.tags.join(' ') : ''
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  const cmp = {
    mtime: (a, b) => b.mtime - a.mtime,
    size: (a, b) => b.size - a.size,
    name: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
    chars: (a, b) => (b.chars || 0) - (a.chars || 0)
  }[state.filter.sort] || ((a, b) => b.mtime - a.mtime);

  return list.sort(cmp);
}

/* ---------------- 全文搜索 ---------------- */
let contentTimer = null;
let contentRequestId = 0;

function scheduleContentSearch(q) {
  clearTimeout(contentTimer);
  const reset = () => {
    state.contentHits = new Map();
    state.contentSearching = false;
    state.contentScanned = 0;
    state.contentPartial = false;
  };

  if (!q || q.length < 2 || !state.files.length) {
    const had = state.contentHits.size || state.contentSearching;
    reset();
    if (had) renderList();
    return;
  }

  reset();
  state.contentSearching = true;
  renderList(); // 先把「正在翻正文」的状态显示出来
  const myId = ++contentRequestId;

  contentTimer = setTimeout(async () => {
    let r = null;
    try {
      r = await window.api.searchContent({ q });
    } catch {
      r = null;
    }
    if (myId !== contentRequestId) return; // 用户又改了关键词，这份结果作废
    state.contentSearching = false;
    if (r && r.ok) {
      state.contentHits = new Map((r.hits || []).map((h) => [h.path, h]));
      state.contentScanned = r.scanned || 0;
      state.contentPartial = !!r.partial;
    }
    renderList();
  }, 350);
}


/** 分类 key → 词典键 */
const CAT_KEY = {
  knowledge: 'cat.knowledge',
  'tool-common': 'cat.toolCommon',
  'tool-onetime': 'cat.toolOneTime',
  junk: 'cat.junk',
  other: 'cat.other'
};

/**
 * 来源只对外说两件事：这是 AI 产出的，还是看不出来。
 * 具体是哪家 AI 靠规则猜的，猜错比不猜更伤用户信任，所以不往外摆。
 * （后端仍然算出了具体来源，要恢复细分只改这一个函数即可。）
 */
function isUnknownSource(f) {
  const src = f.source || {};
  return !src.id || src.id === 'unknown';
}

function sourceName(f) {
  return isUnknownSource(f) ? t('src.unknown') : t('src.aiTool');
}

const SRC_COLORS = { ai: '#6366f1', unknown: '#cbd5e1' };

/** 把后端算出的具体来源压成两类，坐标轴/图例只认这两个 */
function aiSourceBuckets(bySource) {
  let ai = 0;
  let unk = 0;
  for (const x of bySource || []) {
    if (x.id === 'unknown' || !x.id) unk += x.count;
    else ai += x.count;
  }
  return [
    { id: 'ai', label: t('src.aiTool'), color: SRC_COLORS.ai, count: ai },
    { id: 'unknown', label: t('src.unknown'), color: SRC_COLORS.unknown, count: unk }
  ].filter((x) => x.count > 0);
}

function catLabel(f) {
  const k = f.category && f.category.key;
  return CAT_KEY[k] ? t(CAT_KEY[k]) : (f.category && f.category.label) || t('cat.other');
}

function keepLabel(f) {
  const k = f.category && f.category.key;
  if (k === 'knowledge') return t('keep.knowledge');
  if (k === 'tool-common') return t('keep.toolCommon');
  if (k === 'tool-onetime') return t('keep.toolOneTime');
  if (k === 'junk') return t('keep.junk');
  return t('keep.other');
}

/** 把搜索词在文本里标出来（先转义再包 mark，避免 XSS） */
function highlightHit(text, q) {
  const t = String(text || '');
  const needle = String(q || '').toLowerCase();
  if (!needle) return esc(t);
  const lower = t.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j === -1) {
      out += esc(t.slice(i));
      break;
    }
    out += esc(t.slice(i, j)) + '<mark>' + esc(t.slice(j, j + needle.length)) + '</mark>';
    i = j + needle.length;
  }
  return out;
}

function rowCells(f) {
  const cat = f.category || { key: 'other', label: '', retention: '' };
  const extLabel = (f.ext || '').replace('.', '').slice(0, 5) || 'FILE';
  const dup = f.duplicate && f.duplicate.isDuplicate;

  // 正文搜到的文件，在文件名下面带一行命中片段，省得逐个点开确认
  const hit = state.filter.q ? state.contentHits.get(f.path) : null;
  const hitLine = hit
    ? `<div class="hit-line" title="${esc(hit.snippet)}">${highlightHit(hit.snippet, state.filter.q)}${
        hit.count > 1 ? ` <span class="hit-count">${t('search.hitCount', { n: hit.count })}</span>` : ''
      }</div>`
    : '';

  const nameCell = `<div class="fname-wrap"><div class="fname">
    <span class="fext ${esc((f.ext || '').replace('.', ''))}">${esc(extLabel)}</span>
    <span class="fname-text" title="${esc(f.name)}">${esc(f.name)}</span>
    ${dup ? `<span class="dup-flag">${LANG === 'zh' ? '重复' : 'Dup'}</span>` : ''}
  </div>${hitLine}</div>`;

  if (state.view === 'knowledge') {
    // 只放主标签：两个标签在窄列里总有一个被截成「数…」，反而不好读
    const tags = (cat.tags || []).slice(0, 1);
    return {
      name: nameCell,
      c3: tags.length
        ? `<span class="tag-row">${tags
            .map((t) => `<span class="tag-chip" title="${esc(t)}">${esc(t)}</span>`)
            .join('')}</span>`
        : '<span class="cell-text">—</span>',
      c4: `<span class="cell-num">${(f.chars || 0).toLocaleString()} ${t('unit.chars')}</span>`
    };
  }

  if (state.view === 'tools') {
    return {
      name: nameCell,
      c3: `<span class="cat-badge cat-${esc(cat.key)}">${esc(cat.key === 'tool-common' ? t('cat.toolCommon') : t('cat.toolOneTime'))}</span>`,
      c4: `<span class="cell-text">${esc(langOf(f.ext))}</span>`
    };
  }

  if (state.view === 'duplicates') {
    const sim = dup ? Math.round((f.duplicate.similarity || 1) * 100) : 100;
    return {
      name: nameCell,
      c3: `<span class="cell-num">${f.duplicate && f.duplicate.kind === 'exact' ? t('dup.exact') : t('dup.similar', { p: sim })}</span>`,
      c4: `<span class="cell-text" title="${esc((f.duplicate && f.duplicate.withName) || '')}">${esc(
        (f.duplicate && f.duplicate.withName) || '—'
      )}</span>`
    };
  }

  // files
  return {
    name: nameCell,
    c3: `<div class="source-badge"><span class="source-dot" style="background:${
      isUnknownSource(f) ? SRC_COLORS.unknown : SRC_COLORS.ai
    }"></span><span class="source-name">${esc(sourceName(f))}</span></div>`,
    c4: `<span class="cat-badge cat-${esc(cat.key)}">${esc(catLabel(f))}</span>`
  };
}

function renderList() {
  const listEl = $('#fileList');
  const empty = $('#emptyState');
  state.filtered = computeFiltered();

  if (!state.scan || !state.files.length) {
    empty.classList.remove('hidden');
    listEl.querySelectorAll('.file-row, .list-tip').forEach((r) => r.remove());
    $('#tableHead').classList.add('hidden');
    return;
  }

  $('#tableHead').classList.remove('hidden');
  empty.classList.add('hidden');

  const shown = state.filtered.slice(0, MAX_RENDER);
  const frag = document.createDocumentFragment();

  for (const f of shown) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.id = f.id;
    if (state.currentId === f.id) row.classList.add('selected');
    if (state.selection.has(f.id)) row.classList.add('checked');

    const cells = rowCells(f);
    row.innerHTML = `
      <span class="col-check"><input type="checkbox" data-id="${esc(f.id)}" ${
      state.selection.has(f.id) ? 'checked' : ''
    }></span>
      ${cells.name}
      ${cells.c3}
      ${cells.c4}
      <div class="size-text">${fmtSize(f.size)}</div>
      <div class="path-text" title="${esc(f.path)}">${esc(f.path)}</div>
    `;
    frag.appendChild(row);
  }

  listEl.querySelectorAll('.file-row, .list-tip').forEach((r) => r.remove());
  listEl.appendChild(frag);

  if (!state.filtered.length) {
    const tip = document.createElement('div');
    tip.className = 'empty-state list-tip';
    if (state.view === 'knowledge') {
      tip.innerHTML = `<h3>${t('list.emptyKnowledge')}</h3><p>${t('list.emptyKnowledgeHint')}</p>`;
    } else if (state.view === 'tools') {
      tip.innerHTML = `<h3>${t('list.emptyTools')}</h3><p>${t('list.emptyToolsHint')}</p>`;
    } else if (state.view === 'duplicates') {
      tip.innerHTML = `<h3>${t('list.emptyDup')}</h3><p>${t('list.emptyDupHint')}</p>`;
    } else {
      tip.innerHTML = `<h3>${t('list.empty')}</h3><p>${t('list.emptyHint')}</p>`;
    }
    listEl.appendChild(tip);
  } else if (state.filtered.length > MAX_RENDER) {
    const tip = document.createElement('div');
    tip.className = 'list-tip';
    tip.style.cssText = 'padding:12px 16px;font-size:12px;color:#98a2b3;text-align:center;';
    tip.textContent = t('list.tooMany', { n: state.filtered.length, max: MAX_RENDER });
    listEl.appendChild(tip);
  }

  updateSelectionUI();
  const q = state.filter.q;
  let status = t('status.count', { n: state.files.length, shown: state.filtered.length });
  if (q && q.length >= 2) {
    if (state.contentSearching) {
      status = t('status.searchingBody', { q, n: state.filtered.length });
    } else if (state.contentHits.size) {
      status = t('status.searchHits', { q, total: state.filtered.length, body: state.contentHits.size });
    } else if (state.contentScanned) {
      status =
        t('status.searchDone', { q, total: state.filtered.length }) +
        (state.contentPartial ? t('status.searchPartial') : t('status.searchFull'));
    }
  }
  $('#statusText').textContent = status;
}

function updateSelectionUI() {
  const n = state.selection.size;
  const total = state.filtered.length;
  const all = $('#selectAll');
  all.checked = n > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
  $('#btnArchive').textContent = n ? `${t('tb.archive')} (${n})` : t('tb.archive');
  $('#btnExport').textContent = n ? `${t('tb.export')} (${n})` : t('tb.export');
}

/* ---------------- 预览 ---------------- */
function currentFile() {
  return state.files.find((f) => f.id === state.currentId) || null;
}

function renderPreviewEmpty() {
  $('#previewEmpty').classList.remove('hidden');
  $('#previewContent').classList.add('hidden');
}

/* ---------------- 自动监控 ---------------- */
function renderWatchDirs() {
  const box = $('#watchDirs');
  if (!box) return;
  const dirs = (state.watch && state.watch.dirs) || [];
  box.innerHTML = dirs
    .map(
      (d, i) =>
        `<div class="watch-dir"><span title="${esc(d)}">${esc(d)}</span><button type="button" data-i="${i}" title="不再盯这个">×</button></div>`
    )
    .join('');
}

function refreshWatchUI() {
  const w = state.watch || { enabled: false, dirs: [] };
  const txt = $('#watchStatusText');
  const btn = $('#btnWatchToggle');
  if (txt) {
    txt.textContent = w.enabled
      ? LANG === 'zh'
        ? `正在盯 ${w.dirs.length} 个文件夹`
        : `Watching ${w.dirs.length} folder(s)`
      : LANG === 'zh'
      ? '未开启'
      : 'Off';
    txt.style.color = w.enabled ? '#059669' : '';
  }
  if (btn) btn.textContent = w.enabled ? (LANG === 'zh' ? '停止监控' : 'Stop') : LANG === 'zh' ? '开启监控' : 'Start';
  renderWatchDirs();

  const bar = $('#watchBar');
  if (bar) {
    if (w.enabled) {
      const total = (w.recent || []).reduce((n, r) => n + (r.count || 0), 0);
      $('#watchBarText').textContent = total
        ? `自动监控中 · 已经发现 ${total} 个新文件，都分好类了`
        : `自动监控中 · 盯着 ${w.dirs.length} 个文件夹，有新文件会提醒你`;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }
  }
  const show = $('#btnWatchShow');
  if (show && w.recent && w.recent.length) show.classList.remove('hidden');
  else if (show) show.classList.add('hidden');
}

async function loadWatchStatus() {
  try {
    const r = await window.api.watchStatus();
    state.watch = { enabled: !!r.enabled, dirs: r.dirs || [], recent: r.recent || [] };
  } catch {
    state.watch = { enabled: false, dirs: [], recent: [] };
  }
  refreshWatchUI();
}

async function toggleWatch() {
  const w = state.watch || {};
  try {
    if (w.enabled) {
      await window.api.watchStop();
      toast(t('msg.watchStopped'));
    } else {
      if (!w.dirs || !w.dirs.length) return toast(t('msg.watchPickFirst'), true);
      const r = await window.api.watchStart(w.dirs);
      if (!r || !r.ok) return toast(t('msg.watchStartFail'), true);
      toast(t('msg.watchStarted', { n: r.dirs.length }));
    }
    await loadWatchStatus();
  } catch (err) {
    toast(t('msg.opFail', { msg: err.message }), true);
  }
}

async function addWatchDir() {
  const r = await window.api.watchPickDir();
  if (!r || !r.ok) return;
  if (state.watch.dirs.includes(r.dir)) return toast(t('msg.watchDup'));
  state.watch.dirs.push(r.dir);
  refreshWatchUI();
  if (state.watch.enabled) {
    const s2 = await window.api.watchStart(state.watch.dirs);
    if (!s2 || !s2.ok) return toast(t('msg.watchUpdateFail'), true);
  }
  await loadWatchStatus();
}

async function selectFile(id) {
  state.currentId = id;
  $$('#fileList .file-row').forEach((r) => r.classList.toggle('selected', r.dataset.id === id));
  const f = currentFile();
  if (!f) return;

  $('#previewEmpty').classList.add('hidden');
  $('#previewContent').classList.remove('hidden');
  $('#previewName').textContent = f.name;
  $('#previewPath').textContent = f.path;
  $('#previewPath').title = f.path;
  $('#aiResult').classList.add('hidden');

  const cat = f.category || {};
  const chips = [
    `<span class="meta-chip">${LANG === 'zh' ? '来源' : 'Source'} <b>${esc(
      sourceName(f)
    )}</b></span>`,
    `<span class="meta-chip">${LANG === 'zh' ? '分类' : 'Category'} <b>${esc(catLabel(f))}</b></span>`,
    `<span class="meta-chip">${LANG === 'zh' ? '建议' : 'Advice'} <b>${esc(keepLabel(f))}</b></span>`,
    `<span class="meta-chip">${LANG === 'zh' ? '大小' : 'Size'} <b>${fmtSize(f.size)}</b></span>`,
    `<span class="meta-chip">${LANG === 'zh' ? '修改' : 'Modified'} <b>${fmtTime(f.mtime)}</b></span>`
  ];
  if (f.duplicate && f.duplicate.isDuplicate) {
    chips.push(
      `<span class="meta-chip" style="color:#dc2626;border-color:#f6d5d5;background:#fef2f2">${t('prev.dupKeep')}<b>${esc(
        f.duplicate.withName || ''
      )}</b></span>`
    );
  }
  if (f.aiSummary) chips.push(`<span class="meta-chip" style="color:#4338ca">${t('prev.summary')} <b>${esc(f.aiSummary)}</b></span>`);
  $('#previewMeta').innerHTML = chips.join('');

  $('#previewText').textContent = t('prev.loading');
  const r = await window.api.preview(f.path);
  if (r && r.ok) {
    const raw = r.text || t('prev.empty');
    const tail = r.truncated ? '\n\n' + t('prev.truncated') : '';
    const q = state.filter.q;
    // 带着搜索词打开时，把命中的词就地标出来，并滚到第一处
    if (q && q.length >= 2 && raw.toLowerCase().includes(q.toLowerCase())) {
      $('#previewText').innerHTML = highlightHit(raw, q) + esc(tail);
      requestAnimationFrame(() => {
        const mark = $('#previewText').querySelector('mark');
        if (mark) mark.scrollIntoView({ block: 'center' });
      });
    } else {
      $('#previewText').textContent = raw + tail;
    }
  } else {
    $('#previewText').textContent = (r && r.error) || t('prev.fail');
  }
}

/* ---------------- 归档 / 一键整理 / 导出 / 清理 ---------------- */
function selectedPaths() {
  return state.files.filter((f) => state.selection.has(f.id)).map((f) => f.path);
}

async function ensureArchiveRoot() {
  let root = state.config && state.config.archiveRoot;
  if (root) return root;
  const docs = (state.appPaths && state.appPaths.documents) || '';
  if (!docs) return '';
  root = `${docs}\\${LANG === 'zh' ? 'AI产出管家归档' : 'AI-Artifacts'}`;
  try {
    await window.api.configPatch({ archiveRoot: root });
    state.config = await window.api.configGet();
  } catch {
    /* 保存失败也让本次整理继续用这个目录 */
  }
  return root;
}

async function doArchive() {
  const paths = selectedPaths();
  if (!paths.length) return toast(t('msg.pickFiles'), true);
  const root = await ensureArchiveRoot();
  if (!root) return toast(t('msg.noArchiveRoot'), true);
  const tip =
    LANG === 'zh'
      ? `把 ${paths.length} 个文件【移动】到：\n${root}\n\n原位置不再保留，会按分类建文件夹。确定吗？`
      : `Move ${paths.length} files to:\n${root}\n\nOriginals will not stay; subfolders are created by category. Continue?`;
  if (!window.confirm(tip)) return;

  try {
    const r = await window.api.archive({ paths, targetDir: root });
    removeFromState(r.done || []);
    toast(t('msg.archiveDone', { ok: r.ok, fail: r.failed.length }));
  } catch (err) {
    toast(t('msg.archiveFail', { msg: err.message }), true);
  }
}

async function archiveCurrent() {
  const f = currentFile();
  if (!f) return;
  const root = await ensureArchiveRoot();
  if (!root) return toast(t('msg.noArchiveRoot'), true);
  try {
    const r = await window.api.archive({ paths: [f.path], targetDir: root });
    if (r.ok) {
      removeFromState(r.done || []);
      toast(t('msg.alreadyArchived'));
    } else {
      toast(t('msg.archiveFail', { msg: (r.failed[0] && r.failed[0].error) || t('msg.unknownReason') }), true);
    }
  } catch (err) {
    toast(t('msg.archiveFail', { msg: err.message }), true);
  }
}

async function doOneClickOrganize() {
  if (!state.files.length) return toast(t('msg.scanFirstTidy'), true);

  const keep = state.files.filter(
    (f) => f.category && (f.category.group === 'knowledge' || f.category.group === 'tool')
  );

  // 只自动处理「完全相同」和规则判定的垃圾；「相似但不完全相同」一律不动，交给用户自己看
  const exactDups = state.files.filter(
    (f) => f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'exact'
  );
  const similarDups = state.files.filter(
    (f) => f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'similar'
  );
  const junk = state.files.filter(
    (f) => f.category && f.category.key === 'junk' && !(f.duplicate && f.duplicate.isDuplicate)
  );

  const trashMap = new Map();
  for (const f of [...exactDups, ...junk]) trashMap.set(f.path, f);
  const keepList = keep.filter((f) => !trashMap.has(f.path));
  const trashList = Array.from(trashMap.values());

  if (!keepList.length && !trashList.length) {
    return toast(similarDups.length ? t('msg.tidyOnlySimilar') : t('msg.tidyNothing'));
  }

  const root = await ensureArchiveRoot();
  if (!root) return toast(t('msg.noArchiveRoot'), true);

  const sample = trashList.slice(0, 5).map((f) => `· ${f.name}`).join('\n');
  const more =
    trashList.length > 5
      ? LANG === 'zh'
        ? `\n…还有 ${trashList.length - 5} 个`
        : `\n…and ${trashList.length - 5} more`
      : '';
  const similarNote = similarDups.length
    ? LANG === 'zh'
      ? `\n\n③ 另外有 ${similarDups.length} 个「相似但不完全相同」的文件，管家不会自动动它们，\n   你可以到「重复文件」页逐个看。`
      : `\n\n3) ${similarDups.length} near-identical files are left alone.\n   Review them yourself in the Duplicates tab.`
    : '';

  const ok = window.confirm(
    LANG === 'zh'
      ? `管家准备这样做：\n\n` +
          `① 把 ${keepList.length} 个「值得留的知识 / 能用的工具」移动到：\n${root}\n\n` +
          `② 把 ${trashList.length} 个「完全相同 / 可以删的」删掉（进 Windows 回收站，能还原）：\n${sample}${more}` +
          similarNote +
          `\n\n确定就点「确定」，不确定就点「取消」。`
      : `Here's the plan:\n\n` +
          `1) Move ${keepList.length} files worth keeping to:\n${root}\n\n` +
          `2) Delete ${trashList.length} identical/disposable files (they go to the Windows Recycle Bin, restorable):\n${sample}${more}` +
          similarNote +
          `\n\nHit OK to proceed, Cancel to stop.`
  );
  if (!ok) return;

  setBusy(true);
  let archived = 0;
  let trashed = 0;
  try {
    if (keepList.length) {
      const r = await window.api.archive({
        paths: keepList.map((f) => f.path),
        targetDir: root
      });
      archived = r.ok;
      removeFromState(r.done || [], false);
    }
    if (trashList.length) {
      const r = await window.api.cleanupTrash({ paths: trashList.map((f) => f.path) });
      trashed = r.ok;
      if (r.done) removeFromState(r.done, false);
      const stuck = (r.failed || []).length;
      if (stuck) {
        toast(
          `有 ${stuck} 个删不掉——U 盘、网络盘、移动硬盘通常没有回收站，管家不敢硬删，已给你留着。`,
          true
        );
      }
    }
    renderAll();
    toast(t('msg.tidyDone', { a: archived, t: trashed }));
  } catch (err) {
    toast(t('msg.tidyFail', { msg: err.message }), true);
  } finally {
    setBusy(false);
  }
}

function removeFromState(doneList, rerender = true) {
  if (!Array.isArray(doneList) || !doneList.length) return;
  const moved = new Set(doneList.map((d) => d.path));
  state.files = state.files.filter((f) => !moved.has(f.path));
  state.selection.clear();
  if (state.currentId && !state.files.some((f) => f.id === state.currentId)) {
    state.currentId = null;
    renderPreviewEmpty();
  }
  if (state.scan) {
    state.scan.files = state.files;
    state.scan.summary = recomputeSummary();
  }
  if (rerender) renderAll();
}

async function doExport() {
  // 没有扫描结果时，点导出应提示先扫描
  if (!state.files.length) return toast(t('msg.scanFirstExport'), true);
  const paths = selectedPaths();
  const list = paths.length ? state.files.filter((f) => state.selection.has(f.id)) : state.filtered;
  if (!list.length) return toast(t('msg.nothingToExport'), true);
  try {
    const out = await window.api.pickSave({
      title: t('msg.exportTitle'),
      defaultName: paths.length
        ? `${LANG === 'zh' ? 'AI产出清单_选中' : 'AI-artifacts-selected'}.md`
        : `${LANG === 'zh' ? 'AI产出清单' : 'AI-artifacts'}.md`,
      filters: [
        { name: t('msg.exportMd'), extensions: ['md'] },
        { name: t('msg.exportCsv'), extensions: ['csv'] }
      ]
    });
    if (!out) return;
    const format = out.toLowerCase().endsWith('.csv') ? 'csv' : 'md';
    const saved = await window.api.exportRun({ format, paths: list.map((f) => f.path), outPath: out });
    toast(t('msg.exported', { path: saved }));
  } catch (err) {
    toast(t('msg.exportFail', { msg: err.message }), true);
  }
}

async function doCleanDuplicates() {
  const exact = state.files.filter(
    (f) => f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'exact'
  );
  const similar = state.files.filter(
    (f) => f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'similar'
  );

  if (!exact.length) {
    if (similar.length) {
      return toast(t('msg.onlySimilarDup', { n: similar.length }));
    }
    return toast(t('msg.noDup'));
  }

  const size = exact.reduce((s, f) => s + f.size, 0);
  const similarNote = similar.length
    ? LANG === 'zh'
      ? `\n\n另有 ${similar.length} 个「相似但不完全相同」的文件，管家不会自动删，你可以到「重复文件」页逐个看。`
      : `\n\nThere are also ${similar.length} near-identical files. They are NOT auto-deleted — review them in the Duplicates tab.`
    : '';
  const ok = window.confirm(
    LANG === 'zh'
      ? `发现 ${exact.length} 个内容完全相同的文件，可释放约 ${fmtSize(size)}。\n\n` +
          `会把多余的删掉（进 Windows 回收站，能在回收站里还原），每组保留一份。${similarNote}\n\n确定吗？`
      : `Found ${exact.length} byte-identical files, about ${fmtSize(size)}.\n\n` +
          `Extras go to the Windows Recycle Bin (restorable); one copy per group is kept.${similarNote}\n\nContinue?`
  );
  if (!ok) return;

  try {
    const r = await window.api.removeDuplicates({ paths: exact.map((f) => f.path), toTrash: true });
    removeFromState(r.done || exact.map((f) => ({ path: f.path })));
    const stuck = (r.failed || []).length;
    if (stuck) {
      toast(
        `删了 ${r.ok} 个，释放约 ${fmtSize(size)}。另外 ${stuck} 个没删成（U 盘/网络盘一般没有回收站，管家不硬删）。`,
        true
      );
    } else {
      toast(t('msg.cleanDone', { n: r.ok, size: fmtSize(size) }));
    }
  } catch (err) {
    toast(t('msg.cleanFail', { msg: err.message }), true);
  }
}

async function openTrash() {
  $('#trashModal').classList.remove('hidden');
  await renderTrash();
}

async function renderTrash() {
  const box = $('#trashList');
  box.innerHTML = '<div class="trash-empty">正在读取…</div>';
  try {
    const batches = await window.api.trashList();
    if (!batches.length) {
      box.innerHTML =
        '<div class="trash-empty">还没有清理过东西。<br /><span class="muted-sm">管家删掉的都会进 Windows 回收站，不会真删。</span></div>';
      return;
    }
    box.innerHTML = batches
      .map(
        (b) => `<div class="trash-batch">
          <div class="trash-batch-head"><span>${fmtTime(b.at)} 清理</span><span>${b.files.length} 个文件</span></div>
          ${b.files
            .map(
              (f) => `<div class="trash-item">
                <div class="ti-main">
                  <div class="ti-name" title="${esc(f.name)}">${esc(f.name)}</div>
                  <div class="ti-path" title="${esc(f.path)}">原来在：${esc(f.path)}</div>
                </div>
                <span class="ti-size">${fmtSize(f.size || 0)}</span>
              </div>`
            )
            .join('')}
        </div>`
      )
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="trash-empty">读取失败：${esc(err.message)}</div>`;
  }
}

function recomputeSummary() {
  const files = state.files;
  const bySource = {};
  const byCategory = {};
  let size = 0;
  let cleanableSize = 0;
  let duplicateSize = 0;

  for (const f of files) {
    size += f.size;
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

    const ck = (f.category && f.category.key) || 'other';
    if (!byCategory[ck]) {
      byCategory[ck] = { key: ck, label: (f.category && f.category.label) || '其他', count: 0, size: 0 };
    }
    byCategory[ck].count += 1;
    byCategory[ck].size += f.size;
    if (ck === 'junk') cleanableSize += f.size;
    if (f.duplicate && f.duplicate.isDuplicate) duplicateSize += f.size;
  }

  return {
    files: files.length,
    size,
    cleanableSize,
    duplicateSize,
    bySource: Object.values(bySource).sort((a, b) => b.size - a.size),
    byCategory: Object.values(byCategory).sort((a, b) => b.size - a.size),
    duplicateStats: { groups: 0, exactFiles: 0, similarFiles: 0, freeableSize: duplicateSize }
  };
}

/* ---------------- AI ---------------- */
function aiConfigured() {
  const ai = state.config && state.config.ai;
  return !!(ai && ai.baseUrl);
}

function ensureAi() {
  if (aiConfigured()) return true;
  toast(t('msg.noAi'));
  return false;
}

/** 第一次用 AI 前说明：内容会发给所配置的 AI 服务，本地模型则不出本机 */
function aiPrivacyConfirmed() {
  try {
    if (localStorage.getItem('aiPrivacyConfirmed') === '1') return true;
    const ok = window.confirm(
      '提醒一下：\n\nAI 摘要 / 起名 / 打标签会把文件开头的内容，发给你在设置里配置的 AI 服务。\n\n如果连的是本机 Ollama 或 LM Studio，内容不出这台电脑；\n如果填的是远程 API，内容会发送到那家服务商。\n\n继续吗？'
    );
    if (ok) localStorage.setItem('aiPrivacyConfirmed', '1');
    return ok;
  } catch {
    return true;
  }
}

async function runAi(kind) {
  const f = currentFile();
  if (!f) return toast(t('msg.pickAFile'), true);
  if (!ensureAi()) return;
  if (!aiPrivacyConfirmed()) return;

  const box = $('#aiResult');
  const labels = {
      summary: LANG === 'zh' ? '生成摘要' : 'summarizing',
      rename: LANG === 'zh' ? '想新名字' : 'suggesting a name',
      tags: LANG === 'zh' ? '打标签' : 'tagging',
      category: LANG === 'zh' ? '复核分类' : 're-checking the category'
    };
  box.classList.remove('hidden');
  box.style.borderColor = '';
  box.style.background = '';
  box.style.color = '';
  box.textContent = LANG === 'zh' ? `AI 正在${labels[kind]}…` : `AI is ${labels[kind]}…`;

  try {
    if (kind === 'summary') {
      const r = await window.api.aiSummarize({ path: f.path });
      f.aiSummary = r.summary;
      box.innerHTML = `<b>${LANG === 'zh' ? '一句话摘要：' : 'Summary:'}</b>${esc(r.summary)}`;
    } else if (kind === 'rename') {
      const r = await window.api.aiRename({ path: f.path });
      box.innerHTML = `<b>${LANG === 'zh' ? '建议文件名：' : 'Suggested name:'}</b>${esc(r.name)}
        <div style="margin-top:8px">
          <button class="btn btn-primary btn-sm" data-ai-action="rename" data-value="${esc(r.name)}">${
        LANG === 'zh' ? '执行重命名' : 'Rename'
      }</button>
          <span style="font-size:11px;color:#7c7fb0;margin-left:6px">${
        LANG === 'zh' ? '只改文件名，不动内容' : 'filename only'
      }</span>
        </div>`;
    } else if (kind === 'tags') {
      const r = await window.api.aiTags({ path: f.path });
      box.innerHTML = `<b>${LANG === 'zh' ? '内容标签：' : 'Tags:'}</b>${r.tags
      .map((tg) => `<span class="meta-chip">${esc(tg)}</span>`)
      .join(' ')}
        <div style="margin-top:8px"><button class="btn btn-primary btn-sm" data-ai-action="tags" data-value="${esc(
          r.tags.join(',')
        )}">保存标签</button></div>`;
    } else if (kind === 'category') {
      const r = await window.api.aiCategory({ path: f.path });
      const map = {
        knowledge: '知识库沉淀（建议长期留存）',
        'tool-common': '常用工具（建议留存到工具库）',
        'tool-onetime': '一次性脚本（可归档或清理）',
        junk: '冗余可删（建议清理）'
      };
      box.innerHTML = r.category
        ? `<b>${LANG === 'zh' ? 'AI 复核结果：' : 'AI suggests:'}</b>${esc(map[r.category] || r.category)}
           <div style="margin-top:8px">
             <button class="btn btn-primary btn-sm" data-ai-action="category" data-value="${esc(r.category)}">${
        LANG === 'zh' ? '应用此分类' : 'Apply'
      }</button>
             <span style="font-size:11px;color:#7c7fb0;margin-left:6px">当前是「${esc(
               f.category ? f.category.label : '—'
             )}」</span>
           </div>`
        : LANG === 'zh' ? 'AI 没给出明确分类，保持原判。' : 'AI had no clear answer — keeping the current category.';
    }
  } catch (err) {
    box.textContent = LANG === 'zh' ? `AI 调用失败：${err.message}` : `AI call failed: ${err.message}`;
    box.style.borderColor = '#f3c9c9';
    box.style.background = '#fef2f2';
    box.style.color = '#b91c1c';
  }
}

async function onAiAction(e) {
  const btn = e.target.closest('[data-ai-action]');
  if (!btn) return;
  const f = currentFile();
  if (!f) return;
  const action = btn.dataset.aiAction;

  try {
    if (action === 'rename') {
      const newName = btn.dataset.value;
      if (
        !window.confirm(
          LANG === 'zh'
            ? `把「${f.name}」改名为「${newName}」？\n\n只改文件名，不动内容。`
            : `Rename "${f.name}" to "${newName}"?\n\nOnly the filename changes; content is untouched.`
        )
      )
        return;
      const r = await window.api.renameFile({ path: f.path, name: newName });
      f.name = r.name;
      f.path = r.path;
      f.ext = (r.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      toast(t('msg.renamed', { name: r.name }));
      renderList();
      selectFile(f.id);
    } else if (action === 'tags') {
      const tags = btn.dataset.value.split(',').map((s) => s.trim()).filter(Boolean);
      await window.api.aiApplyTags({ path: f.path, tags });
      if (!f.category) {
        f.category = { key: 'other', group: 'other', label: '其他文件', retention: '按需留存', reason: '', tags: [] };
      }
      f.category.tags = tags;
      toast(t('msg.tagsSaved'));
      renderList();
      selectFile(f.id);
    } else if (action === 'category') {
      const r = await window.api.aiApplyCategory({ path: f.path, category: btn.dataset.value });
      f.category = r.category;
      toast(t('msg.recategorized', { cat: catLabel(f) }));
      renderAll();
      selectFile(f.id);
    }
  } catch (err) {
    toast(t('msg.opFail', { msg: err.message }), true);
  }
}

async function detectLocalAi() {
  const status = $('#localAiStatus');
  status.textContent = '检测中…';
  status.className = 'inline-status';
  try {
    const list = await window.api.aiDetectLocal();
    state.localAi = list;
    const online = list.filter((x) => x.online);
    status.textContent = online.length ? `发现 ${online.length} 个本地 AI` : '没检测到（确认软件已启动并加载模型）';
    status.className = `inline-status ${online.length ? 'ok' : ''}`;
    renderLocalAi(list);
  } catch (err) {
    status.textContent = `检测失败：${err.message}`;
    status.className = 'inline-status err';
  }
}

function renderLocalAi(list) {
  const box = $('#localAiList');
  if (!list || !list.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = list
    .map((item) => {
      const models = item.models && item.models.length ? item.models.slice(0, 3).join('、') : '未读到模型';
      return `<div class="local-ai-item">
        <div>
          <div class="lai-name"><span class="lai-dot ${item.online ? 'on' : 'off'}"></span>${esc(item.name)}</div>
          <div class="lai-models">${item.online ? esc(models) : '未启动 / 端口没开'}</div>
        </div>
        ${item.online ? `<button class="btn btn-ghost btn-sm" data-use-local="${esc(item.provider)}">用这个</button>` : ''}
      </div>`;
    })
    .join('');

  box.querySelectorAll('[data-use-local]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = state.localAi.find((x) => x.provider === btn.dataset.useLocal);
      if (!item) return;
      const model = item.models && item.models[0] ? item.models[0] : '';
      await window.api.aiSave({ provider: item.provider, baseUrl: item.baseUrl, model, apiKey: '' });
      state.config = await window.api.configGet();
      $('#setAiBaseUrl').value = item.baseUrl;
      $('#setAiModel').value = model;
      $('#setAiKey').value = '';
      toast(`已连上 ${item.name}${model ? `，模型：${model}` : ''}。可以直接用 AI 功能了。`);
    });
  });
}

async function saveAi() {
  const baseUrl = $('#setAiBaseUrl').value.trim();
  const model = $('#setAiModel').value.trim();
  const keyInput = $('#setAiKey').value.trim();
  const patch = { baseUrl, model };
  if (keyInput) patch.apiKey = keyInput;
  try {
    await window.api.aiSave(patch);
    state.config = await window.api.configGet();
    $('#setAiKey').value = '';
    toast(t('msg.aiSaved'));
    $('#aiTestStatus').textContent = '';
  } catch (err) {
    toast(t('msg.saveFail', { msg: err.message }), true);
  }
}

async function testAi() {
  const st = $('#aiTestStatus');
  st.textContent = '测试中…';
  st.className = 'inline-status';
  try {
    const cfg = { baseUrl: $('#setAiBaseUrl').value.trim(), model: $('#setAiModel').value.trim() };
    const keyInput = $('#setAiKey').value.trim();
    if (keyInput) cfg.apiKey = keyInput;
    const r = await window.api.aiTest(cfg);
    st.textContent = `连上了，模型回复：${r.reply || 'OK'}`;
    st.className = 'inline-status ok';
  } catch (err) {
    st.textContent = `连不上：${err.message}`;
    st.className = 'inline-status err';
  }
}

/* ---------------- 设置 ---------------- */
async function openSettings() {
  const c = state.config || (await window.api.configGet());
  state.config = c;

  const langSel = $('#setLang');
  if (langSel) langSel.value = (c.ui && c.ui.lang) || '';
  $('#setArchiveRoot').value = c.archiveRoot || '';
  $('#setMaxDepth').value = c.maxDepth || 14;
  $('#setMaxFiles').value = c.maxFiles || 50000;

  const wl = c.whitelist || [];
  $('#setWhitelist').value = wl.filter((w) => !w.builtin).map((w) => w.value).join('\n');
  renderBuiltinWhitelist(wl.filter((w) => w.builtin));

  $('#setAiBaseUrl').value = (c.ai && c.ai.baseUrl) || '';
  $('#setAiModel').value = (c.ai && c.ai.model) || '';
  $('#setAiKey').value = '';
  $('#setAiKey').placeholder =
    c.ai && c.ai.hasKey ? `已保存（${c.ai.apiKeyMasked || '****'}），留空不改` : 'sk-...（只存本机）';

  $('#settingsModal').classList.remove('hidden');
  refreshCtxStatus();
  refreshMcp();
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
}

function renderBuiltinWhitelist(items) {
  const paths = items.filter((i) => i.type === 'path').map((i) => i.value);
  const exts = items.filter((i) => i.type === 'ext').map((i) => i.value);
  $('#builtinList').innerHTML = `
    <div class="builtin-group"><b>不会扫的目录（${paths.length}）</b><br>${paths.map(esc).join('<br>')}</div>
    <div class="builtin-group"><b>不会扫的文件类型（${exts.length}）</b><br>${exts.map(esc).join(' ')}</div>
  `;
}

async function saveGeneral() {
  const raw = $('#setWhitelist').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const custom = raw.map((v) => ({ type: v.startsWith('.') ? 'ext' : 'path', value: v, builtin: false }));
  const builtin = ((state.config && state.config.whitelist) || []).filter((w) => w.builtin);

  const patch = {
    archiveRoot: $('#setArchiveRoot').value.trim(),
    maxDepth: Number($('#setMaxDepth').value) || 14,
    maxFiles: Number($('#setMaxFiles').value) || 50000,
    whitelist: [...builtin, ...custom]
  };
  try {
    await window.api.configPatch(patch);
    state.config = await window.api.configGet();
    toast(t('msg.settingsSaved'));
  } catch (err) {
    toast(t('msg.saveFail', { msg: err.message }), true);
  }
}

async function refreshCtxStatus() {
  try {
    const r = await window.api.ctxStatus();
    $('#ctxStatus').textContent = r.installed ? '已安装' : '未安装';
    $('#ctxStatus').className = `inline-status ${r.installed ? 'ok' : ''}`;
  } catch {
    $('#ctxStatus').textContent = '检测失败';
  }
}

async function setContextMenu(install) {
  try {
    if (install) await window.api.ctxInstall();
    else await window.api.ctxUninstall();
    await refreshCtxStatus();
    toast(install ? '已安装右键扫描：在资源管理器里右键文件夹试试' : '已卸载右键菜单');
  } catch (err) {
    toast(t('msg.opFail', { msg: err.message }), true);
  }
}

/* ---------------- MCP ---------------- */
async function refreshMcp() {
  try {
    const info = await window.api.mcpInfo();
    state.mcp = info;
    $('#mcpStatus').textContent = info.running ? '运行中' : '未启动';
    $('#mcpStatus').className = `inline-status ${info.running ? 'ok' : ''}`;
    $('#mcpEndpoint').textContent = info.running ? info.endpoint : '—';
    $('#btnMcpToggle').textContent = info.running ? '关闭 MCP' : '开启 MCP';
    $('#btnMcpToggle').className = `btn ${info.running ? 'btn-ghost' : 'btn-primary'} btn-sm`;
    $('#mcpConfigText').textContent = JSON.stringify(info.config.http, null, 2);
  } catch (err) {
    $('#mcpStatus').textContent = `读取失败：${err.message}`;
  }
}

async function toggleMcp() {
  try {
    if (state.mcp && state.mcp.running) {
      await window.api.mcpStop();
      toast(t('msg.mcpOff'));
    } else {
      const r = await window.api.mcpStart();
      toast(`MCP 已开启：${r.endpoint || '端口已监听'}`);
    }
    await refreshMcp();
  } catch (err) {
    toast(`MCP 操作失败：${err.message}`, true);
  }
}

async function copyMcpConfig() {
  const text = $('#mcpConfigText').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast(t('msg.mcpCopied'));
  } catch {
    toast(t('msg.copyFail'), true);
  }
}

/* ---------------- 统计 ---------------- */
function openStats() {
  renderStats();
  renderCharts();
  $('#statsModal').classList.remove('hidden');
}

function closeStats() {
  $('#statsModal').classList.add('hidden');
}

function renderStats() {
  const s = state.scan && state.scan.summary;
  if (!s) {
    $('#statFiles').textContent = '—';
    $('#statSize').textContent = '—';
    $('#statCleanable').textContent = '—';
    $('#statDuplicate').textContent = '—';
    return;
  }
  $('#statFiles').textContent = s.files;
  $('#statSize').textContent = fmtSize(s.size);
  $('#statCleanable').textContent = fmtSize(s.cleanableSize);
  $('#statDuplicate').textContent = fmtSize(s.duplicateSize || 0);
  const ds = s.duplicateStats || {};
  $('#statDuplicateNote').textContent = ds.groups
    ? LANG === 'zh'
      ? `${ds.groups} 组重复 / 相似`
      : `${ds.groups} groups`
    : LANG === 'zh'
    ? '没有发现重复'
    : 'none found';
}

function renderCharts() {
  const s = state.scan && state.scan.summary;
  const sourceEl = $('#sourceChart');
  const catEl = $('#categoryChart');
  if (!sourceEl || !catEl) return;

  if (!s) {
    sourceEl.innerHTML = `<div class="chart-empty">${t('chart.afterScan')}</div>`;
    catEl.innerHTML = `<div class="chart-empty">${t('chart.afterScan')}</div>`;
    return;
  }

  const sources = aiSourceBuckets(s.bySource);
  const total = sources.reduce((n, x) => n + x.count, 0) || 1;
  renderDonut(
    sourceEl,
    sources.map((x) => ({ label: x.label, value: x.count, color: x.color })),
    total
  );

  const cats = (s.byCategory || []).slice(0, 5);
  const catMax = Math.max(...cats.map((x) => x.count), 1);
  renderBars(
    catEl,
    cats.map((x) => ({
      label: LANG !== 'zh' && CAT_KEY[x.key] ? t(CAT_KEY[x.key]) : x.label,
      value: x.count,
      color: CAT_COLORS[x.key] || '#94a3b8',
      ratio: x.count / catMax
    }))
  );
}

function renderDonut(container, items, total) {
  if (!items.length) {
    container.innerHTML = `<div class="chart-empty">${t('chart.noData')}</div>`;
    return;
  }
  const R = 38;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segs = items
    .map((it) => {
      const frac = it.value / total;
      const dash = frac * C;
      const seg = `<circle cx="48" cy="48" r="${R}" fill="none" stroke="${it.color}" stroke-width="14" stroke-dasharray="${dash.toFixed(
        2
      )} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(
        2
      )}" transform="rotate(-90 48 48)"/>`;
      offset += dash;
      return seg;
    })
    .join('');

  const legend = items
    .map(
      (it) => `<div class="legend-item"><span class="legend-dot" style="background:${it.color}"></span><span class="legend-name" title="${esc(
        it.label
      )}">${esc(it.label)}</span><span class="legend-val">${it.value}</span></div>`
    )
    .join('');

  container.innerHTML = `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 96 96" width="108" height="108">${segs}
      <text x="48" y="47" text-anchor="middle" class="donut-center-num">${total}</text>
      <text x="48" y="60" text-anchor="middle" class="donut-center-label">${t('chart.files')}</text>
    </svg>
    <div class="legend">${legend}</div>
  </div>`;
}

function renderBars(container, items) {
  if (!items.length) {
    container.innerHTML = `<div class="chart-empty">${t('chart.noData')}</div>`;
    return;
  }
  container.innerHTML = `<div class="bars">${items
    .map(
      (it) => `<div class="bar-row">
        <span class="bar-label" title="${esc(it.label)}">${esc(it.label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, it.ratio * 100).toFixed(
          1
        )}%;background:${it.color}"></div></div>
        <span class="bar-val">${it.value}</span>
      </div>`
    )
    .join('')}</div>`;
}

/* ---------------- 启动 ---------------- */
init().catch((err) => {
  toast(t('msg.initFail', { msg: err.message }), true);
});
