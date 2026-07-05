// Local, on-disk feedback store for `htmldrop edit` (edit mode).
//
// Edit mode is the *pre-publish* loop: no Surge, no Cloudflare Worker, no
// network. This module is the local stand-in for the Worker's KV feedback
// store (worker/src/storage.ts), reduced to a single-user, single-machine
// model. Two design borrowings make it small:
//
//   * Session identity = the file path itself (Lavish's model): the key is
//     sha256(realpath(file)).slice(0,16). Re-opening the same file resumes the
//     same session and its comments. No opaque doc ids to track.
//
//   * The persisted comment shape is exactly the Worker's `FeedbackStored`
//     (worker/src/schema.ts), so the *existing* annotation widget talks to this
//     store byte-for-byte the same way it talks to the Worker — we change the
//     backend, never the widget.
//
// The store is deliberately a plain read-modify-write JSON file per session.
// The Worker needs care because KV has no atomic array append across concurrent
// reviewers; here there is one reviewer on localhost, so simplicity wins.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir, ensureConfigDir } from '../config.js';

// All edit-mode state lives beside the rest of htmldrop's config, under a
// dedicated subdir so it never collides with the Surge staging `site/` dir.
function getEditDir() {
  return join(getConfigDir(), 'edit');
}
function getSessionsDir() {
  return join(getEditDir(), 'sessions');
}

export function ensureEditDir() {
  ensureConfigDir();
  const dir = getSessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return getEditDir();
}

// Canonicalize a path the same way Lavish does so that `./report.html`,
// `report.html`, and an absolute path all resolve to one session. realpathSync
// requires the file to exist — callers open sessions only for files they serve,
// so that holds.
export function sessionKeyFor(file) {
  const abs = realpathSync(file);
  return { key: createHash('sha256').update(abs).digest('hex').slice(0, 16), file: abs };
}

function sessionPath(key) {
  return join(getSessionsDir(), `${key}.json`);
}

function readSessionFile(key) {
  const p = sessionPath(key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSessionFile(session) {
  ensureEditDir();
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionPath(session.key), JSON.stringify(session, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return session;
}

// Only a SHA-256 of the commenter's edit token is ever persisted — the raw
// token stays in the reviewer's browser. Same rule as the Worker (auth.ts): a
// stored token would let anyone with read access to the file edit comments.
function hashToken(token) {
  return token ? createHash('sha256').update(String(token)).digest('hex') : undefined;
}

// --- Session lifecycle -------------------------------------------------------

export function getSession(key) {
  return readSessionFile(key);
}

// Open or resume a session for `file`. Idempotent: resuming keeps existing
// comments and the delivery watermark, only flipping a previously-ended session
// back to open (Lavish's upsertSession does the same).
export function upsertSession(file) {
  const { key, file: abs } = sessionKeyFor(file);
  const existing = readSessionFile(key);
  const now = new Date().toISOString();
  const session = existing || {
    key,
    file: abs,
    docId: key, // the widget's config.docId — same origin, so this is all it needs
    status: 'open',
    createdAt: now,
    // Persistent annotations (the retained comment widget's backend). Shared
    // with reviewers when published; here they're context the author iterates on.
    comments: [],
    // The author ↔ agent conversation (persists so reopening resumes it).
    chat: [],
    // User messages not yet delivered to the agent's poll. Transient
    // instructions: drained (cleared) on delivery, unlike comments.
    queue: [],
    // Watermark (ISO time) for comment delivery. Comments are persistent so they
    // can't be drained like the queue; instead the poll delivers comments newer
    // than this and advances it. Starts at creation so pre-existing/imported
    // comments aren't replayed as "new" on the first poll.
    commentsDeliveredAt: now,
  };
  session.file = abs;
  session.docId = key;
  if (session.status === 'ended') session.status = 'open';
  // Migrate/resume: if a session predates comment-delivery tracking, treat all
  // existing comments as already seen (set the watermark to the newest one), so
  // resuming never floods the agent with the whole backlog. Only comments posted
  // AFTER this resume will be delivered as new.
  if (!session.commentsDeliveredAt) {
    const times = (session.comments || []).map((c) => c.createdAt || '').filter(Boolean);
    session.commentsDeliveredAt = times.length ? times.sort().pop() : now;
  }
  return writeSessionFile(session);
}

export function endSession(key) {
  const session = readSessionFile(key);
  if (!session) return null;
  session.status = 'ended';
  return writeSessionFile(session);
}

// Reopen an ended session (C: re-engage from the UI). Flips status back to open
// so a poll will serve it again; returns the session or null if unknown.
export function reopenSession(key) {
  const session = readSessionFile(key);
  if (!session) return null;
  if (session.status === 'ended') session.status = 'open';
  return writeSessionFile(session);
}

export function listSessions() {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSessionFile(f.replace(/\.json$/, '')))
    .filter(Boolean)
    .sort((a, b) => (a.file || '').localeCompare(b.file || ''));
}

// Seed reviewers' comments (pulled from the published doc's Worker) into the
// edit session so the author can work through them with the agent. Deduped by
// the comment's original id — re-running --with-feedback only adds new ones —
// and re-homed to this session's docId. editTokenHash never travels (it isn't
// ours), so imported comments render read-only, which is exactly right.
export function importComments(key, items) {
  const s = readSessionFile(key);
  if (!s) return { imported: 0 };
  const existing = new Set((s.comments || []).map((c) => c.id));
  let imported = 0;
  for (const it of items || []) {
    if (!it || !it.id || existing.has(it.id)) continue;
    const { editTokenHash, ...rest } = it;
    void editTokenHash;
    s.comments.push({ ...rest, docId: key });
    existing.add(it.id);
    imported += 1;
  }
  if (imported) writeSessionFile(s);
  return { imported };
}

// --- Chat: the author ↔ agent conversation ----------------------------------
// User messages are the agent's real instructions, so they go two places: the
// chat log (persistent, shown in the browser) AND a queue the poll drains. The
// queue is Lavish's transient-prompt model — cleared on delivery so the agent
// never re-runs an instruction, while the chat log keeps the history visible.

export function getChat(key) {
  const s = readSessionFile(key);
  return { chat: (s && s.chat) || [] };
}

// `context` optionally pins the message to what the author was pointing at
// (a text selection, an area, or an existing comment) so the agent knows the
// target without guessing.
export function addUserMessage(key, { text, context } = {}) {
  const s = readSessionFile(key);
  if (!s) return null;
  // C: a message from the UI reopens an ended session, so you never have to go
  // back to the terminal to un-end it — the message lands and waits for a poll.
  if (s.status === 'ended') s.status = 'open';
  const msg = { id: randomUUID(), role: 'user', text: String(text || ''), context: context || null, at: new Date().toISOString() };
  s.chat = [...(s.chat || []), msg];
  s.queue = [...(s.queue || []), msg];
  writeSessionFile(s);
  return msg;
}

export function addAgentMessage(key, text) {
  const s = readSessionFile(key);
  if (!s) return null;
  const msg = { id: randomUUID(), role: 'agent', text: String(text || ''), at: new Date().toISOString() };
  s.chat = [...(s.chat || []), msg];
  writeSessionFile(s);
  return msg;
}

export function pendingCount(key) {
  const s = readSessionFile(key);
  return s && Array.isArray(s.queue) ? s.queue.length : 0;
}

// --- Layout QA ---------------------------------------------------------------
// The widget's auditor measures the RENDERED page (overflow / clipped /
// overlapping text) and posts the current warning set here. It's state, not an
// event stream — it always reflects the latest render — so we overwrite rather
// than append. Stored with the docHash it was measured against so a stale audit
// (from a pre-edit render) can be told apart from the current one.
export function setLayout(key, warnings, docHash) {
  const s = readSessionFile(key);
  if (!s) return null;
  s.layout = {
    warnings: Array.isArray(warnings) ? warnings.slice(0, 100) : [],
    docHash: docHash || undefined,
    at: new Date().toISOString(),
  };
  writeSessionFile(s);
  return s.layout;
}

export function getLayout(key) {
  const s = readSessionFile(key);
  return (s && s.layout) || { warnings: [], at: null };
}

// Drain queued user messages for the agent and clear them (delivered). Peeked
// with pendingCount first so we only drain when we're about to respond.
export function takeQueuedMessages(key) {
  const s = readSessionFile(key);
  if (!s) return [];
  const q = s.queue || [];
  if (q.length) { s.queue = []; writeSessionFile(s); }
  return q;
}

// --- Comments (the Worker's /api/feedback/:docId contract, local) ------------

// GET: top-level comments + replies, editTokenHash stripped (the widget never
// sees it — it gates its own edit/delete UI via localStorage). Optional `since`
// filter mirrors the Worker's ?since= for incremental reads.
export function getComments(key, { since } = {}) {
  const session = readSessionFile(key);
  if (!session) return { docId: key, items: [], count: 0 };
  let items = session.comments || [];
  if (since) items = items.filter((c) => c.createdAt > since);
  const stripped = items.map(({ editTokenHash, ...rest }) => rest);
  return { docId: key, items: stripped, count: stripped.length };
}

// POST: a new top-level comment or (via addReply) a threaded reply. Returns the
// minimal { id, createdAt } the widget reads back to remember "this is mine".
export function addComment(key, body) {
  const session = readSessionFile(key);
  if (!session) return null;
  const item = {
    id: randomUUID(),
    docId: key,
    anchor: body.anchor || { type: 'page_level' },
    content: body.content || { type: 'text', text: '' },
    author: { displayName: (body.author && body.author.displayName) || 'Anonymous' },
    parentId: body.parentId || null,
    createdAt: new Date().toISOString(),
    resolved: false,
    editTokenHash: hashToken(body.editToken),
    docHash: body.docHash || undefined,
  };
  session.comments = [...(session.comments || []), item];
  writeSessionFile(session);
  return { id: item.id, createdAt: item.createdAt };
}

export function addReply(key, parentId, body) {
  return addComment(key, { ...body, parentId });
}

// Comments created since the delivery watermark — what the agent's poll hasn't
// seen yet. Sorted oldest-first. editTokenHash stripped (same as getComments).
export function undeliveredComments(key) {
  const s = readSessionFile(key);
  if (!s) return [];
  const since = s.commentsDeliveredAt || s.createdAt || '';
  return (s.comments || [])
    .filter((c) => (c.createdAt || '') > since)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map(({ editTokenHash, ...rest }) => rest);
}

// Advance the comment watermark to `iso` once the poll has delivered them, so
// each comment reaches the agent exactly once (kept separate from reading so a
// poll that dies before responding re-delivers on the next poll).
export function markCommentsDelivered(key, iso) {
  const s = readSessionFile(key);
  if (!s) return;
  if (iso && (!s.commentsDeliveredAt || iso > s.commentsDeliveredAt)) {
    s.commentsDeliveredAt = iso;
    writeSessionFile(s);
  }
}

// DELETE: cascade to the reply thread (a top-level delete removes its replies),
// matching the Worker's handleDeleteItem. Authorization is by edit token when
// one was stored; on localhost with no token we allow it (the widget already
// gated the button to the poster's own comments).
export function deleteComment(key, id, editToken) {
  const session = readSessionFile(key);
  if (!session) return { ok: false, status: 404 };
  const target = (session.comments || []).find((c) => c.id === id);
  if (!target) return { ok: false, status: 404 };
  if (target.editTokenHash && target.editTokenHash !== hashToken(editToken)) {
    return { ok: false, status: 403 };
  }
  session.comments = session.comments.filter((c) => c.id !== id && c.parentId !== id);
  writeSessionFile(session);
  return { ok: true, status: 200 };
}

// PATCH: edit a comment's text in place, stamping editedAt (rendered as
// "· edited"). Same edit-token check as delete.
export function editComment(key, id, content, editToken) {
  const session = readSessionFile(key);
  if (!session) return { ok: false, status: 404 };
  const target = (session.comments || []).find((c) => c.id === id);
  if (!target) return { ok: false, status: 404 };
  if (target.editTokenHash && target.editTokenHash !== hashToken(editToken)) {
    return { ok: false, status: 403 };
  }
  target.content = content;
  target.editedAt = new Date().toISOString();
  writeSessionFile(session);
  return { ok: true, status: 200 };
}
