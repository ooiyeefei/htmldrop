import CryptoJS from 'crypto-js';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'password-gate.html');

// KDF/cipher parameters for the v2 envelope. These MUST stay in lockstep with
// the WebCrypto decrypt in templates/password-gate.html.
const PBKDF2_ITERATIONS = 600000;
const KEY_BYTES = 32; // AES-256
const SALT_BYTES = 16;
const IV_BYTES = 12; // GCM nonce
const GCM_TAG_BYTES = 16;

export function encryptHtml(htmlContent, password) {
  // Strong KDF + authenticated cipher. Self-describing envelope STRING so it
  // embeds safely (no quotes/backslashes) inside a double-quoted JS literal:
  //   v2:<base64(salt)>:<base64(iv)>:<base64(ciphertext||gcmTag)>
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(htmlContent, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // WebCrypto returns ciphertext||tag from encrypt(), so append the tag here to
  // be byte-compatible with the browser gate's crypto.subtle.decrypt.
  const envelope = `v2:${salt.toString('base64')}:${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;

  // Read the password gate template
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');

  // Inject the encrypted envelope into the template. The gate now decrypts with
  // built-in WebCrypto, so no crypto-js <script> URL is injected anymore.
  const result = template.replace('{{ENCRYPTED_CONTENT}}', envelope);

  return result;
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
  // CryptoJS.AES.decrypt(encryptedContent, password).toString(CryptoJS.enc.Utf8)
  // A wrong password yields garbage bytes whose UTF-8 decode throws
  // "Malformed UTF-8 data" — treat that (and any decode failure) as an empty
  // result so callers can report a clean "incorrect password" message.
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedBlob, password);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch {
    return '';
  }
}
