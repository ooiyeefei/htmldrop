import { writeFileSync } from 'node:fs';
import { decryptHtml } from './encrypt.js';
import { resolvePassword } from './prompt.js';

// Matches the blob stored by templates/password-gate.html:
//   var encryptedContent = "....";
const ENCRYPTED_RE = /var\s+encryptedContent\s*=\s*"([^"]*)"\s*;/;

export async function fetchDoc(url, options = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('A URL is required.');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} (${res.status})`);
  }
  const html = await res.text();

  const match = html.match(ENCRYPTED_RE);

  let output;
  if (match) {
    // Password-gate page — decrypt the blob.
    const password = await resolvePassword(options.password);
    if (!password) {
      throw new Error('This page is password-protected. Provide --password (with a value, env HTMLDROP_PASSWORD, or be prompted) to decrypt it.');
    }
    const decrypted = decryptHtml(match[1], password);
    if (!decrypted || decrypted.length === 0) {
      throw new Error('Incorrect password — could not decrypt this page.');
    }
    output = decrypted;
  } else {
    // Not an encrypted page — output the fetched HTML as-is.
    output = html;
  }

  if (options.out) {
    writeFileSync(options.out, output, 'utf-8');
    console.log(`Wrote ${output.length} bytes to ${options.out}`);
  } else {
    process.stdout.write(output);
  }

  return output;
}
