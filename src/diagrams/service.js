import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, mkdir, stat, rename, unlink, realpath, lstat, open, link } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { getConfigDir } from '../config.js';
import { fail, isUUID, LIMITS, parseDocument, replaceDiagram, validateScene, validateSvg } from './document.js';

// Shared by service instances: multiple HTTP adapters cannot race the same file.
const locks = new Map();
async function serialized(file, operation) {
  const previous = locks.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(file, next);
  try { return await next; } finally { if (locks.get(file) === next) locks.delete(file); }
}
function authenticate(actor, owner = false) {
  if (!['owner', 'reviewer'].includes(actor)) fail('An authenticated diagram actor is required', 403);
  if (owner && actor !== 'owner') fail('Only the local owner can change accepted diagrams', 403);
}
const permissions = (actor) => ({ create: actor === 'owner', save: actor === 'owner', accept: actor === 'owner', reject: actor === 'owner', propose: true });
function title(value, fallback = 'Untitled diagram') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 500) fail('Diagram title must be at most 500 characters');
  return value;
}
function summary(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2000) fail('Revision summary must be at most 2000 characters');
  return value;
}
const snapshot = (entry) => {
  const { location, ...value } = entry; void location;
  return value;
};

export function createDiagramService({ getSession, configDir = getConfigDir() } = {}) {
  if (typeof getSession !== 'function') throw new TypeError('getSession is required');
  const stateDir = join(configDir, 'edit', 'diagrams');
  let keyPromise;
  async function encryptionKey() {
    if (!keyPromise) keyPromise = (async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const path = join(stateDir, 'history.key');
      return serialized(path, async () => {
        const temp = join(stateDir, `.history.key.${randomUUID()}.tmp`);
        try {
          const handle = await open(temp, 'wx', 0o600);
          try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
          // Publish a fully written key without replacing a key another process
          // may already have initialized. A crash cannot leave an empty key.
          await link(temp, path);
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
        const key = await readFile(path);
        if (key.length !== 32) fail('Local diagram history key is invalid', 500);
        return key;
      });
    })();
    return keyPromise;
  }
  function statePath(documentId, diagramId) {
    if (!isUUID(documentId) || !isUUID(diagramId)) fail('Invalid diagram identity');
    return join(stateDir, `${documentId}-${diagramId}.json.enc`);
  }
  async function loadState(documentId, diagramId, currentRevisionId) {
    let encrypted;
    try { encrypted = await readFile(statePath(documentId, diagramId), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { revisions: [], proposals: [] }; throw error; }
    try {
      const envelope = JSON.parse(encrypted);
      if (envelope.version !== 1) throw new Error('version');
      const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${documentId}/${diagramId}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      if (!Array.isArray(state.revisions) || !Array.isArray(state.proposals)) throw new Error('shape');
      // The HTML is authoritative after a crash. A staged transaction only
      // becomes visible when its exact revision reached the source file.
      if (state.pending) return state.pending.revisionId === currentRevisionId ? state.pending.nextState : { revisions: state.revisions, proposals: state.proposals };
      return state;
    } catch { fail('Cannot decrypt private diagram history in this profile', 500); }
  }
  async function writeAtomic(path, bytes, mode = 0o600, beforeRename) {
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', mode);
      await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); await handle.close(); handle = null;
      if (beforeRename) await beforeRename();
      await rename(temp, path);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function persistState(documentId, diagramId, state) {
    const plaintext = JSON.stringify(state);
    if (Buffer.byteLength(plaintext) > 32 * 1024 * 1024) fail('Private diagram history reached the 32 MB profile limit. Start a new diagram or profile to continue.', 413);
    const key = await encryptionKey(), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${documentId}/${diagramId}`));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    await writeAtomic(statePath(documentId, diagramId), JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  }
  async function sessionFile(key) {
    const session = await getSession(key);
    if (!session?.file) fail('Edit session not found', 404);
    try {
      const file = await realpath(session.file), info = await lstat(session.file);
      if (!info.isFile() || file !== resolve(session.file)) fail('Registered artifact path changed or is a symbolic link', 400);
      return file;
    } catch (error) { if (error.statusCode) throw error; fail('Registered HTML artifact is unavailable', 404); }
  }
  async function readDocument(file) {
    const info = await stat(file);
    if (info.size > LIMITS.html) fail('HTML exceeds the 2 MB publication limit; reduce embedded images or diagram size', 413);
    const bytes = await readFile(file);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source).equals(bytes)) fail('HTML must use valid UTF-8');
    return { ...parseDocument(source), bytes, mode: info.mode & 0o777 };
  }
  function diagram(document, id) {
    if (!isUUID(id)) fail('Diagram not found', 404);
    const entry = document.diagrams.find((item) => item.diagramId === id);
    if (!entry) fail('Diagram not found', 404);
    return entry;
  }
  function conflict(document, entry, message = 'Diagram or source changed. Reload the current diagram and reapply your changes.') {
    fail(message, 409, { current: { documentId: document.documentId, diagramId: entry?.diagramId, revisionId: entry?.revisionId, sourceHash: document.sourceHash } });
  }
  function checkBase(document, entry, body) {
    if (!body || typeof body.baseSourceHash !== 'string' || (entry && typeof body.baseRevisionId !== 'string')) fail('baseSourceHash and the current baseRevisionId are required');
    if (body.baseSourceHash !== document.sourceHash || (entry && body.baseRevisionId !== entry.revisionId)) conflict(document, entry);
  }
  async function recheck(file, document, entry) {
    const info = await lstat(file);
    if (!info.isFile() || await realpath(file) !== file || !(await readFile(file)).equals(document.bytes)) {
      let latest;
      try { latest = await readDocument(file); } catch { /* Preserve the original safe conflict if external source is malformed. */ }
      conflict(latest || document, latest?.diagrams.find((item) => item.diagramId === entry?.diagramId) || entry, 'HTML changed outside the editor. Reload the file before retrying.');
    }
  }
  async function writeSource(file, document, entry, source = replaceDiagram(document, entry, entry.svg)) {
    await writeAtomic(file, source, document.mode, () => recheck(file, document, entry));
    return { ...parseDocument(source), bytes: Buffer.from(source), mode: document.mode };
  }
  async function commitRevision(file, doc, entry, previousState, nextState, source) {
    await recheck(file, doc, entry);
    await persistState(entry.documentId, entry.diagramId, { ...previousState, pending: { revisionId: entry.revisionId, nextState } });
    const updated = await writeSource(file, doc, entry, source);
    // The durable journal already contains all history. If finalization fails,
    // read/load resolves it from the authoritative source revision on restart.
    await persistState(entry.documentId, entry.diagramId, nextState).catch(() => {});
    return updated;
  }
  function includeCurrent(state, entry) {
    if (!state.revisions.some((item) => item.revisionId === entry.revisionId)) state.revisions.push({ ...snapshot(entry), summary: 'Imported accepted revision', createdAt: null });
    return state;
  }
  async function payload(document, entry, actor, suppliedState) {
    const state = includeCurrent(suppliedState || await loadState(document.documentId, entry.diagramId, entry.revisionId), entry);
    const proposals = actor === 'owner' ? state.proposals : state.proposals.filter((item) => item.baseRevisionId === entry.revisionId && item.baseSourceHash === document.sourceHash);
    const revisions = actor === 'owner' ? state.revisions.slice().reverse() : [snapshot(entry)];
    return { ...snapshot(entry), sourceHash: document.sourceHash, proposals: proposals.slice().reverse(), revisions, permissions: permissions(actor) };
  }
  async function mutate(key, actor, owner, operation) {
    authenticate(actor, owner);
    const file = await sessionFile(key);
    return serialized(file, async () => operation(file, await readDocument(file)));
  }
  function candidate(body, fallbackTitle) {
    if (!body || typeof body !== 'object') fail('A diagram request body is required');
    return { title: title(body.title, fallbackTitle), scene: validateScene(body.scene), summary: summary(body.summary) };
  }
  function newRevision(documentId, diagramId, parentRevisionId, value, svg) {
    return { version: 1, documentId, diagramId, revisionId: randomUUID(), parentRevisionId, ...value, svg, createdAt: new Date().toISOString() };
  }
  const service = {
    async list(key, actor) {
      authenticate(actor);
      const doc = await readDocument(await sessionFile(key));
      return { documentId: doc.documentId, sourceHash: doc.sourceHash, diagrams: doc.diagrams.map(({ diagramId, revisionId, title }) => ({ diagramId, revisionId, title })), permissions: permissions(actor) };
    },
    async read(key, id, actor) {
      authenticate(actor);
      const file = await sessionFile(key);
      return serialized(file, async () => {
        const doc = await readDocument(file);
        return payload(doc, diagram(doc, id), actor);
      });
    },
    async create(key, body, actor) {
      return mutate(key, actor, true, async (file, doc) => {
        checkBase(doc, null, body);
        const value = candidate(body), svg = validateSvg(body.svg), documentId = doc.documentId || randomUUID(), id = randomUUID();
        const entry = newRevision(documentId, id, null, value, svg), state = { revisions: [entry], proposals: [] };
        const source = replaceDiagram(doc, entry, svg);
        const updated = await commitRevision(file, doc, entry, { revisions: [], proposals: [] }, state, source);
        return payload(updated, diagram(updated, id), actor, state);
      });
    },
    async save(key, id, body, actor) {
      return mutate(key, actor, true, async (file, doc) => {
        const current = diagram(doc, id); checkBase(doc, current, body);
        const value = candidate(body, current.title), svg = validateSvg(body.svg);
        const state = includeCurrent(await loadState(doc.documentId, id, current.revisionId), current);
        if (value.title === current.title && JSON.stringify(value.scene) === JSON.stringify(current.scene) && svg === current.svg) return payload(doc, current, actor, state);
        const entry = newRevision(doc.documentId, id, current.revisionId, value, svg);
        const source = replaceDiagram(doc, entry, svg), previousState = structuredClone(state);
        state.revisions.push(entry);
        const updated = await commitRevision(file, doc, entry, previousState, state, source);
        return payload(updated, diagram(updated, id), actor, state);
      });
    },
    async propose(key, id, body, actor) {
      return mutate(key, actor, false, async (file, doc) => {
        const current = diagram(doc, id); checkBase(doc, current, body);
        const value = candidate(body, current.title), svg = body.svg == null ? undefined : validateSvg(body.svg);
        const state = includeCurrent(await loadState(doc.documentId, id, current.revisionId), current);
        if (state.proposals.length >= 1000) fail('Private proposal limit reached');
        state.proposals.push({ proposalId: randomUUID(), documentId: doc.documentId, diagramId: id, baseRevisionId: current.revisionId, baseSourceHash: doc.sourceHash, ...value, ...(svg ? { svg } : {}), status: 'pending', actor, createdAt: new Date().toISOString() });
        await recheck(file, doc, current); await persistState(doc.documentId, id, state);
        return payload(doc, current, actor, state);
      });
    },
    async accept(key, id, proposalId, body, actor) {
      return mutate(key, actor, true, async (file, doc) => {
        const current = diagram(doc, id); checkBase(doc, current, body);
        const state = includeCurrent(await loadState(doc.documentId, id, current.revisionId), current), proposal = state.proposals.find((item) => item.proposalId === proposalId);
        if (!proposal) fail('Proposal not found', 404);
        if (proposal.status !== 'pending') fail('This proposal has already been decided', 409);
        if (proposal.baseRevisionId !== current.revisionId || proposal.baseSourceHash !== doc.sourceHash) conflict(doc, current, 'Proposal was based on an older revision or source. Create a new proposal against the current diagram.');
        const entry = newRevision(doc.documentId, id, current.revisionId, { title: proposal.title, scene: validateScene(proposal.scene), summary: summary(body.summary ?? proposal.summary) }, validateSvg(body.svg));
        const source = replaceDiagram(doc, entry, entry.svg), previousState = structuredClone(state);
        state.revisions.push(entry);
        proposal.status = 'accepted'; proposal.acceptedRevisionId = entry.revisionId; proposal.decidedAt = new Date().toISOString();
        const updated = await commitRevision(file, doc, entry, previousState, state, source);
        return payload(updated, diagram(updated, id), actor, state);
      });
    },
    async reject(key, id, proposalId, body, actor) {
      return mutate(key, actor, true, async (file, doc) => {
        const current = diagram(doc, id); checkBase(doc, current, body);
        const state = includeCurrent(await loadState(doc.documentId, id, current.revisionId), current), proposal = state.proposals.find((item) => item.proposalId === proposalId);
        if (!proposal) fail('Proposal not found', 404);
        if (proposal.status !== 'pending') fail('This proposal has already been decided', 409);
        proposal.status = 'rejected'; proposal.decidedAt = new Date().toISOString();
        await recheck(file, doc, current); await persistState(doc.documentId, id, state);
        return payload(doc, current, actor, state);
      });
    },
    async exportDiagram(key, id, { format = 'excalidraw', revisionId } = {}, actor) {
      authenticate(actor);
      const file = await sessionFile(key);
      return serialized(file, async () => {
        const doc = await readDocument(file), current = diagram(doc, id);
        if (actor === 'reviewer' && revisionId && revisionId !== current.revisionId) fail('Reviewers may only export the current accepted revision', 403);
        let entry = current;
        if (revisionId && revisionId !== current.revisionId) {
          const state = await loadState(doc.documentId, id, current.revisionId);
          entry = state.revisions.find((item) => item.revisionId === revisionId);
          if (!entry) fail('Accepted revision not found in this local profile', 404);
        }
        if (format === 'excalidraw') return { format, content: JSON.stringify(validateScene(entry.scene), null, 2), mimeType: 'application/json', revisionId: entry.revisionId };
        if (format === 'svg') {
          if (!entry.svg) fail('This accepted revision has no matching SVG preview', 409);
          return { format, content: validateSvg(entry.svg), mimeType: 'image/svg+xml', revisionId: entry.revisionId };
        }
        fail('Export format must be excalidraw or svg');
      });
    },
    async checkAnchor(key, id, body, actor, operation) {
      return mutate(key, actor, false, async (_file, doc) => {
        const current = diagram(doc, id); checkBase(doc, current, body);
        if (typeof body.shapeId !== 'string' || !current.scene.elements.some((item) => item.id === body.shapeId && !item.isDeleted)) fail('Shape is absent or removed from the current diagram', 400);
        const anchor = { type: 'diagram_shape', documentId: doc.documentId, diagramId: id, shapeId: body.shapeId, revisionId: current.revisionId };
        // The optional local callback lets the HTTP adapter persist a comment
        // before a queued diagram save can invalidate its checked revision.
        return operation ? operation(anchor) : anchor;
      });
    },
  };
  return service;
}
