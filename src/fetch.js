import { writeFileSync } from 'node:fs';
import { decryptHtml } from './encrypt.js';

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
    if (!options.password) {
      throw new Error('This page is password-protected. Provide --password <pw> to decrypt it.');
    }
    const decrypted = decryptHtml(match[1], options.password);
    if (!decrypted || decrypted.length === 0) {
      throw new Error('Decryption failed — wrong password (empty result).');
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
