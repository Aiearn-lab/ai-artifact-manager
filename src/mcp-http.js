'use strict';

const http = require('http');
const { createHandler, SERVER_INFO } = require('./mcp-core');

/**
 * 内置 MCP 服务（Streamable HTTP，127.0.0.1 本机监听）。
 * 只监听回环地址，不对局域网/公网开放。
 */
function createMcpHttpServer(options) {
  const opts = options || {};
  const handle = createHandler(opts);
  let server = null;
  let port = 0;

  async function onRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      // 健康检查 / 说明页，真正的 MCP 走 POST
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          server: SERVER_INFO,
          transport: 'streamable-http',
          endpoint: '/mcp',
          message: 'AI工件管家 MCP 服务运行中。把 http://127.0.0.1:' + port + '/mcp 配到支持 MCP 的 AI 工具里。'
        })
      );
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const isBatch = Array.isArray(payload);
      const items = isBatch ? payload : [payload];
      const responses = [];

      for (const item of items) {
        const id = item && Object.prototype.hasOwnProperty.call(item, 'id') ? item.id : undefined;
        const method = item && item.method;

        // 通知类消息没有 id，不返回响应
        if (id === undefined) {
          try {
            if (method) await handle(method, item.params || {});
          } catch {
            /* 通知失败不返回 */
          }
          continue;
        }

        try {
          const result = await handle(method, item.params || {});
          if (result === null) continue;
          responses.push({ jsonrpc: '2.0', id, result });
        } catch (err) {
          responses.push({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: String((err && err.message) || err) }
          });
        }
      }

      if (!responses.length) {
        res.writeHead(202);
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(isBatch ? responses : responses[0]));
    });
  }

  async function start(preferredPort) {
    if (server) return { port, already: true };
    port = Number(preferredPort) || 3927;
    server = http.createServer((req, res) => {
      onRequest(req, res).catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String((err && err.message) || err) }));
        } catch {
          /* ignore */
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

    const addr = server.address();
    port = addr && addr.port ? addr.port : port;
    return { port, already: false };
  }

  async function stop() {
    if (!server) return { stopped: true };
    const s = server;
    server = null;
    await new Promise((resolve) => s.close(() => resolve()));
    return { stopped: true };
  }

  function info() {
    return { running: !!server, port, endpoint: server ? `http://127.0.0.1:${port}/mcp` : '' };
  }

  return { start, stop, info };
}

module.exports = { createMcpHttpServer };
