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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, lstat } from 'node:fs/promises';
import { watch, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectFeedbackWidget } from '../feedback/inject.js';
import { injectEditRuntime } from './runtime.js';
import * as store from './store.js';
import { serveEditAsset, scanArtifactDependencies, computeArtifactRevision } from './assets.js';
import { startRemoteGateway } from './remote.js';

const HEARTBEAT_MS = 15000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

// The running package version — served at /health and baked into the injected
// runtime, so an open tab can detect a server restart onto NEW code and reload
// itself once (stops "the fix is in but the tab still shows the old UI").
const PKG_VERSION = (() => {
  try {
    const p = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(p, 'utf8')).version || '0';
  } catch { return '0'; }
})();

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

function isAgentRoute(path, method) {
  return path === '/api/poll' || path === '/shutdown' ||
    (path.startsWith('/__edit/') && !/^\/__edit\/events\/[a-f0-9]{16}$/.test(path)) ||
    (method === 'POST' && /^\/api\/edit\/[a-f0-9]{16}\/(reply|question)$/.test(path));
}
function equalToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reviewerInput(req, body) {
  if (req.headers['x-htmldrop-reviewer'] !== '1') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid request'), { statusCode: 400 });
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? body.context : {};
  if ([body.intent, body.action, context.type, context.intent, context.action].some(value => typeof value === 'string' && /^(publish|deploy|release)$/i.test(value))) {
    throw Object.assign(new Error('Publishing requires local author authorization'), { statusCode: 403 });
  }
  return { ...body, agent: false, context: { ...context, actor: 'reviewer', authority: 'review-only' } };
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

export async function startServer({ host = '127.0.0.1', port = 0, idleTimeoutMs = DEFAULT_IDLE_MS, agentToken = randomBytes(32).toString('base64url') } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('The edit control server must bind to loopback');
  if (typeof agentToken !== 'string' || agentToken.length < 32) throw new Error('An agent token of at least 32 characters is required');
  const gateways = new Map();
  const gatewayEpochs = new Map();
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
  async function watchSession(session) {
    const previous = watchers.get(session.key);
    previous?.close();
    let closed = false, timer = null;
    const handles = [];
    const record = { close() { closed = true; clearTimeout(timer); for (const w of handles) w.close(); } };
    watchers.set(session.key, record);
    let report;
    try { report = await scanArtifactDependencies(session.file); } catch { report = { dependencies: [] }; }
    if (closed) return;
    // Watch only the entry and declared safe existing dependencies. Directory
    // watches survive atomic saves; each event is filtered to exact basenames.
    const byDirectory = new Map();
    for (const file of [session.file, ...(report.dependencies || [])]) {
      const dir = dirname(file);
      if (!byDirectory.has(dir)) byDirectory.set(dir, new Set());
      byDirectory.get(dir).add(basename(file));
    }
    // A missing declared dependency can be created later. Watch its nearest
    // existing safe ancestor for that one component, never recursively.
    for (const missing of report.missing || []) {
      if (!report.root) break;
      const target = resolve(report.root, missing);
      const rel = relative(report.root, target);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) continue;
      let dir = report.root;
      for (const part of rel.split(sep)) {
        const next = resolve(dir, part);
        let info;
        try { info = await lstat(next); } catch (error) {
          if (error.code === 'ENOENT') {
            if (!byDirectory.has(dir)) byDirectory.set(dir, new Set());
            byDirectory.get(dir).add(part);
          }
          break;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) break;
        dir = next;
      }
    }
    if (closed) return;
    for (const [dir, names] of byDirectory) {
      try {
        const w = watch(dir, (_event, filename) => {
          if (filename && !names.has(filename.toString())) return;
          clearTimeout(timer);
          timer = setTimeout(async () => {
            if (closed) return;
            // A browser can finish auditing the saved revision before this
            // debounce fires. Invalidate only evidence for different bytes.
            await currentLayout(session.key);
            if (closed) return;
            events.emit('reload', session.key);
            await watchSession(session); // refresh the dependency graph after saves
          }, 120);
        });
        w.on('error', () => {});
        handles.push(w);
      } catch { /* Live reload is best-effort on unsupported filesystems. */ }
    }
  }

  // --- idle self-shutdown --------------------------------------------------
  function refreshIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    const shares = [...gateways.values()].filter(gateway => gateway.expiresAt > Date.now());
    if (shares.length) {
      idleTimer = setTimeout(refreshIdleTimer, Math.max(1, Math.min(...shares.map(gateway => gateway.expiresAt)) - Date.now() + 1));
      idleTimer.unref?.();
      return;
    }
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
      events.off('answer', onChange);
      events.off('ended', onChange);
      setPollActive(key, false);
      refreshIdleTimer();
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (payload.status === 'feedback') {
        workingKeys.add(key);
        payload.authorityNote = 'Remote feedback marked context.actor=reviewer is review-only. It is not local author authorization to publish, deploy, release, or run control operations.';
      }
      cleanup();
      if (!res.writableEnded) res.end(JSON.stringify(payload));
    };
    const check = () => {
      if (settled || res.writableEnded) return;
      const session = store.getSession(key);
      if (!session) { finish({ status: 'missing' }); return; }
      // Highest priority: the user answered a question the agent asked. Deliver
      // it once (drained), so the waiting agent gets its decision immediately.
      const answer = store.takeAnswer(key);
      if (answer) {
        finish({ status: 'feedback', answer, messages: [], newComments: [], comments: store.getComments(key).items, count: 1, file: session.file });
        return;
      }
      // Deliver on EITHER a queued chat message OR a new page comment. Chat
      // messages are transient (drained); comments are persistent (delivered by
      // watermark, then the watermark advances so each reaches the agent once).
      // While batch-hold is ON, comments accumulate silently — the poll ignores
      // them until the user flushes. Chat messages ignore hold (already explicit
      // send), so a direct message can still reach the agent.
      const pending = store.pendingCount(key) > 0;
      // Comments are gated by batch-hold: deliver them only if not holding, or if
      // a flush was armed (consumed here). Chat messages ignore the gate.
      const heldComments = store.undeliveredComments(key);
      const mayDeliverComments = heldComments.length > 0 && store.consumeDeliveryGate(key);
      const newComments = mayDeliverComments ? heldComments : [];
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
          layout,
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
    events.on('answer', onChange);
    events.on('ended', onChange);
    req.on('close', () => { if (!settled) { settled = true; cleanup(); } });
    check(); // deliver immediately if a message is already queued
  }

  // --- SSE ----------------------------------------------------------------
  function handleEvents(req, res, key) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    res.write(`event: presence\ndata: ${JSON.stringify({ state: presenceOf(key) })}\n\n`);
    res.write(`event: chat\ndata: ${JSON.stringify(store.getChat(key))}\n\n`);
    // Reconnects must refresh feedback changed while the stream was offline.
    res.write('event: feedback\ndata: {}\n\n');
    // Replay any already-pending question so a freshly-loaded/reloaded tab shows it.
    const q0 = store.getQuestion(key);
    if (q0) res.write(`event: question\ndata: ${JSON.stringify({ question: q0 })}\n\n`);
    sseClients.add(res);
    refreshIdleTimer();
    const onReload = (k) => { if (k === key && !res.writableEnded) res.write('event: reload\ndata: {}\n\n'); };
    const onPresence = (k, state) => { if (k === key && !res.writableEnded) res.write(`event: presence\ndata: ${JSON.stringify({ state })}\n\n`); };
    const onChat = (k) => { if (k === key && !res.writableEnded) res.write(`event: chat\ndata: ${JSON.stringify(store.getChat(key))}\n\n`); };
    const onFeedback = (k) => { if (k === key && !res.writableEnded) res.write('event: feedback\ndata: {}\n\n'); };
    const onEnded = (k) => { if (k === key && !res.writableEnded) res.write('event: ended\ndata: {}\n\n'); };
    const onHold = (k, on) => { if (k === key && !res.writableEnded) res.write(`event: hold\ndata: ${JSON.stringify({ hold: on })}\n\n`); };
    const onQuestion = (k) => { if (k === key && !res.writableEnded) res.write(`event: question\ndata: ${JSON.stringify({ question: store.getQuestion(key) })}\n\n`); };
    events.on('reload', onReload);
    events.on('presence', onPresence);
    events.on('chat', onChat);
    events.on('feedback', onFeedback);
    events.on('ended', onEnded);
    events.on('hold', onHold);
    events.on('question', onQuestion);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      events.off('reload', onReload);
      events.off('presence', onPresence);
      events.off('chat', onChat);
      events.off('feedback', onFeedback);
      events.off('ended', onEnded);
      events.off('hold', onHold);
      events.off('question', onQuestion);
      refreshIdleTimer();
    });
  }

  // --- artifact serving ----------------------------------------------------
  async function serveArtifact(req, res, key) {
    const session = store.getSession(key);
    if (!session) { res.writeHead(404).end('Session not found'); return; }
    let html;
    try { html = await readFile(session.file, 'utf-8'); }
    catch { res.writeHead(404).end('File not found'); return; }
    const revision = await computeArtifactRevision(session.file, html);
    const hash = revision.sourceHash;
    const previousLayout = store.getLayout(key);
    if (previousLayout.sourceHash && (previousLayout.sourceHash !== hash || previousLayout.renderRevision !== revision.renderRevision || !revision.complete)) store.invalidateLayout(key);
    html = injectFeedbackWidget(html, { docId: key, workerUrl: '' });
    html = injectEditRuntime(html, { key, version: PKG_VERSION, sourceHash: hash, renderRevision: revision.renderRevision || '', reviewer: req.headers['x-htmldrop-reviewer'] === '1' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async function serveAsset(req, res, key, assetPath) {
    const session = store.getSession(key);
    if (!session) { res.writeHead(404).end('Session not found'); return; }
    await serveEditAsset(req, res, { file: session.file, assetPath });
  }

  async function currentLayout(key) {
    const session = store.getSession(key);
    let revision = null;
    try { if (session) revision = await computeArtifactRevision(session.file); } catch { /* unverified */ }
    // A POST may save a fresh audit while the filesystem digest is pending.
    // Compare the latest evidence; an older snapshot must not invalidate it.
    let layout = store.getLayout(key);
    if (revision?.complete && layout.sourceHash && layout.sourceHash === revision.sourceHash && layout.renderRevision === revision.renderRevision) return layout;
    if (layout.sourceHash) { store.invalidateLayout(key); layout = store.getLayout(key); }
    return { ...layout, complete: false, stale: true, issues: (layout.issues || []).map(issue =>
      issue.status === 'resolved' ? issue : { ...issue, status: 'unverified' }) };
  }

  // --- router --------------------------------------------------------------
  const server = createServer(async (req, res) => {
    try {
      // Parse against a fixed base so a hostile Host header can't influence it.
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;

      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-content-type-options', 'nosniff');
      // The listener is loopback-only; Host must also name this actual port.
      if (!isLoopbackHost(req.headers.host) || ![...LOOPBACK_HOSTS].some(h => req.headers.host === `${h}:${publicPort}`)) {
        res.writeHead(403).end('Forbidden'); return;
      }
      const authorizedAgent = equalToken(req.headers.authorization, `Bearer ${agentToken}`);
      if (isAgentRoute(path, method) && !authorizedAgent) { sendJson(res, 401, { error: 'Agent authentication required' }); return; }
      if (method !== 'GET' && method !== 'HEAD') {
        // A browser must prove its exact origin, including scheme and port.
        // Authenticated CLI requests have no Origin; page scripts never get the
        // agent token. No wildcard CORS or forwarded-header exceptions.
        if ((req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) ||
            (req.headers.origin === undefined && !authorizedAgent) ||
            ((method !== 'DELETE' || Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding']) && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) {
          res.writeHead(403).end('Same-origin JSON required'); return;
        }
      }

      if (path === '/health') { sendJson(res, 200, { ok: true, app: 'htmldrop-edit', port: publicPort, version: PKG_VERSION, authenticated: authorizedAgent }); return; }
      // Browsers auto-request /favicon.ico; answer 204 so it isn't a console 404.
      if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (path === '/shutdown' && method === 'POST') { sendJson(res, 200, { status: 'shutting-down' }); setImmediate(shutdown); return; }

      if (path === '/__edit/sessions' && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
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
        await watchSession(session);
        sendJson(res, 200, { key: session.key, file: session.file, url: `http://${host}:${publicPort}/s/${session.key}/` });
        return;
      }
      if (path === '/__edit/sessions' && method === 'GET') { sendJson(res, 200, { sessions: store.listSessions() }); return; }

      if (path === '/api/poll' && method === 'GET') { handlePoll(req, res, url.searchParams); return; }

      let m;
      // Artifact + assets
      if ((m = path.match(/^\/s\/([a-f0-9]{16})$/)) && method === 'GET') { res.writeHead(308, { location: `/s/${m[1]}/` }).end(); return; }
      if ((m = path.match(/^\/s\/([a-f0-9]{16})\/$/)) && method === 'GET') { await serveArtifact(req, res, m[1]); return; }
      if ((m = path.match(/^\/s\/([a-f0-9]{16})\/index\.html$/)) && method === 'GET') { await serveArtifact(req, res, m[1]); return; }
      if ((m = path.match(/^\/s\/([a-f0-9]{16})\/(.+)$/)) && method === 'GET') { await serveAsset(req, res, m[1], m[2]); return; }

      // SSE
      if ((m = path.match(/^\/__edit\/events\/([a-f0-9]{16})$/)) && method === 'GET') { handleEvents(req, res, m[1]); return; }

      // Sharing is an agent control operation; this local listener is never
      // forwarded wholesale. A gateway gets exactly one review session.
      if ((m = path.match(/^\/__edit\/([a-f0-9]{16})\/share$/))) {
        const key = m[1];
        if (method === 'DELETE') {
          gatewayEpochs.set(key, (gatewayEpochs.get(key) || 0) + 1);
          const previous = gateways.get(key);
          await previous?.close();
          if (gateways.get(key) === previous) gateways.delete(key);
          refreshIdleTimer();
          sendJson(res, 200, { revoked: true }); return;
        }
        if (method === 'POST') {
          const session = store.getSession(key);
          if (!session || session.status === 'ended') { sendJson(res, 404, { error: 'Active session not found' }); return; }
          const body = reviewerInput(req, await readJsonBody(req));
          const epoch = (gatewayEpochs.get(key) || 0) + 1;
          gatewayEpochs.set(key, epoch);
          const previous = gateways.get(key);
          await previous?.close();
          if (gateways.get(key) === previous) gateways.delete(key);
          let gateway;
          try { gateway = await startRemoteGateway({ publicOrigin: body.publicOrigin, port: body.port ?? 0, sessionKey: key, backendPort: publicPort, backendHost: host, ttlMs: body.ttlMs }); }
          catch (error) { sendJson(res, 400, { error: error.message }); return; }
          if (shuttingDown || gatewayEpochs.get(key) !== epoch) { await gateway.close(); sendJson(res, 409, { error: 'Share request superseded or revoked' }); return; }
          gateways.set(key, gateway);
          refreshIdleTimer();
          sendJson(res, 201, { url: gateway.url, port: gateway.port, origin: gateway.origin, expiresAt: gateway.expiresAt }); return;
        }
      }

      // End a session
      if ((m = path.match(/^\/__edit\/([a-f0-9]{16})\/end$/)) && method === 'POST') {
        store.endSession(m[1]);
        gatewayEpochs.set(m[1], (gatewayEpochs.get(m[1]) || 0) + 1);
        const previous = gateways.get(m[1]);
        await previous?.close();
        if (gateways.get(m[1]) === previous) gateways.delete(m[1]);
        watchers.get(m[1])?.close();
        watchers.delete(m[1]);
        events.emit('ended', m[1]);
        sendJson(res, 200, { status: 'ended' });
        setImmediate(shutdownIfAllEnded);
        return;
      }

      // Seed reviewers' published comments into the session (CLI --with-feedback).
      if ((m = path.match(/^\/__edit\/([a-f0-9]{16})\/import$/)) && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
        const r = store.importComments(m[1], body.comments || []);
        events.emit('feedback', m[1]);
        sendJson(res, 200, r);
        return;
      }

      // Feedback API (docId === session key). Same contract as the Worker.
      if ((m = path.match(/^\/api\/feedback\/([a-f0-9]{16})$/))) {
        const key = m[1];
        if (method === 'GET') { sendJson(res, 200, store.getComments(key, { since: url.searchParams.get('since') || undefined })); return; }
        if (method === 'POST') {
          const body = reviewerInput(req, await readJsonBody(req));
          const result = store.addComment(key, body);
          if (!result) { sendJson(res, 404, { error: 'session not found' }); return; }
          events.emit('feedback', key); // refresh browser panels (SSE) — always
          // Only wake the agent's poll if NOT holding for a batch. While held,
          // the comment still persisted + rendered; it just waits for a flush.
          if (!store.getHold(key)) events.emit('comment', key);
          sendJson(res, 201, result);
          return;
        }
      }
      if ((m = path.match(/^\/api\/feedback\/([a-f0-9]{16})\/([0-9a-f-]{36})\/reply$/)) && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
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
          const body = reviewerInput(req, await readJsonBody(req));
          const r = store.editComment(key, id, body.content, req.headers['x-htmldrop-edit-token']);
          if (r.ok) events.emit('feedback', key);
          sendJson(res, r.status, { status: r.ok ? 'edited' : 'error' });
          return;
        }
      }
      if ((m = path.match(/^\/api\/insights\/([a-f0-9]{16})$/)) && method === 'GET') { sendJson(res, 200, { insights: {} }); return; }
      if ((m = path.match(/^\/api\/access\/([a-f0-9]{16})$/)) && method === 'GET') { sendJson(res, 200, { scheme: 'open' }); return; }

      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/health$/)) && method === 'GET') {
        if (!store.getSession(m[1])) { sendJson(res, 404, { error: 'Session not found' }); return; }
        sendJson(res, 200, { ok: true, version: PKG_VERSION }); return;
      }

      // Edit-mode chat: author ↔ agent conversation.
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/chat$/)) && method === 'GET') { sendJson(res, 200, store.getChat(m[1])); return; }
      // Agent → user question (reverse channel). GET current pending question;
      // POST (agent) sets one + SSE-pops the card; the /answer route below stores
      // the user's reply and wakes the poll.
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/question$/))) {
        if (method === 'GET') { sendJson(res, 200, { question: store.getQuestion(m[1]) }); return; }
        if (method === 'POST') {
          const body = reviewerInput(req, await readJsonBody(req));
          const q = store.setQuestion(m[1], body);
          if (!q) { sendJson(res, 404, { error: 'session not found' }); return; }
          events.emit('question', m[1]); // SSE → browser pops the card
          sendJson(res, 201, { id: q.id });
          return;
        }
      }
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/answer$/)) && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
        const a = store.answerQuestion(m[1], body);
        if (!a) { sendJson(res, 409, { error: 'no pending question' }); return; }
        events.emit('answer', m[1]);  // wake the agent's poll with the answer
        events.emit('question', m[1]); // SSE → browser dismisses the card
        sendJson(res, 200, { ok: true });
        return;
      }
      // Layout QA: the widget's auditor posts the current render's warnings here.
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/layout$/))) {
        if (method === 'POST') {
          const body = reviewerInput(req, await readJsonBody(req));
          const session = store.getSession(m[1]);
          if (!session) { sendJson(res, 404, { error: 'Session not found' }); return; }
          const revision = await computeArtifactRevision(session.file);
          if (!revision.complete || body.sourceHash !== revision.sourceHash || body.renderRevision !== revision.renderRevision) { sendJson(res, 409, { error: 'Stale or unverifiable layout report; reload the current artifact' }); return; }
          store.setLayout(m[1], body.warnings || [], body.docHash, { sourceHash: revision.sourceHash, renderRevision: revision.renderRevision, viewport: body.viewport, complete: body.complete === true, reason: body.reason });
          sendJson(res, 200, await currentLayout(m[1]));
          return;
        }
        if (method === 'GET') { sendJson(res, 200, await currentLayout(m[1])); return; }
      }
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/layout\/queue$/)) && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
        if (!Array.isArray(body.ids) || !body.ids.length || !body.ids.every(id => typeof id === 'string')) { sendJson(res, 400, { error: 'Select layout issue ids' }); return; }
        const layout = await currentLayout(m[1]);
        if (layout.stale) { sendJson(res, 409, { error: 'Layout report is stale; reload before queuing issues' }); return; }
        const result = store.queueLayoutIssues(m[1], body.ids, body.context);
        if (!result) { sendJson(res, 404, { error: 'Session not found' }); return; }
        const wasListening = (activePolls.get(m[1]) || 0) > 0;
        if (result.message) { events.emit('message', m[1]); events.emit('chat', m[1]); if (!wasListening) notifyNoListener(m[1]); }
        sendJson(res, 200, { ...result, delivered: !!result.message && wasListening }); return;
      }
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/layout\/ignore$/)) && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
        if (typeof body.id !== 'string' || typeof body.reason !== 'string' || !body.reason.trim()) { sendJson(res, 400, { error: 'An issue id and reason are required' }); return; }
        const issue = store.ignoreLayoutIssue(m[1], body.id, body.reason);
        if (!issue) { sendJson(res, 404, { error: 'Issue not found' }); return; }
        sendJson(res, 200, { issue }); return;
      }
      // Batch hold: GET current state, POST {on} to toggle. Toggling OFF also
      // flushes — if comments accumulated while held, wake the poll so the whole
      // batch reaches the agent at once.
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/hold$/))) {
        if (method === 'GET') { sendJson(res, 200, { hold: store.getHold(m[1]), pending: store.undeliveredComments(m[1]).length }); return; }
        if (method === 'POST') {
          const body = reviewerInput(req, await readJsonBody(req));
          const on = store.setHold(m[1], body.on);
          if (!on) events.emit('comment', m[1]); // released → deliver the batch
          events.emit('hold', m[1], on);          // sync the browser toggle
          sendJson(res, 200, { hold: on, pending: store.undeliveredComments(m[1]).length });
          return;
        }
      }
      // Explicit flush while staying in hold mode: arm a one-shot delivery, then
      // wake the poll so the held batch goes out once (hold stays on after).
      // Report whether an agent was actually LISTENING, so the UI can be honest:
      // if none is polling, the batch stays queued (nothing was really "sent").
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/flush$/)) && method === 'POST') {
        const listening = (activePolls.get(m[1]) || 0) > 0;
        store.armFlush(m[1]);
        events.emit('comment', m[1]);
        sendJson(res, 200, { flushed: true, delivered: listening, pending: store.undeliveredComments(m[1]).length });
        return;
      }
      if ((m = path.match(/^\/api\/edit\/([a-f0-9]{16})\/message$/)) && method === 'POST') {
        const body = reviewerInput(req, await readJsonBody(req));
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
        const body = reviewerInput(req, await readJsonBody(req));
        const msg = store.addAgentMessage(m[1], body.text);
        if (!msg) { sendJson(res, 404, { error: 'session not found' }); return; }
        clearWorking(m[1]); // agent responded → unlock the author's composer
        events.emit('chat', m[1]);
        sendJson(res, 201, { id: msg.id });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.statusCode || (err instanceof SyntaxError ? 400 : 500), { error: err.statusCode ? err.message : err instanceof SyntaxError ? 'Invalid JSON request' : 'Request failed' });
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
    const closingGateways = [...gateways.values()].map(gateway => gateway.close());
    gateways.clear();
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    watchers.clear();
    server.close(() => Promise.allSettled(closingGateways).then(shutdownResolve));
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

  return { port: publicPort, host, agentToken, close: async () => { shutdown(); await done; }, done };
}
