#!/usr/bin/env node
'use strict';

/**
 * MCP stdio 入口：给 Cursor / Claude Desktop 等支持 stdio 的客户端用。
 * 用法：node mcp-stdio.js [索引文件路径] [默认归档目录]
 */

const readline = require('readline');
const path = require('path');
const { createHandler, SERVER_INFO } = require('./mcp-core');

const indexPath =
  process.argv[2] ||
  process.env.AI_ARTIFACT_INDEX ||
  path.join(process.env.APPDATA || process.cwd(), 'AI工件管家', 'mcp-index.json');

const archiveRoot = process.argv[3] || process.env.AI_ARTIFACT_ARCHIVE || '';

const handle = createHandler({
  indexPath,
  getDefaultArchiveRoot: () => archiveRoot
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;

  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (!hasId) {
    try {
      await handle(msg.method, msg.params || {});
    } catch {
      /* 通知不返回 */
    }
    return;
  }

  try {
    const result = await handle(msg.method, msg.params || {});
    if (result === null) return;
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: String((err && err.message) || err) }
    });
  }
});

process.stderr.write(`[${SERVER_INFO.name}] MCP stdio server ready. index=${indexPath}\n`);
