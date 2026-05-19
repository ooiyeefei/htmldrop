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
  let isEncrypted = false;

  // Encrypt if password provided
  if (options.password) {
    content = encryptHtml(content, options.password);
    isEncrypted = true;
    console.log(`Encrypting ${filename} with password protection...`);
  }

  // Inject noindex meta tag if requested
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

  // Inject feedback widget if --feedback flag
  let docId = null;
  if (options.feedback && !isEncrypted) {
    const authorKey = getAuthorKey();
    docId = randomUUID();
    const workerUrl = options.workerUrl || DEFAULT_WORKER_URL;
    content = injectFeedbackWidget(content, { docId, workerUrl });
    console.log(`Feedback enabled for ${filename} (docId: ${docId.slice(0, 8)}...)`);

    // Register doc with the worker
    try {
      const res = await fetch(`${workerUrl}/api/register/${docId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authorKey}` },
      });
      if (!res.ok) {
        console.warn('Warning: could not register doc with feedback worker.');
      }
    } catch {
      console.warn('Warning: feedback worker unreachable. Comments may not work until worker is deployed.');
    }
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
