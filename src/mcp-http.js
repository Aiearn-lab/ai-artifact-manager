'use strict';

const http = require('http');
const { createHandler, SERVER_INFO } = require('./mcp-core');

// 单次批量请求上限：MCP 规范里批量是「几个请求打包」，不是压测工具。
// 不设上限时 500 条 ping 一次就能让主进程同步跑满、返回十几 KB，等于本机自伤。
const MAX_BATCH = 100;

/** 只认本机 Host：防 DNS rebinding（浏览器把 evil.com 解析到 127.0.0.1 后直接打本服务） */
function isLocalHost(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return false;
  let hostname = '';
  try {
    hostname = new URL(`http://${h}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * 内置 MCP 服务（Streamable HTTP，127.0.0.1 本机监听）。
 * 只监听回环地址，不对局域网/公网开放。
 */
function createMcpHttpServer(options) {
  const opts = options || {};
  const handle = createHandler(opts);
  const token = String(opts.token || '');
  let server = null;
  let port = 0;

  async function onRequest(req, res) {
    // 不设 CORS 通配：MCP 客户端是本地进程，不需要浏览器跨域；
    // 关掉后恶意网页无法直接探测/调用本机服务
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, X-Mcp-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Host 必须指向本机：哪怕带了正确 token，来自 evil.example.com 的请求也拒
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden', message: '只接受本机访问（Host 须为 127.0.0.1 / localhost）' }));
      return;
    }

    // 没有 token 一律拒绝（fail-closed）。上层会先自动生成并持久化一个 token；
    // 走到这里还空着，说明调用方没配置好，此时放行等于把本机文件索引开放给任何本地进程
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: 'no_token',
          message: '本机 MCP 服务未配置访问 token，已拒绝。请在软件里开启 MCP 服务（会自动生成 token）。'
        })
      );
      return;
    }

    // 本机鉴权：token 不对一律拒绝，防止本机其他程序乱调
    {
      let provided = '';
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        provided = u.searchParams.get('token') || '';
      } catch {
        provided = '';
      }
      if (!provided) provided = String(req.headers['x-mcp-token'] || '');
      if (provided !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized', message: '需要正确的 token' }));
        return;
      }
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

      if (isBatch && items.length > MAX_BATCH) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: `批量请求最多 ${MAX_BATCH} 条，收到 ${items.length} 条` }
          })
        );
        return;
      }

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
