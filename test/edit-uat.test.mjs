import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const scratch = resolve('.scratch/m1-uat');
await mkdir(scratch, { recursive: true });
const fixture = await mkdtemp(join(scratch, 'run-'));
// Set before importing anything that captures the config directory.
process.env.HTMLDROP_CONFIG_DIR = join(fixture, 'config');
process.env.TMPDIR = join(fixture, 'browser-tmp');
await mkdir(process.env.TMPDIR, { recursive: true });
process.env.HTMLDROP_EDIT_NOTIFY = '0';
const { startServer } = await import('../src/edit/server.js');
const { startRemoteGateway } = await import('../src/edit/remote.js');
const { injectEditRuntime } = await import('../src/edit/runtime.js');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
const initialCss = 'body{margin:24px;font:16px/1.5 system-ui;background:#f7f9fb;color:#234}main{max-width:620px}h1{color:rgb(20,80,110);font-size:28px}img{width:48px;height:48px}#clipped:not(.repaired){width:150px;height:20px;overflow:hidden}a{display:block;margin-top:12px}';
const source = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit UAT</title><link rel="icon" href="data:,"><link rel="stylesheet" href="site.css"></head><body><main><h1>Quarterly review</h1><p id="clipped">This deliberate long sentence must fit after the requested layout repair.</p><img src="pixel.png" alt="Local fixture"><a href="report.xlsx" download>Download spreadsheet</a><p id="revision">Original source</p></main></body></html>';

// A real minimal OOXML workbook, stored without compression for a byte-exact download assertion.
function workbook() {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="UAT" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
  };
  let offset = 0;
  const local = [], central = [];
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += h.length + n.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function freePort() {
  const probe = createServer();
  await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
  const port = probe.address().port;
  await new Promise(ok => probe.close(ok));
  return port;
}
async function eventually(fn, message, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  do { try { const result = await fn(); if (result) return result; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 60)); } while (Date.now() < end);
  throw new Error(`${message}${last ? ': ' + last.message : ''}`);
}
async function getJson(origin, path, { token, method = 'GET', body, signal } = {}) {
  const response = await fetch(origin + path, { method, signal, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function withinViewport(page) {
  const failures = await page.evaluate(() => {
    const problems = [], width = innerWidth, height = innerHeight;
    for (const id of ['htmldrop-edit-host', 'htmldrop-widget-host']) {
      const root = document.getElementById(id)?.shadowRoot;
      if (!root) { problems.push(`${id} missing`); continue; }
      for (const selector of id === 'htmldrop-edit-host' ? ['.bar', '.row1', '#inbox'] : ['.hd-panel', '.hd-compose']) {
        const element = root.querySelector(selector);
        if (!element || !element.getClientRects().length) continue;
        const box = element.getBoundingClientRect();
        if (box.left < -1 || box.right > width + 1 || box.top < -1 || box.bottom > height + 1 || element.scrollWidth > element.clientWidth + 2) problems.push(`${id} ${selector} overflows: ${JSON.stringify({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })}`);
      }
    }
    return problems;
  });
  assert.deepEqual(failures, []);
}

test('actual browser edit and private reviewer UAT', { timeout: 120000 }, async t => {
  const file = join(fixture, 'review.html'), xlsx = workbook();
  await Promise.all([writeFile(file, source), writeFile(join(fixture, 'site.css'), initialCss), writeFile(join(fixture, 'pixel.png'), png), writeFile(join(fixture, 'report.xlsx'), xlsx)]);
  const server = await startServer({ idleTimeoutMs: null });
  const origin = `http://127.0.0.1:${server.port}`, token = server.agentToken;
  let browser, gateway;
  t.after(async () => { await browser?.close(); await gateway?.close(); await server.close(); });
  const registered = await getJson(origin, '/__edit/sessions', { token, method: 'POST', body: { file } });
  assert.equal(registered.status, 200);
  const key = registered.data.key, path = `/s/${key}/`, errors = [];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const bar = page.locator('#htmldrop-edit-host');
  const layout = () => getJson(origin, `/api/edit/${key}/layout`).then(r => r.data);
  const screenshot = name => page.screenshot({ path: join(fixture, name), fullPage: true });

  await t.test('runtime scripts parse and declared CSS, PNG, XLSX load in Chromium', async () => {
    const injected = injectEditRuntime(source, { key });
    for (const match of injected.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
    await page.goto(origin + path);
    await bar.locator('#inboxToggle').waitFor();
    await eventually(() => layout().then(l => l.issues.some(i => i.selector === '#clipped')), 'Browser did not persist deliberate clipping warning');
    assert.equal(await page.locator('h1').evaluate(el => getComputedStyle(el).color), 'rgb(20, 80, 110)');
    assert.equal(await page.locator('img').evaluate(el => el.complete && el.naturalWidth > 0), true);
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download spreadsheet' }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'report.xlsx');
    assert.deepEqual(await readFile(await download.path()), xlsx);
    const asset = await context.request.get(origin + path + 'report.xlsx');
    assert.match(asset.headers()['content-type'], /spreadsheetml/);
    assert.deepEqual(errors, []);
    await screenshot('01-desktop-loaded.png');
  });

  await t.test('layout Inbox counts, target focus, long poll, reply, and source repair resolve', async () => {
    const initial = await eventually(() => layout().then(l => l.complete && l.issues.some(i => i.selector === '#clipped') ? l : null), 'Complete browser layout evidence missing');
    const issue = initial.issues.find(i => i.selector === '#clipped');
    const activeCount = initial.issues.filter(i => !['resolved', 'ignored'].includes(i.status)).length;
    assert.equal(await bar.locator('#inboxToggle').innerText(), `Layout inbox (${activeCount})`);
    await bar.locator('#inboxToggle').click();
    const row = bar.locator('.issue').filter({ hasText: '#clipped ·' });
    await row.getByRole('button', { name: 'Show target' }).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'clipped');
    await row.getByRole('checkbox').check();
    const poll = getJson(origin, `/api/poll?file=${encodeURIComponent(file)}`, { token, signal: AbortSignal.timeout(15000) });
    await eventually(() => bar.locator('#pl').textContent().then(text => text === 'listening'), 'Agent presence did not become listening');
    await bar.getByRole('button', { name: 'Queue selected fixes' }).click();
    const delivered = await poll;
    assert.equal(delivered.data.status, 'feedback');
    assert.ok(delivered.data.messages.some(m => m.text.includes('#clipped')));
    assert.equal((await layout()).issues.find(i => i.id === issue.id).status, 'queued');
    assert.equal((await getJson(origin, `/api/edit/${key}/reply`, { token, method: 'POST', body: { text: 'Fixed the clipped paragraph; verifying this viewport.' } })).status, 201);
    await eventually(() => bar.locator('#feed').textContent().then(text => text.includes('Fixed the clipped paragraph')), 'Agent reply did not reach browser SSE');
    await screenshot('02-desktop-queued-replied.png');
    const repaired = source.replace('id="clipped"', 'id="clipped" class="repaired"').replace('Original source', 'Repaired source');
    await writeFile(file, repaired);
    await eventually(() => page.locator('#revision').textContent().then(text => text === 'Repaired source'), 'Source change did not reload browser');
    let lastLayout;
    let fixed;
    try {
      fixed = await eventually(() => layout().then(l => {
        lastLayout = l;
        return l.complete && l.issues.find(i => i.id === issue.id)?.status === 'resolved' ? l : null;
      }), 'Complete same-viewport recheck did not resolve repaired issue');
    } catch (error) {
      await writeFile(join(fixture, 'source-recheck-failure.json'), JSON.stringify({ layout: lastLayout, errors, browser: await page.evaluate(() => ({ visibility: document.visibilityState, ready: document.readyState, fonts: document.fonts.status, images: Array.from(document.images, img => ({ src: img.src, complete: img.complete, naturalWidth: img.naturalWidth })) })) }, null, 2));
      await screenshot('source-recheck-failure.png');
      throw error;
    }
    assert.equal(fixed.sourceHash, createHash('sha256').update(repaired).digest('hex'));
    await bar.locator('#inboxToggle').click();
    await withinViewport(page);
    await screenshot('03-desktop-resolved.png');
  });

  await t.test('declared CSS edit triggers SSE reload and fresh layout revision without changing HTML', async () => {
    const before = await layout();
    const navigated = page.waitForEvent('load');
    await writeFile(join(fixture, 'site.css'), initialCss.replace('rgb(20,80,110)', 'rgb(130,40,90)'));
    await navigated;
    await eventually(() => page.locator('h1').evaluate(el => getComputedStyle(el).color === 'rgb(130, 40, 90)'), 'CSS change did not render in reloaded browser');
    const after = await eventually(() => layout().then(l => l.complete && l.renderRevision && l.renderRevision !== before.renderRevision ? l : null), 'CSS edit did not create fresh complete layout revision');
    assert.equal(after.sourceHash, before.sourceHash);
    assert.deepEqual(errors, []);
    await screenshot('04-desktop-css-reloaded.png');
  });

  await t.test('desktop 1280 and fresh mobile 390 editor overlays fit the viewport', async () => {
    await page.goto(origin + path); await bar.locator('#inboxToggle').waitFor();
    await bar.locator('#inboxToggle').click(); await withinViewport(page);
    await screenshot('05-desktop-inbox.png');
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
    const small = await mobile.newPage(); small.on('pageerror', e => errors.push(e.message));
    try {
      await small.goto(origin + path); await small.locator('#htmldrop-edit-host #inboxToggle').waitFor();
      await eventually(() => layout().then(l => l.viewport?.width === 390), 'Mobile viewport was not audited');
      await small.locator('#htmldrop-edit-host #inboxToggle').click();
      await small.screenshot({ path: join(fixture, '06-mobile-inbox.png'), fullPage: true });
      await withinViewport(small);
      // A panel can fit the viewport and still be unusable under a higher-z-index bar.
      await small.locator('#htmldrop-widget-host .hd-compose textarea').click({ timeout: 2000 });
      assert.equal(await small.locator('#htmldrop-widget-host .hd-compose textarea').evaluate(el => el === el.getRootNode().activeElement), true);
      assert.deepEqual(errors, []);
    } finally { await mobile.close(); }
  });

  await t.test('private reviewer bootstrap, comment/reply, reload, and authority boundaries', async () => {
    const port = await freePort(), remoteOrigin = `http://127.0.0.1:${port}`;
    gateway = await startRemoteGateway({ port, publicOrigin: remoteOrigin, sessionKey: key, backendPort: server.port });
    const reviewer = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const review = await reviewer.newPage(), remoteErrors = [], browserTrace = [];
    await review.exposeFunction('__recordUatEvent', event => browserTrace.push({ at: Date.now(), ...event }));
    await review.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url, options) {
          super(url, options);
          for (const type of ['open', 'error', 'presence', 'chat', 'feedback', 'reload', 'ended', 'hold', 'question']) {
            this.addEventListener(type, event => { window.__recordUatEvent({ kind: 'sse', type, path: new URL(url, location.href).pathname, data: event.data || null }).catch(() => {}); });
          }
        }
      };
    });
    review.on('response', async response => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/feedback/')) return;
      const record = { at: Date.now(), kind: 'feedback-response', method: response.request().method(), path: url.pathname, status: response.status() };
      try { record.data = await response.json(); } catch (error) { record.error = error.message; }
      browserTrace.push(record);
    });
    review.on('requestfailed', request => browserTrace.push({ at: Date.now(), kind: 'requestfailed', method: request.method(), path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    review.on('pageerror', e => remoteErrors.push(e.message));
    const remoteBar = review.locator('#htmldrop-edit-host'), widget = review.locator('#htmldrop-widget-host');
    const replyVisible = text => review.evaluate(expected => {
      const sections = document.getElementById('htmldrop-widget-host')?.shadowRoot?.querySelectorAll('.hd-reply-section') || [];
      return [...sections].some(section => section.textContent.includes(expected) && section.checkVisibility());
    }, text);
    async function delayedSave(method, routePath, send, changeDraft, expectedStatus) {
      let response, routed = false, routeError;
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      const handler = async route => {
        if (route.request().method() !== method) { await route.continue(); return; }
        try {
          response = await route.fetch();
          await pending;
          await route.fulfill({ response });
          routed = true;
        } catch (error) { routeError = error; }
      };
      await review.route(remoteOrigin + routePath, handler);
      try {
        await send();
        await eventually(() => response || routeError, `${method} save did not reach the response barrier`);
        if (routeError) throw routeError;
        assert.equal(response.status(), expectedStatus);
        await changeDraft();
        release();
        await eventually(() => routed || routeError, `${method} saved response was not released`);
        if (routeError) throw routeError;
      } finally { release(); await review.unroute(remoteOrigin + routePath, handler); }
    }
    try {
      assert.equal((await reviewer.request.get(remoteOrigin + path)).status(), 401);
      const secondFile = join(fixture, 'other.html'); await writeFile(secondFile, '<html><body>Unshared</body></html>');
      const other = (await getJson(origin, '/__edit/sessions', { token, method: 'POST', body: { file: secondFile } })).data.key;
      await review.goto(gateway.url);
      await review.waitForURL(remoteOrigin + path);
      await remoteBar.locator('#inboxToggle').waitFor();
      assert.equal(new URL(review.url()).hash, '');
      assert.ok(!(await review.content()).includes(token), 'Agent bearer credential leaked into reviewer HTML');
      const cookies = await reviewer.cookies();
      assert.ok(cookies.some(c => c.name === 'htmldrop-review' && c.httpOnly && c.sameSite === 'Strict'));
      assert.equal(await remoteBar.locator('#pub').count(), 0);
      assert.equal((await reviewer.request.post(remoteOrigin + '/__review/exchange', { headers: { origin: remoteOrigin }, data: { token: new URL(gateway.url).hash.slice(1) } })).status(), 401);
      const poll = getJson(origin, `/api/poll?file=${encodeURIComponent(file)}`, { token, signal: AbortSignal.timeout(15000) });
      await eventually(() => remoteBar.locator('#pl').textContent().then(text => text === 'listening'), 'Reviewer does not see listening agent');
      await widget.getByPlaceholder('Display name').fill('UAT Reviewer');
      await widget.locator('.hd-compose textarea').fill('Please confirm this reviewer comment.');
      await widget.getByRole('button', { name: 'Comment', exact: true }).click();
      const delivered = await poll;
      const comment = delivered.data.newComments.find(c => c.content.text === 'Please confirm this reviewer comment.');
      assert.ok(comment); assert.equal(comment.context.actor, 'reviewer'); assert.equal(comment.agent, false);
      assert.match(delivered.data.authorityNote, /review-only/);
      // Finish the reviewer's own POST/refresh before replying. Otherwise a fast
      // agent reply can enter that GET snapshot and conceal a missing SSE refresh.
      await eventually(() => browserTrace.some(event => event.kind === 'feedback-response' && event.method === 'GET' && event.data?.items?.some(item => item.id === comment.id)), 'Reviewer own-comment refresh did not complete');
      await eventually(() => review.evaluate(id => !!document.getElementById('htmldrop-widget-host')?.shadowRoot?.querySelector(`.hd-comment[data-comment-id="${id}"]`), comment.id), 'Reviewer own comment did not render');
      await widget.locator('.hd-compose textarea').fill('Unsent second review note.');
      await widget.getByPlaceholder('Display name').fill('Draft reviewer name');
      assert.equal(await replyVisible('Confirmed in the local agent reply.'), false);
      const agentReply = await getJson(origin, `/api/feedback/${key}/${comment.id}/reply`, { token, method: 'POST', body: { content: { type: 'text', text: 'Confirmed in the local agent reply.' }, author: { displayName: 'Agent' }, agent: true } });
      assert.equal(agentReply.status, 201);
      browserTrace.push({ at: Date.now(), kind: 'agent-reply', status: agentReply.status, data: agentReply.data });
      await eventually(() => replyVisible('Confirmed in the local agent reply.'), 'Reviewer did not see threaded reply via SSE');
      assert.equal(await widget.locator('.hd-compose textarea').inputValue(), 'Unsent second review note.', 'Incoming feedback discarded the unsent main comment');
      assert.equal(await widget.getByPlaceholder('Display name').inputValue(), 'Draft reviewer name', 'Incoming feedback discarded the uncommitted display name');
      await widget.locator('.hd-compose textarea').fill('');
      await widget.locator('.hd-comment').first().getByRole('button', { name: 'Reply', exact: true }).first().click();
      await widget.getByPlaceholder('Reply…', { exact: true }).fill('Reviewer follow-up saved.');
      assert.equal((await getJson(origin, `/api/feedback/${key}/${comment.id}/reply`, { token, method: 'POST', body: { content: { type: 'text', text: 'Second agent message while composing a follow-up.' }, author: { displayName: 'Agent' }, agent: true } })).status, 201);
      await eventually(() => replyVisible('Second agent message while composing a follow-up.'), 'Second agent reply did not appear while reviewer was composing');
      assert.equal(await widget.getByPlaceholder('Reply…', { exact: true }).inputValue(), 'Reviewer follow-up saved.', 'Incoming feedback discarded the unsent threaded reply');
      await widget.locator('.hd-reply-input').getByRole('button', { name: 'Reply', exact: true }).click();
      await eventually(() => replyVisible('Reviewer follow-up saved.'), 'Reviewer threaded follow-up missing');

      // Save acknowledgements must not erase text typed after the submission.
      // Hold real upstream responses so both backend writes and SSE refreshes
      // occur while the user is already composing the next draft.
      await widget.locator('.hd-compose textarea').fill('Main comment submitted before response.');
      await delayedSave('POST', `/api/feedback/${key}`,
        () => widget.locator('.hd-compose-submit').click(),
        () => widget.locator('.hd-compose textarea').fill('Main draft typed while response pending.'), 201);
      await eventually(() => widget.locator('.hd-compose-submit').isEnabled(), 'Main comment button remained disabled after save');
      assert.equal(await widget.locator('.hd-compose textarea').inputValue(), 'Main draft typed while response pending.', 'Main save acknowledgement erased the newer draft');
      assert.ok((await getJson(origin, `/api/feedback/${key}`)).data.items.some(item => item.content.text === 'Main comment submitted before response.'));
      await widget.locator('.hd-compose textarea').fill('');

      const ownComment = widget.locator(`.hd-comment[data-comment-id="${comment.id}"]`);
      await eventually(() => ownComment.locator(':scope > .hd-reply-input').count().then(count => count === 0), 'Previous submitted reply composer did not close');
      await ownComment.locator(':scope > .hd-reply-btn').click();
      await ownComment.locator('.hd-reply-input textarea').fill('Reply submitted before response.');
      await delayedSave('POST', `/api/feedback/${key}/${comment.id}/reply`,
        () => ownComment.locator('.hd-reply-input button').click(),
        () => ownComment.locator('.hd-reply-input textarea').fill('Reply draft typed while response pending.'), 201);
      await eventually(() => ownComment.locator('.hd-reply-input button').isEnabled(), 'Reply button remained disabled after save');
      assert.equal(await ownComment.locator('.hd-reply-input textarea').inputValue(), 'Reply draft typed while response pending.', 'Reply save acknowledgement erased the newer draft');
      assert.ok((await getJson(origin, `/api/feedback/${key}`)).data.items.some(item => item.parentId === comment.id && item.content.text === 'Reply submitted before response.'));
      await ownComment.locator(':scope > .hd-reply-btn').click();

      await ownComment.locator(':scope > .hd-edit-btn').click();
      await ownComment.locator('.hd-edit-area').fill('Inline edit submitted before response.');
      await delayedSave('PATCH', `/api/feedback/${key}/${comment.id}`,
        () => ownComment.locator('.hd-edit-actions .hd-popover-submit').click(),
        () => ownComment.locator('.hd-edit-area').fill('Inline edit draft typed while response pending.'), 200);
      await eventually(() => ownComment.locator('.hd-edit-actions .hd-popover-submit').isEnabled(), 'Inline edit Save remained disabled after save');
      assert.equal(await ownComment.locator('.hd-edit-area').inputValue(), 'Inline edit draft typed while response pending.', 'Inline edit acknowledgement erased the newer draft');
      assert.equal((await getJson(origin, `/api/feedback/${key}`)).data.items.find(item => item.id === comment.id).content.text, 'Inline edit submitted before response.');
      await ownComment.locator('.hd-edit-actions .hd-popover-cancel').click();
      const blocked = [
        ['GET', '/__edit/sessions'], ['POST', '/__edit/sessions'], ['GET', `/api/poll?file=${encodeURIComponent(file)}`],
        ['POST', `/api/edit/${key}/reply`], ['POST', `/api/edit/${key}/question`], ['POST', `/__edit/${key}/end`],
        ['POST', `/__edit/${key}/share`], ['POST', `/__edit/${key}/import`], ['POST', '/shutdown'],
        ['GET', `/s/${other}/`], ['GET', `/api/feedback/${other}`], ['GET', `/api/edit/${other}/chat`], ['GET', `/__edit/events/${other}`],
      ];
      for (const [method, route] of blocked) {
        const r = await reviewer.request.fetch(remoteOrigin + route, { method, headers: { origin: remoteOrigin, authorization: `Bearer ${token}` }, ...(method === 'GET' ? {} : { data: {} }) });
        assert.equal(r.status(), 404, `${method} ${route}`);
      }
      const publishing = await reviewer.request.post(remoteOrigin + `/api/edit/${key}/message`, { headers: { origin: remoteOrigin }, data: { text: 'Publish', context: { type: 'publish' } } });
      assert.equal(publishing.status(), 403);
      const changed = (await readFile(file, 'utf8')).replace(/(?:Original|Repaired) source/, 'Reviewer source reload');
      await writeFile(file, changed);
      await eventually(() => review.locator('#revision').textContent().then(text => text === 'Reviewer source reload'), 'Reviewer SSE source reload missing');
      await eventually(() => replyVisible('Reviewer follow-up saved.'), 'Reviewer comments did not persist after reload');
      await writeFile(join(fixture, 'site.css'), initialCss.replace('rgb(20,80,110)', 'rgb(30,100,60)'));
      await eventually(() => review.locator('h1').evaluate(el => getComputedStyle(el).color === 'rgb(30, 100, 60)'), 'Reviewer dependency CSS SSE reload missing');
      await eventually(() => replyVisible('Reviewer follow-up saved.'), 'Reviewer comments did not persist after dependency reload');
      assert.equal(await remoteBar.locator('#pub').count(), 0);
      assert.deepEqual(remoteErrors, []);
      await eventually(() => remoteBar.locator('#inboxToggle').textContent().then(text => !text.includes('unverified') && !text.includes('checking')), 'Reviewer browser did not complete its current layout check');
      await withinViewport(review);
      await review.screenshot({ path: join(fixture, '07-private-reviewer.png'), fullPage: true });
      const clean = await browser.newContext();
      const reuse = await clean.newPage(); await reuse.goto(gateway.url);
      await reuse.getByText('This review link has expired or was already used.', { exact: false }).waitFor();
      assert.equal((await clean.request.get(remoteOrigin + path)).status(), 401);
      await clean.close();
    } catch (error) {
      const evidence = await Promise.allSettled([
        getJson(origin, `/api/feedback/${key}`),
        review.evaluate(() => {
          const root = document.getElementById('htmldrop-widget-host')?.shadowRoot;
          return { url: location.origin + location.pathname, ready: document.readyState, visibility: document.visibilityState, widgetHtml: root?.innerHTML, widgetText: root?.textContent, renderedComments: [...(root?.querySelectorAll('.hd-comment') || [])].map(node => ({ id: node.dataset.commentId, text: node.innerText, visible: node.checkVisibility() })), renderedReplySections: [...(root?.querySelectorAll('.hd-reply-section') || [])].map(node => ({ text: node.innerText, visible: node.checkVisibility() })), editHtml: document.getElementById('htmldrop-edit-host')?.shadowRoot?.innerHTML };
        }),
        review.screenshot({ path: join(fixture, 'reviewer-failure.png'), fullPage: true }),
      ]);
      await writeFile(join(fixture, 'reviewer-failure.json'), JSON.stringify({ error: error.message, remoteErrors, browserTrace, comments: evidence[0].status === 'fulfilled' ? evidence[0].value : String(evidence[0].reason), browser: evidence[1].status === 'fulfilled' ? evidence[1].value : String(evidence[1].reason) }, null, 2));
      throw error;
    } finally { await reviewer.close(); }
  });
  t.diagnostic(`Evidence: ${fixture}`);
});
