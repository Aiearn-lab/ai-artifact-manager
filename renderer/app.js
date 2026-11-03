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
  files: ['', '文件名', 'AI 来源', '分类', '大小', '所在路径'],
  knowledge: ['', '文件名', '主题标签', '字数', '大小', '所在路径'],
  tools: ['', '文件名', '类型', '语言', '大小', '所在路径'],
  duplicates: ['', '文件名', '重复度', '保留哪份', '大小', '所在路径']
};

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
  busy: false
};

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
    scope.textContent = v ? '停止扫描' : '扫描整个电脑';
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
      scanning: '正在看文件…',
      classifying: '正在分类…',
      deduping: '正在找重复内容…'
    }[p.phase] || '处理中…';
    $('#statusText').textContent = p.phase === 'scanning' && p.done ? `已扫描 ${p.done} 个文件…` : label;
  });

  window.api.onAutoScan((dir) => {
    if (!dir) return;
    scanRoots([dir], '指定文件夹');
  });
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  $('#btnScanScope').addEventListener('click', () => {
    if (state.busy) {
      window.api.cancelScan();
      $('#statusText').textContent = '正在停止…';
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
    scanRoots([root], `${root} 全盘`);
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
    renderList();
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
      const dir = await window.api.openTrash();
      toast(`已打开回收站文件夹：${dir}`);
    } catch (err) {
      toast(`打开失败：${err.message}`, true);
    }
  });
  $('#trashList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-restore]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const r = await window.api.trashRestore({ batch: btn.dataset.batch, trashedPath: btn.dataset.trashed });
      toast(`已放回原位置：${r.path}`);
      await renderTrash();
    } catch (err) {
      toast(`放回失败：${err.message}`, true);
      btn.disabled = false;
    }
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
  $('#diskList').innerHTML = '<div class="disk-empty">正在读取磁盘…</div>';
  try {
    const disks = await window.api.listDisks();
    state.disks = disks;
    renderDiskList(disks);
  } catch (err) {
    $('#diskList').innerHTML = `<div class="disk-empty">读取磁盘失败：${esc(err.message)}</div>`;
  }
}

function closeDiskModal() {
  $('#diskModal').classList.add('hidden');
}

function renderDiskList(disks) {
  if (!disks.length) {
    $('#diskList').innerHTML = '<div class="disk-empty">没有找到可扫描的磁盘</div>';
    return;
  }
  $('#diskList').innerHTML = disks
    .map((d) => {
      const used = d.total ? Math.max(2, Math.round(((d.total - d.free) / d.total) * 100)) : 0;
      const sys = d.letter.toUpperCase() === 'C' ? '（系统盘）' : '';
      const sizeText = d.total ? `共 ${fmtSize(d.total)} · 可用 ${fmtSize(d.free)}` : '容量未知';
      return `<button class="disk-item" data-root="${esc(d.root)}" type="button">
        <span class="disk-icon">${esc(d.letter)}:</span>
        <span class="disk-info">
          <span class="disk-name">${esc(d.letter)}: 盘${sys}</span>
          <span class="disk-meta">${sizeText}</span>
          <span class="disk-bar"><span style="width:${used}%"></span></span>
        </span>
        <span class="btn btn-primary btn-sm">扫这个盘</span>
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
  if (!roots.length) return toast('没找到常用文件夹，请用「扫描整个电脑」', true);
  await scanRoots(roots, '桌面 + 下载 + 文档');
}

async function pickFolder() {
  const dir = await window.api.pickFolder();
  if (!dir) return;
  await scanRoots([dir], '指定文件夹');
}

async function scanRoots(roots, label) {
  if (state.busy) return;
  setBusy(true);
  $('#statusText').textContent = `正在扫描${label}…`;
  try {
    const scan = await window.api.scan({ roots });
    applyScan(scan);
    const s = scan.summary || {};
    if (s.cancelled) {
      toast(`扫描已停止，已经找到 ${s.files || 0} 个文件`);
    } else {
      toast(`扫描完成：找到 ${s.files || 0} 个文件，用时 ${((scan.durationMs || 0) / 1000).toFixed(1)} 秒`);
    }
    if (scan.truncated) toast('文件太多，达到上限了。可以在设置里调大「最大文件数」。', true);
  } catch (err) {
    toast(`扫描失败：${err.message}`, true);
    $('#statusText').textContent = '扫描失败';
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
}

function renderNavStats() {
  const s = state.scan && state.scan.summary;
  if (!s) {
    $('#navStats').textContent = '还没有扫描';
    return;
  }
  $('#navStats').textContent = `共 ${s.files} 个 · ${fmtSize(s.size)} · 可清理 ${fmtSize(s.cleanableSize)}`;
}

function baseViewFiles() {
  if (state.view === 'knowledge') return state.files.filter((f) => (f.category && f.category.group) === 'knowledge');
  if (state.view === 'tools') return state.files.filter((f) => (f.category && f.category.group) === 'tool');
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
        <div class="mini-stat"><span class="ms-label">找到的文件</span><span class="ms-value">${
          s ? all.length : 0
        }</span><span class="ms-sub">${s ? `${keep} 个建议留 · ${clean} 个可清理` : '还没扫描'}</span></div>
        <div class="mini-stat"><span class="ms-label">占用空间</span><span class="ms-value">${
          s ? fmtSize(s.size) : '—'
        }</span><span class="ms-sub">AI 产出合计</span></div>
        <div class="mini-stat"><span class="ms-label">可以清理</span><span class="ms-value warn">${
          s ? fmtSize(s.cleanableSize) : '—'
        }</span><span class="ms-sub">草稿 / 空洞 / 重复</span></div>
        <div class="mini-stat"><span class="ms-label">重复可释放</span><span class="ms-value warn">${
          s ? fmtSize(s.duplicateSize || 0) : '—'
        }</span><span class="ms-sub">${groups} 组重复</span></div>
      </div>
      <div class="mini-chart" id="miniChart"></div>
    </div>`;
    renderMiniChart();
    return;
  }

  if (!s) {
    el.innerHTML = '先选一个位置，点「扫描整个电脑」或「一键扫常用位置」';
    return;
  }

  if (state.view === 'knowledge') {
    const list = baseViewFiles();
    const chars = list.reduce((n, f) => n + (f.chars || 0), 0);
    const tags = topTags(list, 5);
    el.innerHTML = `知识库里已经有 <b>${list.length}</b> 份资料，共约 <b>${chars.toLocaleString()}</b> 字${
      tags.length ? `。常见主题：<b>${tags.map(esc).join('、')}</b>` : ''
    }。`;
    return;
  }

  if (state.view === 'tools') {
    const list = baseViewFiles();
    const common = list.filter((f) => f.category && f.category.key === 'tool-common').length;
    const onetime = list.filter((f) => f.category && f.category.key === 'tool-onetime').length;
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
    el.innerHTML = `工具库里 <b>${list.length}</b> 个脚本：常用 <span class="ok">${common}</span> 个、一次性 <span class="warn">${onetime}</span> 个${
      langText ? `。语言：${esc(langText)}` : ''
    }。`;
    return;
  }

  if (state.view === 'duplicates') {
    const list = baseViewFiles();
    const free = list.reduce((n, f) => n + (f.size || 0), 0);
    const groups = (s.duplicateStats && s.duplicateStats.groups) || 0;
    el.innerHTML = `发现 <b>${groups}</b> 组重复，共 <b>${list.length}</b> 个多余文件，处理掉能腾出 <span class="warn">${fmtSize(
      free
    )}</span>。`;
  }
}

function renderMiniChart() {
  const box = document.getElementById('miniChart');
  if (!box) return;
  const s = state.scan && state.scan.summary;

  if (!s || !s.bySource || !s.bySource.length) {
    box.innerHTML = `<svg viewBox="0 0 60 60" width="56" height="56" class="mini-donut"><circle cx="30" cy="30" r="23" fill="none" stroke="#e6ebf5" stroke-width="10"/></svg>
      <div class="mini-legend"><span class="mini-legend-empty">扫描后显示<br>AI 来源分布</span></div>`;
    return;
  }

  const items = (s.bySource || []).slice(0, 4);
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
        }"></span><span class="mini-legend-name">${esc(it.name)}</span><span class="mini-legend-val">${it.count}</span></span>`
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
    sel.innerHTML = '<option value="all">全部来源</option>';
    return;
  }
  const opts = ['<option value="all">全部来源</option>'];
  for (const src of s.bySource || []) {
    opts.push(`<option value="${esc(src.id)}">${esc(src.name)} (${src.count})</option>`);
  }
  sel.innerHTML = opts.join('');
  if (state.filter.source !== 'all' && !(s.bySource || []).some((x) => x.id === state.filter.source)) {
    state.filter.source = 'all';
  }
  sel.value = state.filter.source;
}

function renderTableHead() {
  const cols = VIEW_COLUMNS[state.view] || VIEW_COLUMNS.files;
  $('#tableHead').innerHTML = cols.map((c) => `<span>${esc(c)}</span>`).join('');
}

function computeFiltered() {
  let list = baseViewFiles();
  if (state.view === 'files' && state.filter.cat !== 'all') {
    list = list.filter((f) => catMatch(f, state.filter.cat));
  }
  if (state.filter.source !== 'all') {
    list = list.filter((f) => f.source && f.source.id === state.filter.source);
  }
  if (state.filter.q) {
    const needle = state.filter.q.toLowerCase();
    list = list.filter((f) => {
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

function rowCells(f) {
  const cat = f.category || { key: 'other', label: '其他', retention: '按需留存' };
  const extLabel = (f.ext || '').replace('.', '').slice(0, 5) || 'FILE';
  const dup = f.duplicate && f.duplicate.isDuplicate;

  const nameCell = `<div class="fname">
    <span class="fext ${esc((f.ext || '').replace('.', ''))}">${esc(extLabel)}</span>
    <span class="fname-text" title="${esc(f.name)}">${esc(f.name)}</span>
    ${dup ? '<span class="dup-flag">重复</span>' : ''}
  </div>`;

  if (state.view === 'knowledge') {
    const tags = (cat.tags || []).slice(0, 2);
    return {
      name: nameCell,
      c3: tags.length
        ? tags.map((t) => `<span class="tag-chip" title="${esc(t)}">${esc(t)}</span>`).join('')
        : '<span class="cell-text">—</span>',
      c4: `<span class="cell-num">${(f.chars || 0).toLocaleString()} 字</span>`
    };
  }

  if (state.view === 'tools') {
    return {
      name: nameCell,
      c3: `<span class="cat-badge cat-${esc(cat.key)}">${esc(cat.key === 'tool-common' ? '常用工具' : '一次性脚本')}</span>`,
      c4: `<span class="cell-text">${esc(langOf(f.ext))}</span>`
    };
  }

  if (state.view === 'duplicates') {
    const sim = dup ? Math.round((f.duplicate.similarity || 1) * 100) : 100;
    return {
      name: nameCell,
      c3: `<span class="cell-num">${f.duplicate && f.duplicate.kind === 'exact' ? '完全相同' : `${sim}% 相似`}</span>`,
      c4: `<span class="cell-text" title="${esc((f.duplicate && f.duplicate.withName) || '')}">${esc(
        (f.duplicate && f.duplicate.withName) || '—'
      )}</span>`
    };
  }

  // files
  return {
    name: nameCell,
    c3: `<div class="source-badge"><span class="source-dot" style="background:${esc(
      (f.source && f.source.color) || '#94a3b8'
    )}"></span><span class="source-name">${esc((f.source && f.source.name) || '未识别')}</span></div>`,
    c4: `<span class="cat-badge cat-${esc(cat.key)}">${esc(cat.label || '其他')}</span>`
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
    tip.innerHTML = '<h3>这个筛选下没有文件</h3><p>换个分类、来源，或者清掉搜索词看看。</p>';
    listEl.appendChild(tip);
  } else if (state.filtered.length > MAX_RENDER) {
    const tip = document.createElement('div');
    tip.className = 'list-tip';
    tip.style.cssText = 'padding:12px 16px;font-size:12px;color:#98a2b3;text-align:center;';
    tip.textContent = `共 ${state.filtered.length} 个文件，为保证流畅只显示前 ${MAX_RENDER} 个。用搜索或筛选缩小范围。`;
    listEl.appendChild(tip);
  }

  updateSelectionUI();
  $('#statusText').textContent = `共 ${state.files.length} 个文件 · 当前显示 ${state.filtered.length} 个`;
}

function updateSelectionUI() {
  const n = state.selection.size;
  const total = state.filtered.length;
  const all = $('#selectAll');
  all.checked = n > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
  $('#btnArchive').textContent = n ? `归档 (${n})` : '归档';
  $('#btnExport').textContent = n ? `导出 (${n})` : '导出';
}

/* ---------------- 预览 ---------------- */
function currentFile() {
  return state.files.find((f) => f.id === state.currentId) || null;
}

function renderPreviewEmpty() {
  $('#previewEmpty').classList.remove('hidden');
  $('#previewContent').classList.add('hidden');
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
    `<span class="meta-chip">来源 <b>${esc((f.source && f.source.name) || '未识别')}</b></span>`,
    `<span class="meta-chip">分类 <b>${esc(cat.label || '其他')}</b></span>`,
    `<span class="meta-chip">建议 <b>${esc(cat.retention || '')}</b></span>`,
    `<span class="meta-chip">大小 <b>${fmtSize(f.size)}</b></span>`,
    `<span class="meta-chip">修改 <b>${fmtTime(f.mtime)}</b></span>`
  ];
  if (f.duplicate && f.duplicate.isDuplicate) {
    chips.push(
      `<span class="meta-chip" style="color:#dc2626;border-color:#f6d5d5;background:#fef2f2">重复 · 保留：<b>${esc(
        f.duplicate.withName || ''
      )}</b></span>`
    );
  }
  if (f.aiSummary) chips.push(`<span class="meta-chip" style="color:#4338ca">摘要 <b>${esc(f.aiSummary)}</b></span>`);
  $('#previewMeta').innerHTML = chips.join('');

  $('#previewText').textContent = '读取中…';
  const r = await window.api.preview(f.path);
  if (r && r.ok) {
    $('#previewText').textContent = r.text || '（空文件）';
    if (r.truncated) $('#previewText').textContent += '\n\n…（内容较长，只显示前 30 万字符）';
  } else {
    $('#previewText').textContent = (r && r.error) || '无法预览';
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
  root = `${docs}\\AI产出管家归档`;
  try {
    await window.api.configPatch({ archiveRoot: root });
    state.config = await window.api.configGet();
  } catch {
    /* 保存失败也让本次整理继续用这个目录 */
  }
  return root;
}

function archiveMode() {
  return (state.config && state.config.archiveMode) === 'copy' ? 'copy' : 'move';
}

async function doArchive() {
  const paths = selectedPaths();
  if (!paths.length) return toast('先在左边勾选要归档的文件', true);
  const root = await ensureArchiveRoot();
  if (!root) return toast('没有找到归档目录，请到设置里选一个', true);
  const mode = archiveMode();
  const tip =
    mode === 'copy'
      ? `把 ${paths.length} 个文件【复制】到：\n${root}\n\n原文件会留着。确定吗？`
      : `把 ${paths.length} 个文件【移动】到：\n${root}\n\n原位置不再保留，会按分类建文件夹。确定吗？`;
  if (!window.confirm(tip)) return;

  try {
    const r = await window.api.archive({ paths, targetDir: root, mode });
    removeFromState(mode === 'move' ? r.done || [] : []);
    toast(`归档完成：成功 ${r.ok} 个，失败 ${r.failed.length} 个。`);
  } catch (err) {
    toast(`归档失败：${err.message}`, true);
  }
}

async function archiveCurrent() {
  const f = currentFile();
  if (!f) return;
  const root = await ensureArchiveRoot();
  if (!root) return toast('没有找到归档目录，请到设置里选一个', true);
  try {
    const r = await window.api.archive({ paths: [f.path], targetDir: root, mode: archiveMode() });
    if (r.ok) {
      removeFromState(r.done || []);
      toast('这个文件已经归档好了');
    } else {
      toast('归档失败：' + ((r.failed[0] && r.failed[0].error) || '未知原因'), true);
    }
  } catch (err) {
    toast(`归档失败：${err.message}`, true);
  }
}

async function doOneClickOrganize() {
  if (!state.files.length) return toast('先扫描一次再整理', true);

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
    return toast(similarDups.length ? '没有可自动整理的；有相似文件需要你手动确认' : '没有需要整理的文件，挺干净的');
  }

  const root = await ensureArchiveRoot();
  if (!root) return toast('没有找到归档目录，请到设置里选一个', true);

  const sample = trashList.slice(0, 5).map((f) => `· ${f.name}`).join('\n');
  const more = trashList.length > 5 ? `\n…还有 ${trashList.length - 5} 个` : '';
  const similarNote = similarDups.length
    ? `\n\n③ 另外有 ${similarDups.length} 个「相似但不完全相同」的文件，管家不会自动动它们，\n   你可以到「重复文件」页逐个看。`
    : '';

  const ok = window.confirm(
    `管家准备这样做：\n\n` +
      `① 把 ${keepList.length} 个「值得留的知识 / 能用的工具」移动到：\n${root}\n\n` +
      `② 把 ${trashList.length} 个「完全相同 / 可以删的」移到回收站（之后能一键放回）：\n${sample}${more}` +
      similarNote +
      `\n\n确定就点「确定」，不确定就点「取消」。`
  );
  if (!ok) return;

  setBusy(true);
  let archived = 0;
  let trashed = 0;
  try {
    if (keepList.length) {
      const r = await window.api.archive({
        paths: keepList.map((f) => f.path),
        targetDir: root,
        mode: archiveMode()
      });
      archived = r.ok;
      removeFromState(archiveMode() === 'move' ? r.done || [] : [], false);
    }
    if (trashList.length) {
      const r = await window.api.cleanupTrash({ paths: trashList.map((f) => f.path) });
      trashed = r.ok;
      if (r.done) removeFromState(r.done, false);
    }
    renderAll();
    toast(`整理完成：${archived} 个归档，${trashed} 个移到回收站。想找回点「回收站」。`);
  } catch (err) {
    toast(`整理失败：${err.message}`, true);
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
  if (!state.files.length) return toast('先扫描一次再导出', true);
  const paths = selectedPaths();
  const list = paths.length ? state.files.filter((f) => state.selection.has(f.id)) : state.filtered;
  if (!list.length) return toast('当前没有可导出的文件', true);
  try {
    const out = await window.api.pickSave({
      title: '导出清单',
      defaultName: paths.length ? 'AI产出清单_选中.md' : 'AI产出清单.md',
      filters: [
        { name: 'Markdown 表格', extensions: ['md'] },
        { name: 'CSV（Excel 可打开）', extensions: ['csv'] }
      ]
    });
    if (!out) return;
    const format = out.toLowerCase().endsWith('.csv') ? 'csv' : 'md';
    const saved = await window.api.exportRun({ format, paths: list.map((f) => f.path), outPath: out });
    toast(`已导出：${saved}`);
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
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
      return toast(`没有完全相同的文件；有 ${similar.length} 个相似文件，请到「重复文件」页逐个确认`);
    }
    return toast('没有发现重复文件');
  }

  const size = exact.reduce((s, f) => s + f.size, 0);
  const similarNote = similar.length
    ? `\n\n另有 ${similar.length} 个「相似但不完全相同」的文件，管家不会自动删，你可以到「重复文件」页逐个看。`
    : '';
  const ok = window.confirm(
    `发现 ${exact.length} 个内容完全相同的文件，可释放约 ${fmtSize(size)}。\n\n` +
      `会把多余的移到回收站（能一键放回），每组保留一份。${similarNote}\n\n确定吗？`
  );
  if (!ok) return;

  try {
    const r = await window.api.removeDuplicates({ paths: exact.map((f) => f.path), toTrash: true });
    removeFromState(r.done || exact.map((f) => ({ path: f.path })));
    toast(`已移入回收站 ${r.ok} 个，释放约 ${fmtSize(size)}。点「回收站」可以放回。`);
  } catch (err) {
    toast(`清理失败：${err.message}`, true);
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
      box.innerHTML = '<div class="trash-empty">回收站是空的</div>';
      return;
    }
    box.innerHTML = batches
      .map(
        (b) => `<div class="trash-batch">
          <div class="trash-batch-head"><span>${fmtTime(b.createdAt)} 移入</span><span>${b.files.length} 个文件</span></div>
          ${b.files
            .map(
              (f) => `<div class="trash-item">
                <div class="ti-main">
                  <div class="ti-name" title="${esc(f.name)}">${esc(f.name)}</div>
                  <div class="ti-path" title="${esc(f.originalPath)}">原位置：${esc(f.originalPath)}</div>
                </div>
                <button class="btn btn-ghost btn-sm" data-restore="1" data-batch="${esc(b.id)}" data-trashed="${esc(
                f.trashedPath
              )}">放回去</button>
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
  toast('还没配 AI。打开设置 → AI 接入，先连本地 Ollama，或填自己的 API。');
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
  if (!f) return toast('先选一个文件', true);
  if (!ensureAi()) return;
  if (!aiPrivacyConfirmed()) return;

  const box = $('#aiResult');
  const labels = { summary: '生成摘要', rename: '想新名字', tags: '打标签', category: '复核分类' };
  box.classList.remove('hidden');
  box.style.borderColor = '';
  box.style.background = '';
  box.style.color = '';
  box.textContent = `AI 正在${labels[kind]}…`;

  try {
    if (kind === 'summary') {
      const r = await window.api.aiSummarize({ path: f.path });
      f.aiSummary = r.summary;
      box.innerHTML = `<b>一句话摘要：</b>${esc(r.summary)}`;
    } else if (kind === 'rename') {
      const r = await window.api.aiRename({ path: f.path });
      box.innerHTML = `<b>建议文件名：</b>${esc(r.name)}
        <div style="margin-top:8px">
          <button class="btn btn-primary btn-sm" data-ai-action="rename" data-value="${esc(r.name)}">执行重命名</button>
          <span style="font-size:11px;color:#7c7fb0;margin-left:6px">只改文件名，不动内容</span>
        </div>`;
    } else if (kind === 'tags') {
      const r = await window.api.aiTags({ path: f.path });
      box.innerHTML = `<b>内容标签：</b>${r.tags.map((t) => `<span class="meta-chip">${esc(t)}</span>`).join(' ')}
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
        ? `<b>AI 复核结果：</b>${esc(map[r.category] || r.category)}
           <div style="margin-top:8px">
             <button class="btn btn-primary btn-sm" data-ai-action="category" data-value="${esc(r.category)}">应用此分类</button>
             <span style="font-size:11px;color:#7c7fb0;margin-left:6px">当前是「${esc(
               f.category ? f.category.label : '—'
             )}」</span>
           </div>`
        : 'AI 没给出明确分类，保持原判。';
    }
  } catch (err) {
    box.textContent = `AI 调用失败：${err.message}`;
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
      if (!window.confirm(`把「${f.name}」改名为「${newName}」？\n\n只改文件名，不动内容。`)) return;
      const r = await window.api.renameFile({ path: f.path, name: newName });
      f.name = r.name;
      f.path = r.path;
      f.ext = (r.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      toast(`已改名为：${r.name}`);
      renderList();
      selectFile(f.id);
    } else if (action === 'tags') {
      const tags = btn.dataset.value.split(',').map((s) => s.trim()).filter(Boolean);
      await window.api.aiApplyTags({ path: f.path, tags });
      if (!f.category) {
        f.category = { key: 'other', group: 'other', label: '其他文件', retention: '按需留存', reason: '', tags: [] };
      }
      f.category.tags = tags;
      toast('标签已保存');
      renderList();
      selectFile(f.id);
    } else if (action === 'category') {
      const r = await window.api.aiApplyCategory({ path: f.path, category: btn.dataset.value });
      f.category = r.category;
      toast(`已改成：${r.category.label}`);
      renderAll();
      selectFile(f.id);
    }
  } catch (err) {
    toast(`操作失败：${err.message}`, true);
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
    toast('AI 配置已保存（只存在你本机）');
    $('#aiTestStatus').textContent = '';
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
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

  $('#setArchiveRoot').value = c.archiveRoot || '';
  $('#setArchiveMode').value = c.archiveMode || 'move';
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
    archiveMode: $('#setArchiveMode').value === 'copy' ? 'copy' : 'move',
    maxDepth: Number($('#setMaxDepth').value) || 14,
    maxFiles: Number($('#setMaxFiles').value) || 50000,
    whitelist: [...builtin, ...custom]
  };
  try {
    await window.api.configPatch(patch);
    state.config = await window.api.configGet();
    toast('设置已保存');
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
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
    toast(`操作失败：${err.message}`, true);
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
      toast('MCP 已关闭');
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
    toast('配置已复制，粘贴到 Cursor 的 MCP 设置里');
  } catch {
    toast('复制失败，可以手动选中文本复制', true);
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
  $('#statDuplicateNote').textContent = ds.groups ? `${ds.groups} 组重复 / 相似` : '没有发现重复';
}

function renderCharts() {
  const s = state.scan && state.scan.summary;
  const sourceEl = $('#sourceChart');
  const catEl = $('#categoryChart');
  if (!sourceEl || !catEl) return;

  if (!s) {
    sourceEl.innerHTML = '<div class="chart-empty">扫描后显示</div>';
    catEl.innerHTML = '<div class="chart-empty">扫描后显示</div>';
    return;
  }

  const sources = (s.bySource || []).slice(0, 6);
  const total = sources.reduce((n, x) => n + x.count, 0) || 1;
  renderDonut(sourceEl, sources.map((x) => ({ label: x.name, value: x.count, color: x.color || '#94a3b8' })), total);

  const cats = (s.byCategory || []).slice(0, 5);
  const catMax = Math.max(...cats.map((x) => x.count), 1);
  renderBars(
    catEl,
    cats.map((x) => ({
      label: x.label,
      value: x.count,
      color: CAT_COLORS[x.key] || '#94a3b8',
      ratio: x.count / catMax
    }))
  );
}

function renderDonut(container, items, total) {
  if (!items.length) {
    container.innerHTML = '<div class="chart-empty">没有数据</div>';
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
      <text x="48" y="60" text-anchor="middle" class="donut-center-label">份文件</text>
    </svg>
    <div class="legend">${legend}</div>
  </div>`;
}

function renderBars(container, items) {
  if (!items.length) {
    container.innerHTML = '<div class="chart-empty">没有数据</div>';
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
  toast(`初始化失败：${err.message}`, true);
});
