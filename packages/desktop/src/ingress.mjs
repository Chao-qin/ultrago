import { createServer, request } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function authorized(actual, secret) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createIngress({ token, nativeToken, resolve, discover, sample, target: selectedTarget, status, agentEvent, openConnections }) {
  let origin;
  const server = createServer((req, res) => {
    const host = req.headers.host;
    if (host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.url === '/__desktop/discover' || req.url === '/__desktop/mcp') {
      if (req.method !== 'GET' || !authorized(req.headers.authorization, nativeToken)) {
        res.writeHead(401).end('Unauthorized'); return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/__desktop/mcp' ? { url: `${origin}/__bcp/mcp/mcp`, token } : discover())); return;
    }
    if (req.url === '/__desktop/sample' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.end(sample); return;
    }
    if (req.url === '/__desktop/agent' && req.method === 'POST') {
      if (!authorized(req.headers.authorization, nativeToken)) { res.writeHead(401).end('Unauthorized'); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => { size += chunk.length; if (size > 8192) req.destroy(); else chunks.push(chunk); });
      req.on('end', () => {
        try { agentEvent?.(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.writeHead(204).end(); }
        catch { res.writeHead(400).end('Invalid connection event'); }
      });
      return;
    }
    if (!authorized(req.headers.authorization, token)) {
      res.writeHead(401).end('Unauthorized'); return;
    }
    if (req.url === '/__desktop/status' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status?.() || {})); return;
    }
    if (req.url === '/__desktop/open-connections' && req.method === 'POST') {
      if (!openConnections) { res.writeHead(503).end('Desktop unavailable'); return; }
      void Promise.resolve().then(openConnections).then(() => res.writeHead(204).end()).catch(() => res.writeHead(500).end('Connection page unavailable'));
      return;
    }
    const incoming = new URL(req.url || '/', origin);
    const match = /^\/__bcp\/(backend|llm|mcp)(\/|$)/.exec(incoming.pathname);
    const service = match ? match[1] : 'console';
    const policyPath = incoming.pathname.toLowerCase();
    if (req.method !== 'GET' && ((service === 'console' && policyPath.startsWith('/api/llm/admin')) || (service === 'llm' && policyPath.startsWith('/__bcp/llm/admin/')))) {
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: '请在客户端的模型方式中配置云 API。' }));
      return;
    }
    // The coordinator switches browser-tool policy on the backend directly; a proxied caller never may.
    if (service === 'backend' && policyPath.startsWith('/__bcp/backend/internal/browsers/policy')) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: '浏览器能力只能在客户端的准备与连接页面修改。' }));
      return;
    }
    // Installed clients cannot run developer scripts or modify environment files.
    if (service === 'console' && policyPath.startsWith('/api/settings')) {
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: '请在客户端的准备与连接页面管理设置。' }));
      return;
    }
    const endpoint = resolve(service);
    if (!endpoint) { res.writeHead(503).end('Service is not ready'); return; }
    const route = match ? incoming.pathname.slice(match[0].length - (match[2] ? 1 : 0)) || '/' : incoming.pathname;
    let decodedRoute;
    try { decodedRoute = decodeURIComponent(route); }
    catch { res.writeHead(400).end('Invalid path'); return; }
    if (decodedRoute.startsWith('//') || decodedRoute.includes('\\')) { res.writeHead(400).end('Invalid path'); return; }
    const target = new URL(endpoint);
    target.pathname = route;
    target.search = incoming.search;
    // Never forward caller-selected hosts, hop-by-hop headers or stale origins.
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${token}` };
    delete headers.origin;
    delete headers.connection;
    delete headers['proxy-authorization'];
    const upstream = request(target, { method: req.method, headers }, (reply) => {
      res.writeHead(reply.statusCode || 502, reply.headers);
      reply.pipe(res);
      // An upstream that dies mid-response must cut the client off too, or a streamed reply hangs open.
      reply.once('close', () => { if (!reply.complete) res.destroy(); });
    });
    upstream.on('error', () => {
      if (res.writableEnded || res.destroyed) return;
      // Text appended to a reply that already started would make a dead stream look complete.
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502).end('Service unavailable');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    if (service === 'backend' && incoming.pathname === '/__bcp/backend/internal/run' && req.method === 'POST') {
      const browser = selectedTarget?.();
      if (!browser) { upstream.destroy(); res.writeHead(409).end('Select a connected browser first'); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { upstream.destroy(); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          body.target = { kind: browser.kind, instanceId: browser.instanceId };
          if (body.name === 'desktop-readonly-demo') body.params = { ...body.params, sampleUrl: `${origin}/__desktop/sample` };
          const bytes = Buffer.from(JSON.stringify(body));
          upstream.removeHeader('content-length');
          upstream.setHeader('content-length', bytes.length);
          upstream.end(bytes);
        } catch { upstream.destroy(); if (!res.headersSent) res.writeHead(400); res.end('Invalid JSON'); }
      });
    } else req.pipe(upstream);
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}
