import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

mkdirSync(resolve('.scratch/mcp-tests'), { recursive: true });
const fixture = mkdtempSync(resolve('.scratch/mcp-tests/session-'));
process.env.HTMLDROP_CONFIG_DIR = join(fixture, 'profile');
const { startServer } = await import('../src/edit/server.js');
const { writeServerInfo, removeServerInfo } = await import('../src/edit/discovery.js');
const { upsertSession } = await import('../src/edit/store.js');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="0" width="80" height="50" fill="white" stroke="black"/></svg>';
const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'shape-one', type: 'rectangle', x: 0, y: 0, width: 80, height: 50, angle: 0, strokeColor: '#000000', backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }], appState: {}, files: {} };

async function connect(file, role) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('bin/htmldrop.js'), 'mcp', '--artifact', file, ...(role ? ['--role', role] : [])],
    env: { ...process.env, HTMLDROP_CONFIG_DIR: process.env.HTMLDROP_CONFIG_DIR }, stderr: 'pipe',
  });
  const client = new Client({ name: 'htmldrop-integration-test', version: '1.0.0' });
  client.protocolErrors = [];
  client.onerror = error => client.protocolErrors.push(error);
  await client.connect(transport);
  return client;
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent || JSON.parse(result.content[0].text);
};

test('real SDK stdio tools/resources share diagram service and enforce revision, role and artifact boundaries', { timeout: 60000 }, async t => {
  const file = join(fixture, 'artifact.html');
  const other = join(fixture, 'other.html');
  writeFileSync(file, '<!doctype html><html><body><h1>Original</h1></body></html>');
  writeFileSync(other, '<html><body>Other artifact</body></html>');
  const session = upsertSession(file);
  upsertSession(other);
  const http = await startServer({ idleTimeoutMs: 120000 });
  writeServerInfo({ port: http.port, agentToken: http.agentToken, pid: process.pid });
  t.after(async () => { removeServerInfo(); await http.close(); });
  const owner = await connect(file, 'owner');
  t.after(() => owner.close());
  const reviewer = await connect(file);
  t.after(() => reviewer.close());
  const ownerNames = (await owner.listTools()).tools.map(item => item.name);
  const reviewerNames = (await reviewer.listTools()).tools.map(item => item.name);
  for (const name of ['diagram_create', 'diagram_save', 'diagram_accept', 'diagram_reject']) {
    assert.ok(ownerNames.includes(name)); assert.ok(!reviewerNames.includes(name));
  }
  const initial = await call(owner, 'diagram_list');
  assert.equal(initial.diagrams.length, 0);
  const created = await call(owner, 'diagram_create', { baseSourceHash: initial.sourceHash, title: 'First', scene, svg });
  assert.ok(created.diagramId);
  const diagramId = created.diagramId;
  const current = await call(reviewer, 'diagram_read', { diagramId });
  const base = { diagramId, baseRevisionId: current.revisionId, baseSourceHash: current.sourceHash };
  const resources = await reviewer.listResources();
  assert.equal(resources.resources.length, 2);
  const resource = await reviewer.readResource({ uri: `htmldrop://artifact/${session.key}/diagrams` });
  assert.equal(JSON.parse(resource.contents[0].text).diagrams[0].diagramId, diagramId);
  const forbiddenResource = await reviewer.readResource({ uri: 'file:///etc/passwd' }).then(() => false, () => true);
  assert.ok(forbiddenResource);
  const proposal = await call(reviewer, 'diagram_propose', { ...base, title: 'Proposed', scene });
  assert.equal(readFileSync(file, 'utf8').includes('Proposed'), false);
  await call(reviewer, 'diagram_comment', { ...base, shapeId: 'shape-one', text: 'Please check this shape', authorName: 'Reviewer' });
  assert.equal((await call(owner, 'diagram_comments', { diagramId })).items.length, 1);
  assert.equal((await call(owner, 'diagram_export', { diagramId, format: 'svg', revisionId: current.revisionId })).content, svg);
  const saved = await call(owner, 'diagram_save', { ...base, title: 'Saved', scene, svg });
  assert.notEqual(saved.revisionId, current.revisionId);
  const source = readFileSync(file, 'utf8');
  const stale = await owner.callTool({ name: 'diagram_save', arguments: { ...base, title: 'Stale', scene, svg } });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.statusCode, 409);
  assert.equal(readFileSync(file, 'utf8'), source);
  const savedBase = { diagramId, baseRevisionId: saved.revisionId, baseSourceHash: saved.sourceHash };
  const rejectedProposal = await call(reviewer, 'diagram_propose', { ...savedBase, title: 'Reject candidate', scene });
  const rejectId = rejectedProposal.proposals.find(item => item.title === 'Reject candidate').proposalId;
  const decision = await call(owner, 'diagram_reject', { ...savedBase, proposalId: rejectId });
  assert.equal(decision.proposals.find(item => item.proposalId === rejectId).status, 'rejected');
  const acceptedProposal = await call(reviewer, 'diagram_propose', { ...savedBase, title: 'Accepted candidate', scene });
  const acceptId = acceptedProposal.proposals.find(item => item.title === 'Accepted candidate').proposalId;
  const accepted = await call(owner, 'diagram_accept', { ...savedBase, proposalId: acceptId, svg });
  assert.equal(accepted.title, 'Accepted candidate');
  assert.notEqual(accepted.revisionId, saved.revisionId);
  const history = await call(reviewer, 'diagram_history', { diagramId });
  assert.deepEqual(history.revisions.map(item => item.revisionId), [accepted.revisionId]);
  assert.ok(history.proposals.every(item => item.baseRevisionId === accepted.revisionId));
  const ownerHistory = await call(owner, 'diagram_history', { diagramId });
  assert.ok(ownerHistory.revisions.some(item => item.revisionId === saved.revisionId));
  const oldExport = await reviewer.callTool({ name: 'diagram_export', arguments: { diagramId, format: 'excalidraw', revisionId: saved.revisionId } });
  assert.equal(oldExport.isError, true);
  assert.equal(oldExport.structuredContent.error.statusCode, 403);
  assert.equal(JSON.parse((await call(reviewer, 'diagram_export', { diagramId, format: 'excalidraw' })).content).type, 'excalidraw');
  const forbiddenSave = await reviewer.callTool({ name: 'diagram_save', arguments: { ...base, title: 'Forbidden', scene, svg } }).catch(() => ({ isError: true }));
  assert.equal(forbiddenSave.isError, true);
  const cross = await connect(other, 'owner');
  t.after(() => cross.close());
  const rejected = await cross.callTool({ name: 'diagram_read', arguments: { diagramId } });
  assert.equal(rejected.isError, true);
  assert.ok(proposal);
  assert.deepEqual(owner.protocolErrors, [], 'Owner stdout must contain protocol messages only');
  assert.deepEqual(reviewer.protocolErrors, [], 'Reviewer stdout must contain protocol messages only');
});

test('stdio startup refuses an unregistered HTML artifact without registering it', { timeout: 10000 }, async () => {
  const file = join(fixture, 'unregistered.html');
  writeFileSync(file, '<html></html>');
  await assert.rejects(connect(file));
});
