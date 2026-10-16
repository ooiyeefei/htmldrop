import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const runFile = promisify(execFile);
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = join(repo, '.scratch/m2-uat');
await mkdir(scratch, { recursive: true });
const fixture = await mkdtemp(join(scratch, 'run-'));
process.env.HTMLDROP_CONFIG_DIR = join(fixture, 'owner-profile');
process.env.TMPDIR = join(fixture, 'browser-tmp');
process.env.HTMLDROP_EDIT_NOTIFY = '0';
await mkdir(process.env.TMPDIR, { recursive: true });

const source = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Diagram acceptance</title><link rel="icon" href="data:,"></head><body><main><h1>Architecture review</h1><p id="preserved">Source before managed diagram.</p></main></body></html>';
function rectangle(id = 'uat-stable-shape', x = 100) {
  return { id, type: 'rectangle', x, y: 100, width: 220, height: 110, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0', roundness: null, seed: 17893, version: 1, versionNonce: 9221, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}
const scene = (elements = [rectangle()]) => ({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} });
const svg = label => `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180"><rect x="10" y="10" width="220" height="110" fill="none" stroke="#1e1e1e"/><text x="20" y="150">${label}</text></svg>`;
async function json(origin, path, { token, method = 'GET', body, reviewer = false } = {}) {
  const response = await fetch(origin + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(reviewer ? { 'x-htmldrop-reviewer': '1' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', origin }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function eventually(fn, message, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  do { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 80)); } while (Date.now() < end);
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}
// CSP can reject a request before Playwright's routing callback observes it.
// Count browser attempts independently, including requests from editor iframes.
function recordExternalAttempts(context, origin, attempts) {
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin && !attempts.includes(url.href)) attempts.push(url.href);
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
  const port = probe.address().port;
  await new Promise(ok => probe.close(ok));
  return port;
}

// Real publication code runs against isolated profiles and an inert local deploy
// executable. The assertions concern the staged single file, never public reachability.
test('diagram scene and SVG survive staged push, pull and encrypted publication history', { timeout: 90000 }, async t => {
  const dir = join(fixture, 'publication');
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'surge'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'surge'), 0o755);
  const documentId = 'b69bc0cb-cbf8-4ce4-9a96-87c44a3de195';
  const diagramId = '510c0919-0f21-48a4-9fc7-b02091a1536f';
  function artifact(revisionId, title, native, preview) {
    const payload = { version: 1, documentId, diagramId, revisionId, parentRevisionId: null, title, scene: native };
    return source.replace('</head>', `<meta name="htmldrop-document-id" content="${documentId}"></head>`).replace('</main>', `<!-- htmldrop:diagram:${diagramId}:start --><figure data-htmldrop-diagram="${diagramId}"><img alt="${title}" src="data:image/svg+xml;base64,${Buffer.from(preview).toString('base64')}"><script type="application/json" data-htmldrop-scene="${diagramId}">${JSON.stringify(payload).replaceAll('<', '\\u003c')}</script></figure><!-- htmldrop:diagram:${diagramId}:end --></main>`);
  }
  const first = artifact('20f9ec68-26a0-4316-a946-91a97d3d3f99', 'Private architecture alpha', scene(), svg('Private architecture alpha'));
  const second = artifact('af5860b3-6c17-40e4-a77f-75e8b056142a', 'Private architecture beta', scene([rectangle('uat-stable-shape', 180)]), svg('Private architecture beta'));
  await writeFile(join(dir, 'first.html'), first);
  await writeFile(join(dir, 'second.html'), second);
  const moduleUrl = name => JSON.stringify(pathToFileURL(join(repo, 'src', name)).href);
  const publishScript = `
    import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
    import {join} from 'node:path';
    import {push} from ${moduleUrl('push.js')};
    import {writeConfig,getSiteDir,getConfigDir} from ${moduleUrl('config.js')};
    import {loadManifest} from ${moduleUrl('manifest.js')};
    import {readHistoryConfig,stripHistoryWidget} from ${moduleUrl('history/index.js')};
    import {decryptHtml} from ${moduleUrl('encrypt.js')};
    writeConfig({subdomain:'local-diagram-uat'});
    globalThis.fetch=async()=>{throw Error('Unexpected outbound request from local-only publication UAT');};
    const first=readFileSync('first.html','utf8'),second=readFileSync('second.html','utf8');
    writeFileSync('architecture.html',first);
    await push('architecture.html');
    const initial=readFileSync(join(getSiteDir(),'architecture.html'),'utf8');
    assert.equal(stripHistoryWidget(initial),first);
    writeFileSync('architecture.html',second);
    await push('architecture.html');
    const staged=readFileSync(join(getSiteDir(),'architecture.html'),'utf8');
    const history=readHistoryConfig(staged);
    assert.equal(history.version,2);
    assert.equal(history.revisions[0].html,first);
    assert.equal(history.revisions[1].html,second);
    writeFileSync('published.html',staged);
    await push('architecture.html',{password:'local-fixture-password'});
    const gate=readFileSync(join(getSiteDir(),'architecture.html'),'utf8');
    assert.ok(!gate.includes('Private architecture beta'));
    const encrypted=/var\\s+encryptedContent\\s*=\\s*"([^"]*)"/.exec(gate)[1];
    const unlocked=decryptHtml(encrypted,'local-fixture-password');
    assert.equal(stripHistoryWidget(unlocked),second);
    const privateHistory=readHistoryConfig(unlocked);
    assert.equal(privateHistory.version,3);
    assert.equal(decryptHtml(privateHistory.revisions[2].envelope,'local-fixture-password'),second);
    const archive=readFileSync(join(getConfigDir(),'history',loadManifest().files[0].historyId+'.json'),'utf8');
    const parsed=JSON.parse(archive);
    assert.ok(!JSON.stringify(parsed.revisions[2]).includes('Private architecture beta'));
    assert.ok(!archive.includes('local-fixture-password'));
    console.log('STAGED_DIAGRAM_PUBLICATION_PASSED');
  `;
  await writeFile(join(dir, 'publish.mjs'), publishScript);
  const published = await runFile(process.execPath, ['publish.mjs'], { cwd: dir, env: { ...process.env, HTMLDROP_CONFIG_DIR: join(dir, 'publisher-profile'), PATH: `${bin}:${process.env.PATH}` } });
  assert.match(published.stdout, /STAGED_DIAGRAM_PUBLICATION_PASSED/);
  const pullScript = `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {pull} from ${moduleUrl('pull.js')};
    import {loadManifest} from ${moduleUrl('manifest.js')};
    import {prepareHistory} from ${moduleUrl('history/index.js')};
    const published=readFileSync('published.html','utf8');
    globalThis.fetch=async()=>({status:200,text:async()=>published});
    await pull('https://local-diagram-uat.invalid/architecture.html',{open:false,output:'pulled.html'});
    assert.equal(readFileSync('pulled.html','utf8'),readFileSync('second.html','utf8'));
    const entry=loadManifest().files[0];
    const next=prepareHistory({html:readFileSync('first.html','utf8'),priorEntry:entry});
    assert.equal(next.version,3);
    assert.equal(next.revisions[0].html,readFileSync('first.html','utf8'));
    assert.equal(next.revisions[1].html,readFileSync('second.html','utf8'));
    console.log('PULLED_DIAGRAM_HISTORY_PASSED');
  `;
  await writeFile(join(dir, 'pull.mjs'), pullScript);
  const pulled = await runFile(process.execPath, ['pull.mjs'], { cwd: dir, env: { ...process.env, HTMLDROP_CONFIG_DIR: join(dir, 'reader-profile') } });
  assert.match(pulled.stdout, /PULLED_DIAGRAM_HISTORY_PASSED/);
  t.diagnostic(`Local staging and clean-source evidence: ${dir}`);
});

async function startFixture(name) {
  const { startServer } = await import('../src/edit/server.js');
  const file = join(fixture, `${name}.html`);
  await writeFile(file, source);
  const server = await startServer({ idleTimeoutMs: null });
  const origin = `http://127.0.0.1:${server.port}`;
  const registered = await json(origin, '/__edit/sessions', { token: server.agentToken, method: 'POST', body: { file } });
  assert.equal(registered.status, 200);
  const key = registered.data.key;
  const root = `/api/edit/${key}/diagrams`;
  const listed = await json(origin, root);
  assert.equal(listed.status, 200);
  const created = await json(origin, root, { token: server.agentToken, method: 'POST', body: { baseSourceHash: listed.data.sourceHash, title: 'Accepted architecture', scene: scene(), svg: svg('First accepted preview'), summary: 'Initial acceptance fixture' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return { file, server, origin, key, root, created: created.data };
}

test('real HTTP diagram revisions preserve source and reject stale writes and reviewer owner operations', { timeout: 60000 }, async t => {
  const state = await startFixture('http');
  const { server, origin, file, key, root } = state;
  let gateway;
  t.after(async () => { await gateway?.close(); await server.close(); });
  const listed = await json(origin, root);
  assert.equal(listed.data.diagrams.length, 1);
  const id = listed.data.diagrams[0].diagramId;
  const path = `${root}/${id}`;
  const first = (await json(origin, path)).data;
  const initialSource = await readFile(file, 'utf8');
  assert.ok(initialSource.includes('<p id="preserved">Source before managed diagram.</p>'));
  assert.ok(initialSource.includes(`data-htmldrop-scene="${id}"`));
  const firstNative = await json(origin, `${path}/export?format=excalidraw&revisionId=${first.revisionId}`);
  assert.equal(firstNative.status, 200);
  assert.deepEqual(JSON.parse(firstNative.data.content).elements, first.scene.elements);
  const firstSvg = await json(origin, `${path}/export?format=svg&revisionId=${first.revisionId}`);
  assert.equal(firstSvg.status, 200);
  assert.equal(firstSvg.data.content, first.svg);
  const body = { baseRevisionId: first.revisionId, baseSourceHash: first.sourceHash, title: 'Second accepted architecture', scene: scene([rectangle('uat-stable-shape', 190)]), svg: svg('Second accepted preview'), summary: 'Move rectangle' };
  const saved = await json(origin, `${path}/save`, { token: server.agentToken, method: 'POST', body });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const second = (await json(origin, path)).data;
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(second.parentRevisionId, first.revisionId);
  const currentBytes = await readFile(file, 'utf8');
  assert.notEqual(currentBytes, initialSource);
  const stale = await json(origin, `${path}/save`, { token: server.agentToken, method: 'POST', body: { ...body, title: 'Stale overwrite attempt' } });
  assert.equal(stale.status, 409);
  assert.match(JSON.stringify(stale.data), /stale|conflict|changed|reload/i);
  assert.equal(await readFile(file, 'utf8'), currentBytes, '409 changed the authoritative source');
  const staleProposal = await json(origin, `${path}/proposals`, { token: server.agentToken, method: 'POST', body });
  assert.equal(staleProposal.status, 409);
  assert.equal(await readFile(file, 'utf8'), currentBytes);
  const historical = await json(origin, `${path}/export?format=svg&revisionId=${first.revisionId}`);
  assert.equal(historical.data.content, firstSvg.data.content);
  assert.notEqual(historical.data.content, second.svg);
  const nativeHistorical = await json(origin, `${path}/export?format=excalidraw&revisionId=${first.revisionId}`);
  assert.deepEqual(JSON.parse(nativeHistorical.data.content), JSON.parse(firstNative.data.content));

  const port = await freePort();
  const remoteOrigin = `http://127.0.0.1:${port}`;
  const { startRemoteGateway } = await import('../src/edit/remote.js');
  gateway = await startRemoteGateway({ port, publicOrigin: remoteOrigin, sessionKey: key, backendPort: server.port });
  const exchange = await fetch(remoteOrigin + '/__review/exchange', { method: 'POST', headers: { origin: remoteOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ token: new URL(gateway.url).hash.slice(1) }) });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const remoteCall = async (route, method = 'GET', data) => {
    const response = await fetch(remoteOrigin + route, { method, headers: { cookie, origin: remoteOrigin, ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const review = await remoteCall(path);
  assert.equal(review.status, 200);
  for (const operation of ['create', 'save', 'accept', 'reject']) assert.equal(review.data.permissions[operation], false);
  assert.equal(review.data.permissions.propose, true);
  const proposed = await remoteCall(`${path}/proposals`, 'POST', { baseRevisionId: second.revisionId, baseSourceHash: second.sourceHash, title: 'Reviewer proposal', scene: scene([rectangle('uat-stable-shape', 240)]), summary: 'Reviewer moves rectangle', actor: 'owner' });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
  assert.equal(await readFile(file, 'utf8'), currentBytes, 'Reviewer proposal modified accepted source');
  const withProposal = (await json(origin, path)).data;
  const proposal = withProposal.proposals.find(item => item.title === 'Reviewer proposal');
  assert.ok(proposal);
  const denied = [[root, {}], [`${path}/save`, body], [`${path}/proposals/${proposal.proposalId || proposal.id}/accept`, {}], [`${path}/proposals/${proposal.proposalId || proposal.id}/reject`, {}]];
  for (const [route, data] of denied) {
    const gatewayDenied = await remoteCall(route, 'POST', { ...data, actor: 'owner' });
    assert.ok([403, 404].includes(gatewayDenied.status), `${route} gateway returned ${gatewayDenied.status}`);
    const backendDenied = await json(origin, route, { method: 'POST', body: { ...data, actor: 'owner' }, reviewer: true });
    assert.equal(backendDenied.status, 403, `${route} backend did not honor authenticated reviewer actor`);
  }
  assert.equal(await readFile(file, 'utf8'), currentBytes);
  t.diagnostic(`Revision and reviewer gateway evidence: ${file}`);
});

async function downloadBytes(page, action) {
  const pending = page.waitForEvent('download');
  await action();
  const download = await pending;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('bundled canvas drawing, selected-shape threads, review and conflict retain actual browser work', { timeout: 180000 }, async t => {
  const { server, origin, key, root, file } = await startFixture('browser');
  let browser, gateway;
  const cleanup = async () => { await browser?.close(); await gateway?.close(); await server.close(); };
  const id = (await json(origin, root)).data.diagrams[0].diagramId;
  const path = `${root}/${id}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  page.setDefaultTimeout(15000);
  t.after(async () => { if (!page.isClosed()) { await page.screenshot({ path: join(fixture, 'browser-final.png'), fullPage: true }).catch(() => {}); await writeFile(join(fixture, 'browser-final.json'), JSON.stringify({ errors, external, externalAttempts, apiResponses, frames: await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.locator('body').innerText().catch(() => '') }))) }, null, 2)); } await cleanup(); });
  const external = [], externalAttempts = [], errors = [], requests = [], apiResponses = [];
  recordExternalAttempts(context, origin, externalAttempts);
  page.on('response', async response => { if (response.url().includes('/api/edit/') && response.request().method() === 'POST') apiResponses.push({url:response.url(),status:response.status(),body:await response.text().catch(()=>'')}); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === origin) { await route.continue(); return; }
    external.push(url.href); await route.abort();
  });
  page.on('request', request => { requests.push(request.url()); if (request.url().endsWith('/save')) { const body=request.postDataJSON(); writeFile(join(fixture,'browser-save.svg'),body.svg); writeFile(join(fixture,'browser-save-scene.json'),JSON.stringify(body.scene,null,2)); } });
  page.on('pageerror', error => errors.push(error.message));
  const ui = page.frameLocator('iframe[title="Diagram editor"]');
  const status = () => ui.getByRole('status');
  const read = async () => (await json(origin, path)).data;
  let lastDrawPoint;
  const open = async target => {
    await target.locator('#htmldrop-diagrams').click();
    const frame = target.frameLocator('iframe[title="Diagram editor"]');
    await frame.getByLabel('Choose diagram').selectOption(id);
    await frame.locator('.excalidraw canvas.interactive').first().waitFor();
    await eventually(() => frame.getByRole('status').textContent().then(text => text.includes('Diagram ready')), 'Canvas did not finish opening');
    await editorReady(frame);
    return frame;
  };
  async function editorReady(frame) {
    await eventually(() => frame.locator('body').evaluate(() => ['.toolbar', '.workspace'].every(selector => {
      const element = document.querySelector(selector);
      return element && !element.inert;
    })), 'Editor did not release its toolbar and canvas');
  }
  async function selectShape(target, frame, point, shapeId) {
    await editorReady(frame);
    const canvas = frame.locator('.excalidraw canvas.interactive');
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: box.width - 120, y: 100 } });
    await target.keyboard.press('Escape');
    await eventually(() => frame.getByText(/^Selected shape:/).count().then(count => count === 0), 'Canvas selection did not clear');
    await target.keyboard.press('v');
    await target.mouse.click(point.x, point.y);
    await eventually(() => frame.getByText(`Selected shape: ${shapeId}`, { exact: true }).count().then(Boolean), 'Intended saved shape was not selected');
  }
  async function draw(target, frame, xOffset = 0) {
    await editorReady(frame);
    const canvas = frame.locator('.excalidraw canvas.interactive').first();
    const box = await canvas.boundingBox();
    assert.ok(box && box.width > 300 && box.height > 200, 'Real canvas must have a usable viewport');
    await canvas.click({ position: { x: box.width - 120, y: 100 } });
    await target.keyboard.press('r');
    const x = box.x + box.width * 0.57 + xOffset, y = box.y + box.height * 0.52;
    await target.mouse.move(x, y); await target.mouse.down(); await target.mouse.move(x + 115, y + 85, { steps: 8 }); await target.mouse.up();
    await target.keyboard.press('v');
    await target.mouse.click(x, y + 40);
    lastDrawPoint = { x, y: y + 40 };
    await eventually(() => frame.getByText(/^Selected shape:/).count().then(Boolean), 'Mouse-created rectangle was not selected').catch(async error => { await target.screenshot({path:join(fixture,'draw-selection-failure.png')}); await writeFile(join(fixture,'draw-selection-failure.txt'),await frame.locator('body').innerText()); throw error; });
    return (await frame.getByText(/^Selected shape:/).textContent()).replace('Selected shape: ', '').trim();
  }
  let createdShapeId, savedRevision, rootCommentId;
  await page.goto(`${origin}/s/${key}/`);
  await page.locator('#htmldrop-diagrams').waitFor();
  assert.equal(requests.some(url => url.includes('/__editor/')), false, 'Canvas dependencies loaded before opening the editor');
  await open(page);
  assert.equal(await ui.getByRole('link', { name: /browse|library/i }).count(), 0, 'Canvas exposes an outbound library link');
  await t.test('real canvas edit saves native geometry and graphical SVG, then selection attaches a threaded comment', async () => {
    createdShapeId = await draw(page, ui);
    const rectanglePoint = { ...lastDrawPoint };
    await page.keyboard.press('t');
    await page.mouse.click(rectanglePoint.x + 10, rectanglePoint.y + 110);
    await page.keyboard.insertText('Native acceptance text');
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');
    await page.mouse.click(rectanglePoint.x, rectanglePoint.y);
    await ui.getByLabel('Diagram title').fill('Browser-drawn architecture');
    const draft = await downloadBytes(page, () => ui.getByRole('button', { name: 'Export JSON', exact: true }).click());
    const native = JSON.parse(draft.bytes.toString());
    assert.ok(native.elements.some(el => el.id === createdShapeId && el.type === 'rectangle' && el.width > 100 && el.height > 70));
    assert.ok(native.elements.some(el => el.type === 'text' && el.text === 'Native acceptance text'));
    const saveResponse = page.waitForResponse(response => response.url() === `${origin}${path}/save` && response.request().method() === 'POST');
    await ui.getByRole('button', { name: 'Save diagram', exact: true }).click();
    assert.equal((await saveResponse).status(), 200, 'Native canvas save did not succeed');
    const accepted = await read(); savedRevision = accepted.revisionId;
    assert.deepEqual(accepted.scene.elements, native.elements, 'Native save changed the drawn shapes or text');
    assert.ok(accepted.scene.elements.some(el => el.id === createdShapeId && !el.isDeleted));
    assert.match(accepted.svg, /<path|<rect/);
    assert.match(accepted.svg, /Native acceptance text/);
    assert.ok(!accepted.svg.includes('First accepted preview'), 'Saved SVG was the seed preview rather than real canvas rendering');
    await selectShape(page, ui, rectanglePoint, createdShapeId);
    await ui.getByLabel('Your name', { exact: true }).fill('Canvas reviewer');
    await ui.getByLabel('Shape comment', { exact: true }).fill('Please keep this component visible.');
    const commentResponse = page.waitForResponse(response => response.url() === `${origin}${path}/comments` && response.request().method() === 'POST');
    await ui.getByRole('button', { name: 'Comment on shape', exact: true }).click();
    assert.equal((await commentResponse).status(), 201, 'Selected-shape comment did not save');
    const comments = (await json(origin, `${path}/comments`)).data.items;
    const comment = comments.find(c => (c.text || c.content?.text) === 'Please keep this component visible.');
    assert.ok(comment); rootCommentId = comment.id;
    assert.equal(comment.anchor.shapeId, createdShapeId);
    assert.equal(comment.anchor.revisionId, savedRevision);
    const record = ui.locator('.record').filter({ hasText: 'Please keep this component visible.' });
    await record.getByLabel('Reply to shape comment').fill('Confirmed; this stays in the diagram.');
    // The actual reply can arrive via SSE before its POST acknowledges and
    // releases the canvas. Hold that response to exercise this ordering.
    let releaseReply, finishReply, replyArrived = false, replyError;
    const replyFinished = new Promise(resolve => { finishReply = resolve; });
    const replyBarrier = new Promise(resolve => { releaseReply = resolve; });
    const replyPath = `${origin}/api/feedback/${key}/${comment.id}/reply`;
    const holdReply = async route => {
      replyArrived = true;
      try { const response = await route.fetch(); await replyBarrier; await route.fulfill({ response }); }
      catch (error) { replyError = error.message; }
      finally { finishReply(); }
    };
    await page.route(replyPath, holdReply);
    try {
      await record.getByRole('button', { name: 'Reply', exact: true }).click();
      await record.getByText('Confirmed; this stays in the diagram.', { exact: false }).waitFor();
      assert.equal(await ui.locator('.workspace').evaluate(element => element.inert), true, 'Reply visibility must not imply editable canvas');
    } finally {
      releaseReply();
      if (replyArrived) await replyFinished;
      await page.unroute(replyPath, holdReply);
    }
    assert.equal(replyError, undefined);
    await selectShape(page, ui, rectanglePoint, createdShapeId);
    await page.keyboard.press('Delete');
    const afterDelete = JSON.parse((await downloadBytes(page, () => ui.getByRole('button', { name: 'Export JSON', exact: true }).click())).bytes.toString());
    assert.equal(afterDelete.elements.some(element => element.id === createdShapeId && !element.isDeleted), false, 'Native canvas still contains the shape after Delete');
    assert.ok(afterDelete.elements.some(element => element.id === 'uat-stable-shape' && !element.isDeleted), 'Delete removed another component');
    assert.ok(afterDelete.elements.some(element => element.type === 'text' && element.text === 'Native acceptance text'), 'Delete removed the unrelated text');
    await editorReady(ui);
    await ui.getByRole('button', { name: 'Save diagram', exact: true }).click();
    await eventually(() => read().then(doc => doc.revisionId !== savedRevision && !doc.scene.elements.some(el => el.id === createdShapeId && !el.isDeleted)), 'Deleting a selected canvas shape was not saved');
    await page.screenshot({ path: join(fixture, 'canvas-comment-reply.png'), fullPage: true });
    await ui.getByRole('button', { name: 'Close editor', exact: true }).click();
    await page.locator('iframe[title="Diagram editor"]').waitFor({ state: 'detached' });
    await open(page);
    await ui.getByText('Confirmed; this stays in the diagram.', { exact: false }).waitFor();
    await ui.getByText('Shape removed', { exact: true }).waitFor();
    const retainedComment = (await json(origin, `${path}/comments`)).data.items.find(item => item.id === rootCommentId);
    assert.equal(retainedComment.anchor.shapeId, createdShapeId);
  });

  assert.ok(rootCommentId, `Browser thread prerequisite failed: ${await status().textContent()}`);
  await t.test('Mermaid import becomes editable native shapes using only bundled assets', async () => {
    const previousCanvas = await ui.locator('.excalidraw canvas.interactive').elementHandle();
    await ui.getByRole('button', { name: 'Import Mermaid', exact: true }).click();
    await ui.getByLabel('Mermaid source', { exact: true }).fill('flowchart LR\n  A[Client] --> B[Service]');
    await ui.getByRole('button', { name: 'Create from Mermaid', exact: true }).click();
    await eventually(() => status().textContent().then(text => text.includes('Mermaid imported')), 'Bundled Mermaid conversion failed');
    await eventually(() => previousCanvas.evaluate(element => !element.isConnected), 'Imported diagram did not mount a new native canvas');
    await ui.locator('.excalidraw canvas.interactive').waitFor();
    await editorReady(ui);
    const imported = JSON.parse((await downloadBytes(page, () => ui.getByRole('button', { name: 'Export JSON', exact: true }).click())).bytes.toString());
    await writeFile(join(fixture,'mermaid-native-export.json'), JSON.stringify(imported,null,2));
    assert.ok(imported.elements.some(el => el.type === 'text' && el.text === 'Client'));
    assert.ok(imported.elements.some(el => el.type === 'arrow'));
    await ui.getByLabel('Diagram title').fill('Imported Mermaid acceptance');
    const sourceBefore = await readFile(file, 'utf8');
    const { parseDocument } = await import('../src/diagrams/document.js');
    const before = parseDocument(sourceBefore);
    // Delay the real post-save listing response until the save's filesystem
    // notification reaches the editor. Its status message can replace the
    // transient save acknowledgement; accepted source is the success contract.
    await ui.locator('body').evaluate(() => {
      window.__htmldropUatSourceNotifications = 0;
      window.__htmldropUatSourceObserver = event => {
        if (event.origin === location.origin && event.source === parent && event.data?.type === 'htmldrop:diagram-source-changed') window.__htmldropUatSourceNotifications += 1;
      };
      addEventListener('message', window.__htmldropUatSourceObserver);
    });
    let finishRefresh, responseRecord, requestBody, acceptedDiagram, notificationError;
    const refreshFinished = new Promise(resolve => { finishRefresh = resolve; });
    const holdRefresh = async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const response = await route.fetch();
      try {
        await eventually(() => ui.locator('body').evaluate(() => window.__htmldropUatSourceNotifications > 0), 'Own-save source notification did not arrive');
      } catch (error) { notificationError = error.message; }
      await route.fulfill({ response });
      finishRefresh();
    };
    await page.route(origin + root, holdRefresh);
    try {
      const responsePending = page.waitForResponse(response => response.url() === origin + root && response.request().method() === 'POST');
      await ui.getByRole('button', { name: 'Save diagram', exact: true }).click();
      const response = await responsePending;
      requestBody = response.request().postDataJSON();
      responseRecord = { status: response.status(), body: await response.json() };
      assert.equal(responseRecord.status, 201, JSON.stringify(responseRecord.body));
      acceptedDiagram = responseRecord.body;
      assert.equal(acceptedDiagram.title, 'Imported Mermaid acceptance');
      assert.deepEqual(acceptedDiagram.scene.elements, imported.elements, 'Save changed imported native shapes or geometry');
      await refreshFinished;
      assert.equal(notificationError, undefined);
      const persisted = parseDocument(await readFile(file, 'utf8'));
      const embedded = persisted.diagrams.find(diagram => diagram.diagramId === acceptedDiagram.diagramId);
      assert.ok(embedded, 'Accepted Mermaid diagram is missing from authoritative source');
      assert.equal(embedded.revisionId, acceptedDiagram.revisionId);
      assert.deepEqual(embedded.scene, acceptedDiagram.scene);
      assert.equal(embedded.svg, acceptedDiagram.svg);
      for (const prior of before.diagrams) {
        const retained = persisted.diagrams.find(diagram => diagram.diagramId === prior.diagramId);
        assert.equal(retained?.revisionId, prior.revisionId, 'Import changed a previous diagram revision');
        assert.deepEqual(retained?.scene, prior.scene, 'Import overwrote a previous diagram');
      }
      const diagrams = (await json(origin, root)).data.diagrams;
      assert.ok(diagrams.some(diagram => diagram.diagramId === acceptedDiagram.diagramId && diagram.revisionId === acceptedDiagram.revisionId));
      await eventually(() => ui.getByLabel('Choose diagram').inputValue().then(value => value === acceptedDiagram.diagramId), 'Editor did not adopt the accepted Mermaid diagram');
      await eventually(() => ui.locator('.toolbar').evaluate(element => !element.inert), 'Mermaid save did not release the editor');
      assert.equal(await ui.getByRole('button', { name: 'Save diagram', exact: true }).isDisabled(), true, 'Accepted Mermaid scene remained unsaved');
    } finally {
      await writeFile(join(fixture, 'mermaid-save-response.json'), JSON.stringify({ status: await status().textContent(), notificationError, sourceNotifications: await ui.locator('body').evaluate(() => window.__htmldropUatSourceNotifications), response: responseRecord, request: requestBody, diagramId: acceptedDiagram?.diagramId, sourceBefore, sourceAfter: await readFile(file, 'utf8') }, null, 2));
      await ui.locator('body').evaluate(() => { removeEventListener('message', window.__htmldropUatSourceObserver); delete window.__htmldropUatSourceObserver; delete window.__htmldropUatSourceNotifications; });
      await page.unroute(origin + root, holdRefresh);
    }
    await ui.getByLabel('Choose diagram').selectOption(id);
    await eventually(() => ui.getByLabel('Diagram title').inputValue().then(title => title === 'Browser-drawn architecture'), 'Original diagram did not reopen after import');
    await editorReady(ui);
  });

  await t.test('private reviewer edits real canvas and proposes; owner accepts then rejects a separate candidate', async () => {
    const port = await freePort(), remoteOrigin = `http://127.0.0.1:${port}`;
    const { startRemoteGateway } = await import('../src/edit/remote.js');
    gateway = await startRemoteGateway({ port, publicOrigin: remoteOrigin, sessionKey: key, backendPort: server.port });
    const reviewer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    recordExternalAttempts(reviewer, remoteOrigin, externalAttempts);
    await reviewer.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin === remoteOrigin || !['http:', 'https:'].includes(url.protocol)) await route.continue(); else { external.push(url.href); await route.abort(); } });
    const review = await reviewer.newPage();
    review.on('dialog', dialog => dialog.accept());
    review.on('pageerror', error => errors.push(error.message));
    try {
      await review.goto(gateway.url); await review.waitForURL(`${remoteOrigin}/s/${key}/`);
      const reviewerUi = await open(review);
      assert.equal(await reviewerUi.getByRole('button', { name: 'Save diagram', exact: true }).count(), 0);
      const before = await readFile(file, 'utf8');
      const reviewerShape = await draw(review, reviewerUi, 25);
      await reviewerUi.getByLabel('Diagram title').fill('Reviewer drawn proposal');
      await reviewerUi.getByRole('button', { name: 'Propose changes', exact: true }).click();
      await eventually(() => reviewerUi.getByRole('status').textContent().then(text => text.includes('Proposal saved')), 'Reviewer proposal did not save');
      assert.equal(await readFile(file, 'utf8'), before);
      await ui.getByLabel('Choose diagram').selectOption(id);
      const proposal = ui.locator('.record').filter({ hasText: 'Reviewer drawn proposal' }).filter({ has: ui.getByRole('button', { name: 'Accept proposal', exact: true }) });
      await proposal.getByRole('button', { name: 'Accept proposal', exact: true }).click();
      await eventually(() => read().then(doc => doc.title === 'Reviewer drawn proposal' && doc.revisionId !== savedRevision), 'Owner acceptance did not commit reviewer candidate');
      const accepted = await read();
      assert.ok(accepted.scene.elements.some(el => el.id === reviewerShape && !el.isDeleted));
      assert.match(accepted.svg, /<path|<rect/);
      const acceptedSource = await readFile(file, 'utf8');
      const rejected = await json(origin, `${path}/proposals`, { token: server.agentToken, method: 'POST', body: { baseRevisionId: accepted.revisionId, baseSourceHash: accepted.sourceHash, title: 'Reject this candidate', scene: scene(), summary: 'Rejection acceptance check' } });
      assert.equal(rejected.status, 201);
      await ui.getByLabel('Choose diagram').selectOption(id);
      const rejectedRecord = ui.locator('.record').filter({ hasText: 'Reject this candidate' });
      await rejectedRecord.getByRole('button', { name: 'Reject proposal', exact: true }).click();
      await eventually(() => rejectedRecord.textContent().then(text => text.includes('rejected')), 'Rejected proposal did not show its final state');
      assert.equal(await readFile(file, 'utf8'), acceptedSource);
      await page.screenshot({ path: join(fixture, 'proposal-accepted-rejected.png'), fullPage: true });
    } finally { await reviewer.close(); }
  });

  await t.test('historical export downloads the earlier graphical revision', async () => {
    const historical = (await json(origin, `${path}/export?format=svg&revisionId=${savedRevision}`)).data;
    const record = ui.locator('.record').filter({ hasText: 'Browser-drawn architecture' }).filter({ has: ui.getByRole('button', { name: 'Export revision SVG', exact: true }) }).last();
    const exported = await downloadBytes(page, () => record.getByRole('button', { name: 'Export revision SVG', exact: true }).click());
    assert.equal(exported.bytes.toString(), historical.content);
    assert.notEqual(exported.bytes.toString(), (await read()).svg);
  });

  await t.test('external source conflict yields 409, preserves accepted bytes and downloadable unsaved draft', async () => {
    await editorReady(ui);
    await ui.getByLabel('Diagram title').fill('Unsaved conflict draft');
    const expectedDraft = JSON.parse((await downloadBytes(page, () => ui.getByRole('button', { name: 'Export JSON', exact: true }).click())).bytes.toString());
    let release, observedStatus;
    const barrier = new Promise(resolve => { release = resolve; });
    let arrived;
    const pending = new Promise(resolve => { arrived = resolve; });
    await page.route(`${origin}${path}/save`, async route => { arrived(); await barrier; const response = await route.fetch(); observedStatus = response.status(); await route.fulfill({ response }); });
    try {
      await ui.getByRole('button', { name: 'Save diagram', exact: true }).click();
      await pending;
      assert.equal(await ui.locator('.toolbar').evaluate(element => element.inert), true, 'Pending save left toolbar editable');
      assert.equal(await ui.locator('.workspace').evaluate(element => element.inert), true, 'Pending save left canvas editable');
      const current = await readFile(file, 'utf8');
      const externalSource = current.replace('Source before managed diagram.', 'External source edit must survive.');
      await writeFile(file, externalSource);
      release();
      await eventually(() => observedStatus, 'Stale save response did not arrive');
      assert.equal(observedStatus, 409);
      await eventually(() => status().textContent().then(text => text.includes('Your draft is preserved')), '409 has no actionable browser message');
      assert.equal(await readFile(file, 'utf8'), externalSource);
      assert.equal(await ui.getByLabel('Diagram title').inputValue(), 'Unsaved conflict draft');
      const retained = JSON.parse((await downloadBytes(page, () => ui.getByRole('button', { name: 'Export JSON', exact: true }).click())).bytes.toString());
      assert.deepEqual(retained.elements, expectedDraft.elements);
      await page.screenshot({ path: join(fixture, 'stale-conflict-draft-preserved.png'), fullPage: true });
    } finally { release(); await page.unroute(`${origin}${path}/save`); }
  });
  assert.deepEqual(external, [], 'Bundled editor sent outbound requests past CSP');
  assert.deepEqual(externalAttempts, [], 'Bundled editor attempted outbound requests, including requests blocked by CSP');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  t.diagnostic(`Real Chromium canvas evidence: ${fixture}`);
});

test('plain published figure fits mobile and hosted widget creates, replies and retains changed or removed shape threads', { timeout: 60000 }, async t => {
  const { server, origin, key, root, file } = await startFixture('hosted-mobile');
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  const id = (await json(origin, root)).data.diagrams[0].diagramId, path = `${root}/${id}`;
  let accepted = (await json(origin, path)).data;
  const wideSvg = svg('Wide hosted preview').replace('width="360" height="180"', 'width="2400" height="1200"');
  let saved = await json(origin, `${path}/save`, { token: server.agentToken, method: 'POST', body: { baseRevisionId: accepted.revisionId, baseSourceHash: accepted.sourceHash, title: accepted.title, scene: accepted.scene, svg: wideSvg, summary: 'Wide mobile preview' } });
  assert.equal(saved.status, 200);
  const { injectFeedbackWidget } = await import('../src/feedback/inject.js');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), external = [], externalAttempts = [], errors = [];
  recordExternalAttempts(context, origin, externalAttempts);
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/published.html`, async route => route.fulfill({ contentType: 'text/html', body: injectFeedbackWidget(await readFile(file, 'utf8'), { docId: key, workerUrl: origin }) }));
  await page.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) await route.fallback(); else { external.push(url.href); await route.abort(); } });
  await page.goto(`${origin}/published.html`);
  const widget = page.locator('#htmldrop-widget-host');
  await widget.getByPlaceholder('Display name').fill('Mobile reviewer');
  const image = page.locator(`figure[data-htmldrop-diagram="${id}"] img`);
  await eventually(() => image.evaluate(img => img.complete && img.naturalWidth === 2400), 'Wide published SVG did not load');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Plain published document overflows mobile viewport');
  assert.ok((await image.boundingBox()).width <= 390);
  await widget.getByRole('button', { name: '×', exact: true }).click();
  await page.getByLabel('Diagram shape to comment on').selectOption('uat-stable-shape');
  await page.getByRole('button', { name: 'Comment on shape', exact: true }).click();
  await page.locator('.hd-diagram-shape-highlight').waitFor();
  await widget.locator('.hd-popover textarea').fill('Hosted mobile shape note');
  await widget.locator('.hd-popover').getByRole('button', { name: 'Comment', exact: true }).click();
  const note = await eventually(() => json(origin, `/api/feedback/${key}`).then(result => result.data.items.find(item => item.content.text === 'Hosted mobile shape note')), 'Hosted widget did not create an actual shape comment');
  assert.equal(note.anchor.shapeId, 'uat-stable-shape');
  await widget.getByRole('button', { name: /Comments/ }).click();
  let thread = widget.locator(`.hd-comment[data-comment-id="${note.id}"]`);
  await thread.locator(':scope > .hd-reply-btn').click();
  await thread.getByPlaceholder('Reply…', { exact: true }).fill('Hosted reply remains attached');
  await thread.locator('.hd-reply-input button').click();
  await eventually(() => thread.textContent().then(text => text.includes('Hosted reply remains attached')), 'Hosted widget threaded reply was lost');
  await page.screenshot({ path: join(fixture, 'hosted-mobile-comment-reply.png'), fullPage: true });

  accepted = (await json(origin, path)).data;
  saved = await json(origin, `${path}/save`, { token: server.agentToken, method: 'POST', body: { baseRevisionId: accepted.revisionId, baseSourceHash: accepted.sourceHash, title: accepted.title, scene: scene([rectangle('uat-stable-shape', 140)]), svg: wideSvg, summary: 'Move shape after comment' } });
  assert.equal(saved.status, 200);
  await page.reload();
  thread = widget.locator(`.hd-comment[data-comment-id="${note.id}"]`);
  await eventually(() => thread.textContent().then(text => text.includes('Changed')), 'Changed shape revision is not visible in hosted thread');
  await thread.locator(':scope > .hd-text').click();
  await page.locator('.hd-diagram-shape-highlight').waitFor();
  accepted = (await json(origin, path)).data;
  saved = await json(origin, `${path}/save`, { token: server.agentToken, method: 'POST', body: { baseRevisionId: accepted.revisionId, baseSourceHash: accepted.sourceHash, title: accepted.title, scene: scene([]), svg: wideSvg, summary: 'Remove commented shape' } });
  assert.equal(saved.status, 200);
  await page.reload();
  thread = widget.locator(`.hd-comment[data-comment-id="${note.id}"]`);
  await eventually(() => thread.textContent().then(text => text.includes('Removed') && text.includes('Hosted reply remains attached')), 'Removed shape thread or its reply was lost');
  await thread.locator(':scope > .hd-text').click();
  assert.equal(await page.locator('.hd-diagram-shape-highlight').count(), 0, 'Removed shape comment highlighted a different live target');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await writeFile(join(fixture, 'hosted-network.json'), JSON.stringify({ external, externalAttempts, errors }, null, 2));
  assert.deepEqual(external, []);
  assert.deepEqual(externalAttempts, [], 'Hosted widget attempted an outbound request');
  assert.deepEqual(errors, []);
  t.diagnostic(`Published widget and 390px preview evidence: ${fixture}`);
});
