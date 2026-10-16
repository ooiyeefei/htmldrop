import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { encryptToEnvelope } from '../src/encrypt.js';

const require = createRequire(new URL('../worker/package.json', import.meta.url));
const { build } = require('esbuild');
const bundle = await build({ entryPoints: [new URL('../worker/src/index.ts', import.meta.url).pathname], bundle: true, write: false,
  format: 'esm', platform: 'browser', loader: { '.html': 'text' }, logLevel: 'silent' });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function namespace() {
  const items = new Map();
  return { get: async key => items.get(key) ?? null, put: async (key, value) => { items.set(key, value); },
    delete: async key => { items.delete(key); }, list: async () => ({ keys: [], list_complete: true }) };
}

test('a public document made private stops serving old plaintext and rejects new plaintext uploads', async () => {
  const env = { FEEDBACK: namespace(), AUTHORS: namespace(), RATE_LIMITS: namespace(), ENVIRONMENT: 'test' };
  const id = randomUUID(), owner = `owner-${randomUUID()}`;
  const request = (path, { method = 'GET', body, contentType = 'application/json', auth = true } = {}) => worker.fetch(new Request(`https://worker.invalid${path}`, {
    method, headers: { ...(auth ? { authorization: `Bearer ${owner}` } : {}), 'content-type': contentType },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env);
  assert.equal((await request(`/api/register/${id}`, { method: 'POST', body: { url: 'https://example.surge.sh/report.html' } })).status, 200);
  assert.equal((await request(`/api/doc/${id}/content`, { method: 'POST', body: '<h1>Former public snapshot</h1>', contentType: 'text/html' })).status, 200);
  assert.match(await (await request(`/doc/${id}`, { auth: false })).text(), /Former public snapshot/);
  const encrypted = encryptToEnvelope('<h1>Private replacement</h1>', 'fixture-password');
  assert.equal((await request(`/api/register/${id}`, { method: 'POST', body: { url: 'https://example.surge.sh/report.html', accessHash: encrypted.accessHash, salt: encrypted.salt } })).status, 200);
  assert.equal(await env.FEEDBACK.get(`content:${id}`), null);
  // Simulate delayed old content deletion: the independent route guard still denies it.
  await env.FEEDBACK.put(`content:${id}`, '<h1>Former public snapshot</h1>');
  for (const auth of [false, true]) {
    const response = await request(`/doc/${id}`, { auth });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /Former public snapshot|Private replacement/);
  }
  assert.equal((await request(`/api/doc/${id}/content`, { method: 'POST', body: '<h1>Accidental private plaintext</h1>', contentType: 'text/html' })).status, 409);
  assert.doesNotMatch(await env.FEEDBACK.get(`content:${id}`), /Accidental private plaintext/);
});
