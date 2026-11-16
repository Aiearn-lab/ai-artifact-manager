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
  view: 'disk',
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
  // v0.8：英文界面入口已移除（代码保留作内部截图用）。默认只认显式保存过的 'en'，
  // 其他一律中文——不再按系统语言自动切英文，小白装完看到的就是中文。
  const saved = state.config && state.config.ui && state.config.ui.lang;
  return saved === 'en' ? 'en' : 'zh';
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
  ['#btnQuickScan', '#btnPickFolder', '#btnEmptyScan'].forEach((sel) => {
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

  // 空间体检页先开箱可用：磁盘容量立刻读出来，体检按钮是可点的
  await loadDiskDrives();

  let info = {};
  try {
    info = await window.api.appInfo();
    $('#statusVersion').textContent = `v${info.version}`;
    $('#aboutVersion').textContent = `v${info.version}`;
  } catch {
    /* ignore */
  }

  try {
    const last = await window.api.lastScan();
    if (last && last.files && last.files.length) applyScan(last);
    // v0.8 M3 开箱即用：装机第一次打开就自动把整台电脑扫一遍（只盘点不动手），
    // 上次被叫停的半截账也不算数；回归测试里关掉，免得把固定样本之外的盘也扫进来。
    if (
      (!last || !(last.files || []).length || (last.summary && last.summary.cancelled)) &&
      info.e2e !== true &&
      (!state.config || !state.config.ui || state.config.ui.autoFullScan !== false)
    ) {
      const disks = await window.api.listDisks();
      const roots = (disks || []).map((d) => d.root).filter(Boolean);
      if (roots.length) scanRoots(roots, t('label.allDisks'));
    }
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
      deduping: t('prog.deduping'),
      diskScan: t('prog.diskScan', { n: p.done || 0 })
    }[p.phase] || t('prog.working');
    if (p.phase === 'diskScan') {
      bar.classList.remove('hidden');
      fill.style.width = '45%';
      $('#statusText').textContent = label;
      return;
    }
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
  // v0.8 小白首屏：空状态「帮我扫一扫」= 全盘扫描入口（和顶部按钮同一个流程），
  // 旧行为只扫桌面/下载/文档——哥哥判过「AI 产出一般不放这几个地方」，废弃。
  $('#btnEmptyScan').addEventListener('click', () => {
    if (state.busy) return;
    openDiskModal();
  });

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

  /* ---- 空间体检 ---- */
  $('#btnDiskScan').addEventListener('click', () => {
    // 体检要数几十万个文件，等不及的时候得能停下来
    if (diskState.busy) {
      diskState.cancelling = true;
      $('#btnDiskScan').textContent = '正在停下…';
      window.api.diskCancel();
      return;
    }
    runDiskScan();
  });

  $('#diskDrives').addEventListener('click', (e) => {
    const card = e.target.closest('.disk-drive');
    if (!card) return;
    diskState.picked = card.dataset.root;
    renderDiskDrives();
  });

  $('#diskGroups').addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const k = toggle.dataset.toggle;
      diskState.open[k] = !diskState.open[k];
      renderDiskGroups(diskState.result);
      return;
    }
    const all = e.target.closest('[data-showall]');
    if (all) {
      diskState.open['all-' + all.dataset.showall] = true;
      renderDiskGroups(diskState.result);
      return;
    }
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) {
      try {
        await window.api.diskReveal(reveal.dataset.reveal);
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  $('#btnDiskOpenReport').addEventListener('click', async () => {
    const text = buildDiskReport();
    if (!text) return;
    try {
      const r = await window.api.diskExport({ text });
      if (r && r.saved) toast('体检结果已存好，可以随时翻出来看');
    } catch (err) {
      toast(`没存成功：${err.message}`, true);
    }
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
  // v0.8：界面语言选择器已移除（英文入口下线），setLang 仅留给内部截图工具调用
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
  $('#btnSlim').addEventListener('click', doSlim);
  $('#btnOpenStash').addEventListener('click', openStashModal);
  // v0.8 M3 小报：月度四个数字 + 一行服务入口
  $('#btnOpenDigest').addEventListener('click', openDigestModal);
  $('#btnCloseDigest').addEventListener('click', closeDigestModal);
  $('#btnCloseDigest2').addEventListener('click', closeDigestModal);
  $('#digestModal').addEventListener('click', (e) => {
    if (e.target === $('#digestModal')) closeDigestModal();
  });
  $('#btnDigestSite').addEventListener('click', () => {
    window.api.openUrl('https://www.zhiweistudio.com.cn');
  });
  $('#btnCloseSlim').addEventListener('click', closeSlimModal);
  $('#btnCloseSlim2').addEventListener('click', closeSlimModal);
  $('#btnSlimRun').addEventListener('click', runSlim);
  $('#btnStashOpen2').addEventListener('click', openStashModal);
  $('#btnCloseStash').addEventListener('click', closeStashModal);
  $('#btnCloseStash2').addEventListener('click', closeStashModal);
  $('#btnStashRestoreAll').addEventListener('click', restoreAllStash);
  $('#btnStashEmpty').addEventListener('click', emptyStash);
  $('#slimModal').addEventListener('click', (e) => {
    if (e.target === $('#slimModal')) closeSlimModal();
  });
  $('#stashModal').addEventListener('click', (e) => {
    if (e.target === $('#stashModal')) closeStashModal();
  });
  $('#slimBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-slim-chain]');
    if (!btn || !tierPlan) return;
    const key = btn.getAttribute('data-slim-chain');
    const act = btn.getAttribute('data-slim-act');
    if (act === 'approve') tierApproved.add(key);
    if (act === 'revoke') tierApproved.delete(key);
    renderSlimBody();
  });
  $('#stashBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stash-restore]');
    if (!btn) return;
    restoreStash([btn.getAttribute('data-stash-restore')]);
  });
  $('#btnArchive').addEventListener('click', doArchive);
  $('#btnUndoArchive').addEventListener('click', doUndoArchive);
  $('#btnExport').addEventListener('click', doExport);
  $('#btnCleanDup').addEventListener('click', doCleanDuplicates);
  $('#btnOpenTrash').addEventListener('click', openTrash);
  $('#btnCloseTidy').addEventListener('click', () => $('#tidyModal').classList.add('hidden'));
  $('#btnTidyCancel').addEventListener('click', () => $('#tidyModal').classList.add('hidden'));
  $('#btnTidyRun').addEventListener('click', runTidyPlan);
  $('#tidyModal').addEventListener('click', (e) => {
    if (e.target === $('#tidyModal')) $('#tidyModal').classList.add('hidden');
  });
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
  $('#btnMarkMine').addEventListener('click', doMarkMine);
  $('#btnAiSummary').addEventListener('click', () => runAi('summary'));
  $('#btnAiRename').addEventListener('click', () => runAi('rename'));
  $('#btnAiTags').addEventListener('click', () => runAi('tags'));
  $('#btnAiCategory').addEventListener('click', () => runAi('category'));
  $('#btnAiAdvise').addEventListener('click', doAiAdvise);
  window.api.onAdviceProgress((p) => {
    if (!state.adviseRunning) return;
    const btn = $('#btnAiAdvise');
    if (btn) btn.textContent = `${LANG === 'zh' ? '建议中' : 'Advising'} ${p.done}/${p.total} · ${LANG === 'zh' ? '点此停止' : 'click to stop'}`;
  });

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
  applyViewVisibility(state.view);
  if (state.view === 'disk') {
    renderDiskView();
    renderNavStats();
    return;
  }
  renderNavStats();
  renderViewSummary();
  renderTabsCounts();
  renderSourceFilter();
  renderTableHead();
  renderList();
  renderCharts();
  renderPreviewEmpty();
  updateAiAdviseBtn();
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
  if (state.view === 'disk') return;
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

  // 空间体检是独立的一页：把文件清单和预览两栏整块收起来，别让小白看着一屏空白
  renderAll();
}

/** 空间体检页与文件清单页互斥显示 */
function applyViewVisibility(view) {
  const isDisk = view === 'disk';
  const listPanel = $('#listPanel');
  const previewPanel = $('#previewPanel');
  const diskPanel = $('#diskPanel');
  if (listPanel) listPanel.classList.toggle('hidden', isDisk);
  if (previewPanel) previewPanel.classList.toggle('hidden', isDisk);
  if (diskPanel) diskPanel.classList.toggle('hidden', !isDisk);
  const scanActions = $('.topbar .scan-actions');
  if (scanActions) scanActions.classList.toggle('hidden', isDisk);
  // 「还没扫描 · N 个文件」是 AI 文件扫描的数字，体检页看了会混淆
  const statsBtn = $('#btnStats');
  if (statsBtn) statsBtn.classList.toggle('hidden', isDisk);
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

  const adviceLabel = { keep: LANG === 'zh' ? '建议留' : 'Keep', clean: LANG === 'zh' ? '建议清' : 'Clean', unsure: '?' };
  const nameCell = `<div class="fname-wrap"><div class="fname">
    <span class="fext ${esc((f.ext || '').replace('.', ''))}">${esc(extLabel)}</span>
    <span class="fname-text" title="${esc(f.name)}">${esc(f.name)}</span>
    ${dup ? `<span class="dup-flag">${LANG === 'zh' ? '重复' : 'Dup'}</span>` : ''}
    ${f.aiAdvice ? `<span class="advice-flag advice-${esc(f.aiAdvice.v)}" title="${LANG === 'zh' ? 'AI 建议（只建议，不执行）' : 'AI suggestion (advice only)'}：${esc(f.aiAdvice.r || '')}">${esc(adviceLabel[f.aiAdvice.v] || '?')}</span>` : ''}
    ${f.mine ? `<span class="mine-flag">${LANG === 'zh' ? '我写的' : 'Mine'}</span>` : ''}
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
    const exact = !!(f.duplicate && f.duplicate.kind === 'exact');
    const auto = exact && autoCleanable(f);
    const flag = auto
      ? `<span class="dup-flag dup-flag-auto" title="${esc(t('dup.autoWhy'))}">${esc(t('dup.auto'))}</span>`
      : `<span class="dup-flag dup-flag-manual" title="${esc(t('dup.manualWhy'))}">${esc(t('dup.manual'))}</span>`;
    return {
      name: nameCell,
      c3: `<span class="cell-num">${exact ? esc(t('dup.exact')) : esc(t('dup.similar', { p: sim }))}</span>${flag}`,
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

/**
 * 这份重复副本会不会被「一键瘦身」自动清掉。
 * 口径与主进程 tiers.basicEligible 一致：确认是 AI 产出、且不在项目文件夹里、没标「我写的」。
 * 不满足的仍然列在「重复文件」页，但只提示、不动手——让用户自己判断。
 */
function autoCleanable(f) {
  if (!f || !f.duplicate || !f.duplicate.isDuplicate) return false;
  if (f.duplicate.kind !== 'exact') return false;
  if (!f.source || f.source.id === 'unknown') return false;
  if (f.mine || f.inProject) return false;
  return true;
}

function renderList() {
  if (state.view === 'disk') {
    $('#tableHead').classList.add('hidden'); // 空间体检页没有表格头
    return;
  }
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

  // 重复文件页：先说清「哪些会被自动清、哪些要你自己判断」，别让人以为工具在装瞎
  if (state.view === 'duplicates' && state.filtered.length) {
    const nAuto = state.filtered.filter(autoCleanable).length;
    const nManual = state.filtered.length - nAuto;
    const note = document.createElement('div');
    note.className = 'list-tip';
    note.style.cssText =
      'padding:10px 16px;font-size:12px;line-height:1.7;color:#667085;background:#f8fafc;border-bottom:1px solid #eef2f6;';
    note.innerHTML =
      esc(t('dup.tip')) +
      `　<b style="color:#0f766e">${t('dup.auto')} ${nAuto}</b> / <b style="color:#98a2b3">${t('dup.manual')} ${nManual}</b>`;
    listEl.appendChild(note);
  }
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
    `<span class="meta-chip">${LANG === 'zh' ? 'AI 工具' : 'Source'} <b>${esc(
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
  if (f.aiAdvice) {
    const av = { keep: ['#15803d', '#f0fdf4', LANG === 'zh' ? '建议留' : 'Keep'], clean: ['#b91c1c', '#fef2f2', LANG === 'zh' ? '建议清' : 'Clean'], unsure: ['#6b7280', '#f3f4f6', LANG === 'zh' ? '看不准' : 'Unsure'] }[f.aiAdvice.v] || ['#6b7280', '#f3f4f6', '?'];
    chips.push(
      `<span class="meta-chip" style="color:${av[0]};background:${av[1]}" title="${LANG === 'zh' ? 'AI 只给建议，不会动文件' : 'AI advice only; nothing is touched'}">AI ${av[2]} <b>${esc(f.aiAdvice.r || '')}</b></span>`
    );
  }
  if (f.mine) {
    chips.push(
      `<span class="meta-chip" style="color:#15803d;border-color:#bbf7d0;background:#f0fdf4">${LANG === 'zh' ? '你写的' : 'Yours'} <b>${LANG === 'zh' ? '自动整理不碰' : 'never auto-touched'}</b></span>`
    );
  }
  if (f.inProject) {
    chips.push(
      `<span class="meta-chip" style="color:#92400e;border-color:#fde68a;background:#fffbeb">${LANG === 'zh' ? '项目内代码' : 'Project code'} <b>${LANG === 'zh' ? '只盘点不搬删' : 'inventory only'}</b></span>`
    );
  }
  $('#previewMeta').innerHTML = chips.join('');
  const mineBtn = $('#btnMarkMine');
  if (mineBtn) mineBtn.textContent = f.mine ? (LANG === 'zh' ? '撤销「我写的」标记' : 'Unmark as mine') : (LANG === 'zh' ? '这是我写的' : 'I wrote this');

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
  root = `${docs}\\${LANG === 'zh' ? 'AI产出管家整理' : 'AI-Artifacts'}`;
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

/** 待确认桶的拦截原因，翻译成人话 */
function tidyWhyText(why) {
  const zh = {
    'source-unknown': '认不出是 AI 产出的：不能证明，就不自动动',
    'low-confidence': '没太大把握：只能你手动确认后再处理',
    mine: '你标过「这是我写的」：任何自动整理都不碰',
    'in-project': '项目内代码：只盘点，不搬不删（搬走会断依赖）'
  };
  const en = {
    'source-unknown': 'Source unverified: not proven AI output',
    'low-confidence': 'Not high-confidence: manual only',
    mine: 'You marked it as yours: never auto-touched',
    'in-project': 'Project code: inventory only, never moved'
  };
  return (LANG === 'zh' ? zh : en)[why] || why;
}

async function doOneClickOrganize() {
  if (!state.files.length) return toast(t('msg.scanFirstTidy'), true);
  setBusy(true);
  let plan;
  try {
    plan = await window.api.tidyPlan();
  } catch (err) {
    setBusy(false);
    return toast(t('msg.tidyFail', { msg: err.message }), true);
  }
  setBusy(false);
  const s = plan.stats;
  if (!s.keep && !s.trash && !s.pending && !s.similar) return toast(t('msg.tidyNothing'));
  openTidyModal(plan);
}

/**
 * 全量清单确认框：默认是「预演」——只看不执行。
 * 要删的每一个文件都列出来、可逐个取消勾选，不再只给 5 个名字盲签。
 */
function openTidyModal(plan) {
  state.tidyPlan = plan;
  const zh = LANG === 'zh';
  $('#tidyTitle').textContent = zh ? '整理预案（预演，未动任何文件）' : 'Tidy plan (dry run, nothing touched)';
  $('#tidyNote').innerHTML = plan.aiOnly
    ? zh
      ? '安全闸已开启：只有<b>确认是 AI 产出、把握大</b>的文件才会自动处理。其余进「待确认」，只能你手动勾。删除一律进 Windows 回收站，可还原；挪走的能一键退回原位。'
      : 'Safety gate ON: only <b>verified AI output we are sure about</b> is auto-processed. Everything else waits for your manual pick. Deletions go to the Recycle Bin; moves can be undone.'
    : zh
      ? '⚠ 安全闸已关闭（调试模式）：认不出是 AI 产出的文件也会被自动处理。'
      : '⚠ Safety gate OFF (debug): unverified files will be auto-processed.';

  const body = $('#tidyBody');
  const sections = [];

  const rowHtml = (f, opts) => {
    const o = opts || {};
    const reason =
      (f.duplicate && f.duplicate.isDuplicate && f.duplicate.kind === 'exact'
        ? zh
          ? `与「${f.duplicate.withName || ''}」完全重复`
          : `Exact duplicate of "${f.duplicate.withName || ''}"`
        : (f.category && f.category.reason) || '');
    return (
      `<div class="trash-item tidy-item${o.pending ? ' tidy-pending' : ''}">` +
      (o.checkbox ? `<input type="checkbox" data-tidy-path="${esc(f.path)}" checked>` : '') +
      `<div class="ti-main"><div class="ti-name">${esc(f.name)}</div>` +
      `<div class="ti-path" title="${esc(f.path)}">${esc(f.path)}</div>` +
      (o.why ? `<div class="tidy-why">${esc(o.why)}</div>` : reason ? `<div class="ti-path">${esc(reason)}</div>` : '') +
      `</div><span class="ti-size">${fmtSize(f.size)}</span></div>`
    );
  };

  if (plan.keep.length) {
    sections.push(
      `<div class="trash-batch"><div class="tidy-section-head">${zh ? '① 整理留存（挪到你选的整理目录）' : '1) Keepers (moved to your tidy folder)'}<span class="ts-count">${plan.keep.length}</span></div>` +
        plan.keep.map((f) => rowHtml(f)).join('') +
        '</div>'
    );
  }
  if (plan.trash.length) {
    sections.push(
      `<div class="trash-batch"><div class="tidy-section-head">${zh ? '② 清理（进 Windows 回收站，可还原）——逐个看过再执行' : '2) Clean (to Recycle Bin, restorable) — review each one'}<span class="ts-count" id="tidyTrashCount">${plan.trash.length}</span></div>` +
        plan.trash.map((f) => rowHtml(f, { checkbox: true })).join('') +
        '</div>'
    );
  }
  if (plan.pending.length) {
    sections.push(
      `<div class="trash-batch"><div class="tidy-section-head">${zh ? '③ 待确认（安全闸拦下，只能手动处理）' : '3) Needs your confirmation (blocked by safety gate)'}<span class="ts-count">${plan.pending.length}</span></div>` +
        plan.pending.map((p) => rowHtml(p.file, { pending: true, why: tidyWhyText(p.why) })).join('') +
        '</div>'
    );
  }
  if (plan.similar.length) {
    sections.push(
      `<div class="trash-batch"><div class="tidy-section-head">${zh ? '④ 相似但不完全相同（永不自动删，去「重复的」页自己看）' : '4) Near-identical (never auto-deleted; review in Duplicates tab)'}<span class="ts-count">${plan.similar.length}</span></div></div>`
    );
  }
  body.innerHTML = sections.join('');

  // 勾选变化实时更新计数，让用户知道勾掉了多少
  body.querySelectorAll('input[data-tidy-path]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const n = body.querySelectorAll('input[data-tidy-path]:checked').length;
      const el = $('#tidyTrashCount');
      if (el) el.textContent = n;
    });
  });

  const canRun = plan.keep.length || plan.trash.length;
  $('#btnTidyRun').disabled = !canRun;
  $('#tidyHint').textContent = canRun
    ? zh
      ? '现在是预演：只看清单，不动任何文件。确认无误再点右边执行。'
      : 'Dry run: nothing is touched until you hit Execute.'
    : zh
      ? '没有可自动执行的项——待确认的请回列表手动勾选处理。'
      : 'Nothing auto-executable — handle pending items manually in the list.';
  $('#tidyModal').classList.remove('hidden');
}

async function runTidyPlan() {
  const plan = state.tidyPlan;
  if (!plan) return;
  const checked = Array.from($('#tidyBody').querySelectorAll('input[data-tidy-path]:checked')).map((cb) =>
    cb.getAttribute('data-tidy-path')
  );
  const keepPaths = plan.keep.map((f) => f.path);
  if (!keepPaths.length && !checked.length) {
    $('#tidyModal').classList.add('hidden');
    return;
  }
  const root = await ensureArchiveRoot();
  if (keepPaths.length && !root) return toast(t('msg.noArchiveRoot'), true);

  $('#tidyModal').classList.add('hidden');
  setBusy(true);
  try {
    const out = await window.api.tidyRun({ keepPaths, trashPaths: checked, targetDir: root });
    if (out.done) removeFromState(out.done, false);
    renderAll();
    toast(t('msg.tidyDone', { a: out.archived, t: out.trashed }));
    const stuck = (out.failed || []).length;
    if (stuck) {
      toast(
        LANG === 'zh'
          ? `有 ${stuck} 个没动成——U 盘、网络盘通常没有回收站，管家不敢硬删，已给你留着。`
          : `${stuck} items were left untouched (no Recycle Bin on removable/network drives).`,
        true
      );
    }
    const blocked = (out.skipped || []).filter((s) => s.reason);
    if (blocked.length) {
      toast(
        LANG === 'zh' ? `${blocked.length} 个被安全闸拦下，未处理。` : `${blocked.length} items blocked by the safety gate.`,
        true
      );
    }
  } catch (err) {
    toast(t('msg.tidyFail', { msg: err.message }), true);
  } finally {
    setBusy(false);
    state.tidyPlan = null;
  }
}

/* ================= v0.8 一键瘦身（三档责任）＋ 回收箱 =================
   一档：逐字节相同的副本，直接删进系统回收站（正本必在）；
   二档：版本链——用户按「组」点头「删旧版本」才删，没点头的一组不动；
   三档：拿不准的只收进回收箱，不删任何东西，随时放回。
   术语对小白全部译成大实话；这套界面不出现哈希/置信/来源等词。 */

let tierPlan = null;
const tierApproved = new Set();
let stashCount = 0;

function closeSlimModal() {
  $('#slimModal').classList.add('hidden');
}

function closeStashModal() {
  $('#stashModal').classList.add('hidden');
}

async function doSlim() {
  if (!state.files.length) return toast(t('msg.scanFirstTidy'), true);
  setBusy(true);
  let plan;
  try {
    plan = await window.api.tierPlan();
  } catch (err) {
    setBusy(false);
    return toast(String((err && err.message) || err), true);
  }
  setBusy(false);
  const s = plan.stats;
  if (!s.dupes && !s.chainCards && !s.stash) return toast('没找到要收拾的，你这挺干净。');
  tierPlan = plan;
  tierApproved.clear();
  $('#slimModal').classList.remove('hidden');
  renderSlimBody();
}

function renderSlimBody() {
  if (!tierPlan) return;
  const s = tierPlan.stats;
  $('#slimNote').innerHTML =
    '工具按「有多少把握」决定动手的轻重：<b>完全相同的重复</b>直接删（删的是副本，正本都还在）；' +
    '<b>同一个文件的多个旧版本</b>要你每组点一下「删旧版本」才删；<b>其余拿不准的</b>只收进回收箱，<b>不删除任何东西</b>，随时放回。';

  const parts = [];
  if (s.dupes) {
    parts.push(
      `<div class="tier-sec"><div class="tidy-section-head">完全重复：${s.dupes} 个副本（约 ${fmtSize(
        s.freedBytes
      )}）</div><div class="tier-sec-body">内容和正本逐字节相同，正本一个都不动。处理时副本直接放进系统回收站，不用你确认每一个。</div></div>`
    );
  }
  if (tierPlan.chains.length) {
    const cards = tierPlan.chains
      .map((c) => {
        const key = `${c.family}|${c.ext}`;
        const on = tierApproved.has(key);
        const olderNames = c.older.map((f) => esc(f.name)).join('、');
        const act = on
          ? `<span class="chain-approved">已选：删掉 ${c.older.length} 个旧版本</span> <button type="button" class="btn btn-ghost btn-sm" data-slim-chain="${esc(
              key
            )}" data-slim-act="revoke">再想想</button>`
          : `<button type="button" class="btn btn-primary btn-sm" data-slim-chain="${esc(
              key
            )}" data-slim-act="approve">删旧版本，留最新</button>`;
        return `<div class="chain-card${on ? ' approved' : ''}">
            <div class="chain-head"><b>${esc(c.family)}${esc(c.ext)}</b><span class="chain-sub">${
          c.memberCount
        } 个版本 · 最新是 ${esc(c.keeper.name)}</span></div>
            <div class="chain-old">旧版本：${olderNames}</div>
            <div class="chain-act">${act}</div>
          </div>`;
      })
      .join('');
    parts.push(
      `<div class="tier-sec"><div class="tidy-section-head">同一个文件攒了多个版本：${s.chainCards} 组（${s.chainOlder} 个旧的）</div>${cards}</div>`
    );
  }
  if (s.stash) {
    parts.push(
      `<div class="tier-sec"><div class="tidy-section-head">拿不准的：${s.stash} 个</div><div class="tier-sec-body">看着像一次性的，但没有百分百把握。收进<b>回收箱</b>（挪出你视线、<b>不删除</b>），点开回收箱随时放回。</div></div>`
    );
  }
  $('#slimBody').innerHTML = parts.join('');

  const olderApproved = tierPlan.chains
    .filter((c) => tierApproved.has(`${c.family}|${c.ext}`))
    .reduce((n, c) => n + c.older.length, 0);
  const total = s.dupes + olderApproved + s.stash;
  $('#slimHint').textContent = `现在：删 ${s.dupes + olderApproved} 个（都进系统回收站）· 收 ${s.stash} 个（不删）。没点头的版本组不会动。`;
  $('#btnSlimRun').textContent = total > 0 ? `处理这 ${total} 个` : '没可处理的';
  $('#btnSlimRun').disabled = total === 0;
}

async function runSlim() {
  if (!tierPlan) return;
  const approvedChains = [...tierApproved];
  setBusy(true);
  let out;
  try {
    out = await window.api.tierRun({ approvedChains });
  } catch (err) {
    setBusy(false);
    return toast('瘦身失败：' + ((err && err.message) || err), true);
  }
  setBusy(false);
  closeSlimModal();
  tierPlan = null;
  try {
    const scan = await window.api.lastScan();
    if (scan && scan.files) applyScan(scan);
  } catch {
    /* 刷新失败不影响结果 */
  }
  const bits = [];
  if (out.dupTrashed) bits.push(`删了 ${out.dupTrashed} 个重复`);
  if (out.chainTrashed) bits.push(`删了 ${out.chainTrashed} 个旧版本`);
  if (out.stashed) bits.push(`收起了 ${out.stashed} 个（没删，回收箱随时放回）`);
  toast('处理好了：' + (bits.join('，') || '其实没什么可动的'));
  if (out.failed && out.failed.length) toast(`有 ${out.failed.length} 个没动成（文件可能已经不在原位置）。`, true);
  if (out.skipped && out.skipped.length) toast(`另有 ${out.skipped.length} 个被保护规则挡下，没碰。`);
}

async function openStashModal() {
  setBusy(true);
  let r;
  try {
    r = await window.api.stashList();
  } catch (err) {
    setBusy(false);
    return toast(String((err && err.message) || err), true);
  }
  setBusy(false);
  renderStashBody(r);
  $('#slimModal').classList.add('hidden');
  $('#stashModal').classList.remove('hidden');
}

function renderStashBody(r) {
  const items = (r && r.items) || [];
  stashCount = items.length;
  const empty = !items.length;
  $('#stashNote').innerHTML = empty
    ? '回收箱是空的。工具只把<b>拿不准</b>的 AI 文件收在这儿——这里的东西<b>永远不会自动删</b>，放不放回、清不清空都由你。'
    : `收着 <b>${items.length}</b> 个（约 ${fmtSize(r.stats.size)}）。放回＝搬回原位置（原位有了同名文件会加个序号，绝不覆盖）；<b>清空才会进系统回收站</b>，在那之前还能救。`;
  $('#stashBody').innerHTML = items
    .map(
      (it) =>
        `<div class="trash-item tidy-item"><span class="stash-name">${esc(it.name || '')}</span><span class="tidy-why">原来在 ${esc(
          it.from || ''
        )}</span><button type="button" class="btn btn-ghost btn-sm" data-stash-restore="${esc(it.id)}">放回</button></div>`
    )
    .join('');
  $('#btnStashRestoreAll').disabled = empty;
  $('#btnStashEmpty').disabled = empty;
}

async function restoreStash(ids) {
  setBusy(true);
  let r;
  try {
    r = await window.api.stashRestore(ids ? { ids } : {});
  } catch (err) {
    setBusy(false);
    return toast('放回失败：' + ((err && err.message) || err), true);
  }
  setBusy(false);
  if (r.ok) toast(`放回了 ${r.ok} 个，回到原来的位置。`);
  else if (r.skipped && r.skipped.length) toast('这几个没放回去：' + (r.skipped[0].reason || ''), true);
  try {
    const [list, scan] = await Promise.all([window.api.stashList(), window.api.lastScan()]);
    renderStashBody(list);
    if (scan && scan.files) applyScan(scan);
  } catch {
    /* ignore */
  }
}

async function restoreAllStash() {
  if (!stashCount) return toast('回收箱是空的。');
  await restoreStash(null);
}

async function emptyStash() {
  if (!stashCount) return toast('回收箱是空的。');
  const sure = window.confirm(
    `清空回收箱？\n里面的 ${stashCount} 个文件会放进 Windows 系统回收站——在你清空系统回收站之前，还能从那儿找回来。\n工具自己不会彻底删除任何文件。`
  );
  if (!sure) return;
  setBusy(true);
  let r;
  try {
    r = await window.api.stashEmpty();
  } catch (err) {
    setBusy(false);
    return toast('清空失败：' + ((err && err.message) || err), true);
  }
  setBusy(false);
  toast(`已把 ${r.ok} 个放进系统回收站。`);
  if (r.failed && r.failed.length) toast(`有 ${r.failed.length} 个没放进去（U 盘/网络盘通常没有回收站），留在回收箱里没动。`, true);
  try {
    renderStashBody(await window.api.stashList());
  } catch {
    /* ignore */
  }
}

async function doUndoArchive() {
  const zh = LANG === 'zh';
  if (
    !window.confirm(
      zh
        ? '把最近一次整理挪走的文件，整批搬回原位置？\n（原位置已有同名文件时会自动加序号，不会覆盖）'
        : 'Move the last archived batch back to original locations?\n(Name collisions get a suffix; nothing is overwritten.)'
    )
  )
    return;
  setBusy(true);
  try {
    const r = await window.api.archiveUndo();
    if (r.empty) return toast(zh ? '没有可退回的整理记录。' : 'No tidy batch to undo.', true);
    toast(
      zh ? `已还原 ${r.ok} 个文件回原位置${r.failed.length ? `，${r.failed.length} 个失败` : ''}。重新扫描即可看到。` : `Restored ${r.ok} files${r.failed.length ? `, ${r.failed.length} failed` : ''}. Rescan to see them.`
    );
  } catch (err) {
    toast(t('msg.archiveFail', { msg: err.message }), true);
  } finally {
    setBusy(false);
  }
}

/** 「这是我写的」：一键打标/撤销，持久化，重扫不抹 */
async function doMarkMine() {
  const f = currentFile();
  if (!f) return;
  const on = !f.mine;
  try {
    const r = await window.api.markMine({ path: f.path, mine: on });
    f.mine = r.mine;
    selectFile(f.id);
    renderAll();
    toast(
      r.mine
        ? LANG === 'zh'
          ? '已标记「这是我写的」：任何自动整理都不会碰它。'
          : 'Marked as yours: auto-tidy will never touch it.'
        : LANG === 'zh'
          ? '已撤销标记。'
          : 'Mark removed.'
    );
  } catch (err) {
    toast(err.message, true);
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

/* ---------------- v0.8 M3 管家小报：本机月度四个数字 + 服务入口 ---------------- */

/** 字节说成人话（和 src/digest.js 同一口径，别让用户看见 B/KB 打架） */
function fmtBytesPlain(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function openDigestModal() {
  $('#digestModal').classList.remove('hidden');
  await renderDigest();
}

function closeDigestModal() {
  $('#digestModal').classList.add('hidden');
}

async function renderDigest() {
  const note = $('#digestNote');
  const cards = $('#digestCards');
  const week = $('#digestWeek');
  note.textContent = '正在算这个月的账…';
  cards.innerHTML = '';
  week.textContent = '';
  try {
    const d = await window.api.digestGet();
    const m = d.month || {};
    note.textContent = d.monthLine || '';
    cards.innerHTML = [
      { n: m.removed || 0, label: '收进回收箱', tip: '随时能放回原位置' },
      { n: m.restored || 0, label: '放回原位', tip: '你反悔了，管家照办' },
      { n: fmtBytesPlain(m.freedBytes || 0), label: '腾出空间', tip: '删掉的都进了系统回收站，还能反悔' },
      { n: m.kept || 0, label: '收进整理目录', tip: '没删，只是挪到了一起' }
    ]
      .map(
        (c) => `<div class="digest-card"><div class="dc-num">${esc(String(c.n))}</div><div class="dc-label">${esc(c.label)}</div><div class="dc-tip">${esc(c.tip)}</div></div>`
      )
      .join('');
    week.textContent = d.trayLine || '';
  } catch (err) {
    note.textContent = `算不出来：${err.message}`;
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
    if (localStorage.getItem('aiPrivacyConfirmed2') === '1') return true;
    const ok = window.confirm(
      '提醒一下：\n\nAI 摘要 / 起名 / 打标签 / 批量建议会把文件开头的内容，发给你在设置里配置的 AI 服务。\n\n如果连的是本机 Ollama 或 LM Studio，内容不出这台电脑；\n如果填的是远程 API，内容会发送到那家服务商。\n\nAI 只给建议，不会自动动任何文件。\n\n继续吗？'
    );
    if (ok) localStorage.setItem('aiPrivacyConfirmed2', '1');
    return ok;
  } catch {
    return true;
  }
}

/** AI 批量建议入口：没配 AI 时整个隐藏（离线基层不需要它） */
function updateAiAdviseBtn() {
  const btn = $('#btnAiAdvise');
  if (!btn) return;
  btn.classList.toggle('hidden', !aiConfigured());
  if (state.adviseRunning) {
    btn.textContent = LANG === 'zh' ? '停止建议' : 'Stop advising';
  } else {
    btn.textContent = LANG === 'zh' ? 'AI 批量建议' : 'AI batch advice';
  }
}

/**
 * AI 批量建议：对当前勾选（没勾就对当前列表）逐个要一句判断。
 * 只写建议列，不改分类、不动文件；哈希缓存命中不重问；中途可停，停了不丢已判的。
 */
async function doAiAdvise() {
  if (state.adviseRunning) {
    await window.api.aiAdviseCancel();
    return;
  }
  if (!state.files.length) return toast(t('msg.scanFirstTidy'), true);
  if (!ensureAi()) return;
  if (!aiPrivacyConfirmed()) return;

  const picked = selectedPaths();
  const targets = picked.length
    ? state.files.filter((f) => state.selection.has(f.id))
    : state.filtered.slice(0, 500); // 没勾就对当前视图，最多 500 个免得本地模型跑一夜
  if (!targets.length) return toast(t('msg.pickFiles'), true);

  state.adviseRunning = true;
  updateAiAdviseBtn();
  try {
    const r = await window.api.aiAdvise({ paths: targets.map((f) => f.path) });
    // 主进程把建议随结果带回来，同步到本地文件对象（分类一个字都不会变）
    const byPath = new Map(state.files.map((f) => [f.path, f]));
    for (const item of r.advice || []) {
      const local = byPath.get(item.path);
      if (local && item.advice) local.aiAdvice = item.advice;
    }
    renderAll();
    if (state.currentId) selectFile(state.currentId);
    const zh = LANG === 'zh';
    toast(
      r.stopped
        ? zh
          ? `已停止：新判 ${r.judged} 个，缓存 ${r.cached} 个，剩下的下次接着判。`
          : `Stopped: ${r.judged} new, ${r.cached} cached. The rest resumes next time.`
        : zh
          ? `建议完成：新判 ${r.judged}，缓存命中 ${r.cached}${r.failed ? `，${r.failed} 个没判成可重试` : ''}。只是建议，文件一个没动。`
          : `Done: ${r.judged} new, ${r.cached} cached${r.failed ? `, ${r.failed} retryable` : ''}. Advice only — nothing touched.`
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.adviseRunning = false;
    updateAiAdviseBtn();
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
        'tool-onetime': '一次性脚本（可整理或清理）',
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

  const langSel = $('#setLang'); // v0.8 起界面已无此控件，留着只为兼容旧截图工具
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

/* ---------------- v0.9 空间体检 ---------------- */
// 这一页只回答一个问题：盘为什么满了。
// 规矩：只统计、不动文件；三档相加必须等于实际占用；不认识的一律「别碰」。
const diskState = {
  drives: [],
  picked: null,
  result: null,
  busy: false,
  cancelling: false,
  open: { safe: true, careful: false, keep: false }
};

const GRADE_META = {
  safe: {
    label: '能安全清掉',
    color: '#10b981',
    head: '装得回来的东西',
    note: '缓存、依赖包、编译产物。删掉之后要用的时候重新装一次、重新编一次就回来了，不影响你任何成果。这一档我们敢给你数字。'
  },
  careful: {
    label: '占地大户',
    color: '#f59e0b',
    head: '占了地方，但你说了算',
    note: '这几块块头最大。我们没把握替你判断能不能删——可能是你留的游戏、聊天记录里的文件、下载的素材。点「打开」看一眼里面是什么，你比我们清楚。我们不给这一档任何清理建议。'
  },
  keep: {
    label: '不用管',
    color: '#94a3b8',
    head: '不该动的',
    note: '系统、程序、游戏本体、照片、源码。这些动了会出事，工具一律不碰。'
  }
};

async function loadDiskDrives() {
  try {
    const list = await window.api.listDisks();
    diskState.drives = (list || []).filter((d) => d && d.root && d.total);
  } catch {
    diskState.drives = [];
  }
  // 默认选中占用率最高的那块盘（用户最可能是这块满了）
  if (!diskState.picked && diskState.drives.length) {
    const hottest = diskState.drives
      .slice()
      .sort((a, b) => (b.total - b.free) / b.total - (a.total - a.free) / a.total)[0];
    diskState.picked = (hottest || diskState.drives[0]).root;
  }
  renderDiskDrives();
}

function renderDiskDrives() {
  const box = $('#diskDrives');
  if (!box) return;
  if (!diskState.drives.length) {
    box.innerHTML = '<div class="disk-drive-loading">没有检测到可用的磁盘</div>';
    const btn = $('#btnDiskScan');
    if (btn) btn.disabled = true;
    return;
  }
  box.innerHTML = diskState.drives
    .map((d) => {
      const used = Math.max(0, (Number(d.total) || 0) - (Number(d.free) || 0));
      const pct = d.total ? (used / d.total) * 100 : 0;
      const hot = pct >= 85 ? ' hot' : '';
      const on = diskState.picked === d.root ? ' on' : '';
      return `<button class="disk-drive${on}" type="button" data-root="${esc(d.root)}">
        <div class="disk-drive-top">
          <span class="disk-drive-name">${esc(d.letter)}: 盘</span>
          <span class="disk-drive-free">剩 ${fmtSize(d.free)}</span>
        </div>
        <div class="disk-drive-bar${hot}"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="disk-drive-sub">已用 ${fmtSize(used)} · 共 ${fmtSize(d.total)}</div>
      </button>`;
    })
    .join('');

  const btn = $('#btnDiskScan');
  if (btn) {
    btn.disabled = !diskState.picked || diskState.cancelling;
    btn.textContent = diskState.busy ? (diskState.cancelling ? '正在停下…' : '停下来') : '体检这块盘';
  }
  const hint = $('#diskPickHint');
  if (hint) hint.textContent = diskState.picked ? `已选 ${String(diskState.picked).replace(/\\$/, '')} 盘` : '下面点一块盘';
}

/** 体检一块盘。只统计体积，一个文件都不动 */
async function runDiskScan() {
  const root = diskState.picked;
  if (!root || diskState.busy) return;
  diskState.busy = true;
  diskState.cancelling = false;
  renderDiskDrives();
  $('#statusText').textContent = `正在数 ${root} 里的文件…（文件多的时候要等十几秒，可以随时点「停下来」）`;
  $('#progressBar').classList.remove('hidden');
  $('#progressFill').style.width = '12%';
  try {
    const res = await window.api.diskScan({ root, maxDepth: 6 });
    diskState.result = res;
    renderDiskView();
    if (res.stopped) {
      toast('停下了，没有动任何文件。想看完整结果再点一次「体检这块盘」');
      $('#statusText').textContent = '体检已停下';
    } else {
      toast(`体检完了：${fmtSize(res.totalSize)}、${res.totalFiles} 个文件`);
      $('#statusText').textContent = '体检完成，没有动任何文件';
    }
  } catch (err) {
    toast(`体检没做成功：${err.message}`, true);
    $('#statusText').textContent = '体检失败';
  } finally {
    diskState.busy = false;
    diskState.cancelling = false;
    $('#progressBar').classList.add('hidden');
    renderDiskDrives();
  }
}

function renderDiskView() {
  const idle = $('#diskIdle');
  const result = $('#diskResult');
  if (!idle || !result) return;
  const has = !!(diskState.result && diskState.result.grades);
  idle.classList.toggle('hidden', has);
  result.classList.toggle('hidden', !has);
  if (has) renderDiskResult();
}

function renderDiskResult() {
  const res = diskState.result;
  if (!res || !res.grades) return;
  const g = res.grades;
  const total = Number(res.totalSize) || 0;
  const grades = ['safe', 'careful', 'keep'];
  const pct = (n) => (total ? (n / total) * 100 : 0);

  // 第一行：这块盘总共多大、多少文件、数了多久
  const totalEl = $('#diskTotal');
  if (totalEl) {
    const secs = res.durationMs ? Math.max(1, Math.round(res.durationMs / 1000)) : 0;
    totalEl.innerHTML = `
      <span class="dt-big">${fmtSize(total)}</span>
      <span>这块盘上一共有这么多东西</span>
      <span class="dt-chip">${(res.totalFiles || 0).toLocaleString()} 个文件</span>
      ${secs ? `<span class="dt-chip">数完花了 ${secs} 秒</span>` : ''}`;
  }

  // 第二行：一条按体积分段的色条
  const barEl = $('#diskBar');
  if (barEl) {
    barEl.innerHTML = grades
      .map((k) => `<span class="seg-${k}" style="width:${pct(g[k].size).toFixed(2)}%" title="${GRADE_META[k].label} ${fmtSize(
        g[k].size
      )}"></span>`)
      .join('');
  }

  // 第三行：图例（每一档多少、多少处）。中间档必须写清「不是都能删」，
  // 否则一个 235GB 的数字摆在「占地大户」后面，小白会以为能清出 235GB。
  const legendEl = $('#diskLegend');
  if (legendEl) {
    const extra = {
      safe: '',
      careful: '<span class="dl-warn">不是都能删，得你自己看一眼</span>',
      keep: ''
    };
    legendEl.innerHTML = grades
      .map(
        (k) =>
          `<span class="disk-legend-item"><span class="disk-legend-dot ${k}"></span>${GRADE_META[k].label} <b>${fmtSize(
            g[k].size
          )}</b> <span class="dl-count">${g[k].count} 处</span>${extra[k]}</span>`
      )
      .join('') + '<span class="disk-legend-item dl-sum">三档相加＝整块盘，不重不漏</span>';
  }

  renderDiskRecycle(res);
  renderDiskGroups(res);
}

function renderDiskRecycle(res) {
  const el = $('#diskRecycle');
  if (!el) return;
  const rb = res.recycleBin;
  if (!rb || !rb.exists || !rb.size) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const top = (rb.byExt || []).slice(0, 3)
    .map((x) => `${esc(x.ext)} ${fmtSize(x.size)}`)
    .join('　');
  el.innerHTML = `
    <div class="rb-main">
      <div class="rb-title">回收站里还躺着 <span class="rb-num">${fmtSize(rb.size)}</span></div>
      <div class="rb-note">${rb.files.toLocaleString()} 个文件已经被删掉了，但空间还没还给你——它们占的就是这块盘。${top ? `主要类型：${top}` : ''}</div>
    </div>
    <button class="btn btn-ghost btn-sm" id="btnDiskOpenTrash" type="button">打开回收站自己看</button>`;
  const btn = $('#btnDiskOpenTrash');
  if (btn) btn.addEventListener('click', () => window.api.openTrash());
}

function renderDiskGroups(res) {
  const box = $('#diskGroups');
  if (!box) return;
  const g = res.grades;
  const root = String(res.root || '');
  box.innerHTML = ['safe', 'careful', 'keep']
    .map((k) => {
      const bucket = g[k];
      const meta = GRADE_META[k];
      const open = diskState.open[k] ? ' open' : '';
      const items = (bucket.items || []).filter((it) => it.size > 0);
      const showAll = diskState.open['all-' + k];
      const shown = showAll ? items : items.slice(0, 12);
      const allPaths = items.map((it) => String(it.path));
      const rows = shown
        .map((it) => {
          const full = String(it.path);
          const rel = full.startsWith(root) ? full.slice(root.length) : full;
          // 只剩下的"本级零散文件"：路径等于上级，写成「xx（本级零散文件）」才不会被误读成整个目录
          const hasDeeper = allPaths.some((p) => p !== full && p.startsWith(full.endsWith('\\') ? full : full + '\\'));
          const label = (rel || it.name || full).replace(/^\\+/, '');
          const name = hasDeeper ? `${label}（本级零散文件）` : label;
          return `<div class="disk-row">
            <div class="dr-path">
              <div class="dr-name">${esc(name || full)}</div>
              <div class="dr-full" title="${esc(full)}">${esc(full)}</div>
            </div>
            <div class="dr-why" title="${esc(it.why || '')}">${esc(it.why || GRADE_META[k].head)}</div>
            <div class="dr-size">${fmtSize(it.size)}</div>
            <button class="btn btn-ghost btn-sm dr-btn" type="button" data-reveal="${esc(full)}">打开</button>
          </div>`;
        })
        .join('');
      const more =
        items.length > 12 && !showAll
          ? `<div class="disk-row-more">还有 ${items.length - 12} 处，合计 ${fmtSize(
              items.slice(12).reduce((n, x) => n + x.size, 0)
            )}　<button class="btn btn-ghost btn-sm" type="button" data-showall="${k}">全部展开</button></div>`
          : '';
      return `<div class="disk-group${open}" data-grade="${k}">
        <div class="disk-group-head" data-toggle="${k}">
          <span class="dg-dot ${k}"></span>
          <span class="dg-name">${meta.label} · ${meta.head}</span>
          <span class="dg-size">${fmtSize(bucket.size)}</span>
          <span class="dg-count">${bucket.count} 处</span>
          <span class="dg-caret">▶</span>
        </div>
        <div class="disk-group-body">
          <div class="disk-group-note">${esc(meta.note)}</div>
          ${rows || '<div class="disk-group-note">这一档没有东西。</div>'}
          ${more}
        </div>
      </div>`;
    })
    .join('');
}

/** 一句话解释为什么这个目录被归到这一档（理由由分类层给，界面不自己猜） */
function whyOf(it, grade) {
  if (it && it.why) return it.why;
  return (GRADE_META[grade] && GRADE_META[grade].head) || '';
}

/** 体检结果导成 Markdown，给用户自己留档或转给别人看 */
function buildDiskReport() {
  const res = diskState.result;
  if (!res || !res.grades) {
    toast('还没有体检结果', true);
    return '';
  }
  const g = res.grades;
  const root = String(res.root || '');
  const lines = [];
  lines.push(`# 磁盘体检 · ${root.replace(/\\$/, '')} 盘`);
  lines.push('');
  lines.push(`- 日期：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 这块盘一共占用：${fmtSize(res.totalSize)}（${(res.totalFiles || 0).toLocaleString()} 个文件）`);
  if (res.recycleBin && res.recycleBin.exists && res.recycleBin.size) {
    lines.push(`- 回收站里还压着：${fmtSize(res.recycleBin.size)}（${res.recycleBin.files.toLocaleString()} 个已删文件）`);
  }
  lines.push('');
  lines.push('## 三档汇总');
  lines.push('');
  lines.push('| 档位 | 体积 | 目录数 | 含义 |');
  lines.push('| --- | --- | --- | --- |');
  for (const k of ['safe', 'careful', 'keep']) {
    lines.push(`| ${GRADE_META[k].label} | ${fmtSize(g[k].size)} | ${g[k].count} | ${GRADE_META[k].head} |`);
  }
  lines.push('');
  lines.push('三档相加正好等于整块盘的占用，没有重复计算。');
  for (const k of ['safe', 'careful', 'keep']) {
    const items = (g[k].items || []).filter((it) => it.size > 0).slice(0, 30);
    if (!items.length) continue;
    lines.push('');
    lines.push(`## ${GRADE_META[k].label}（${fmtSize(g[k].size)}）`);
    lines.push('');
    lines.push(GRADE_META[k].note);
    lines.push('');
    for (const it of items) {
      lines.push(`- \`${it.path}\`　${fmtSize(it.size)}　${whyOf(it, k)}`);
    }
    const rest = (g[k].items || []).filter((it) => it.size > 0).length - items.length;
    if (rest > 0) lines.push(`- ……另有 ${rest} 处未列出`);
  }
  lines.push('');
  lines.push('---');
  lines.push('由 AI产出管家 生成 · 智维工作室 Zhiwei Studio · www.zhiweistudio.com.cn');
  return lines.join('\n');
}

/* ---------------- 启动 ---------------- */
init().catch((err) => {
  toast(t('msg.initFail', { msg: err.message }), true);
});
