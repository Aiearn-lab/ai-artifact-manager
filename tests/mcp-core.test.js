'use strict';

// 用 Node 内置测试框架（node:test），不引入任何第三方依赖。
// 覆盖 MCP 暴露的 4 个工具，并校验工具注解符合 MCP 规范。
// 运行：npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHandler, TOOLS, SERVER_INFO, PROTOCOL_VERSION } = require('../src/mcp-core');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiam-test-'));
  const sample = path.join(dir, 'notes.md');
  fs.writeFileSync(sample, '# 测试笔记\n这是 AI 生成的摘要内容。', 'utf8');
  const indexPath = path.join(dir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    root: dir,
    updatedAt: Date.now(),
    files: [{
      name: 'notes.md',
      path: sample,
      size: 42,
      source: 'ai-generated',
      summary: '测试笔记摘要',
      category: { key: 'knowledge', group: 'knowledge', label: '知识库沉淀', retention: '保留', tags: ['笔记'] }
    }]
  }), 'utf8');
  return { dir, sample, indexPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function text(result) {
  return result.content.map((c) => c.text).join('\n');
}

test('initialize 返回协议版本与 serverInfo', async () => {
  const fx = makeFixture();
  try {
    const handle = createHandler({ indexPath: fx.indexPath });
    const r = await handle('initialize', { protocolVersion: PROTOCOL_VERSION });
    assert.equal(r.protocolVersion, PROTOCOL_VERSION);
    assert.equal(r.serverInfo.name, SERVER_INFO.name);
    assert.ok(r.capabilities.tools);
  } finally { fx.cleanup(); }
});

test('tools/list 返回 4 个工具，注解齐全且为布尔值', async () => {
  const fx = makeFixture();
  try {
    const handle = createHandler({ indexPath: fx.indexPath });
    const r = await handle('tools/list', {});
    assert.equal(r.tools.length, 4);
    const expected = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
    for (const tool of r.tools) {
      assert.ok(tool.inputSchema, `${tool.name} 缺 inputSchema`);
      assert.ok(tool.annotations, `${tool.name} 缺 annotations`);
      for (const k of expected) {
        assert.equal(typeof tool.annotations[k], 'boolean', `${tool.name}.${k} 必须是显式布尔值`);
      }
    }
    // 写操作工具必须与只读工具有区分
    const byName = Object.fromEntries(r.tools.map((t) => [t.name, t.annotations]));
    assert.equal(byName.search_files.readOnlyHint, true);
    assert.equal(byName.get_file_summary.readOnlyHint, true);
    assert.equal(byName.list_by_category.readOnlyHint, true);
    assert.equal(byName.archive_files.readOnlyHint, false);
    assert.equal(byName.archive_files.destructiveHint, true);
  } finally { fx.cleanup(); }
});

test('search_files 能按关键词命中索引', async () => {
  const fx = makeFixture();
  try {
    const handle = createHandler({ indexPath: fx.indexPath });
    const hit = await handle('tools/call', { name: 'search_files', arguments: { query: '测试笔记' } });
    assert.ok(text(hit).includes('notes.md'));
    const miss = await handle('tools/call', { name: 'search_files', arguments: { query: '完全不存在的词zzz' } });
    assert.ok(text(miss).includes('没有找到'));
    const empty = await handle('tools/call', { name: 'search_files', arguments: { query: '' } });
    assert.equal(empty.isError, true);
  } finally { fx.cleanup(); }
});

test('get_file_summary 读取索引内文件并拒绝索引外路径', async () => {
  const fx = makeFixture();
  try {
    const handle = createHandler({ indexPath: fx.indexPath });
    const ok = await handle('tools/call', { name: 'get_file_summary', arguments: { path: fx.sample } });
    assert.ok(text(ok).includes('测试笔记'));
    const bad = await handle('tools/call', { name: 'get_file_summary', arguments: { path: 'C:\\不存在的路径\\x.md' } });
    assert.equal(bad.isError, true);
  } finally { fx.cleanup(); }
});

test('list_by_category 正确分类，未知分类直接报错', async () => {
  const fx = makeFixture();
  try {
    const handle = createHandler({ indexPath: fx.indexPath });
    const ok = await handle('tools/call', { name: 'list_by_category', arguments: { category: 'knowledge' } });
    assert.ok(text(ok).includes('notes.md'));
    const bad = await handle('tools/call', { name: 'list_by_category', arguments: { category: 'wrong' } });
    assert.equal(bad.isError, true);
  } finally { fx.cleanup(); }
});

test('archive_files 拒绝索引外路径与越权目标目录（不实际移动文件）', async () => {
  const fx = makeFixture();
  try {
    const handle = createHandler({ indexPath: fx.indexPath, getDefaultArchiveRoot: () => path.join(fx.dir, 'archive') });
    const outside = await handle('tools/call', {
      name: 'archive_files', arguments: { paths: ['C:\\不存在的路径\\x.md'] }
    });
    assert.equal(outside.isError, true);
    const escaped = await handle('tools/call', {
      name: 'archive_files', arguments: { paths: [fx.sample], targetDir: path.join(fx.dir, '别的目录') }
    });
    assert.equal(escaped.isError, true);
    assert.ok(fs.existsSync(fx.sample), '安全拒绝时源文件必须原样保留');
  } finally { fx.cleanup(); }
});
