// Builds a real password-gated page exactly as `htmldrop push --feedback --password`
// would (widget injected -> encrypted -> wrapped in the gate), registers the
// private doc's access capability with the local Worker, and writes the gate to
// test-fixtures/private-gate.html for a browser click-through.
//   node test-fixtures/build-private-gate.mjs
import { injectFeedbackWidget } from '../src/feedback/inject.js';
import { encryptToEnvelope, buildGatePage } from '../src/encrypt.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const WORKER = process.env.WORKER_BASE || 'http://127.0.0.1:8787';
const GATE_ORIGIN = 'http://127.0.0.1:8080';
const PASSWORD = 'coral-sunset-42';
const OWNER = 'privowner-' + randomUUID();
const docId = 'privux-' + randomUUID();

const content = `<!doctype html><html><head><meta charset="utf-8"><title>Private Spec</title></head>`
  + `<body><h1>Confidential Design</h1><p id="p1">The ledger uses event sourcing for auditability.</p></body></html>`;

// Same pipeline as push.js for an encrypted feedback doc:
const injected = injectFeedbackWidget(content, { docId, workerUrl: WORKER });
const enc = encryptToEnvelope(injected, PASSWORD);
writeFileSync(new URL('./private-gate.html', import.meta.url), buildGatePage(enc.envelope));

const res = await fetch(`${WORKER}/api/register/${docId}`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${OWNER}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: `${GATE_ORIGIN}/private-gate.html`, accessHash: enc.accessHash, salt: enc.salt }),
});

const noToken = await fetch(`${WORKER}/api/feedback/${docId}`);
console.log(JSON.stringify({
  register: res.status,
  docId,
  password: PASSWORD,
  gatedWithoutToken: noToken.status, // want 401 — proves the doc is private
  gateUrl: `${GATE_ORIGIN}/private-gate.html`,
}, null, 2));
