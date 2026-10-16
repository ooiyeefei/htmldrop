import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Writable } from 'node:stream';
import { serveEditAsset, scanArtifactDependencies, computeArtifactRevision } from '../src/edit/assets.js';

class Response extends Writable {
  constructor() { super(); this.chunks = []; this.headersSent = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks); }
}

async function fixture(t) {
  const base = resolve('.scratch/test');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'public');
  await mkdir(join(root, 'styles'), { recursive: true });
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'index.html'), '<link href="styles/site.css"><img src="images/photo.png"><a href="report.xlsx">Download</a><img src="missing.png"><img src=".env"><img src="outside.png">');
  await writeFile(join(root, 'styles/site.css'), '@import "theme.css"; body { background: url(../images/photo.png) }');
  await writeFile(join(root, 'styles/theme.css'), 'body { color: red }');
  await writeFile(join(root, 'images/photo.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(root, 'report.xlsx'), 'benign spreadsheet fixture');
  await writeFile(join(root, '.env'), 'BENIGN_FIXTURE=not-secret');
  await writeFile(join(root, 'unreferenced.png'), 'private work in progress');
  await writeFile(join(dir, 'outside.png'), 'outside fixture');
  await symlink(join(dir, 'outside.png'), join(root, 'outside.png'));
  return { root, file: join(root, 'index.html') };
}

async function request(file, assetPath, method = 'GET') {
  const response = new Response();
  await serveEditAsset({ method }, response, { file, assetPath });
  return response;
}

test('declared CSS, nested images and spreadsheet downloads retain bytes and MIME', async t => {
  const { file } = await fixture(t);
  for (const [path, mime] of [['styles/site.css', 'text/css; charset=utf-8'], ['styles/theme.css', 'text/css; charset=utf-8'], ['images/photo.png', 'image/png'], ['report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    const response = await request(file, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], mime);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(Number(response.headers['content-length']), response.body.length);
  }
  const download = await request(file, 'report.xlsx');
  assert.match(download.headers['content-disposition'], /^attachment;/);
  assert.match(download.headers['content-disposition'], /filename\*=UTF-8''report.xlsx/);
  assert.equal((await request(file, 'report.xlsx', 'HEAD')).body.length, 0);
});

test('hidden, traversal, symlink, undeclared and malformed paths are denied without path disclosure', async t => {
  const { file, root } = await fixture(t);
  for (const [path, status] of [['.env', 403], ['%2eenv', 403], ['../outside.png', 403], ['%2e%2e%2foutside.png', 403], ['outside.png', 404], ['unreferenced.png', 404], ['bad%zz.png', 400], ['styles\\site.css', 403], ['config.json', 403]]) {
    const response = await request(file, path);
    assert.equal(response.status, status, path);
    assert.ok(!response.body.toString().includes(root));
    assert.ok(!response.body.toString().includes('BENIGN_FIXTURE'));
  }
});

test('scanner identifies safe nested dependencies, missing refs and blocked paths for preflight/watchers', async t => {
  const { file, root } = await fixture(t);
  const report = await scanArtifactDependencies(file);
  assert.deepEqual(new Set(report.assets), new Set(['styles/site.css', 'styles/theme.css', 'images/photo.png', 'report.xlsx']));
  assert.deepEqual(report.missing, ['missing.png']);
  assert.deepEqual(new Set(report.blocked), new Set(['.env', 'outside.png']));
  assert.ok(report.dependencies.every(path => path.startsWith(root + '/')));
  assert.equal(report.truncated, false);
});

test('intermediate symlink directories and credential-like referenced JSON are blocked', async t => {
  const { file, root } = await fixture(t);
  await symlink(join(root, 'images'), join(root, 'linked'));
  await writeFile(join(root, 'credentials.json'), 'benign');
  await writeFile(file, '<img src="linked/photo.png"><script src="credentials.json"></script>');
  const report = await scanArtifactDependencies(file);
  assert.deepEqual(new Set(report.blocked), new Set(['linked/photo.png', 'credentials.json']));
  assert.equal((await request(file, 'linked/photo.png')).status, 404);
  assert.equal((await request(file, 'credentials.json')).status, 403);
});

test('render revision changes with CSS, binary images, missing refs and source HTML', async t => {
  const { file, root } = await fixture(t);
  const first = await computeArtifactRevision(file);
  assert.equal(first.complete, true);
  assert.match(first.renderRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(await computeArtifactRevision(file), first);
  await writeFile(join(root, 'styles/theme.css'), 'body { color: blue }');
  const css = await computeArtifactRevision(file);
  assert.equal(css.sourceHash, first.sourceHash);
  assert.notEqual(css.renderRevision, first.renderRevision);
  await writeFile(join(root, 'images/photo.png'), Buffer.from([137, 80, 78, 72]));
  const image = await computeArtifactRevision(file);
  assert.notEqual(image.renderRevision, css.renderRevision);
  await writeFile(join(root, 'missing.png'), 'new asset');
  const missing = await computeArtifactRevision(file);
  assert.notEqual(missing.renderRevision, image.renderRevision);
  await writeFile(file, '<p>Changed HTML</p>');
  const html = await computeArtifactRevision(file);
  assert.notEqual(html.sourceHash, first.sourceHash);
  assert.notEqual(html.renderRevision, missing.renderRevision);
  const stale = await computeArtifactRevision(file, '<p>Stale HTML</p>');
  assert.equal(stale.complete, false);
  assert.equal(stale.renderRevision, null);
});

test('private ancestor roots never expose declared discovery JSON', async t => {
  const { root } = await fixture(t);
  const privateRoot = join(root, '.htmldrop/edit');
  await mkdir(privateRoot, { recursive: true });
  const file = join(privateRoot, 'index.html');
  await writeFile(file, '<a href="server.json">data</a>');
  await writeFile(join(privateRoot, 'server.json'), '{"agentToken":"benign-fixture"}');
  const report = await scanArtifactDependencies(file);
  assert.deepEqual(report.assets, []);
  assert.deepEqual(report.blocked, ['[private asset root]']);
  assert.equal((await request(file, 'server.json')).status, 404);
});

test('query-only and hash-only navigation do not introduce publication dependencies', async t => {
  const { file } = await fixture(t);
  await writeFile(file, '<a href="?tab=details">Details</a><a href="#section">Section</a><a href="?tab=details#section">Both</a>');
  const report = await scanArtifactDependencies(file);
  assert.deepEqual(report.assets, []);
  assert.deepEqual(report.dependencies, []);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.blocked, []);
  assert.equal(report.truncated, false);
});
