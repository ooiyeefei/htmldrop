// The edit-mode local server (node:http, zero extra deps).
//
// It is the Cloudflare Worker's feedback API (worker/src/index.ts) reimplemented
// for localhost, plus the two things a Worker can't do: serve the live file from
// disk and hold a long-poll open for the agent. Concretely it exposes:
//
//   Reviewer-facing (same-origin as the served page, so the widget just works):
//     GET  /s/:key/                 → the artifact + injected widget + runtime
//     GET  /s/:key/<asset>          → sibling assets (path-traversal guarded)
//     GET  /api/feedback/:key       → list comments        (?since= supported)
//     POST /api/feedback/:key       → add a comment
//     POST /api/feedback/:key/:id/reply
//     DELETE/PATCH /api/feedback/:key/:id
//     GET  /api/insights/:key       → {} (no local AI insights)
//     GET  /api/access/:key         → {scheme:'open'} (no gate locally)
//     GET  /__edit/events/:key      → SSE: reload + presence
//
//   Agent-facing:
//     GET  /api/poll?file=...       → long-poll; returns new comments in batches
//
//   Control:
//     GET /health, POST /__edit/sessions, POST /__edit/:key/end, POST /shutdown
//
// The whole thing is one request handler and an EventEmitter — no web framework,
// just Node built-ins.

import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { injectFeedbackWidget } from '../feedback/inject.js';
import { injectEditRuntime } from './runtime.js';
import * as store from './store.js';

const HEARTBEAT_MS = 15000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// --- localhost hardening (DNS-rebinding + CSRF) -----------------------------
// A loopback server is reachable by any web page the user visits. Two guards
// keep an attacker's site from driving it: a Host allowlist (a DNS-rebound
// request carries the attacker's hostname, not a loopback one) and an Origin
// check on writes (browsers attach Origin to cross-origin requests).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  if (hostHeader[0] === '[') { const i = hostHeader.indexOf(']'); return i === -1 ? hostHeader : hostHeader.slice(0, i + 1); }
  const i = hostHeader.lastIndexOf(':');
  return i === -1 ? hostHeader : hostHeader.slice(0, i);
}

function isLoopbackHost(hostHeader) {
  return LOOPBACK_HOSTS.has(hostnameOf(hostHeader));
}

// Only consulted for mutating requests, and only when an Origin is present:
// the CLI and curl send none (and are already local), so absent = allowed.
function isLoopbackOrigin(origin) {
  try { return LOOPBACK_HOSTS.has(new URL(origin).hostname); } catch { return false; }
}

// Best-effort desktop nudge when a message arrives with no poll listening (B).
// Purely advisory — the authoritative "queued vs delivered" signal is the
// `delivered` flag returned to the browser. Never throws, never blocks: if no
// notifier exists (headless/CI/unknown OS) it silently no-ops. Opt out with
// HTMLDROP_EDIT_NOTIFY=0.
let lastNotifyAt = 0;
function osNotify(title, message) {
  if (process.env.HTMLDROP_EDIT_NOTIFY === '0') return;
  const now = Date.now();
  if (now - lastNotifyAt < 5000) return; // throttle bursts
  lastNotifyAt = now;
  let cmd, args;
  if (process.platform === 'darwin') {
    cmd = 'osascript';
    args = ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`];
  } else if (process.platform === 'linux') {
    cmd = 'notify-send';
    args = [title, message];
  } else {
    return; // windows/other — skip; the browser signal still covers it
  }
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {}); // notifier not installed — ignore
    p.unref();
  } catch { /* ignore */ }
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve2, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve2({});
      try { resolve2(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export async function startServer({ host = '127.0.0.1', port = 0, idleTimeoutMs = DEFAULT_IDLE_MS } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const watchers = new Map();      // key -> fs.FSWatcher
  const sseClients = new Set();    // res objects
  const activePolls = new Map();   // key -> open poll count  (presence: listening)
  const workingKeys = new Set();   // keys whose last poll delivered feedback (presence: working)
  let idleTimer = null;
  let shuttingDown = false;
  let publicPort = port;

  // --- presence ------------------------------------------------------------
  function presenceOf(key) {
    if (activePolls.get(key) > 0) return 'listening';
    if (workingKeys.has(key)) return 'working';
    return 'waiting';
  }
  function emitPresence(key) {
    events.emit('presence', key, presenceOf(key));
  }
  // Fired when a message lands with no poll open: nudge the human to have the
  // agent re-poll (the browser also shows an honest "queued" state).
  function notifyNoListener(key) {
    const s = store.getSession(key);
    const name = s && s.file ? basename(s.file) : 'a doc';
    osNotify('htmldrop edit — message waiting', `Run: htmldrop edit poll ${name}`);
  }
  function setPollActive(key, active) {
    const before = presenceOf(key);
    const n = activePolls.get(key) || 0;
    if (active) { activePolls.set(key, n + 1); workingKeys.delete(key); }
    else if (n <= 1) activePolls.delete(key);
    else activePolls.set(key, n - 1);
    if (presenceOf(key) !== before) emitPresence(key);
  }
  // A reply means the agent is done with the current message → drop 'working' so
  // the composer unlocks even before the agent re-polls.
  function clearWorking(key) {
    const before = presenceOf(key);
    workingKeys.delete(key);
    if (presenceOf(key) !== before) emitPresence(key);
  }

  // --- file watch → reload -------------------------------------------------
  // Watch the file's *directory* and filter to its basename: editors that save
  // via write-to-temp-then-rename fire a 'rename' on the directory, which a
  // direct fs.watch(file) can miss. Debounced so a multi-write save is one
  // reload.
  function watchSession(session) {
    if (watchers.has(session.key)) return;
    const dir = dirname(session.file);
    const base = session.file.slice(dir.length + 1);
    let timer = null;
    try {
      const w = watch(dir, (_event, filename) => {
        if (filename && filename !== base) return;
        clearTimeout(timer);
        timer = setTimeout(() => events.emit('reload', session.key), 120);
      });
      w.on('error', () => {});
      watchers.set(session.key, w);
    } catch {
      // Some platforms/filesystems can't watch — live reload is best-effort.
    }
  }

  // --- idle self-shutdown --------------------------------------------------
  function refreshIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      if (!shuttingDown && sseClients.size === 0 && activePolls.size === 0) shutdown();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // --- the agent long-poll drain ------------------------------------------
  // Holds the connection open until the author sends a chat message (or the
  // session ends), then returns the queued instructions plus the current
  // comments as context. Queue model: messages are drained on delivery.
  function handlePoll(req, res, query) {
    const filePath = query.get('file');
    if (!filePath) { sendJson(res, 400, { status: 'error', error: 'missing file' }); return; }

    let key;
    try { ({ key } = store.sessionKeyFor(filePath)); }
    catch { sendJson(res, 200, { status: 'missing' }); return; }

    // Stream mode: whitespace heartbeats keep the socket alive, then a single
    // final JSON write ends it. `text.trim()` on the client recovers the JSON.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.write(' ');
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(' '); }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let settled = false;
    setPollActive(key, true);
    refreshIdleTimer();

    const cleanup = () => {
      clearInterval(heartbeat);
      events.off('message', onChange);
      events.off('comment', onChange);
      events.off('ended', onChange);
      setPollActive(key, false);
      refreshIdleTimer();
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (payload.status === 'feedback') workingKeys.add(key);
      cleanup();
      if (!res.writableEnded) res.end(JSON.stringify(payload));
    };
    const check = () => {
      if (settled || res.writableEnded) return;
      const session = store.getSession(key);
      if (!session) { finish({ status: 'missing' }); return; }
      // Deliver on EITHER a queued chat message OR a new page comment. Chat
      // messages are transient (drained); comments are persistent (delivered by
      // watermark, then the watermark advances so each reaches the agent once).
      const pending = store.pendingCount(key) > 0;
      const newComments = store.undeliveredComments(key);
      if (pending || newComments.length) {
        const messages = pending ? store.takeQueuedMessages(key) : [];
        if (newComments.length) store.markCommentsDelivered(key, newComments[newComments.length - 1].createdAt);
        // Full comment set as standing context; newComments flags what just arrived.
        const comments = store.getComments(key).items;
        // Attach current layout warnings as standing context so the agent can
        // fix render problems in the same turn it addresses feedback.
        const layout = store.getLayout(key);
        finish({
          status: 'feedback',
          messages,
          newComments,
          comments,
          layoutWarnings: layout.warnings || [],
          count: messages.length + newComments.length,
          file: session.file,
        });
        return;
      }
      if (session.status === 'ended') finish({ status: 'ended' });
      // else: nothing new — stay open until onChange or the client disconnects.
    };
    const onChange = (changedKey) => { if (changedKey === key) check(); };

    events.on('message', onChange);
    events.on('comment', onChange);
    events.on('ended', onChange);
    req.on('close', () => { if (!settled) { settled = true; cleanup(); } });
    check(); // deliver immediately if a message is already queued
  }

  // --- SSE ----------------------------------------------------------------
  function handleEvents(req, res, key) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: presence\ndata: ${JSON.stringify({ state: presenceOf(key) })}\n\n`);
    res.write(`event: chat\ndata: ${JSON.stringify(store.getChat(key))}\n\n`);
    sseClients.add(res);
    refreshIdleTimer();
    const onReload = (k) => { if (k === key && !res.writableEnded) res.write('event: reload\ndata: {}\n\n'); };
    const onPresence = (k, state) => { if (k === key && !res.writableEnded) res.write(`event: presence\ndata: ${JSON.stringify({ state })}\n\n`); };
    const onChat = (k) => { if (k === key && !res.writableEnded) res.write(`event: chat\ndata: ${JSON.stringify(store.getChat(key))}\n\n`); };
    const onEnded = (k) => { if (k === key && !res.writableEnded) res.write('event: ended\ndata: {}\n\n'); };
    events.on('reload', onReload);
    events.on('presence', onPresence);
    events.on('chat', onChat);
    events.on('ended', onEnded);
    req.on('close', () => {
      sseClients.delete(res);
      events.off('reload', onReload);
      events.off('presence', onPresence);
      events.off('chat', onChat);
      events.off('ended', onEnded);
      refreshIdleTimer();
    });
  }

  // --- artifact serving ----------------------------------------------------
  async function serveArtifact(res, key) {
    const session = store.getSession(key);
    if (!session) { res.writeHead(404).end('Session not found'); return; }
    let html;
    try { html = await readFile(session.file, 'utf-8'); }
    catch { res.writeHead(404).end('File not found'); return; }
    html = injectFeedbackWidget(html, { docId: key, workerUrl: '' });
    html = injectEditRuntime(html, { key });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async function serveAsset(res, key, assetPath) {
    const session = store.getSession(key);
    if (!session) { res.writeHead(404).end('Session not found'); return; }
    const root = dirname(session.file);
    const target = resolve(root, decodeURIComponent(assetPath));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403).end('Forbidden'); return; }
    try {
      const data = await readFile(target);
      res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }

  // --- router --------------------------------------------------------------
  const server = createServer(async (req, res) => {
    try {
      // Parse against a fixed base so a hostile Host header can't influence it.
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;

      // Reject DNS-rebound requests: they arrive with the attacker's hostname.
      if (!isLoopbackHost(req.headers.host)) { res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden'); return; }
      // Reject cross-origin writes (CSRF). Same-origin pages and the CLI pass.
      if (method !== 'GET' && method !== 'HEAD' && req.headers.origin !== undefined && !isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden'); return;
      }

      if (path === '/health') { sendJson(res, 200, { ok: true, app: 'htmldrop-edit', port: publicPort }); return; }
      if (path === '/shutdown' && method === 'POST') { sendJson(res, 200, { status: 'shutting-down' }); setImmediate(shutdown); return; }

      if (path === '/__edit/sessions' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.file) { sendJson(res, 400, { error: 'missing file' }); return; }
        // Resolve symlinks BEFORE the extension check so `foo.html` → /etc/passwd
        // can't smuggle a non-HTML file past the server boundary. The CLI checks
        // this too, but the server is the actual trust boundary and must enforce
        // it independently.
        let resolved;
        try { resolved = store.sessionKeyFor(body.file); }
        catch { sendJson(res, 400, { error: 'file not found' }); return; }
        if (!/\.html?$/i.test(resolved.file)) { sendJson(res, 400, { error: 'edit mode only serves .html/.htm files' }); return; }
        let session;
        try { session = store.upsertSession(resolved.file); }
        catch (e) { sendJson(res, 400, { error: e.message }); return; }
        watchSession(session);
        sendJson(res, 200, { key: session.key, file: session.file, url: `http://${host}:${publicPort}/s/${session.key}/` });
        return;
      }
      if (path === '/__edit/sessions' && method === 'GET') { sendJson(res, 200, { sessions: store.listSessions() }); return; }

      if (path === '/api/poll' && method === 'GET') { handlePoll(req, res, url.searchParams); return; }

      let m;
      // Artifact + assets
      if ((m = path.match(/^\/s\/([a-f0-9]{16})\/?$/)) && method === 'GET') { await serveArtifact(res, m[1]); return; }
      if ((m = path.match(/^\/s\/([a-f0-9]{16})\/index\.html$/)) && method === 'GET') { await serveArtifact(res, m[1]); return; }
      if ((m = path.match(/^\/s\/([a-f0-9]{16})\/(.+)$/)) && method === 'GET') { await serveAsset(res, m[1], m[2]); return; }

      // SSE
      if ((m = path.match(/^\/__edit\/events\/([a-f0-9]{16})$/)) && method === 'GET') { handleEvents(req, res, m[1]); return; }

      // End a session
      if ((m = path.match(/^\/__edit\/([a-f0-9]{16})\/end$/)) && method === 'POST') {
        store.endSession(m[1]);
        events.emit('ended', m[1]);
        sendJson(res, 200, { status: 'ended' });
        setImmediate(shutdownIfAllEnded);
        return;
      }

      // Seed reviewers' published comments into the session (CLI --with-feedback).
      if ((m = path.match(/^\/__edit\/([a-f0-9]{16})\/import$/)) && method === 'POST') {
        const body = await readJsonBody(req);
        const r = store.importComments(m[1], body.comments || []);
        sendJson(res, 200, r);
        return;
      }

      // Feedback API (docId === session key). Same contract as the Worker.
      if ((m = path.match(/^\/api\/feedback\/([a-f0-9]{16})$/))) {
        const key = m[1];
        if (method === 'GET') { sendJson(res, 200, store.getComments(key, { since: url.searchParams.get('since') || undefined })); return; }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const result = store.addComment(key, body);
          if (!result) { sendJson(res, 404, { error: 'session not found' }); return; }
          events.emit('feedback', key); // refresh browser panels (SSE)
          events.emit('comment', key);  // wake the agent's poll — comments reach it too
          sendJson(res, 201, result);
          return;
        }
      }
      if ((m = path.match(/^\/api\/feedback\/([a-f0-9]{16})\/([0-9a-f-]{36})\/reply$/)) && method === 'POST') {
        const body = await readJsonBody(req);
        const result = store.addReply(m[1], m[2], body);
        if (!result) { sendJson(res, 404, { error: 'session not found' }); return; }
        events.emit('feedback', m[1]);
        events.emit('comment', m[1]);
        sendJson(res, 201, result);
        return;
      }
      if ((m = path.match(/^\/api\/feedback\/([a-f0-9]{16})\/([0-9a-f-]{36})$/))) {
        const [, key, id] = m;
        if (method === 'DELETE') {
          const r = store.deleteComment(key, id, req.headers['x-htmldrop-edit-token']);
          if (r.ok) events.emit('feedback', key);
          sendJson(res, r.status, { status: r.ok ? 'deleted' : 'error' });
          return;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const r = store.editComment(key, id, body.content, req.headers['x-htmldrop-edit-token']);
          if (r.ok) events.emit('feedback', key);
          sendJson(res, r.status, { status: r.ok ? 'edited' : 'error' });
          return;
        }
      }
      if ((m = path.match(/^\/api\/insights\/([a-f0-9]{16})$/)) && method === 'GET') { sendJson(res, 200, { insights: {} }); return; }
      if ((m = path.match(/^\/api\/access\/([a-f0-9]{16})$/)) && method === 'GET') { sendJson(res, 200, { scheme: 'open' }); return; }

      // Edit-mode chat: author ↔ agent conversation.
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/chat$/)) && method === 'GET') { sendJson(res, 200, store.getChat(m[1])); return; }
      // Layout QA: the widget's auditor posts the current render's warnings here.
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/layout$/))) {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          store.setLayout(m[1], body.warnings || [], body.docHash);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (method === 'GET') { sendJson(res, 200, store.getLayout(m[1])); return; }
      }
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/message$/)) && method === 'POST') {
        const body = await readJsonBody(req);
        // Was a poll listening at the moment the message arrived? Capture BEFORE
        // emit, since emitting synchronously wakes and drains the open poll. This
        // is the honest "did it land now, or is it queued?" signal for the UI (B).
        const wasListening = (activePolls.get(m[1]) || 0) > 0;
        const msg = store.addUserMessage(m[1], body);
        if (!msg) { sendJson(res, 404, { error: 'session not found' }); return; }
        events.emit('message', m[1]); // wakes the agent poll (if one is open)
        events.emit('chat', m[1]);    // updates the browser chat log
        events.emit('presence', m[1], presenceOf(m[1])); // reopen may change it
        if (!wasListening) notifyNoListener(m[1]); // best-effort nudge to re-poll (B)
        sendJson(res, 201, { id: msg.id, delivered: wasListening });
        return;
      }
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/reply$/)) && method === 'POST') {
        const body = await readJsonBody(req);
        const msg = store.addAgentMessage(m[1], body.text);
        if (!msg) { sendJson(res, 404, { error: 'session not found' }); return; }
        clearWorking(m[1]); // agent responded → unlock the author's composer
        events.emit('chat', m[1]);
        sendJson(res, 201, { id: msg.id });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else if (!res.writableEnded) res.end();
    }
  });

  // --- lifecycle -----------------------------------------------------------
  let shutdownResolve;
  const done = new Promise((r) => { shutdownResolve = r; });
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const res of sseClients) { try { res.write('event: chrome-reload\ndata: {}\n\n'); res.end(); } catch {} }
    sseClients.clear();
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    watchers.clear();
    server.close(() => shutdownResolve());
    server.closeAllConnections?.();
  }
  function shutdownIfAllEnded() {
    if (sseClients.size > 0 || activePolls.size > 0) return;
    const sessions = store.listSessions();
    if (sessions.length === 0 || sessions.every((s) => s.status === 'ended')) setImmediate(shutdown);
  }

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { publicPort = server.address().port; resolveListen(); });
  });
  refreshIdleTimer();

  return { port: publicPort, host, close: async () => { shutdown(); await done; }, done };
}
