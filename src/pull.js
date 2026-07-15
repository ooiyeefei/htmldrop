import { writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import open from 'open';
import { decryptHtml } from './encrypt.js';
import { loadManifest, saveManifest } from './manifest.js';
import { resolvePassword } from './prompt.js';

// Matches the blob stored by templates/password-gate.html:
//   var encryptedContent = "....";
const ENCRYPTED_RE = /var\s+encryptedContent\s*=\s*"([^"]*)"\s*;/;
const CONFIG_SCRIPT_RE = /<script\b(?=[^>]*\sid\s*=\s*["']htmldrop-config["'])[^>]*>([\s\S]*?)<\/script\s*>/i;

function parseFeedbackConfig(html) {
  const match = CONFIG_SCRIPT_RE.exec(html);
  if (!match) {
    return null;
  }

  let config;
  try {
    config = JSON.parse(match[1].trim());
  } catch {
    throw new Error('Could not parse the htmldrop feedback config in this page.');
  }

  if (!config || typeof config.docId !== 'string' || config.docId.length === 0) {
    throw new Error('The htmldrop feedback config is missing a docId.');
  }

  return {
    docId: config.docId,
    workerUrl: typeof config.workerUrl === 'string' ? config.workerUrl : undefined,
    start: match.index,
  };
}

function stripInjectedFeedbackBlock(html, start) {
  const tail = html.slice(start);
  const bodyClose = /<\/body\s*>/i.exec(tail);
  if (bodyClose) {
    return html.slice(0, start) + html.slice(start + bodyClose.index);
  }

  const htmlClose = /<\/html\s*>/i.exec(tail);
  if (htmlClose) {
    return html.slice(0, start) + html.slice(start + htmlClose.index);
  }

  // injectFeedbackWidget's final fallback appends "\n" before the config tag.
  // If that newline is still immediately before the marker, remove just that
  // one inserted byte so the source round-trips cleanly.
  const prefix = html.slice(0, start);
  return prefix.endsWith('\n') ? prefix.slice(0, -1) : prefix;
}

export function reconstructSource(html, password) {
  if (typeof html !== 'string') {
    throw new Error('HTML content is required.');
  }

  const encryptedMatch = html.match(ENCRYPTED_RE);
  let pageHtml = html;
  let wasGated = false;

  if (encryptedMatch) {
    wasGated = true;
    if (!password) {
      throw new Error('This doc is password-protected. Provide --password (with a value, env HTMLDROP_PASSWORD, or a hidden prompt) to decrypt it.');
    }

    const decrypted = decryptHtml(encryptedMatch[1], password);
    if (!decrypted || decrypted.length === 0) {
      throw new Error('Incorrect password — could not decrypt this doc.');
    }
    pageHtml = decrypted;
  }

  const config = parseFeedbackConfig(pageHtml);
  if (!config) {
    return { cleanHtml: pageHtml, docId: undefined, workerUrl: undefined, wasGated };
  }

  return {
    cleanHtml: stripInjectedFeedbackBlock(pageHtml, config.start),
    docId: config.docId,
    workerUrl: config.workerUrl,
    wasGated,
  };
}

function defaultOutputFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    if (last) {
      const decoded = decodeURIComponent(last);
      const name = basename(decoded);
      if (/\.html?$/i.test(name)) {
        return name;
      }
    }
  } catch {
    // Fetch will report invalid URLs. The fallback keeps this helper total.
  }
  return 'pulled.html';
}

function resolveOutputPath(outputFile) {
  const cwd = resolve(process.cwd());
  const outPath = resolve(cwd, outputFile);
  if (outPath !== cwd && !outPath.startsWith(cwd + sep)) {
    throw new Error('Refusing to write outside the current directory');
  }
  if (outPath === cwd) {
    throw new Error('Output path must be a file inside the current directory');
  }
  return outPath;
}

function recordPulledDoc({ name, url, cleanHtml, docId, workerUrl, wasGated }) {
  const manifest = loadManifest();
  if (!Array.isArray(manifest.files)) {
    manifest.files = [];
  }

  const existingIndex = manifest.files.findIndex((f) => f.name === name);
  const existing = existingIndex >= 0 ? manifest.files[existingIndex] : {};
  const entry = {
    ...existing,
    name,
    date: new Date().toISOString(),
    size: Buffer.byteLength(cleanHtml, 'utf8'),
    encrypted: wasGated,
    noindex: existing.noindex || false,
    feedback: true,
    docId,
    pulledFrom: url,
  };

  if (workerUrl !== undefined) {
    entry.workerUrl = workerUrl;
  } else {
    delete entry.workerUrl;
  }

  if (existingIndex >= 0) {
    manifest.files[existingIndex] = entry;
  } else {
    manifest.files.push(entry);
  }

  saveManifest(manifest);
  return entry;
}

export async function pull(url, options = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('A URL is required.');
  }

  const res = await fetch(url);
  if (res.status !== 200) {
    throw new Error(`Failed to fetch ${url} (${res.status})`);
  }
  const html = await res.text();

  const password = html.match(ENCRYPTED_RE)
    ? await resolvePassword(options.password)
    : undefined;
  const reconstructed = reconstructSource(html, password);

  const outputFile = options.output || defaultOutputFromUrl(url);
  const outPath = resolveOutputPath(outputFile);
  writeFileSync(outPath, reconstructed.cleanHtml, 'utf-8');

  const name = basename(outPath);
  console.log(`Wrote ${Buffer.byteLength(reconstructed.cleanHtml, 'utf8')} bytes to ${outputFile}`);

  if (reconstructed.docId) {
    recordPulledDoc({
      name,
      url,
      cleanHtml: reconstructed.cleanHtml,
      docId: reconstructed.docId,
      workerUrl: reconstructed.workerUrl,
      wasGated: reconstructed.wasGated,
    });
    console.log(`Linked ${name} to feedback doc ${reconstructed.docId} (same review thread).`);
  } else {
    console.warn('Warning: no htmldrop feedback config was found; saved the HTML as-is and skipped relinking.');
  }

  console.log('\nNext steps:');
  if (reconstructed.docId) {
    console.log(`  htmldrop edit start ${outputFile} --with-feedback`);
    console.log(`  htmldrop push ${outputFile} --feedback`);
    if (reconstructed.wasGated) {
      console.log('  (Add --password <pw> to the push command to keep the published doc password-protected.)');
    }
  } else {
    console.log(`  htmldrop edit start ${outputFile}`);
    console.log(`  htmldrop push ${outputFile}`);
  }

  if (options.open !== false) {
    try {
      await open(outPath);
    } catch {
      console.warn(`Warning: could not open ${outputFile}.`);
    }
  }

  return { file: outPath, ...reconstructed };
}
