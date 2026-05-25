import CryptoJS from 'crypto-js';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'password-gate.html');

// KDF/cipher parameters for the v2 envelope. These MUST stay in lockstep with
// the WebCrypto code in templates/password-gate.html and the worker verifier.
const PBKDF2_ITERATIONS = 600000;
const KEY_BYTES = 32;   // AES-256 key  = derived bytes [0:32]
const TOKEN_BYTES = 32; // access token = derived bytes [32:64]
const SALT_BYTES = 16;
const IV_BYTES = 12;    // GCM nonce
const GCM_TAG_BYTES = 16;

// One PBKDF2 pass -> 64 bytes, split into the AES key and the feedback access
// token. PBKDF2 emits output block-by-block, so bytes [0:32] are byte-identical
// to a 32-byte derivation -> the AES key matches pre-token v2 docs (full
// back-compat, decryptHtml unchanged). The token (bytes [32:64]) is an
// independent block: revealing it to the Worker never reveals the key.
function deriveKeyAndToken(password, salt) {
  const material = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES + TOKEN_BYTES, 'sha256');
  return { key: material.subarray(0, KEY_BYTES), token: material.subarray(KEY_BYTES) };
}

function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// Encrypt to the self-describing envelope and return the credentials the CLI
// needs to register the doc's feedback-access capability with the Worker:
//   envelope: v2:<base64(salt)>:<base64(iv)>:<base64(ciphertext||gcmTag)>
export function encryptToEnvelope(htmlContent, password) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const { key, token } = deriveKeyAndToken(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(htmlContent, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // WebCrypto returns ciphertext||tag from encrypt(), so append the tag to be
  // byte-compatible with the browser gate's crypto.subtle.decrypt.
  const envelope = `v2:${salt.toString('base64')}:${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
  const accessToken = token.toString('base64');
  return {
    envelope,
    salt: salt.toString('base64'),
    accessToken,
    accessHash: sha256Hex(accessToken),
  };
}

// Wrap an envelope in the password-gate page (built-in WebCrypto decrypt; no
// crypto-js CDN script is injected).
export function buildGatePage(envelope) {
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  return template.replace('{{ENCRYPTED_CONTENT}}', envelope);
}

// Back-compat convenience: HTML -> ready-to-deploy gate page (string).
export function encryptHtml(htmlContent, password) {
  return buildGatePage(encryptToEnvelope(htmlContent, password).envelope);
}

// Derive the feedback access token from a password + the doc's (public) salt.
// Used by the teammate CLI (feedback read/add --password) after fetching the
// salt from GET /api/access/:docId. Byte-identical to the browser gate's
// WebCrypto derivation and to encryptToEnvelope's token.
export function deriveAccessToken(password, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return deriveKeyAndToken(password, salt).token.toString('base64');
}

// SHA-256(tokenB64) hex — what the Worker stores as access:<docId>.tokenHash and
// recomputes from the X-HTMLDrop-Access header to authorize (constant-time).
export function accessHashHex(tokenB64) {
  return sha256Hex(tokenB64);
}

export function decryptHtml(encryptedBlob, password) {
  // Handles BOTH formats so docs published before the v2 upgrade still decrypt.
  if (typeof encryptedBlob === 'string' && encryptedBlob.startsWith('v2:')) {
    // v2 envelope: PBKDF2(SHA-256) key + AES-256-GCM. Mirrors the WebCrypto
    // decrypt in templates/password-gate.html. Any failure (wrong password,
    // tampered ciphertext, malformed envelope) returns '' — no oracle change.
    try {
      const [, b64salt, b64iv, b64ct] = encryptedBlob.split(':');
      const salt = Buffer.from(b64salt, 'base64');
      const iv = Buffer.from(b64iv, 'base64');
      const data = Buffer.from(b64ct, 'base64');
      const ct = data.subarray(0, data.length - GCM_TAG_BYTES);
      const tag = data.subarray(data.length - GCM_TAG_BYTES);
      const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  // Legacy crypto-js path (OpenSSL passphrase mode). Kept for back-compat:
  // a wrong password yields garbage whose UTF-8 decode throws "Malformed UTF-8
  // data" — treat that (and any decode failure) as an empty result so callers
  // can report a clean "incorrect password" message.
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedBlob, password);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch {
    return '';
  }
}
