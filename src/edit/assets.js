import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

// Only declared HTML/CSS dependencies are exposed. These limits also bound
// preflight and watcher discovery; no recursive directory scan is performed.
const MAX_FILES = 512;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_REVISION_BYTES = 256 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
const DOWNLOAD = new Set(['.pdf', '.csv', '.xlsx', '.xls', '.docx', '.zip', '.txt']);
const PRIVATE = /^(?:node_modules|coverage|dist|build|vendor|credentials?(?:\..*)?|secrets?(?:\..*)?|config(?:\..*)?|package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|id_(?:rsa|ed25519)(?:\..*)?)$/i;
const SENSITIVE = /(?:^|[-_.])(?:secrets?|credentials?|tokens?|passwords?|private[-_]?key|service[-_]?account)(?:[-_.]|$)/i;
const PRIVATE_ROOT = new Set(['.htmldrop', '.ssh', '.aws', '.git', '.config', '.codex', '.agents', '.gnupg', '.kube']);

function safeRelative(path) {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path)) return false;
  const parts = path.split('/');
  return parts.every(p => p && p !== '..' && !p.startsWith('.') && !PRIVATE.test(p) && !SENSITIVE.test(p)) && !!MIME[extname(path).toLowerCase()];
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Reject every symlink, including intermediate directories. O_NOFOLLOW protects
// the final open, and descriptor/target identity is checked after opening.
// Portable Node APIs cannot lock ancestor directories against concurrent rename;
// the artifact tree must not be concurrently replaced by an untrusted writer.
async function openSafe(root, path, limit = MAX_BYTES) {
  if (!inside(root, path)) throw Object.assign(new Error('Unavailable'), { code: 'EACCES' });
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Object.assign(new Error('Unavailable'), { code: 'EACCES' });
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    const actual = await realpath(path);
    const target = await lstat(path);
    if (!inside(root, actual) || actual !== path || target.isSymbolicLink() || target.dev !== info.dev || target.ino !== info.ino || !info.isFile()) {
      throw Object.assign(new Error('Unavailable'), { code: 'EACCES' });
    }
    if (info.size > limit) throw Object.assign(new Error('Too large'), { code: 'EFBIG' });
    return { handle, size: info.size };
  } catch (error) { await handle.close(); throw error; }
}

function references(source, css) {
  const refs = [];
  if (!css) {
    // Ignore comments and inline script bodies: they are not asset declarations.
    const html = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, tag => tag.slice(0, tag.indexOf('>') + 1));
    for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) refs.push(attr[1] ?? attr[2] ?? attr[3]);
      for (const attr of tag[0].matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        for (const entry of (attr[1] ?? attr[2]).split(',')) refs.push(entry.trim().split(/\s+/)[0]);
      }
    }
    source = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m => m[1]).join('\n') + '\n' + [...html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(m => m[1] ?? m[2]).join('\n');
  }
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+["']([^"']+)["']/gi)) refs.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  return refs;
}

/** Bounded static HTML/CSS dependency discovery; dynamic JS URLs are unsupported.
 * Paths in dependencies are absolute (watchers); all other path lists are relative
 * to root. Missing/blocked/truncated mean publication cannot be assumed portable.
 */
export async function scanArtifactDependencies(file) {
  const root = await realpath(dirname(resolve(file)));
  // A declared reference must never expose editor discovery or user credentials,
  // including when the artifact itself was opened inside a private directory.
  if (root.split(sep).some(part => PRIVATE_ROOT.has(part.toLowerCase()))) {
    return { root, dependencies: [], assets: [], missing: [], blocked: ['[private asset root]'], truncated: false };
  }
  const entry = resolve(root, basename(file));
  const assets = new Set(), missing = new Set(), blocked = new Set(), visited = new Set();
  const queue = [entry];
  let scannedBytes = 0;
  let truncated = false;
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (visited.size > MAX_FILES) { truncated = true; break; }
    let opened;
    try { opened = await openSafe(root, current, MAX_SOURCE_BYTES); }
    catch (error) {
      const name = relative(root, current).split(sep).join('/');
      (error.code === 'ENOENT' ? missing : blocked).add(name);
      if (error.code === 'EFBIG' || current !== entry) truncated = true;
      continue;
    }
    let source;
    try {
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      scannedBytes += length;
      if (length > MAX_SOURCE_BYTES || scannedBytes > MAX_SCAN_BYTES) { truncated = true; break; }
      source = buffer.subarray(0, length).toString('utf8');
    } finally { await opened.handle.close(); }
    for (const raw of references(source, extname(current).toLowerCase() === '.css')) {
      const value = raw.trim().replace(/&amp;/gi, '&');
      if (!value || value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
      const urlPath = value.split(/[?#]/)[0];
      // Query/hash-only links navigate within the current document.
      if (!urlPath) continue;
      let decoded;
      try { decoded = decodeURIComponent(urlPath); } catch { blocked.add(value); continue; }
      const path = resolve(dirname(current), decoded);
      const name = relative(root, path).split(sep).join('/');
      if (decoded.startsWith('/') || !safeRelative(name)) { blocked.add(value); continue; }
      if (assets.has(name) || missing.has(name) || blocked.has(name)) continue;
      if (assets.size + missing.size + blocked.size >= MAX_FILES) { truncated = true; break; }
      let asset;
      try { asset = await openSafe(root, path); }
      catch (error) { (error.code === 'ENOENT' ? missing : blocked).add(name); continue; }
      await asset.handle.close();
      assets.add(name);
      if (extname(path).toLowerCase() === '.css') queue.push(path);
    }
  }
  return { root, dependencies: [...assets].map(name => resolve(root, name)), assets: [...assets], missing: [...missing], blocked: [...blocked], truncated };
}

/** Fingerprint the displayed HTML and every safe static dependency, including
 * binary images/fonts. An incomplete snapshot has no usable revision. Callers
 * must reject writes when complete is false, rather than accepting sourceHash.
 */
export async function computeArtifactRevision(file, sourceHtml) {
  const sourceHash = sourceHtml === undefined ? null : createHash('sha256').update(sourceHtml).digest('hex');
  let report;
  try { report = await scanArtifactDependencies(file); }
  catch { return { sourceHash, renderRevision: null, complete: false }; }
  const digest = createHash('sha256');
  digest.update('htmldrop-render-v1\0');
  const metadata = JSON.stringify({ assets: [...report.assets].sort(), missing: [...report.missing].sort(), blocked: [...report.blocked].sort(), truncated: report.truncated });
  digest.update(metadata);
  let actualSourceHash = sourceHash;
  let total = 0;
  if (report.truncated) return { sourceHash, renderRevision: null, complete: false };
  const paths = [basename(file), ...report.assets.filter(name => name !== basename(file)).sort()];
  for (const name of paths) {
    let opened;
    try {
      opened = await openSafe(report.root, resolve(report.root, name), name === basename(file) ? MAX_SOURCE_BYTES : MAX_BYTES);
      const before = await opened.handle.stat();
      total += opened.size;
      if (total > MAX_REVISION_BYTES) return { sourceHash: actualSourceHash, renderRevision: null, complete: false };
      digest.update(`\0${JSON.stringify(name)}\0${opened.size}\0`);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < opened.size) {
        const { bytesRead } = await opened.handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
        if (!bytesRead) throw new Error('Changed asset');
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        digest.update(bytes);
        position += bytesRead;
      }
      const after = await opened.handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Changed asset');
      if (name === basename(file)) {
        actualSourceHash = hash.digest('hex');
        if (sourceHash !== null && sourceHash !== actualSourceHash) return { sourceHash, renderRevision: null, complete: false };
      }
    } catch {
      return { sourceHash: actualSourceHash, renderRevision: null, complete: false };
    } finally { if (opened) await opened.handle.close(); }
  }
  return { sourceHash: actualSourceHash, renderRevision: digest.digest('hex'), complete: true };
}

/** Serve a URL-encoded session-relative, declared dependency. Never accepts an
 * absolute filename or a user-selected root. All errors omit filesystem paths.
 */
export async function serveEditAsset(req, res, { file, assetPath }) {
  const fail = status => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(status === 400 ? 'Bad asset path' : 'Asset unavailable'); };
  let name;
  try { name = decodeURIComponent(assetPath); } catch { fail(400); return; }
  if (!safeRelative(name)) { fail(403); return; }
  let opened;
  try {
    const report = await scanArtifactDependencies(file);
    if (!report.assets.includes(name)) { fail(404); return; }
    opened = await openSafe(report.root, resolve(report.root, name));
    const extension = extname(name).toLowerCase();
    const headers = { 'content-type': MIME[extension], 'content-length': opened.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (DOWNLOAD.has(extension)) headers['content-disposition'] = `attachment; filename="download${extension}"; filename*=UTF-8''${encodeURIComponent(basename(name)).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else await pipeline(opened.handle.createReadStream({ autoClose: false, start: 0, end: Math.max(0, opened.size - 1) }), res);
  } catch (error) {
    if (!res.headersSent) fail(error.code === 'EFBIG' ? 413 : 404);
    else res.destroy();
  } finally { if (opened) await opened.handle.close(); }
}
