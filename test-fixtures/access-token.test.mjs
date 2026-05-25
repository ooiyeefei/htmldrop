// Pins the v2-capability token contract shared by the CLI (node:crypto),
// the browser password-gate (WebCrypto), and the Worker verifier.
// Run: node test-fixtures/access-token.test.mjs
import { encryptToEnvelope, deriveAccessToken, accessHashHex, decryptHtml } from '../src/encrypt.js';
import { createHash } from 'node:crypto';

const PASSWORD = 'cobalt-lantern-29';
let pass = 0, fail = 0;
const ok = (name, cond) => { (cond ? (pass++, console.log('  PASS ', name)) : (fail++, console.log('  FAIL ', name))); };

// --- The browser gate's derivation, reproduced with Node's WebCrypto. The real
// gate uses exactly this (deriveBits 512 -> [0:32] AES key, [32:64] token). ---
async function gateDerive(password, saltB64) {
  const salt = Uint8Array.from(Buffer.from(saltB64, 'base64'));
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, baseKey, 512));
  return { aesKey: bits.slice(0, 32), token: Buffer.from(bits.slice(32, 64)).toString('base64') };
}

async function gateDecrypt(envelope, password) {
  const [, b64s, b64iv, b64ct] = envelope.split(':');
  const { aesKey } = await gateDerive(password, b64s);
  const iv = Uint8Array.from(Buffer.from(b64iv, 'base64'));
  const data = Uint8Array.from(Buffer.from(b64ct, 'base64'));
  const key = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(pt);
}

const html = '<h1>private</h1><p>secret spec</p>';
const env = encryptToEnvelope(html, PASSWORD);

// 1. Round-trip + the access credentials are well-formed.
ok('1a decryptHtml recovers plaintext', decryptHtml(env.envelope, PASSWORD) === html);
ok('1b wrong password -> ""', decryptHtml(env.envelope, 'nope') === '');
ok('1c envelope has 4 parts', env.envelope.split(':').length === 4);
ok('1d accessHash == sha256(accessToken)', env.accessHash === createHash('sha256').update(env.accessToken).digest('hex'));

// 2. CRITICAL: the browser gate (WebCrypto deriveBits split) derives the SAME
//    token as the CLI (node:crypto pbkdf2Sync split) for the same password+salt.
const gate = await gateDerive(PASSWORD, env.salt);
ok('2a gate token == encryptToEnvelope.accessToken', gate.token === env.accessToken);
ok('2b gate token == deriveAccessToken(pw, salt)', gate.token === deriveAccessToken(PASSWORD, env.salt));

// 3. CRITICAL: the browser gate's AES key (bits[0:32]) decrypts the envelope the
//    CLI produced -> CLI-encrypt and gate-decrypt are byte-compatible.
ok('3a gate decrypts CLI envelope', (await gateDecrypt(env.envelope, PASSWORD)) === html);

// 4. Token + hash are deterministic and stable across calls.
ok('4a deriveAccessToken deterministic', deriveAccessToken(PASSWORD, env.salt) === deriveAccessToken(PASSWORD, env.salt));
ok('4b accessHashHex(token) == registered accessHash', accessHashHex(env.accessToken) === env.accessHash);

// 5. Different password on the same salt -> different token (capability is bound to the password).
ok('5a different password -> different token', deriveAccessToken('other-pw', env.salt) !== env.accessToken);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
