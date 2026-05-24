import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { basename, resolve, join } from 'node:path';
import open from 'open';
import { requireConfig, getSiteDir, ensureSiteDir, getFileUrl } from './config.js';
import { encryptHtml } from './encrypt.js';
import { generateGallery } from './gallery.js';
import { loadManifest, saveManifest } from './manifest.js';
import { injectFeedbackWidget } from './feedback/inject.js';
import { getAuthorKey } from './auth.js';
import { resolvePassword } from './prompt.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

function getSurgeCommand() {
  try {
    execSync('which surge', { stdio: 'ignore' });
    return 'surge';
  } catch {
    return 'npx surge';
  }
}

export async function push(file, options = {}) {
  const config = requireConfig();
  const siteDir = getSiteDir();
  ensureSiteDir();

  // Resolve the input file
  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const filename = basename(filePath);
  if (!filename.endsWith('.html') && !filename.endsWith('.htm')) {
    throw new Error('Only HTML files (.html, .htm) are supported.');
  }

  const stats = statSync(filePath);
  const fileSizeBytes = stats.size;

  // Read the file content
  let content = readFileSync(filePath, 'utf-8');
  // Resolve the password (string from --password <pw>, env var, or hidden prompt)
  const password = await resolvePassword(options.password);
  let isEncrypted = Boolean(password);

  // Inject noindex meta tag if requested.
  // Done before encryption (it would be hidden inside the cipher otherwise, and
  // the password-gate template carries its own <head>), so skip when encrypting.
  if (options.noindex && !isEncrypted) {
    const noindexTag = '<meta name="robots" content="noindex, nofollow">';
    if (content.includes('<head>')) {
      content = content.replace('<head>', `<head>\n  ${noindexTag}`);
    } else if (content.includes('<html>')) {
      content = content.replace('<html>', `<html><head>${noindexTag}</head>`);
    } else {
      content = `<head>${noindexTag}</head>\n${content}`;
    }
    console.log(`Added noindex tag to ${filename} (crawlers blocked).`);
  }

  // Inject feedback widget if --feedback flag.
  // This must happen BEFORE encryption so the widget ends up inside the
  // encrypted payload and runs in the viewer's browser after they enter the
  // password (the gate decrypts and renders the result client-side).
  let docId = null;
  let feedbackAuthorKey = null;
  let feedbackWorkerUrl = null;
  let feedbackCleanContent = null;
  if (options.feedback) {
    feedbackAuthorKey = getAuthorKey();
    feedbackWorkerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL;

    // Reuse existing docId so the shareable link stays stable across re-pushes.
    // --new-doc forces a fresh doc (clean slate, new URL, drops old comments' anchor).
    const priorEntry = loadManifest().files.find((f) => f.name === filename);
    if (priorEntry?.docId && !options.newDoc) {
      docId = priorEntry.docId;
      console.log(`Updating existing feedback doc for ${filename} (docId: ${docId.slice(0, 8)}...)`);
    } else {
      docId = randomUUID();
      console.log(`Feedback enabled for ${filename} (docId: ${docId.slice(0, 8)}...)`);
    }

    // Keep a clean copy (no widget) of the plaintext. For unencrypted docs the
    // Worker injects its own widget at serve time, so it gets this clean copy
    // (uploading the widget-injected copy would double-inject). For encrypted
    // docs we never upload plaintext to the Worker at all.
    feedbackCleanContent = content;
    content = injectFeedbackWidget(content, { docId, workerUrl: feedbackWorkerUrl });
  }

  // Encrypt if password provided. Runs AFTER widget injection so the widget is
  // inside the encrypted payload and survives the client-side decrypt+rerender.
  if (password) {
    content = encryptHtml(content, password);
    console.log(`Encrypting ${filename} with password protection...`);
  }

  // Write to site directory
  const destPath = join(siteDir, filename);
  writeFileSync(destPath, content, 'utf-8');
  console.log(`Added ${filename} to site directory.`);

  // Update manifest
  const manifest = loadManifest();
  const existingIndex = manifest.files.findIndex((f) => f.name === filename);
  const entry = {
    name: filename,
    date: new Date().toISOString(),
    size: fileSizeBytes,
    encrypted: isEncrypted,
    noindex: Boolean(options.noindex),
    feedback: Boolean(options.feedback),
    docId: docId || undefined,
  };

  if (existingIndex >= 0) {
    manifest.files[existingIndex] = entry;
  } else {
    manifest.files.push(entry);
  }
  saveManifest(manifest);

  // Regenerate gallery — stored as _gallery.html to avoid overwriting user's index.html
  // Surge serves index.html at root by default, so if user has no index.html,
  // we symlink/copy _gallery.html as index.html
  const galleryHtml = generateGallery(manifest.files, config);
  writeFileSync(join(siteDir, '_gallery.html'), galleryHtml, 'utf-8');

  // Only use gallery as index.html if user hasn't pushed their own index.html
  const userHasIndex = manifest.files.some((f) => f.name === 'index.html');
  if (!userHasIndex) {
    writeFileSync(join(siteDir, 'index.html'), galleryHtml, 'utf-8');
  }
  console.log('Regenerated gallery.');

  // Deploy to surge
  const domain = `${config.subdomain}.surge.sh`;
  const surgeCmd = getSurgeCommand();
  console.log(`\nDeploying to ${domain}...`);

  try {
    execSync(`${surgeCmd} ${siteDir} --domain ${domain}`, { stdio: 'inherit' });
  } catch {
    throw new Error(
      'Surge deploy failed. Make sure you are logged in (run `htmldrop init`).'
    );
  }

  const url = getFileUrl(config, filename);
  console.log(`\nPublished: ${url}`);
  if (docId) {
    // For encrypted docs the reviewable page is the password-gated Surge URL
    // (the Worker never holds the plaintext, so it cannot serve /doc/:docId).
    // For unencrypted docs the Worker serves a single feedback URL.
    if (isEncrypted) {
      console.log(`Feedback URL: ${url}`);
      console.log('(Reviewers also need the password to view and comment.)');
    } else {
      console.log(`Feedback URL: ${feedbackWorkerUrl}/doc/${docId}`);
    }
  }

  // Register doc with the feedback worker (after deploy so URL is live).
  // Done for BOTH encrypted and unencrypted feedback docs so comments can be stored.
  if (docId && feedbackAuthorKey && feedbackWorkerUrl) {
    try {
      const res = await fetch(`${feedbackWorkerUrl}/api/register/${docId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${feedbackAuthorKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        console.warn('Warning: could not register doc with feedback worker.');
      }
    } catch {
      console.warn('Warning: feedback worker unreachable. Comments may not work until worker is deployed.');
    }

    // Upload HTML content to the Worker for single-URL serving — ONLY for
    // unencrypted docs. For encrypted docs we must never hand the plaintext to
    // the Worker; the password-gated copy is served from Surge instead.
    if (!isEncrypted) {
      try {
        await fetch(`${feedbackWorkerUrl}/api/doc/${docId}/content`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${feedbackAuthorKey}`,
            'Content-Type': 'text/html',
          },
          body: feedbackCleanContent || content,
        });
        console.log(`Document available at: ${feedbackWorkerUrl}/doc/${docId}`);
      } catch {
        console.warn('Warning: could not upload document content to worker.');
      }
    }
  }

  if (isEncrypted) {
    console.log('(Password-protected — viewer must enter password to access content)');
  }

  // Open in browser if --open flag
  if (options.open) {
    await open(url);
    console.log('Opened in browser.');
  }

  return url;
}
