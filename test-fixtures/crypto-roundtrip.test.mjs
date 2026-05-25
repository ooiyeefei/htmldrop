// Proves the v2 crypto scheme is correct and, crucially, that the Node CLI
// (encryptHtml) and the browser password-gate (WebCrypto) are BYTE-COMPATIBLE.
//
// Run: node test-fixtures/crypto-roundtrip.test.mjs
import assert from 'node:assert/strict';
import CryptoJS from 'crypto-js';
import { encryptHtml, decryptHtml } from '../src/encrypt.js';

const PASSWORD = 'coral-sunset-42';
const SAMPLE = '<!DOCTYPE html><html><body><h1>Secret éé \u{1f510}</h1><p>line2</p></body></html>';

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS  ${name}`); }

// ---------------------------------------------------------------------------
// Helper: extract the v2 envelope from the gate HTML that encryptHtml produces.
// Mirrors src/fetch.js ENCRYPTED_RE.
function extractEnvelope(gateHtml) {
  const m = gateHtml.match(/var\s+encryptedContent\s*=\s*"([^"]*)"\s*;/);
  assert.ok(m, 'gate HTML must contain the encryptedContent blob');
  return m[1];
}

// EXACT browser-gate decrypt from templates/password-gate.html step 3,
// running on Node's WebCrypto (globalThis.crypto.subtle).
async function browserDecrypt(envelope, password) {
  const parts = envelope.split(':'); // ['v2', b64salt, b64iv, b64ct]
  const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const salt = dec(parts[1]), iv = dec(parts[2]), data = dec(parts[3]);
  const baseKey = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await globalThis.crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(pt);
}

async function main() {
  // --- Test 1: Node encrypt -> Node decrypt round-trip + wrong password ----
  const gateHtml = encryptHtml(SAMPLE, PASSWORD);
  const envelope = extractEnvelope(gateHtml);

  assert.ok(envelope.startsWith('v2:'), 'envelope must be the v2 format');
  assert.equal(envelope.split(':').length, 4, 'envelope must have 4 colon-separated parts');
  // The injected blob must be safe inside a double-quoted JS string literal.
  assert.ok(!envelope.includes('"') && !envelope.includes('\\'), 'envelope must contain no quotes/backslashes');
  assert.ok(!gateHtml.includes('{{CRYPTO_JS_URL}}'), 'gate must not reference {{CRYPTO_JS_URL}}');
  assert.ok(!gateHtml.includes('crypto-js'), 'gate must not load crypto-js');

  assert.equal(decryptHtml(envelope, PASSWORD), SAMPLE, 'decryptHtml must recover the original plaintext');
  assert.equal(decryptHtml(envelope, 'wrong'), '', 'wrong password must yield empty string');
  ok('Test 1: Node encrypt -> decrypt round-trip (correct pw recovers, wrong pw -> "")');

  // --- Test 2: Node encrypt -> BROWSER (WebCrypto) decrypt (the real path) --
  const browserPlaintext = await browserDecrypt(envelope, PASSWORD);
  assert.equal(browserPlaintext, SAMPLE, 'WebCrypto decrypt must recover the original plaintext');

  // And a wrong password must reject (AES-GCM tag mismatch -> thrown).
  await assert.rejects(browserDecrypt(envelope, 'wrong'), 'WebCrypto must reject a wrong password');
  ok('Test 2: Node encrypt -> WebCrypto (browser gate) decrypt is byte-compatible');

  // --- Test 3: legacy crypto-js blob still decrypts (back-compat) -----------
  const legacyBlob = CryptoJS.AES.encrypt(SAMPLE, PASSWORD).toString();
  assert.ok(!legacyBlob.startsWith('v2:'), 'legacy blob must not look like a v2 envelope');
  assert.equal(decryptHtml(legacyBlob, PASSWORD), SAMPLE, 'decryptHtml must still decrypt legacy crypto-js blobs');
  assert.equal(decryptHtml(legacyBlob, 'wrong'), '', 'legacy wrong password must yield empty string');
  ok('Test 3: legacy crypto-js blob still decrypts (back-compat for old docs)');

  console.log(`\nAll ${passed} tests passed.`);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
