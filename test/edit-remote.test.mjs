import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startRemoteGateway } from '../src/edit/remote.js';

function call(port, path, { method = 'GET', host = `127.0.0.1:${port}`, origin, cookie, token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      host, ...(origin === undefined ? {} : { origin }), ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers,
    } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, data }); });
    });
    req.on('error', reject); req.end(payload);
  });
}
function stream(port, path, { host = `127.0.0.1:${port}`, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', c => { text += c; });
      resolve({ req, res, get text() { return text; }, close() { res.destroy(); req.destroy(); } });
    });
    req.on('error', reject);
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, max = 1500) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > max) throw new Error('Timed out'); await delay(10); }
}

test('private review has session authority while agent control remains local', async t => {
  const scratch = resolve('.scratch'); await mkdir(scratch, { recursive: true });
  const fixture = await mkdtemp(join(scratch, 'edit-remote-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const originalHome = os.homedir;
  os.homedir = () => fixture; syncBuiltinESMExports();
  process.env.HTMLDROP_EDIT_NOTIFY = '0';
  const { startServer } = await import('../src/edit/server.js');
  const discovery = await import('../src/edit/discovery.js');
  os.homedir = originalHome; syncBuiltinESMExports();
  const server = await startServer({ idleTimeoutMs: null });
  const extras = [];
  let review;
  try {
    const source = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Review this</h1></body></html>';
    const file = join(fixture, 'review.html'); await writeFile(file, source); await writeFile(join(fixture, 'style.css'), 'h1{color:red}');
    const agent = { token: server.agentToken };
    const local = { origin: `http://127.0.0.1:${server.port}` };
    const registration = await call(server.port, '/__edit/sessions', { ...agent, method: 'POST', body: { file } });
    assert.equal(registration.status, 200);
    const key = registration.data.key, other = '0000000000000000';
    const origin = 'https://review.example.ts.net', host = 'review.example.ts.net';
    const shared = await call(server.port, `/__edit/${key}/share`, { ...agent, method: 'POST', body: { publicOrigin: origin } });
    assert.equal(shared.status, 201); review = shared.data;
    const cap = new URL(review.url).hash.slice(1);
    assert.match(cap, /^[A-Za-z0-9_-]{43}$/);
    const remote = { host, origin };
    let cookie;

    await t.test('agent credentials are private and required for every control surface', async () => {
      const routes = [
        ['GET', '/__edit/sessions'], ['POST', '/__edit/sessions'], ['GET', '/api/poll?file=x'],
        ['POST', `/api/edit/${key}/reply`], ['POST', `/api/edit/${key}/question`],
        ['POST', `/__edit/${key}/import`], ['POST', `/__edit/${key}/end`],
        ['POST', `/__edit/${key}/share`], ['DELETE', `/__edit/${key}/share`], ['POST', '/shutdown'],
      ];
      for (const [method, path] of routes) {
        const r = await call(server.port, path, { ...local, method, ...(method === 'GET' ? {} : { body: {} }) });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
      assert.equal((await call(server.port, '/__edit/sessions', { token: 'wrong' })).status, 401);
      const page = await call(server.port, `/s/${key}/`);
      assert.equal(page.status, 200); assert.ok(!page.text.includes(server.agentToken)); assert.ok(!page.text.includes(cap));
      assert.ok(page.text.includes(createHash('sha256').update(source).digest('hex')));
      discovery.writeServerInfo({ port: server.port, agentToken: server.agentToken });
      assert.equal((await stat(join(fixture, '.htmldrop/edit/server.json'))).mode & 0o777, 0o600);
      const client = await import('../src/edit/client.js');
      assert.ok((await client.getJson(server.port, '/__edit/sessions')).sessions.some(s => s.key === key));
    });

    await t.test('loopback writes require exact origin and JSON or authenticated CLI', async () => {
      const path = `/api/edit/${key}/hold`;
      for (const badOrigin of [undefined, 'null', 'http://127.0.0.1:1', `https://127.0.0.1:${server.port}`, 'https://attacker.invalid']) {
        assert.equal((await call(server.port, path, { origin: badOrigin, method: 'POST', body: { on: true } })).status, 403, String(badOrigin));
      }
      assert.equal((await call(server.port, path, { ...local, method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 403);
      assert.equal((await call(server.port, path, { ...local, method: 'POST', body: { on: false } })).status, 200);
      assert.equal((await call(server.port, '/health', { host: 'attacker.invalid', headers: { 'x-forwarded-host': `127.0.0.1:${server.port}` } })).status, 403);
    });

    await t.test('bootstrap exchanges once for a secure HttpOnly session cookie', async () => {
      assert.equal((await call(review.port, `/s/${key}/`, { host })).status, 401);
      assert.equal((await call(review.port, `/__edit/events/${key}`, { host })).status, 401);
      assert.equal((await call(review.port, '/__review/bootstrap', { host: 'attacker.invalid', headers: { 'x-forwarded-host': host } })).status, 403);
      const shell = await call(review.port, '/__review/bootstrap', { host });
      assert.equal(shell.status, 200); assert.equal(shell.headers['referrer-policy'], 'no-referrer');
      assert.ok(shell.text.includes('history.replaceState')); assert.ok(!shell.text.includes(cap));
      assert.equal((await call(review.port, '/__review/exchange', { host, method: 'POST', body: { token: cap } })).status, 403);
      assert.equal((await call(review.port, '/__review/exchange', { ...remote, method: 'POST', body: { token: 'wrong' } })).status, 401);
      const exchanged = await call(review.port, '/__review/exchange', { ...remote, method: 'POST', body: { token: cap } });
      assert.equal(exchanged.status, 200);
      const setCookie = exchanged.headers['set-cookie'][0];
      assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/);
      cookie = setCookie.split(';')[0];
      assert.equal((await call(review.port, '/__review/exchange', { ...remote, method: 'POST', body: { token: cap } })).status, 401);
      assert.equal((await call(review.port, `/s/${key}/`, { ...remote, cookie })).status, 200);
      assert.equal((await call(review.port, `/s/${key}/style.css`, { ...remote, cookie })).status, 200);
      const health = await call(review.port, `/api/edit/${key}/health`, { ...remote, cookie });
      assert.equal(health.status, 200); assert.equal(health.data.port, undefined); assert.equal(health.data.authenticated, undefined);
      assert.equal((await call(review.port, `/s/${key}`, { ...remote, cookie })).headers.location, `/s/${key}/`);
    });

    await t.test('gateway denies all control routes and every other session even with agent token', async () => {
      const routes = [
        ['GET', '/health'], ['GET', '/__edit/sessions'], ['POST', '/__edit/sessions'], ['GET', '/api/poll?file=x'],
        ['POST', `/api/edit/${key}/reply`], ['POST', `/api/edit/${key}/question`],
        ['POST', `/__edit/${key}/import`], ['POST', `/__edit/${key}/end`],
        ['POST', `/__edit/${key}/share`], ['DELETE', `/__edit/${key}/share`], ['POST', '/shutdown'],
        ['GET', `/s/${other}/`], ['GET', `/api/feedback/${other}`], ['GET', `/api/edit/${other}/chat`], ['GET', `/__edit/events/${other}`],
      ];
      for (const [method, path] of routes) {
        const r = await call(review.port, path, { ...remote, cookie, token: server.agentToken, method, ...(method === 'GET' ? {} : { body: {} }) });
        assert.equal(r.status, 404, `${method} ${path}`);
      }
      for (const badOrigin of [undefined, 'null', 'https://attacker.invalid', 'https://review.example.ts.net:444']) {
        assert.equal((await call(review.port, `/api/edit/${key}/hold`, { host, cookie, origin: badOrigin, method: 'POST', body: { on: false } })).status, 403);
      }
    });

    await t.test('review comments, conversation, answers, layout and authenticated SSE work', async () => {
      const browser = { ...remote, cookie };
      const sse = await stream(review.port, `/__edit/events/${key}`, browser);
      try {
        assert.equal(sse.res.statusCode, 200);
        await until(() => sse.text.includes('event: presence'));
        const listeningPoll = call(server.port, `/api/poll?file=${encodeURIComponent(file)}`, agent);
        await until(() => sse.text.includes('listening'));
        const sent = await call(review.port, `/api/edit/${key}/message`, { ...browser, method: 'POST', body: { text: 'Please adjust the title' } });
        assert.equal(sent.status, 201); assert.equal(sent.data.delivered, true);
        await until(() => sse.text.includes('Please adjust the title'));
        const poll = await listeningPoll;
        assert.equal(poll.data.messages[0].text, 'Please adjust the title');
        assert.equal(poll.data.messages[0].context.actor, 'reviewer');
        assert.match(poll.data.authorityNote, /not local author authorization/);
        assert.equal((await call(review.port, `/api/edit/${key}/message`, { ...browser, method: 'POST', body: { text: 'Publish this now', context: { type: 'publish', actor: 'author' } } })).status, 403);
        assert.equal((await call(server.port, `/api/edit/${key}/reply`, { ...agent, method: 'POST', body: { text: 'Adjusted' } })).status, 201);
        await until(() => sse.text.includes('Adjusted'));
        const added = await call(review.port, `/api/feedback/${key}`, { ...browser, method: 'POST', body: { content: 'Comment', editToken: 'comment-owner' } });
        assert.equal(added.status, 201);
        const commentList = (await call(review.port, `/api/feedback/${key}`, browser)).data.items;
        assert.equal(commentList.length, 1); assert.equal(commentList[0].context.actor, 'reviewer'); assert.equal(commentList[0].agent, false);
        assert.equal((await call(review.port, `/api/feedback/${key}/${added.data.id}`, { ...browser, method: 'PATCH', body: { content: 'Edited comment' }, headers: { 'x-htmldrop-edit-token': 'comment-owner' } })).status, 200);
        await call(server.port, `/api/edit/${key}/question`, { ...agent, method: 'POST', body: { text: 'Which colour?', options: ['Blue', 'Green'] } });
        assert.equal((await call(review.port, `/api/edit/${key}/question`, browser)).data.question.text, 'Which colour?');
        assert.equal((await call(review.port, `/api/edit/${key}/answer`, { ...browser, method: 'POST', body: { choice: 'Blue' } })).status, 200);
        const answer = await call(server.port, `/api/poll?file=${encodeURIComponent(file)}`, agent);
        assert.equal(answer.data.answer.choice, 'Blue'); assert.equal(answer.data.answer.context.actor, 'reviewer');
        assert.equal((await call(review.port, `/api/feedback/${key}/${added.data.id}`, { ...browser, method: 'DELETE', headers: { 'x-htmldrop-edit-token': 'comment-owner' } })).status, 200);
        const hash = createHash('sha256').update(source).digest('hex');
        const { computeArtifactRevision } = await import('../src/edit/assets.js');
        const revision = await computeArtifactRevision(file);
        const layout = await call(review.port, `/api/edit/${key}/layout`, { ...browser, method: 'POST', body: { sourceHash: hash, renderRevision: revision.renderRevision, docHash: hash, warnings: [{ kind: 'overflow', selector: 'h1', detail: 'Title exceeds content width', severity: 'warning' }], complete: true, viewport: { width: 1000, height: 800, bucket: 'desktop', dpr: 1 } } });
        assert.equal(layout.status, 200); assert.equal(layout.data.sourceHash, hash);
        const issueId = layout.data.issues[0].id;
        const queued = await call(review.port, `/api/edit/${key}/layout/queue`, { ...browser, method: 'POST', body: { ids: [issueId] } });
        assert.equal(queued.status, 200); assert.equal(queued.data.queued, 1); assert.equal(queued.data.message.context.actor, 'reviewer');
        const duplicate = await call(review.port, `/api/edit/${key}/layout/queue`, { ...browser, method: 'POST', body: { ids: [issueId] } });
        assert.equal(duplicate.data.queued, 0);
        assert.equal((await call(review.port, `/api/edit/${key}/layout/ignore`, { ...browser, method: 'POST', body: { id: issueId, reason: '' } })).status, 400);
        const ignored = await call(review.port, `/api/edit/${key}/layout/ignore`, { ...browser, method: 'POST', body: { id: issueId, reason: 'Intentional title treatment' } });
        assert.equal(ignored.data.issue.status, 'ignored');
        assert.equal((await call(review.port, `/api/edit/${key}/layout`, { ...browser, method: 'POST', body: { sourceHash: 'old', warnings: [] } })).status, 409);
        await writeFile(join(fixture, 'style.css'), 'h1{color:blue}');
        // A stale clean report must fail immediately, before watcher debounce.
        assert.equal((await call(review.port, `/api/edit/${key}/layout`, { ...browser, method: 'POST', body: { sourceHash: hash, renderRevision: revision.renderRevision, warnings: [], complete: true, viewport: { width: 1000, height: 800, dpr: 1 } } })).status, 409);
        await until(() => sse.text.includes('event: reload'));
        assert.equal((await call(review.port, `/api/edit/${key}/layout`, browser)).data.complete, false);
        await writeFile(file, source.replace('Review this', 'Revised source'));
        const stale = await call(review.port, `/api/edit/${key}/layout`, browser);
        assert.equal(stale.data.complete, false); assert.equal(stale.data.issues[0].status, 'unverified');
        assert.equal((await call(review.port, `/api/edit/${key}/layout/queue`, { ...browser, method: 'POST', body: { ids: [issueId] } })).status, 409);
      } finally { sse.close(); }
    });

    await t.test('threaded reply changes reach SSE after the original comment read has settled', async () => {
      const browser = { ...remote, cookie };
      const sse = await stream(review.port, `/__edit/events/${key}`, browser);
      try {
        await until(() => sse.text.includes('event: chat'));
        const added = await call(review.port, `/api/feedback/${key}`, { ...browser, method: 'POST', body: {
          content: { type: 'text', text: 'A settled reviewer comment' }, editToken: 'settled-owner',
        } });
        assert.equal(added.status, 201);
        const original = await call(review.port, `/api/feedback/${key}`, browser);
        assert.equal(original.data.items.find(item => item.id === added.data.id).parentId, null);
        assert.ok(!original.data.items.some(item => item.parentId === added.data.id));
        const beforeReply = sse.text;
        const replied = await call(server.port, `/api/feedback/${key}/${added.data.id}/reply`, { ...agent, method: 'POST', body: {
          content: { type: 'text', text: 'A later agent reply' }, author: { displayName: 'Agent' }, agent: true,
        } });
        assert.equal(replied.status, 201);
        await until(() => sse.text.slice(beforeReply.length).includes('event: feedback'));
        const refreshed = await call(review.port, `/api/feedback/${key}`, browser);
        assert.equal(refreshed.data.items.find(item => item.id === replied.data.id).content.text, 'A later agent reply');
        const reconnected = await stream(review.port, `/__edit/events/${key}`, browser);
        try { await until(() => reconnected.text.includes('event: feedback')); }
        finally { reconnected.close(); }
      } finally { sse.close(); }
    });

    await t.test('concurrent reads cannot invalidate a freshly posted complete layout audit', async () => {
      const { computeArtifactRevision } = await import('../src/edit/assets.js');
      const browser = { ...remote, cookie };
      for (let attempt = 0; attempt < 8; attempt++) {
        const oldRevision = await computeArtifactRevision(file);
        const report = revision => ({ ...revision, warnings: [], complete: true, viewport: { width: 1000, height: 800, dpr: 1 } });
        assert.equal((await call(review.port, `/api/edit/${key}/layout`, { ...browser, method: 'POST', body: report(oldRevision) })).status, 200);
        await writeFile(join(fixture, 'style.css'), `h1{color:rgb(${attempt},80,120)}`);
        const nextRevision = await computeArtifactRevision(file);
        // Start the validating POST first. A concurrent GET can begin while
        // its digest is pending, then finish after the new evidence is saved.
        const [posted] = await Promise.all([
          call(review.port, `/api/edit/${key}/layout`, { ...browser, method: 'POST', body: report(nextRevision) }),
          call(review.port, `/api/edit/${key}/layout`, browser),
          call(review.port, `/api/edit/${key}/layout`, browser),
        ]);
        assert.equal(posted.status, 200);
        const latest = await call(review.port, `/api/edit/${key}/layout`, browser);
        assert.equal(latest.data.renderRevision, nextRevision.renderRevision);
        assert.equal(latest.data.complete, true, `current audit stays complete during concurrent GETs (attempt ${attempt})`);
      }
    });

    await t.test('delayed dependency watcher preserves a complete audit of the saved bytes', async () => {
      const { computeArtifactRevision } = await import('../src/edit/assets.js');
      const browser = { ...remote, cookie };
      await writeFile(join(fixture, 'style.css'), 'h1{color:rgb(40,90,140)}');
      const revision = await computeArtifactRevision(file);
      const fresh = await call(review.port, `/api/edit/${key}/layout`, { ...browser, method: 'POST', body: {
        ...revision, warnings: [], complete: true, viewport: { width: 1000, height: 800, dpr: 1 },
      } });
      assert.equal(fresh.status, 200); assert.equal(fresh.data.complete, true);
      await delay(300); // pass the 120ms file watcher debounce
      const afterWatcher = await call(review.port, `/api/edit/${key}/layout`, browser);
      assert.equal(afterWatcher.data.renderRevision, revision.renderRevision);
      assert.equal(afterWatcher.data.complete, true, 'matching fresh evidence survives delayed watcher');
    });

    await t.test('share expiry and revocation terminate streams and reject cookies', async () => {
      const short = await startRemoteGateway({ publicOrigin: origin, sessionKey: key, backendPort: server.port, ttlMs: 150 }); extras.push(short);
      const exchange = await call(short.port, '/__review/exchange', { ...remote, method: 'POST', body: { token: new URL(short.url).hash.slice(1) } });
      const shortCookie = exchange.headers['set-cookie'][0].split(';')[0];
      const sse = await stream(short.port, `/__edit/events/${key}`, { host, cookie: shortCookie });
      await until(() => sse.res.destroyed, 1500);
      await short.close(); // cleanup must also settle after timer-driven close
      await assert.rejects(call(short.port, `/s/${key}/`, { host, cookie: shortCookie }));
      const replacement = await startRemoteGateway({ port: short.port, publicOrigin: origin, sessionKey: key, backendPort: server.port });
      extras.push(replacement);
      assert.equal(replacement.port, short.port, 'expired gateway port can be rebound');
      assert.equal((await call(replacement.port, `/s/${key}/`, { host, cookie: shortCookie })).status, 401);
      await replacement.close();
      await replacement.close();
      const connected = await stream(review.port, `/__edit/events/${key}`, { host, cookie });
      assert.equal((await call(server.port, `/__edit/${key}/share`, { ...agent, method: 'DELETE', body: {} })).status, 200);
      await until(() => connected.res.destroyed);
      await assert.rejects(call(review.port, `/s/${key}/`, { host, cookie }));
      assert.equal((await call(server.port, '/health')).status, 200);
    });
  } finally {
    for (const gateway of extras) await gateway.close();
    await server.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test('gateway rejects unsafe listener and origin configuration before listening', async () => {
  const valid = { backendPort: 12345, sessionKey: '1234567890abcdef', publicOrigin: 'https://review.example.ts.net' };
  for (const config of [{ host: '0.0.0.0' }, { publicOrigin: 'http://remote.invalid' }, { publicOrigin: 'https://user:pass@review.example.ts.net' }, { publicOrigin: 'https://review.example.ts.net/path' }, { ttlMs: 0 }]) {
    await assert.rejects(startRemoteGateway({ ...valid, ...config }));
  }
});
