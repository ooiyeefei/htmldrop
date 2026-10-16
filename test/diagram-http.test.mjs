import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startRemoteGateway } from '../src/edit/remote.js';

function call(port, path, { method = 'GET', token, origin, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers,
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c);
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, data }); });
    });
    req.on('error', reject); req.end(payload);
  });
}
const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'shape-1', type: 'rectangle', x: 20, y: 30, width: 100, height: 50, angle: 0 }], appState: {}, files: {} };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="70"><rect x="10" y="10" width="100" height="50"/></svg>';

test('diagram HTTP transport permissions, conflicts, stable shape feedback and review isolation', async t => {
  const scratch = resolve('.scratch'); await mkdir(scratch, { recursive: true });
  const fixture = await mkdtemp(join(scratch, 'diagram-http-'));
  const previousConfig = process.env.HTMLDROP_CONFIG_DIR;
  process.env.HTMLDROP_CONFIG_DIR = join(fixture, 'profile');
  process.env.HTMLDROP_EDIT_NOTIFY = '0';
  const { startServer } = await import('../src/edit/server.js');
  const server = await startServer({ idleTimeoutMs: null });
  let gateway;
  t.after(async () => { await gateway?.close(); await server.close(); await rm(fixture, { recursive: true, force: true }); if (previousConfig === undefined) delete process.env.HTMLDROP_CONFIG_DIR; else process.env.HTMLDROP_CONFIG_DIR = previousConfig; });
  const owner = { token: server.agentToken }, browser = { origin: `http://127.0.0.1:${server.port}` };
  const reviewer = { token: server.agentToken, headers: { 'x-htmldrop-reviewer': '1' } };
  const file = join(fixture, 'document.html'), otherFile = join(fixture, 'other.html');
  const original = '<!doctype html><html><head><title>Original</title></head><body><p>Keep this content.</p></body></html>';
  await writeFile(file, original); await writeFile(otherFile, original);
  const register = f => call(server.port, '/__edit/sessions', { ...owner, method: 'POST', body: { file: f } });
  const { data: { key } } = await register(file), { data: { key: otherKey } } = await register(otherFile);
  const root = `/api/edit/${key}/diagrams`, otherRoot = `/api/edit/${otherKey}/diagrams`;
  const initial = await call(server.port, root, reviewer);
  assert.equal(initial.status, 200); assert.equal(initial.data.permissions.save, false);
  const createBody = { baseSourceHash: initial.data.sourceHash, title: 'Flow', scene, svg };
  assert.equal((await call(server.port, root, { method: 'POST', body: createBody })).status, 403);
  assert.equal((await call(server.port, root, { ...browser, origin: 'https://evil.example', method: 'POST', body: createBody })).status, 403);
  assert.equal((await call(server.port, root, { ...reviewer, method: 'POST', body: { ...createBody, actor: 'owner', role: 'owner' } })).status, 403);
  const created = await call(server.port, root, { ...browser, method: 'POST', body: createBody });
  assert.equal(created.status, 201, created.text);
  let diagram = created.data;
  const path = `${root}/${diagram.diagramId}`;
  assert.equal((await call(server.port, `${otherRoot}/${diagram.diagramId}`, owner)).status, 404);
  assert.match(await readFile(file, 'utf8'), /Keep this content\./);
  const base = () => ({ baseRevisionId: diagram.revisionId, baseSourceHash: diagram.sourceHash });
  const denied = [path + '/save', path + '/proposals/00000000-0000-4000-8000-000000000000/accept', path + '/proposals/00000000-0000-4000-8000-000000000000/reject'];
  for (const endpoint of denied) assert.equal((await call(server.port, endpoint, { ...reviewer, method: 'POST', body: { ...base(), scene, svg, actor: 'owner' } })).status, 403);
  const stale = await call(server.port, path + '/save', { ...owner, method: 'POST', body: { ...base(), baseSourceHash: '0'.repeat(64), title: 'Flow', scene, svg } });
  assert.equal(stale.status, 409, stale.text); assert.equal(stale.data.current.revisionId, diagram.revisionId);
  const comment = await call(server.port, path + '/comments', { ...browser, method: 'POST', body: { ...base(), shapeId: 'shape-1', text: 'Make it clearer', authorName: 'Owner', editToken: 'browser-secret-0123456789' } });
  assert.equal(comment.status, 201, comment.text);
  const listed = await call(server.port, path + '/comments', reviewer);
  assert.equal(listed.data.items[0].anchor.shapeId, 'shape-1'); assert.equal(listed.data.items[0].agent, undefined);
  assert.equal((await call(server.port, path + '/comments', { ...reviewer, method: 'POST', body: { ...base(), shapeId: 'missing', text: 'Invalid' } })).status, 400);
  const canonical = listed.data.items[0].anchor;
  const feedback = body => call(server.port, `/api/feedback/${key}`, { ...browser, method: 'POST', body: { content: { type: 'text', text: 'Generic API' }, ...body } });
  assert.equal((await feedback({ anchor: { ...canonical, documentId: '00000000-0000-4000-8000-000000000000' } })).status, 400);
  assert.equal((await feedback({ anchor: { ...canonical, shapeId: 'missing' } })).status, 400);
  assert.equal((await feedback({ anchor: canonical })).status, 201);
  const proposed = await call(server.port, path + '/proposals', { ...reviewer, method: 'POST', body: { ...base(), scene, title: 'Proposed flow', actor: 'owner' } });
  assert.equal(proposed.status, 201, proposed.text);
  const unchanged = await call(server.port, path, owner); assert.equal(unchanged.data.revisionId, diagram.revisionId);
  const proposalId = proposed.data.proposals[0].proposalId;
  const accepted = await call(server.port, `${path}/proposals/${proposalId}/accept`, { ...owner, method: 'POST', body: { ...base(), svg } });
  assert.equal(accepted.status, 200, accepted.text); assert.notEqual(accepted.data.revisionId, diagram.revisionId);
  diagram = accepted.data;
  const rejectable = await call(server.port, path + '/proposals', { ...reviewer, method: 'POST', body: { ...base(), scene, title: 'Do not apply' } });
  const rejectId = rejectable.data.proposals[0].proposalId;
  const rejected = await call(server.port, `${path}/proposals/${rejectId}/reject`, { ...owner, method: 'POST', body: base() });
  assert.equal(rejected.status, 200, rejected.text); assert.equal(rejected.data.proposals[0].status, 'rejected');
  assert.equal(rejected.data.revisionId, diagram.revisionId);
  const reply = await call(server.port, `/api/feedback/${key}/${comment.data.id}/reply`, { ...browser, method: 'POST', body: { content: { type: 'text', text: 'Reply to shape' }, editToken: 'browser-secret-0123456789' } });
  assert.equal(reply.status, 201);
  assert.equal((await call(server.port, path + '/comments', reviewer)).data.items.some(item => item.id === reply.data.id), true);

  const exported = await call(server.port, path + '/export?format=svg', reviewer); assert.equal(exported.status, 200); assert.equal(exported.data.content, svg);
  // External author writes invalidate both accepted writes and new proposals.
  await writeFile(file, (await readFile(file, 'utf8')).replace('Keep this content.', 'External edit.'));
  assert.equal((await call(server.port, path + '/proposals', { ...reviewer, method: 'POST', body: { ...base(), scene } })).status, 409);
  diagram = (await call(server.port, path, owner)).data;
  const deleted = structuredClone(scene); deleted.elements[0].isDeleted = true;
  assert.equal((await call(server.port, path + '/save', { ...owner, method: 'POST', body: { ...base(), title: 'Removed', scene: deleted, svg } })).status, 200);
  const historical = await call(server.port, path + '/comments', owner); assert.equal(historical.data.items[0].anchor.shapeId, 'shape-1');
  // Real gateway authentication grants exactly this document's reviewer routes.
  const origin = 'https://review.example.test', host = 'review.example.test';
  gateway = await startRemoteGateway({ publicOrigin: origin, sessionKey: key, backendPort: server.port });
  const exchange = await call(gateway.port, '/__review/exchange', { method: 'POST', origin, headers: { host }, body: { token: new URL(gateway.url).hash.slice(1) } });
  assert.equal(exchange.status, 200); const cookie = exchange.headers['set-cookie'][0].split(';')[0];
  const remote = { origin, headers: { host, cookie } };
  assert.equal((await call(gateway.port, root, remote)).status, 200);
  assert.equal((await call(gateway.port, otherRoot, remote)).status, 404);
  for (const endpoint of [root, ...denied]) assert.equal((await call(gateway.port, endpoint, { ...remote, method: 'POST', body: { actor: 'owner' } })).status, 404);
  const shell = await call(gateway.port, `/s/${key}/__editor/`, remote); assert.equal(shell.status, 200); assert.match(shell.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal((await call(gateway.port, `/s/${otherKey}/__editor/`, remote)).status, 404);
});
