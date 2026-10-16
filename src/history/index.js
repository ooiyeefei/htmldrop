import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.js';
import { decryptHtml, encryptToEnvelope } from '../encrypt.js';
import { historyRuntime, diffWords } from './runtime.js';

const START = '<!-- htmldrop:history:start -->';
const END = '<!-- htmldrop:history:end -->';
const ID_RE = /^[a-zA-Z0-9-]{1,100}$/;

export function stripHistoryWidget(html) {
  let start = html.indexOf(START);
  while (start >= 0) {
    const end = html.indexOf(END, start);
    if (end < 0) return html;
    // Preserve similarly named author comments unless this is our complete block.
    const block = html.slice(start + START.length, end);
    if (block.startsWith('<script type="application/json" id="htmldrop-history-data">') && block.endsWith(');</script>')) {
      return html.slice(0, start) + html.slice(end + END.length);
    }
    start = html.indexOf(START, start + START.length);
  }
  return html;
}

export function readHistoryConfig(html) {
  const match = /<script type="application\/json" id="htmldrop-history-data">([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function validateImportedHistory(data) {
  if (!data || typeof data.id !== 'string' || !ID_RE.test(data.id) || !Array.isArray(data.revisions) || !data.revisions.length || data.revisions.length > 1000) {
    throw new Error('Invalid document history metadata.');
  }
  let size;
  try { size = Buffer.byteLength(JSON.stringify(data.revisions), 'utf8'); } catch { throw new Error('Invalid document history metadata.'); }
  if (size > 20 * 1024 * 1024) throw new Error('Document history exceeds the 20 MB import limit.');
  let previous = 0;
  const revisions = data.revisions.map((item) => {
    if (!item || !Number.isSafeInteger(item.number) || item.number <= previous || typeof item.date !== 'string' || !Number.isFinite(Date.parse(item.date))) {
      throw new Error('Invalid document history revision.');
    }
    previous = item.number;
    if (item.unavailable === true) return { number: item.number, date: item.date, unavailable: true };
    if (typeof item.encrypted !== 'boolean') throw new Error('Invalid document history protection metadata.');
    const revision = { number: item.number, date: item.date, encrypted: item.encrypted };
    if (item.encrypted) {
      if (typeof item.envelope !== 'string' || !/^v2:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/.test(item.envelope) || 'html' in item) {
        throw new Error('Invalid encrypted document history revision.');
      }
      revision.envelope = item.envelope;
    } else {
      if (typeof item.html !== 'string') throw new Error('Invalid public document history revision.');
      revision.html = item.html;
      revision.hash = createHash('sha256').update(item.html).digest('hex');
      if (item.hash !== undefined && item.hash !== revision.hash) throw new Error('Document history source hash does not match.');
    }
    return revision;
  });
  if (data.version !== revisions.at(-1).number) throw new Error('Document history version does not match its revisions.');
  return { id: data.id, revisions, version: data.version };
}

// Adopt the self-contained archive from a pulled page. Shared immutable revision
// numbers must agree; an unavailable placeholder can be filled by a real copy.
// Older pulled pages cannot roll back a newer archive already held locally.
export function importHistory(data) {
  const imported = validateImportedHistory(data);
  const archivePath = join(getConfigDir(), 'history', `${imported.id}.json`);
  let existing = [];
  if (existsSync(archivePath)) {
    let archive;
    try { archive = JSON.parse(readFileSync(archivePath, 'utf8')); } catch { throw new Error('Could not read existing document history archive.'); }
    if (archive.id !== imported.id) throw new Error('Existing document history identity does not match.');
    existing = validateImportedHistory({ ...archive, version: archive.revisions?.at(-1)?.number }).revisions;
  }
  const merged = new Map(existing.map((revision) => [revision.number, revision]));
  for (const revision of imported.revisions) {
    const prior = merged.get(revision.number);
    if (prior && !prior.unavailable && !revision.unavailable && JSON.stringify(prior) !== JSON.stringify(revision)) {
      throw new Error(`Document history conflict at version ${revision.number}; existing history was preserved.`);
    }
    if (!prior || prior.unavailable) merged.set(revision.number, revision);
  }
  const revisions = [...merged.values()].sort((a, b) => a.number - b.number);
  const history = { id: imported.id, revisions, version: revisions.at(-1).number, archivePath };
  // Validate the merged size too, before changing anything on disk.
  validateImportedHistory(history);
  saveHistory(history);
  return history;
}

// Archives live beside the manifest, never under the directory sent to Surge.
// A private source is encrypted individually as well as inside the current gate.
// This preserves older passwords across rotation without retaining any password.
export function prepareHistory({ html, priorEntry, password, newDoc = false, date = new Date().toISOString() }) {
  const id = !newDoc && ID_RE.test(priorEntry?.historyId || '') ? priorEntry.historyId : randomUUID();
  const archivePath = join(getConfigDir(), 'history', `${id}.json`);
  let revisions = [];
  let warning;
  if (existsSync(archivePath)) {
    try {
      const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
      if (archive.id !== id || !Array.isArray(archive.revisions)) throw new Error('Invalid archive');
      revisions = archive.revisions;
    } catch {
      throw new Error(`Could not read document history: ${archivePath}. Restore the archive before publishing.`);
    }
  } else if (!newDoc && priorEntry?.historyVersion) {
    // Keep the sequence truthful on a machine whose archive was not copied.
    // The UI names the gap instead of pretending the prior version is available.
    revisions = [{ number: priorEntry.historyVersion, date: priorEntry.date, unavailable: true }];
    warning = 'Earlier document history is unavailable on this machine. Copy the htmldrop history archive from the original publisher to restore it.';
  }
  const last = revisions.at(-1);
  const previous = last?.encrypted ? (password ? decryptHtml(last.envelope, password) : null) : last?.html;
  // A protection change is a revision too. In particular, never turn a private
  // archive into plaintext simply because a later publish uses no password.
  const same = last && !last.unavailable && Boolean(password) === Boolean(last.encrypted) && previous === html;
  if (!same) {
    const revision = { number: (last?.number || 0) + 1, date, encrypted: Boolean(password) };
    if (password) revision.envelope = encryptToEnvelope(html, password).envelope;
    else {
      revision.html = html;
      revision.hash = createHash('sha256').update(html).digest('hex');
    }
    revisions = [...revisions, revision];
  }
  return { id, revisions, version: revisions.at(-1).number, archivePath, warning };
}

export function saveHistory(history) {
  mkdirSync(join(getConfigDir(), 'history'), { recursive: true, mode: 0o700 });
  writeFileSync(history.archivePath, JSON.stringify({ id: history.id, revisions: history.revisions }), { encoding: 'utf8', mode: 0o600 });
}

export function injectHistoryWidget(html, history) {
  const config = JSON.stringify({ id: history.id, version: history.version, revisions: history.revisions, currentHtml: html }).replace(/</g, '\\u003c');
  const block = `${START}<script type="application/json" id="htmldrop-history-data">${config}</script><script>(${historyRuntime.toString()})(${diffWords.toString()});</script>${END}`;
  const close = /<\/body\s*>/i.exec(html) || /<\/html\s*>/i.exec(html);
  return close ? html.slice(0, close.index) + block + html.slice(close.index) : html + block;
}
