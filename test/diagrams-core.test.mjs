import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createDiagramService } from '../src/diagrams/service.js';
import { parseDocument, validateScene, validateSvg, LIMITS } from '../src/diagrams/document.js';

const original = '<!doctype html>\n<html><head><title>Untouched title</title></head>\n<body data-test="keep"><h1>Keep every byte</h1>\n</body></html>\n';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#fff"/></svg>';
const svg2 = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#f00"/></svg>';
function scene(text = 'Hello') {
  return { type: 'excalidraw', version: 2, elements: [{ id: 'stable-shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, angle: 0, isDeleted: false }, { id: 'stable-text', type: 'text', x: 10, y: 10, width: 50, height: 20, text, angle: 0, isDeleted: false }], appState: { viewBackgroundColor: '#fff' }, files: {} };
}
const base = (value) => ({ baseSourceHash: value.sourceHash, baseRevisionId: value.revisionId });
const hasStatus = (status) => (error) => error.statusCode === status;
async function fixture(t, source = original) {
  await mkdir(resolve('.scratch'), { recursive: true });
  const dir = await mkdtemp(resolve('.scratch/diagrams-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'artifact.html'), configDir = join(dir, 'profile');
  await writeFile(file, source, { mode: 0o640 });
  const service = createDiagramService({ getSession: (key) => key === 'registered' ? { file } : null, configDir });
  const create = async (overrides = {}) => service.create('registered', { baseSourceHash: (await service.list('registered', 'owner')).sourceHash, title: 'Initial', scene: scene(), svg, ...overrides }, 'owner');
  return { dir, file, configDir, service, create };
}

test('accepted diagrams roundtrip safely and preserve surrounding source and shape IDs', async (t) => {
  const f = await fixture(t);
  const before = await f.service.list('registered', 'reviewer');
  assert.equal(before.documentId, null);
  assert.deepEqual(before.diagrams, []);
  assert.equal(before.permissions.save, false);
  await assert.rejects(stat(f.configDir), { code: 'ENOENT' });
  const created = await f.create({ title: 'A "title" <safe>', scene: scene('</script><script>alert(1)</script>') });
  const source = await readFile(f.file, 'utf8'), doc = parseDocument(source);
  assert.equal(doc.diagrams.length, 1);
  assert.equal(doc.diagrams[0].scene.elements[1].text, '</script><script>alert(1)</script>');
  assert.ok(source.includes('\\u003c/script>'));
  const sourceWithoutManaged = source.replace(/\n<meta name="htmldrop-document-id" content="[^"]+">\n/, '').replace(/\n<!-- htmldrop:diagram:[\s\S]+?:end -->\n/, '');
  assert.equal(sourceWithoutManaged, original);
  assert.equal((await stat(f.file)).mode & 0o777, 0o640);
  const saved = await f.service.save('registered', created.diagramId, { ...base(created), title: 'New title', scene: scene('Changed'), svg: svg2, summary: 'Update label' }, 'owner');
  assert.equal(saved.documentId, created.documentId);
  assert.equal(saved.diagramId, created.diagramId);
  assert.equal(saved.parentRevisionId, created.revisionId);
  assert.equal(saved.scene.elements[0].id, 'stable-shape');
  assert.equal(saved.revisions.length, 2);
  assert.equal((await f.service.exportDiagram('registered', created.diagramId, { format: 'svg', revisionId: created.revisionId }, 'owner')).content, svg);
  assert.equal((await f.service.exportDiagram('registered', created.diagramId, { format: 'svg' }, 'owner')).content, svg2);
  const exported = await f.service.exportDiagram('registered', created.diagramId, { format: 'excalidraw', revisionId: created.revisionId }, 'owner');
  assert.deepEqual(JSON.parse(exported.content), created.scene);
  await assert.rejects(f.service.exportDiagram('registered', created.diagramId, { format: 'svg', revisionId: randomUUID() }, 'owner'), hasStatus(404));
});

test('private proposals never enter source; owner acceptance uses the stored candidate and fresh preview', async (t) => {
  const f = await fixture(t), created = await f.create(), source = await readFile(f.file);
  const proposed = await f.service.propose('registered', created.diagramId, { ...base(created), title: 'Candidate title', scene: scene('Private suggestion'), summary: 'Private rationale' }, 'reviewer');
  const proposal = proposed.proposals[0];
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.svg, undefined);
  assert.deepEqual(await readFile(f.file), source);
  await assert.rejects(f.service.accept('registered', created.diagramId, proposal.proposalId, base(created), 'owner'), /fresh SVG preview/);
  const accepted = await f.service.accept('registered', created.diagramId, proposal.proposalId, { ...base(created), scene: scene('Do not use me'), title: 'Do not use me', svg: svg2 }, 'owner');
  assert.equal(accepted.title, 'Candidate title');
  assert.equal(accepted.scene.elements[1].text, 'Private suggestion');
  assert.equal(accepted.proposals[0].acceptedRevisionId, accepted.revisionId);
  assert.equal(accepted.proposals[0].status, 'accepted');
  assert.ok(!(await readFile(f.file, 'utf8')).includes('Private rationale'));
  const next = await f.service.propose('registered', created.diagramId, { ...base(accepted), scene: scene('Rejected candidate') }, 'reviewer');
  const beforeReject = await readFile(f.file);
  const rejected = await f.service.reject('registered', created.diagramId, next.proposals[0].proposalId, base(accepted), 'owner');
  assert.equal(rejected.proposals[0].status, 'rejected');
  assert.deepEqual(await readFile(f.file), beforeReject);
  await assert.rejects(f.service.accept('registered', created.diagramId, next.proposals[0].proposalId, { ...base(accepted), svg }, 'owner'), hasStatus(409));
});

test('role checks occur before owner mutations and all stale operations preserve current bytes', async (t) => {
  const f = await fixture(t), created = await f.create(), body = { ...base(created), scene: scene('Candidate'), svg };
  for (const method of ['save', 'accept', 'reject']) {
    const args = method === 'save' ? ['registered', created.diagramId, body, 'reviewer'] : ['registered', created.diagramId, randomUUID(), body, 'reviewer'];
    await assert.rejects(f.service[method](...args), hasStatus(403));
  }
  await assert.rejects(f.service.create('registered', body, 'reviewer'), hasStatus(403));
  await assert.rejects(f.service.list('registered', 'spoofed-owner'), hasStatus(403));
  const next = await f.service.save('registered', created.diagramId, body, 'owner'), bytes = await readFile(f.file);
  for (const method of ['save', 'propose', 'checkAnchor']) {
    await assert.rejects(f.service[method]('registered', created.diagramId, { ...body, shapeId: 'stable-shape' }, 'owner'), (error) => error.statusCode === 409 && error.current.revisionId === next.revisionId);
    assert.deepEqual(await readFile(f.file), bytes);
  }
  await writeFile(f.file, (await readFile(f.file, 'utf8')).replace('Keep every byte', 'External update'));
  await assert.rejects(f.service.save('registered', next.diagramId, { ...base(next), scene: scene('Overwrite'), svg }, 'owner'), hasStatus(409));
  assert.ok((await readFile(f.file, 'utf8')).includes('External update'));
});

test('per-file serialization across service instances permits one optimistic writer', async (t) => {
  const f = await fixture(t), created = await f.create();
  const second = createDiagramService({ getSession: () => ({ file: f.file }), configDir: f.configDir });
  const results = await Promise.allSettled([f.service.save('registered', created.diagramId, { ...base(created), scene: scene('First'), svg }, 'owner'), second.save('registered', created.diagramId, { ...base(created), scene: scene('Second'), svg: svg2 }, 'owner')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.statusCode, 409);
  assert.equal((await f.service.read('registered', created.diagramId, 'owner')).revisions.length, 2);
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.tmp')));
});

test('private history is encrypted and isolated by profile while embedded accepted source is portable', async (t) => {
  const f = await fixture(t), created = await f.create();
  await f.service.propose('registered', created.diagramId, { ...base(created), scene: scene('TOP SECRET PRIVATE PROPOSAL') }, 'reviewer');
  const stateDir = join(f.configDir, 'edit', 'diagrams'), files = await readdir(stateDir), stateFile = files.find((file) => file.endsWith('.json.enc'));
  const raw = await readFile(join(stateDir, stateFile), 'utf8');
  assert.ok(!raw.includes('TOP SECRET'));
  assert.ok(!raw.includes('stable-shape'));
  assert.equal((await stat(join(stateDir, stateFile))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'history.key'))).mode & 0o777, 0o600);
  const other = createDiagramService({ getSession: () => ({ file: f.file }), configDir: join(f.dir, 'other-profile') });
  const portable = await other.read('registered', created.diagramId, 'reviewer');
  assert.deepEqual(portable.scene, created.scene);
  assert.equal(portable.proposals.length, 0);
  assert.equal(portable.revisions.length, 1);
  await assert.rejects(stat(join(f.dir, 'other-profile')), { code: 'ENOENT' });
});

test('reviewers cannot recover removed confidential scenes, previews, summaries or old proposals', async (t) => {
  const f = await fixture(t), secretSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>OLD CONFIDENTIAL PREVIEW</text></svg>';
  const created = await f.create({ scene: scene('OLD CONFIDENTIAL SHAPE'), svg: secretSvg, summary: 'OLD CONFIDENTIAL SUMMARY' });
  await f.service.propose('registered', created.diagramId, { ...base(created), scene: scene('OLD CONFIDENTIAL PROPOSAL') }, 'reviewer');
  const cleaned = await f.service.save('registered', created.diagramId, { ...base(created), scene: scene('Approved public label'), svg: svg2 }, 'owner');
  const reviewer = await f.service.read('registered', created.diagramId, 'reviewer');
  assert.equal(reviewer.revisions.length, 1);
  assert.equal(reviewer.revisions[0].revisionId, cleaned.revisionId);
  assert.equal(reviewer.proposals.length, 0);
  assert.ok(!JSON.stringify(reviewer).includes('OLD CONFIDENTIAL'));
  for (const format of ['excalidraw', 'svg']) await assert.rejects(f.service.exportDiagram('registered', created.diagramId, { format, revisionId: created.revisionId }, 'reviewer'), hasStatus(403));
  assert.ok(JSON.stringify(await f.service.read('registered', created.diagramId, 'owner')).includes('OLD CONFIDENTIAL'));
  assert.equal((await f.service.exportDiagram('registered', created.diagramId, { format: 'svg', revisionId: created.revisionId }, 'owner')).content, secretSvg);
  const fresh = await f.service.propose('registered', created.diagramId, { ...base(cleaned), scene: scene('Current reviewer proposal') }, 'reviewer');
  assert.equal(fresh.proposals.length, 1);
  assert.equal(fresh.proposals[0].scene.elements[1].text, 'Current reviewer proposal');
});

test('shape anchors validate live shape membership and deleted shapes retain stable identity', async (t) => {
  const f = await fixture(t), created = await f.create();
  const anchor = await f.service.checkAnchor('registered', created.diagramId, { ...base(created), shapeId: 'stable-shape' }, 'reviewer');
  assert.deepEqual(anchor, { type: 'diagram_shape', documentId: created.documentId, diagramId: created.diagramId, revisionId: created.revisionId, shapeId: 'stable-shape' });
  const candidate = scene(); candidate.elements[0].isDeleted = true;
  const saved = await f.service.save('registered', created.diagramId, { ...base(created), scene: candidate, svg }, 'owner');
  assert.equal(saved.scene.elements[0].id, anchor.shapeId);
  await assert.rejects(f.service.checkAnchor('registered', saved.diagramId, { ...base(saved), shapeId: anchor.shapeId }, 'reviewer'), hasStatus(400));
  await assert.rejects(f.service.checkAnchor('registered', saved.diagramId, { ...base(saved), shapeId: 'missing' }, 'owner'), hasStatus(400));
});

test('comment insertion callback stays serialized with a queued accepted save', async (t) => {
  const f = await fixture(t), created = await f.create(), order = [];
  let begin, release;
  const started = new Promise((resolve) => { begin = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const comment = f.service.checkAnchor('registered', created.diagramId, { ...base(created), shapeId: 'stable-shape' }, 'reviewer', async (anchor) => {
    begin(); await gate; order.push('comment inserted');
    assert.equal(parseDocument(await readFile(f.file, 'utf8')).diagrams[0].revisionId, anchor.revisionId);
    return { id: 'created-comment', anchor };
  });
  await started;
  const save = f.service.save('registered', created.diagramId, { ...base(created), scene: scene('Following save'), svg: svg2 }, 'owner').then((value) => { order.push('diagram saved'); return value; });
  release();
  assert.equal((await comment).id, 'created-comment');
  await save;
  assert.deepEqual(order, ['comment inserted', 'diagram saved']);
});

test('HTML parser ignores marker-looking text and rejects structural ambiguity', async (t) => {
  const id = randomUUID();
  const fake = `<script>const text = '<!-- htmldrop:diagram:${id}:start -->';</script><textarea><!-- htmldrop:diagram:${id}:end --></textarea>`;
  const f = await fixture(t, original.replace('<h1>', `${fake}<h1>`)), created = await f.create();
  assert.equal(parseDocument(await readFile(f.file, 'utf8')).diagrams.length, 1);
  const source = await readFile(f.file, 'utf8');
  assert.throws(() => parseDocument(source.replace('</head>', `<meta name="htmldrop-document-id" content="${created.documentId}"></head>`)), /Duplicate document/);
  assert.throws(() => parseDocument(source + `<!-- htmldrop:diagram:${id}:end -->`), /Orphaned/);
  assert.throws(() => parseDocument(source.replace('<figure ', '<figure data-htmldrop-diagram="wrong" ')), /matching figure/);
  assert.throws(() => parseDocument(source.replace('<img alt=', '<img src="invalid" alt=')), /preview requires/);
  assert.throws(() => parseDocument(source.replace('</figure>', '<span>Unexpected node</span></figure>')), /one preview/);
});

test('SVG safety rejects active, external, malformed and oversized content while preserving exported fonts', () => {
  const valid = '<svg xmlns="http://www.w3.org/2000/svg"><defs><style>@font-face{font-family:Test;src:url(data:font/woff2;base64,+///)}</style><clipPath id="clip"><rect width="1" height="1"/></clipPath></defs><g clip-path="url(#clip)"><text>Hello</text></g></svg>';
  assert.equal(validateSvg(valid), valid);
  for (const bad of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>unsafe</p></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.org/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.org/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(//example.org/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u\\72l(https://example.org/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" width="2"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>&#0;</text></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>',
    `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(100001)}</svg>`,
  ]) assert.throws(() => validateSvg(bad), { statusCode: 400 }, bad.slice(0, 80));
});

test('native scenes reject nonfinite geometry, duplicate IDs, dangling refs and unsupported web/image resources', () => {
  const invalid = [];
  let s = scene(); s.elements[0].x = Infinity; invalid.push(s);
  s = scene(); s.elements[1].id = s.elements[0].id; invalid.push(s);
  s = scene(); s.elements[0].type = 'embeddable'; invalid.push(s);
  s = scene(); s.elements[0].link = 'https://example.org'; invalid.push(s);
  s = scene(); s.elements[0].containerId = 'missing'; invalid.push(s);
  s = scene(); s.elements[0].startBinding = { elementId: 'missing' }; invalid.push(s);
  s = scene(); s.files.x = { id: 'x', mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,PHN2Zy8+' }; invalid.push(s);
  s = scene(); s.elements[0].customData = JSON.parse('{"__proto__":{"polluted":true}}'); invalid.push(s);
  for (const candidate of invalid) assert.throws(() => validateScene(candidate), { statusCode: 400 });
  s = scene('A normal label can mention https://example.org without creating a link');
  s.elements[0].updated = Date.now();
  assert.equal(validateScene(s).elements[1].text, s.elements[1].text);
});

test('serialized publication size is rejected before creating any private state', async (t) => {
  const f = await fixture(t, original + ' '.repeat(LIMITS.html - Buffer.byteLength(original) - 100));
  const before = await readFile(f.file);
  await assert.rejects(f.create(), (error) => error.statusCode === 413 && /2 MB publication limit/.test(error.message));
  assert.deepEqual(await readFile(f.file), before);
  await assert.rejects(stat(f.configDir), { code: 'ENOENT' });
});

test('registered artifact paths cannot be redirected through symlinks', async (t) => {
  const f = await fixture(t), created = await f.create(), target = join(f.dir, 'other.html');
  await writeFile(target, await readFile(f.file)); await rm(f.file); await symlink(target, f.file);
  const bytes = await readFile(target);
  await assert.rejects(f.service.read('registered', created.diagramId, 'owner'), hasStatus(400));
  await assert.rejects(f.service.save('registered', created.diagramId, { ...base(created), scene: scene('Redirect'), svg }, 'owner'), hasStatus(400));
  assert.deepEqual(await readFile(target), bytes);
});

test('cumulative private state limit refuses growth without changing source or prior encrypted state', async (t) => {
  const f = await fixture(t), created = await f.create(), source = await readFile(f.file);
  const stateDir = join(f.configDir, 'edit', 'diagrams'), statePath = join(stateDir, (await readdir(stateDir)).find((name) => name.endsWith('.json.enc')));
  const candidate = scene();
  candidate.elements = Array.from({ length: 50 }, (_, i) => ({ id: `bulk-${i}`, type: 'text', x: i, y: i, width: 100, height: 20, text: 'x'.repeat(100000) }));
  let count = 0, previous;
  for (let i = 0; i < 8; i++) {
    previous = await readFile(statePath);
    try {
      const result = await f.service.propose('registered', created.diagramId, { ...base(created), scene: candidate }, 'reviewer');
      count = result.proposals.length;
    } catch (error) {
      assert.equal(error.statusCode, 413);
      assert.match(error.message, /32 MB profile limit/);
      assert.deepEqual(await readFile(statePath), previous);
      assert.equal((await f.service.read('registered', created.diagramId, 'owner')).proposals.length, count);
      break;
    }
  }
  assert.equal(count, 6);
  assert.deepEqual(await readFile(f.file), source);
});

test('interrupted private transaction resolves from authoritative source revision on restart', async (t) => {
  const f = await fixture(t), created = await f.create(), stateDir = join(f.configDir, 'edit', 'diagrams');
  const statePath = join(stateDir, (await readdir(stateDir)).find((name) => name.endsWith('.json.enc'))), key = await readFile(join(stateDir, 'history.key'));
  const envelope = JSON.parse(await readFile(statePath, 'utf8')), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  const aad = Buffer.from(`${created.documentId}/${created.diagramId}`); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString());
  const ghostRevision = { ...state.revisions[0], revisionId: randomUUID(), parentRevisionId: created.revisionId, title: 'Never committed' };
  const interrupted = { ...state, pending: { revisionId: ghostRevision.revisionId, nextState: { revisions: [...state.revisions, ghostRevision], proposals: [{ proposalId: randomUUID(), status: 'accepted', acceptedRevisionId: ghostRevision.revisionId }] } } };
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(JSON.stringify(interrupted), 'utf8'), cipher.final()]);
  await writeFile(statePath, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  const restarted = createDiagramService({ getSession: () => ({ file: f.file }), configDir: f.configDir });
  let read = await restarted.read('registered', created.diagramId, 'owner');
  assert.equal(read.revisions.length, 1); assert.equal(read.proposals.length, 0);
  await assert.rejects(restarted.exportDiagram('registered', created.diagramId, { format: 'svg', revisionId: ghostRevision.revisionId }, 'owner'), hasStatus(404));
  const source = await readFile(f.file, 'utf8');
  await writeFile(f.file, source.replaceAll(created.revisionId, ghostRevision.revisionId));
  read = await restarted.read('registered', created.diagramId, 'owner');
  assert.equal(read.revisions.length, 2); assert.equal(read.proposals[0].status, 'accepted');
});
