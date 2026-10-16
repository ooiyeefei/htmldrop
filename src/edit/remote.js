// A session-scoped reviewer gateway. Run a private reverse proxy (for example
// Tailscale Serve) in front of this loopback listener, preserving Host.
// The agent credential is deliberately neither accepted nor sent here.
import { createServer, request } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_TTL = 60 * 60 * 1000;

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function reviewerRoute(path, method, key) {
  if (method === 'GET' && (path === `/s/${key}` || path.startsWith(`/s/${key}/`))) return true;
  if (method === 'GET' && path === `/__edit/events/${key}`) return true;
  if (method === 'GET' && (path === `/api/insights/${key}` || path === `/api/access/${key}`)) return true;
  if (path === `/api/feedback/${key}`) return method === 'GET' || method === 'POST';
  const comment = path.match(new RegExp(`^/api/feedback/${key}/[0-9a-f-]{36}(/reply)?$`));
  if (comment) return comment[1] ? method === 'POST' : method === 'PATCH' || method === 'DELETE';
  const diagram = path.match(new RegExp(`^/api/edit/${key}/diagrams(?:/[^/]+)?(?:/(proposals|comments|export))?$`));
  if (diagram) return method === 'GET' || (method === 'POST' && ['proposals', 'comments'].includes(diagram[1]));
  const edit = path.match(new RegExp(`^/api/edit/${key}/(health|chat|question|message|answer|hold|flush|layout|layout/queue|layout/ignore)$`));
  if (!edit) return false;
  if (method === 'GET') return ['health', 'chat', 'question', 'hold', 'layout'].includes(edit[1]);
  return method === 'POST' && ['message', 'answer', 'hold', 'flush', 'layout', 'layout/queue', 'layout/ignore'].includes(edit[1]);
}

export async function startRemoteGateway({ port = 0, host = '127.0.0.1', publicOrigin, sessionKey, backendPort, backendHost = '127.0.0.1', ttlMs = DEFAULT_TTL } = {}) {
  if (!LOOPBACK.has(host)) throw new Error('Reviewer gateway must bind to loopback');
  if (!/^[a-f0-9]{16}$/.test(sessionKey || '')) throw new Error('Invalid session key');
  if (!LOOPBACK.has(backendHost)) throw new Error('Review backend must be loopback');
  const backendHostname = backendHost === '[::1]' ? '::1' : backendHost;
  const backendAuthority = `${backendHostname === '::1' ? '[::1]' : backendHostname}:${backendPort}`;
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new Error('Invalid backend port');
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('A public origin is required'); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Use an origin without a path, query, or credentials');
  if (origin.protocol !== 'https:' && !LOOPBACK.has(origin.hostname)) throw new Error('Remote review requires HTTPS');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 7 * 24 * 60 * 60 * 1000) throw new Error('Invalid share lifetime (maximum seven days)');
  const externalOrigin = origin.origin;
  const bootstrap = randomBytes(32).toString('base64url');
  const credential = randomBytes(32).toString('base64url');
  const cookieName = origin.protocol === 'https:' ? '__Host-htmldrop-review' : 'htmldrop-review';
  const expiresAt = Date.now() + ttlMs;
  let consumed = false, revoked = false;
  let timer = null, closePromise = null;
  const active = new Set();
  function invalidate() {
    revoked = true;
    for (const { outgoing, res } of active) { outgoing.destroy(); res.destroy(); }
    active.clear();
  }
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    // Never trust Forwarded/X-Forwarded-* as proof of the external authority.
    if (req.headers.host !== origin.host || (req.headers.origin !== undefined && req.headers.origin !== externalOrigin)) { json(res, 403, { error: 'Forbidden origin or host' }); return; }
    if (revoked || Date.now() >= expiresAt) { json(res, 401, { error: 'Share expired or revoked' }); return; }
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { json(res, 400, { error: 'Invalid URL' }); return; }
    if (path === '/__review/bootstrap' && req.method === 'GET') {
      // The fragment is removed before any request or artifact script runs. The
      // public bootstrap shell has no session data and no third-party assets.
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Open private review</title><p id="status">Opening private review…</p><script>(async()=>{const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{const r=await fetch('/__review/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});if(!r.ok)throw Error();location.replace('/s/${sessionKey}/');}catch{document.getElementById('status').textContent='This review link has expired or was already used. Ask for a new link.';}})();</script>`);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers.origin !== externalOrigin || ((req.method !== 'DELETE' || Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding']) && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')))) { json(res, 403, { error: 'Same-origin JSON required' }); return; }
    if (path === '/__review/exchange' && req.method === 'POST') {
      let size = 0, chunks = [];
      try {
        for await (const chunk of req) { size += chunk.length; if (size > 2048) { json(res, 413, { error: 'Payload too large' }); return; } chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (consumed || !equal(body.token, bootstrap)) { json(res, 401, { error: 'Invalid review link' }); return; }
        consumed = true;
        res.setHeader('set-cookie', `${cookieName}=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil((expiresAt - Date.now()) / 1000)}${origin.protocol === 'https:' ? '; Secure' : ''}`);
        json(res, 200, { ok: true });
      } catch { if (!res.headersSent) json(res, 400, { error: 'Invalid request' }); }
      return;
    }
    const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
    if (!cookies.some(c => c.startsWith(`${cookieName}=`) && equal(c.slice(cookieName.length + 1), credential))) { json(res, 401, { error: 'Review authentication required' }); return; }
    if (!reviewerRoute(path, req.method, sessionKey)) { json(res, 404, { error: 'Not found' }); return; }
    const headers = { host: backendAuthority, 'x-htmldrop-reviewer': '1' };
    for (const name of ['content-type', 'content-length', 'x-htmldrop-edit-token', 'last-event-id']) if (req.headers[name]) headers[name] = req.headers[name];
    if (!['GET', 'HEAD'].includes(req.method)) headers.origin = `http://${backendAuthority}`;
    const outgoing = request({ hostname: backendHostname, port: backendPort, method: req.method, path: req.url, headers }, upstream => {
      outgoing.setTimeout(0); // SSE has its own server heartbeats.
      const responseHeaders = {};
      for (const name of ['content-type', 'content-disposition', 'content-security-policy', 'x-content-type-options', 'x-accel-buffering', 'location']) if (upstream.headers[name]) responseHeaders[name] = upstream.headers[name];
      // Redirects from the backend must remain on this gateway/session.
      if (responseHeaders.location && !responseHeaders.location.startsWith(`/s/${sessionKey}/`)) delete responseHeaders.location;
      res.writeHead(upstream.statusCode || 502, responseHeaders);
      upstream.on('error', () => res.destroy());
      upstream.pipe(res);
    });
    const entry = { outgoing, res };
    active.add(entry);
    res.on('close', () => { active.delete(entry); outgoing.destroy(); });
    req.on('aborted', () => outgoing.destroy());
    outgoing.setTimeout(10000, () => outgoing.destroy());
    outgoing.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Review backend unavailable' }); else res.destroy(); });
    req.pipe(outgoing);
  });
  function close() {
    if (closePromise) return closePromise;
    clearTimeout(timer);
    invalidate();
    closePromise = new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    return closePromise;
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  // Expiry releases the port as well as revoking credentials and streams. The
  // same promise makes explicit cleanup after timer-driven close idempotent.
  timer = setTimeout(() => { void close(); }, Math.max(0, expiresAt - Date.now()));
  timer.unref?.();
  return {
    port: server.address().port, host, origin: externalOrigin, expiresAt,
    url: `${externalOrigin}/__review/bootstrap#${bootstrap}`,
    close,
  };
}
