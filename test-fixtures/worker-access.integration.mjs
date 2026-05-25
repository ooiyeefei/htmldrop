// End-to-end check of the v1.6.0 password-capability access model against a
// live local Worker. Start it with ADMIN_SECRET set (the migration success case
// needs it), then run the test:
//   (cd worker && npx wrangler dev --port 8787 --var ADMIN_SECRET:testsecret123)  # local is the default in wrangler 4
//   node test-fixtures/worker-access.integration.mjs
import { encryptToEnvelope, deriveAccessToken } from '../src/encrypt.js';
import { randomUUID } from 'node:crypto';

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:8787';
const OWNER = 'ownerkey-' + randomUUID();
const ATTACKER = 'attackerkey-' + randomUUID();
const PUBLIC_DOC = 'pub-' + randomUUID();
const PRIVATE_DOC = 'priv-' + randomUUID();
const PASSWORD = 'coral-sunset-42';

// Real access credentials for the private doc (as `push` would compute them).
const enc = encryptToEnvelope('<p>secret</p>', PASSWORD);
const token = deriveAccessToken(PASSWORD, enc.salt); // what a reviewer derives from the password
const item = { anchor: { type: 'page_level' }, content: { type: 'text', text: 'hi' }, author: { displayName: 'R' } };

async function req(method, path, { key, token, adminSecret, body, ct } = {}) {
  const headers = {};
  if (key) headers['Authorization'] = 'Bearer ' + key;
  if (token) headers['X-HTMLDrop-Access'] = token;
  if (adminSecret) headers['X-Admin-Secret'] = adminSecret;
  if (body !== undefined) headers['Content-Type'] = ct || 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS ', n)) : (fail++, console.log('  FAIL ', n)); };

// Registration
ok('register public -> 200', (await req('POST', `/api/register/${PUBLIC_DOC}`, { key: OWNER, body: { url: 'https://x.surge.sh/p.html' } })).status === 200);
ok('register private -> 200', (await req('POST', `/api/register/${PRIVATE_DOC}`, { key: OWNER, body: { url: 'https://x.surge.sh/q.html', accessHash: enc.accessHash, salt: enc.salt } })).status === 200);

// GET /api/access
let a = await req('GET', `/api/access/${PRIVATE_DOC}`);
ok('access private -> {v2-capability, salt}', a.json?.scheme === 'v2-capability' && a.json?.salt === enc.salt);
ok('access public -> open', (await req('GET', `/api/access/${PUBLIC_DOC}`)).json?.scheme === 'open');

// PRIVATE doc gating
ok('private POST no token -> 401', (await req('POST', `/api/feedback/${PRIVATE_DOC}`, { body: item })).status === 401);
ok('private POST wrong token -> 401', (await req('POST', `/api/feedback/${PRIVATE_DOC}`, { token: 'AAAA', body: item })).status === 401);
ok('private POST correct token -> 2xx', [200, 201].includes((await req('POST', `/api/feedback/${PRIVATE_DOC}`, { token, body: item })).status));
ok('private GET no token -> 401', (await req('GET', `/api/feedback/${PRIVATE_DOC}`)).status === 401);
ok('private GET correct token -> 200', (await req('GET', `/api/feedback/${PRIVATE_DOC}`, { token })).status === 200);
ok('private GET owner-key bypass -> 200', (await req('GET', `/api/feedback/${PRIVATE_DOC}`, { key: OWNER })).status === 200);

// PUBLIC doc stays open
ok('public POST open -> 2xx', [200, 201].includes((await req('POST', `/api/feedback/${PUBLIC_DOC}`, { body: item })).status));
ok('public GET open -> 200', (await req('GET', `/api/feedback/${PUBLIC_DOC}`)).status === 200);

// Set-once ownership (F2)
ok('attacker re-register private -> 409', (await req('POST', `/api/register/${PRIVATE_DOC}`, { key: ATTACKER, body: { url: 'https://evil/' } })).status === 409);
ok('attacker clear private -> 403', (await req('DELETE', `/api/feedback/${PRIVATE_DOC}`, { key: ATTACKER })).status === 403);

// CSP sandbox on the served public doc (F1)
await req('POST', `/api/doc/${PUBLIC_DOC}/content`, { key: OWNER, body: '<h1>pub</h1>', ct: 'text/html' });
const docRes = await fetch(`${BASE}/doc/${PUBLIC_DOC}`);
ok('CSP sandbox header on /doc/*', (docRes.headers.get('content-security-policy') || '').includes('sandbox'));

// Insights inherit the private-doc gate (H1 — was publicly readable)
ok('private GET insights no token -> 401', (await req('GET', `/api/insights/${PRIVATE_DOC}`)).status === 401);
ok('private GET insights token -> 200', (await req('GET', `/api/insights/${PRIVATE_DOC}`, { token })).status === 200);
ok('private GET insights owner-key -> 200', (await req('GET', `/api/insights/${PRIVATE_DOC}`, { key: OWNER })).status === 200);
ok('public GET insights open -> 200', (await req('GET', `/api/insights/${PUBLIC_DOC}`)).status === 200);

// Admin migration: header-only secret (M2) + collision report (M1)
const SECRET = process.env.ADMIN_SECRET || 'testsecret123';
ok('migrate no secret -> 403', (await req('POST', '/admin/migrate-owners')).status === 403);
ok('migrate via ?secret= query -> 403 (query rejected)', (await fetch(`${BASE}/admin/migrate-owners?secret=${SECRET}`, { method: 'POST' })).status === 403);
const mig = await req('POST', '/admin/migrate-owners', { adminSecret: SECRET });
ok('migrate via X-Admin-Secret header -> 200 + collisions[]', mig.status === 200 && Array.isArray(mig.json?.collisions));

// Admin resolve-owner repair path (clears a migration conflict). Guarded.
ok('resolve-owner no secret -> 403', (await req('POST', '/admin/resolve-owner', { body: { docId: PUBLIC_DOC } })).status === 403);
const resolve = await req('POST', '/admin/resolve-owner', { adminSecret: SECRET, body: { docId: 'noconflict-' + randomUUID() } });
ok('resolve-owner with secret -> 200 resolved:true', resolve.status === 200 && resolve.json?.resolved === true);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
