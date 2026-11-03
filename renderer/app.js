'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const MAX_RENDER = 600;

const CAT_COLORS = {
  knowledge: '#2563eb',
  'tool-common': '#059669',
  'tool-onetime': '#d97706',
  junk: '#dc2626',
  other: '#94a3b8'
};

const state = {
  config: null,
  scan: null,
  files: [],
  filtered: [],
  filter: { cat: 'all', source: 'all', q: '', sort: 'mtime' },
  selection: new Set(),
  currentId: null,
  localAi: [],
  mcp: null,
  busy: false
};

/* ---------------- 工具 ---------------- */
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setBusy(v) {
  state.busy = v;
  $('#btnScan').disabled = v;
  $('#btnScan').textContent = v ? '扫描中…' : '开始扫描';
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bindEvents();

  try {
    state.config = await window.api.configGet();
  } catch (err) {
    toast(`读取设置失败：${err.message}`, true);
  }

  try {
    const info = await window.api.appInfo();
    $('#statusVersion').textContent = `v${info.version}`;
    $('#aboutVersion').textContent = `v${info.version}`;
  } catch {
    /* ignore */
  }

  renderTabs(0, 0, 0, 0, 0, 0);
  renderSourceFilter();

  try {
    const last = await window.api.lastScan();
    if (last && last.files && last.files.length) applyScan(last);
  } catch {
    /* ignore */
  }

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
    const label = { scanning: '正在扫描文件…', classifying: '正在分类…', deduping: '正在比对重复内容…' }[p.phase] || '处理中…';
    $('#statusText').textContent = label;
  });

  window.api.onAutoScan((dir) => {
    if (!dir) return;
    $('#scanPath').value = dir;
    doScan(dir);
  });
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  $('#btnPickFolder').addEventListener('click', pickFolder);
  $('#btnEmptyPick').addEventListener('click', pickFolder);
  $('#btnScan').addEventListener('click', () => {
    const p = $('#scanPath').value.trim();
    if (!p) return pickFolder();
    doScan(p);
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
    if (e.target.checked) {
      for (const f of state.filtered) state.selection.add(f.id);
    } else {
      state.selection.clear();
    }
    renderList();
  });

  const list = $('#fileList');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) return;
    if (e.target.matches('input[type="checkbox"]')) return;
    selectFile(row.dataset.id);
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

  $('#btnArchive').addEventListener('click', doArchive);
  $('#btnExport').addEventListener('click', doExport);
  $('#btnCleanDup').addEventListener('click', doCleanDuplicates);
  $('#btnOpenTrash').addEventListener('click', async () => {
    try {
      const dir = await window.api.openTrash();
      toast(`已打开回收站：${dir}`);
    } catch (err) {
      toast(`打开回收站失败：${err.message}`, true);
    }
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
  $('#btnOpenPro').addEventListener('click', () => {
    $$('#settingsTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'pro'));
    $$('.settings-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === 'pro'));
  });

  $('#btnDetectLocal').addEventListener('click', detectLocalAi);
  $('#btnSaveAi').addEventListener('click', saveAi);
  $('#btnTestAi').addEventListener('click', testAi);

  $('#btnMcpToggle').addEventListener('click', toggleMcp);
  $('#btnCopyMcp').addEventListener('click', copyMcpConfig);

  $('#aiResult').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ai-action]');
    if (!btn) return;
    const f = currentFile();
    if (!f) return;
    const action = btn.dataset.aiAction;

    try {
      if (action === 'rename') {
        const newName = btn.dataset.value;
        if (!window.confirm(`确定把「${f.name}」重命名为「${newName}」吗？\n\n只改文件名，不动内容。`)) return;
        const r = await window.api.renameFile({ path: f.path, name: newName });
        f.name = r.name;
        f.path = r.path;
        f.ext = (r.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        toast(`已重命名为：${r.name}`);
        renderList();
        selectFile(f.id);
      } else if (action === 'tags') {
        const tags = btn.dataset.value.split(',').map((s) => s.trim()).filter(Boolean);
        await window.api.aiApplyTags({ path: f.path, tags });
        if (!f.category) {
          f.category = { key: 'other', group: 'other', label: '其他文件', retention: '按需留存', reason: '', tags: [] };
        }
        f.category.tags = tags;
        toast('标签已保存到文件');
        renderList();
        selectFile(f.id);
      } else if (action === 'category') {
        const r = await window.api.aiApplyCategory({ path: f.path, category: btn.dataset.value });
        f.category = r.category;
        toast(`已应用分类：${r.category.label}`);
        renderAll();
        selectFile(f.id);
      }
    } catch (err) {
      toast(`操作失败：${err.message}`, true);
    }
  });

  $('#btnPreviewOpen').addEventListener('click', () => {
    const f = currentFile();
    if (f) window.api.openFile(f.path);
  });
  $('#btnPreviewReveal').addEventListener('click', () => {
    const f = currentFile();
    if (f) window.api.reveal(f.path);
  });

  $('#btnAiSummary').addEventListener('click', () => runAi('summary'));
  $('#btnAiRename').addEventListener('click', () => runAi('rename'));
  $('#btnAiTags').addEventListener('click', () => runAi('tags'));
  $('#btnAiCategory').addEventListener('click', () => runAi('category'));

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
async function pickFolder() {
  const dir = await window.api.pickFolder();
  if (!dir) return;
  $('#scanPath').value = dir;
  doScan(dir);
}

async function doScan(root) {
  if (state.busy) return;
  setBusy(true);
  $('#statusText').textContent = '正在扫描…';
  try {
    const scan = await window.api.scan({ root });
    applyScan(scan);
    toast(`扫描完成：${scan.summary.files} 个文件，用时 ${(scan.durationMs / 1000).toFixed(1)} 秒`);
    if (scan.truncated) toast('文件数达到上限，结果可能不全。可调大「最大文件数」或缩小扫描范围。', true);
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
  if (scan.root) $('#scanPath').value = scan.root;
  renderAll();
}

function renderAll() {
  renderStats();
  renderCharts();
  renderTabsCounts();
  renderSourceFilter();
  renderList();
  renderPreviewEmpty();
}

/* ---------------- 统计与图表 ---------------- */
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
  $('#statFilesNote').textContent = state.scan.root ? `来自 ${shortPath(state.scan.root)}` : '扫描完成';
  $('#statSize').textContent = fmtSize(s.size);
  $('#statCleanable').textContent = fmtSize(s.cleanableSize);
  $('#statDuplicate').textContent = fmtSize(s.duplicateSize || 0);
  const ds = s.duplicateStats || {};
  $('#statDuplicateNote').textContent = ds.groups ? `${ds.groups} 组重复 / 相似` : '没有发现重复';
}

function shortPath(p) {
  const parts = String(p || '')
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length <= 2) return parts.join('\\');
  const tail = parts.slice(-2).join('\\');
  return tail.length > 26 ? `…${tail.slice(-25)}` : `…\\${tail}`;
}

function renderCharts() {
  const s = state.scan && state.scan.summary;
  const sourceEl = $('#sourceChart');
  const catEl = $('#categoryChart');

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
  renderBars(catEl, cats.map((x) => ({
    label: x.label,
    value: x.count,
    color: CAT_COLORS[x.key] || '#94a3b8',
    ratio: x.count / catMax
  })));
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
      const seg = `<circle cx="48" cy="48" r="${R}" fill="none" stroke="${it.color}" stroke-width="14" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 48 48)"/>`;
      offset += dash;
      return seg;
    })
    .join('');

  const legend = items
    .map(
      (it) => `<div class="legend-item"><span class="legend-dot" style="background:${it.color}"></span><span class="legend-name" title="${esc(it.label)}">${esc(it.label)}</span><span class="legend-val">${it.value}</span></div>`
    )
    .join('');

  container.innerHTML = `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 96 96" width="96" height="96">${segs}
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
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, it.ratio * 100).toFixed(1)}%;background:${it.color}"></div></div>
        <span class="bar-val">${it.value}</span>
      </div>`
    )
    .join('')}</div>`;
}

/* ---------------- 筛选与列表 ---------------- */
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
  renderTabs(files.length, count('knowledge'), count('tool'), count('junk'), dupCount, count('other'));
}

function renderTabs(all, k, t, j, dup, o) {
  $('#tabCountAll').textContent = all;
  $('#tabCountKnowledge').textContent = k;
  $('#tabCountTool').textContent = t;
  $('#tabCountJunk').textContent = j;
  $('#tabCountDup').textContent = dup;
  $('#tabCountOther').textContent = o;
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
    sel.value = 'all';
  } else {
    sel.value = state.filter.source;
  }
}

function computeFiltered() {
  const { cat, source, q, sort } = state.filter;
  let list = state.files.filter((f) => catMatch(f, cat));  if (source !== 'all') list = list.filter((f) => f.source && f.source.id === source);
  if (q) {
    const needle = q.toLowerCase();
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
  }[sort] || ((a, b) => b.mtime - a.mtime);

  return list.sort(cmp);
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

    const cat = f.category || { key: 'other', label: '其他', retention: '按需留存', reason: '' };
    const catClass = `cat-${cat.key}`;
    const retentionClass =
      cat.key === 'junk' ? 'clean' : cat.key === 'knowledge' ? 'keep' : cat.key === 'tool-onetime' ? 'archive' : '';
    const extLabel = (f.ext || '').replace('.', '').slice(0, 5) || 'FILE';
    const dup = f.duplicate && f.duplicate.isDuplicate;

    row.innerHTML = `
      <span class="col-check"><input type="checkbox" data-id="${esc(f.id)}" ${state.selection.has(f.id) ? 'checked' : ''}></span>
      <div class="fname">
        <span class="fext ${esc((f.ext || '').replace('.', ''))}">${esc(extLabel)}</span>
        <span class="fname-text" title="${esc(f.name)}">${esc(f.name)}</span>
        ${dup ? '<span class="dup-flag">重复</span>' : ''}
      </div>
      <div class="source-badge"><span class="source-dot" style="background:${esc((f.source && f.source.color) || '#94a3b8')}"></span><span class="source-name">${esc((f.source && f.source.name) || '未识别')}</span></div>
      <div><span class="cat-badge ${esc(catClass)}">${esc(cat.label || '其他')}</span></div>
      <div class="retention-text ${retentionClass}" title="${esc(cat.reason || '')}">${esc(cat.retention || '')}</div>
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
    tip.innerHTML = '<h3>这个筛选下没有文件</h3><p>换个分类、来源或清掉搜索词看看。</p>';
    listEl.appendChild(tip);
  } else if (state.filtered.length > MAX_RENDER) {
    const tip = document.createElement('div');
    tip.className = 'list-tip';
    tip.style.cssText = 'padding:12px 16px;font-size:11.5px;color:#98a2b3;text-align:center;';
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
  $('#btnArchive').textContent = n ? `归档选中 (${n})` : '归档选中';
  $('#btnExport').textContent = n ? `导出选中 (${n})` : '导出清单';
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
    chips.push(`<span class="meta-chip" style="color:#dc2626;border-color:#f6d5d5;background:#fef2f2">重复 · 保留版本：<b>${esc(f.duplicate.withName || '')}</b></span>`);
  }
  $('#previewMeta').innerHTML = chips.join('');

  $('#previewText').textContent = '读取中…';
  const r = await window.api.preview(f.path);
  if (r && r.ok) {
    $('#previewText').textContent = r.text || '（空文件）';
    if (r.truncated) $('#previewText').textContent += '\n\n…（内容较长，只显示前 30 万字符）';
  } else {
    $('#previewText').textContent = (r && r.error) || '无法预览';
  }

  markCurrentRow();
}

function markCurrentRow() {
  $$('#fileList .file-row').forEach((r) => r.classList.toggle('selected', r.dataset.id === state.currentId));
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

async function runAi(kind) {
  const f = currentFile();
  if (!f) return toast('先选一个文件', true);
  if (!ensureAi()) return;

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
        <div style="margin-top:8px"><button class="btn btn-primary btn-sm" data-ai-action="tags" data-value="${esc(r.tags.join(','))}">保存标签</button></div>`;
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
             <span style="font-size:11px;color:#7c7fb0;margin-left:6px">当前是「${esc(f.category ? f.category.label : '—')}」</span>
           </div>`
        : 'AI 没给出明确分类，保持原判。';
    }
  } catch (err) {
    box.textContent = `AI 调用失败：${err.message}`;
    box.style.borderColor = '#f3c9c9';
    box.style.background = '#fef2f2';
    box.style.color = '#b91c1c';
    setTimeout(() => {
      box.style.borderColor = '';
      box.style.background = '';
      box.style.color = '';
    }, 4000);
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
    const baseUrl = $('#setAiBaseUrl').value.trim();
    const model = $('#setAiModel').value.trim();
    const keyInput = $('#setAiKey').value.trim();
    const cfg = { baseUrl, model };
    if (keyInput) cfg.apiKey = keyInput;
    const r = await window.api.aiTest(cfg);
    st.textContent = `连上了，模型回复：${r.reply || 'OK'}`;
    st.className = 'inline-status ok';
  } catch (err) {
    st.textContent = `连不上：${err.message}`;
    st.className = 'inline-status err';
  }
}

/* ---------------- 归档 / 导出 / 清理 ---------------- */
function selectedPaths() {
  return state.files.filter((f) => state.selection.has(f.id)).map((f) => f.path);
}

async function doArchive() {
  const paths = selectedPaths();
  if (!paths.length) return toast('先在左边勾选要归档的文件', true);
  const root = state.config && state.config.archiveRoot;
  if (!root) {
    toast('还没设归档目录。打开设置 → 常规，选一个默认归档路径。');
    openSettings();
    return;
  }
  const mode = (state.config && state.config.archiveMode) === 'copy' ? 'copy' : 'move';
  const tip =
    mode === 'copy'
      ? `确定把 ${paths.length} 个文件【复制】到归档目录？原文件会留着。`
      : `确定把 ${paths.length} 个文件【剪切】到归档目录？\n\n原位置不再保留，会按分类自动建子文件夹。`;
  if (!window.confirm(tip)) return;

  try {
    const r = await window.api.archive({ paths, targetDir: root, mode });

    // 剪切归档后，文件已经不在原位置了，列表要跟着更新，别留着一堆点开就报错的旧条目
    if (mode === 'move' && Array.isArray(r.done)) {
      const moved = new Set(r.done.map((d) => d.path));
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
      renderAll();
    }

    toast(`归档完成：成功 ${r.ok} 个，失败 ${r.failed.length} 个。${mode === 'copy' ? '原文件仍在原位置。' : '原位置的已移走。'}`);
    $('#statusText').textContent = `已归档到 ${root}`;
  } catch (err) {
    toast(`归档失败：${err.message}`, true);
  }
}

async function doExport() {
  if (!state.files.length) return toast('还没有扫描结果', true);
  const paths = selectedPaths();
  const defaultName = paths.length ? 'AI工件清单_选中.md' : 'AI工件清单.md';
  try {
    const out = await window.api.pickSave({
      title: '导出清单',
      defaultName,
      filters: [
        { name: 'Markdown 表格', extensions: ['md'] },
        { name: 'CSV（Excel 可打开）', extensions: ['csv'] }
      ]
    });
    if (!out) return;
    const format = out.toLowerCase().endsWith('.csv') ? 'csv' : 'md';
    const saved = await window.api.exportRun({ format, paths, outPath: out });
    toast(`已导出：${saved}`);
  } catch (err) {
    toast(`导出失败：${err.message}`, true);
  }
}

async function doCleanDuplicates() {
  const dups = state.files.filter((f) => f.duplicate && f.duplicate.isDuplicate);
  if (!dups.length) return toast('没有发现重复或高度相似的文件');
  const size = dups.reduce((s, f) => s + f.size, 0);
  const ok = window.confirm(
    `发现 ${dups.length} 个重复/相似文件，可释放约 ${fmtSize(size)}。\n\n` +
      `确定要把它们移到软件回收站吗？（不会直接永久删除，之后可从软件的 trash 目录找回）`
  );
  if (!ok) return;

  try {
    const r = await window.api.removeDuplicates({ paths: dups.map((f) => f.path), toTrash: true });
    const removed = new Set(dups.map((f) => f.path));
    state.files = state.files.filter((f) => !removed.has(f.path));
    state.selection.clear();
    if (state.currentId && !state.files.some((f) => f.id === state.currentId)) {
      state.currentId = null;
      renderPreviewEmpty();
    }
    if (state.scan) {
      state.scan.files = state.files;
      state.scan.summary = recomputeSummary();
    }
    renderAll();
    toast(`已移入回收站 ${r.ok} 个，释放 ${fmtSize(size)}`);
  } catch (err) {
    toast(`清理失败：${err.message}`, true);
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
      bySource[sid] = { id: sid, name: (f.source && f.source.name) || '未识别', color: (f.source && f.source.color) || '#94a3b8', count: 0, size: 0 };
    }
    bySource[sid].count += 1;
    bySource[sid].size += f.size;

    const ck = (f.category && f.category.key) || 'other';
    if (!byCategory[ck]) byCategory[ck] = { key: ck, label: (f.category && f.category.label) || '其他', count: 0, size: 0 };
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

/* ---------------- 设置 ---------------- */
async function openSettings() {
  const c = state.config || (await window.api.configGet());
  state.config = c;

  $('#setArchiveRoot').value = c.archiveRoot || '';
  $('#setArchiveMode').value = c.archiveMode || 'move';
  $('#setMaxDepth').value = c.maxDepth || 14;
  $('#setMaxFiles').value = c.maxFiles || 50000;
  $('#setWhitelist').value = (c.whitelist || [])
    .map((w) => w.value)
    .join('\n');

  $('#setAiBaseUrl').value = (c.ai && c.ai.baseUrl) || '';
  $('#setAiModel').value = (c.ai && c.ai.model) || '';
  $('#setAiKey').value = '';
  $('#setAiKey').placeholder = c.ai && c.ai.hasKey ? `已保存（${c.ai.apiKeyMasked || '****'}），留空不改` : 'sk-...（只存本机）';

  $('#settingsModal').classList.remove('hidden');
  refreshCtxStatus();
  refreshMcp();
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
}

async function saveGeneral() {
  const raw = $('#setWhitelist').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const whitelist = raw.map((v) => ({ type: v.startsWith('.') ? 'ext' : 'path', value: v }));
  const patch = {
    archiveRoot: $('#setArchiveRoot').value.trim(),
    archiveMode: $('#setArchiveMode').value === 'move' ? 'move' : 'copy',
    maxDepth: Number($('#setMaxDepth').value) || 14,
    maxFiles: Number($('#setMaxFiles').value) || 50000,
    whitelist
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

/* ---------------- 启动 ---------------- */
init().catch((err) => {
  toast(`初始化失败：${err.message}`, true);
});
