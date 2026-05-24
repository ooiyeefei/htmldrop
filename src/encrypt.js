import CryptoJS from 'crypto-js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'password-gate.html');

export function encryptHtml(htmlContent, password) {
  // Encrypt the HTML content with AES-256
  const encrypted = CryptoJS.AES.encrypt(htmlContent, password).toString();

  // Read the password gate template
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');

  // Inject the encrypted content into the template
  const result = template
    .replace('{{ENCRYPTED_CONTENT}}', encrypted)
    .replace('{{CRYPTO_JS_URL}}', 'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js');

  return result;
}

export function decryptHtml(encryptedBlob, password) {
  // Mirrors the decrypt logic in templates/password-gate.html:
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
