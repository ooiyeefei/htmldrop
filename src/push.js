import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { basename, resolve, join } from 'node:path';
import open from 'open';
import { requireConfig, getSiteDir, ensureSiteDir, getFileUrl } from './config.js';
import { encryptToEnvelope, buildGatePage } from './encrypt.js';
import { generateGallery } from './gallery.js';
import { loadManifest, saveManifest } from './manifest.js';
import { injectFeedbackWidget } from './feedback/inject.js';
import { getAuthorKey } from './auth.js';
import { resolvePassword } from './prompt.js';
import { generatePassphrase } from './passphrase.js';
import { prepareHistory, saveHistory, injectHistoryWidget, stripHistoryWidget } from './history/index.js';
import { scanArtifactDependencies } from './edit/assets.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

// Build the "save this password now" notice printed after a successful push of
// a password-protected doc. Pure (no I/O) so it can be unit-tested without a
// deploy. It is the one place the CLI ever shows a password, and only when the
// user can reasonably re-read it: when WE generated it (--generate-password),
// or when they passed it on the command line (already in shell history). A
// password that arrived via hidden prompt or env var is deliberately kept
// off-screen and is NOT echoed here.
//
//   source: 'generated' | 'flag' | 'hidden'
export function passwordNotice({ url, password, source }) {
  const showValue = source === 'generated' || source === 'flag';
  const passwordLine = showValue
    ? `Password: ${password}`
    : 'Password: (entered privately via prompt or $HTMLDROP_PASSWORD, not echoed here)';

  const guarantee =
    '⚠ Save this password now — htmldrop is zero-knowledge and stores it nowhere, so a forgotten password cannot be recovered.';
  const tip =
    'Tip: pipe from your password manager, e.g.  htmldrop push file.html --password "$(op read op://vault/item/password)"  (also works with: bw get password <id>, pass show <name>).';

  return [
    '',
    '  ----- Save this password -----',
    `  URL:      ${url}`,
    `  ${passwordLine}`,
    '',
    `  ${guarantee}`,
    `  ${tip}`,
  ].join('\n');
}

function getSurgeCommand() {
  try {
    execSync('which surge', { stdio: 'ignore' });
    return 'surge';
  } catch {
    // Pinned npx fallback (--yes skips the install prompt; pinning avoids
    // silently fetching whatever 'latest' resolves to at deploy time).
    return 'npx --yes surge@0.27.4';
  }
}

export async function push(file, options = {}) {
  const config = requireConfig();
  const siteDir = getSiteDir();

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

  // Publishing uploads one self-contained HTML file. Edit mode can serve sibling
  // assets for local review, but silently omitting those files from a hosted
  // page would break it. Static discovery cannot detect dynamic JavaScript URLs.
  const dependencies = await scanArtifactDependencies(filePath);
  if (dependencies.assets.length || dependencies.missing.length || dependencies.blocked.length || dependencies.truncated) {
    const names = [...new Set([...dependencies.assets, ...dependencies.missing, ...dependencies.blocked])].slice(0, 6).map((name) => {
      if (/^(?:\/|[a-z]:)|(?:^|\/)\.\.(?:\/|$)|\\/i.test(name)) return '(outside artifact folder)';
      return name.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 100);
    });
    const detail = names.length ? ` Local references: ${names.join(', ')}.` : '';
    const incomplete = dependencies.truncated ? ' Dependency discovery reached its safety limit.' : '';
    throw new Error(`Cannot publish this HTML as a self-contained page.${detail}${incomplete} htmldrop push uploads only the HTML file. Embed local assets or use external HTTPS/data URLs before publishing. Use htmldrop edit start to review sibling files locally.`);
  }

  // Read the file content
  let content = stripHistoryWidget(readFileSync(filePath, 'utf-8'));
  const manifest = loadManifest();
  const priorEntry = manifest.files.find((f) => f.name === filename);

  // Resolve the password, honoring --generate-password.
  //   passwordSource: 'generated' | 'flag' | 'hidden'
  //     'generated' — we minted a memorable passphrase (--generate-password); safe to echo once below
  //     'flag'      — an explicit --password <value> was passed (already in shell history); safe to echo
  //     'hidden'    — password came from a hidden prompt or $HTMLDROP_PASSWORD (kept off-screen, never echoed)
  // Zero-knowledge holds for EVERY source: the password lives only in memory
  // for this push and is discarded after. htmldrop stores it nowhere.
  let password;
  let passwordSource;
  if (options.generatePassword && typeof options.password === 'string' && options.password.length > 0) {
    // Explicit value wins; never silently swap a password the user typed.
    password = options.password;
    passwordSource = 'flag';
    console.log('Note: --generate-password ignored because --password <value> was given.');
  } else if (options.generatePassword) {
    password = generatePassphrase();
    passwordSource = 'generated';
    console.log('Generated a memorable password for this push (shown once below).');
  } else {
    password = await resolvePassword(options.password);
    passwordSource = typeof options.password === 'string' && options.password.length > 0 ? 'flag' : 'hidden';
  }
  let isEncrypted = Boolean(password);
  const history = prepareHistory({ html: content, priorEntry, password, newDoc: Boolean(options.newDoc) });
  if (history.warning) console.warn(`Warning: ${history.warning}`);

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

  // History belongs to every publication, including those without comments.
  // Private histories remain inside the password gate; their archived sources
  // are individually encrypted so password rotation cannot reveal old sources.
  content = injectHistoryWidget(content, history);

  // Inject feedback widget if --feedback flag.
  // This must happen BEFORE encryption so the widget ends up inside the
  // encrypted payload and runs in the viewer's browser after they enter the
  // password (the gate decrypts and renders the result client-side).
  let docId = null;
  let feedbackAuthorKey = null;
  let feedbackWorkerUrl = null;
  let feedbackCleanContent = null;
  // An existing public feedback URL must be closed when this file becomes
  // private, even when this push disables the optional feedback widget.
  if (options.feedback || (isEncrypted && priorEntry?.docId)) {
    try {
      feedbackAuthorKey = getAuthorKey();
    } catch (error) {
      if (isEncrypted && priorEntry?.docId) {
        throw new Error('Cannot protect the existing feedback URL without its author credentials. Restore the original author key in your htmldrop configuration before publishing privately. No document was deployed.');
      }
      throw error;
    }
    feedbackWorkerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || priorEntry?.workerUrl || DEFAULT_WORKER_URL;
  }
  if (options.feedback) {

    // Reuse existing docId so the shareable link stays stable across re-pushes.
    // --new-doc forces a fresh doc (clean slate, new URL, drops old comments' anchor).
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
  // For an encrypted feedback doc we also derive the access capability (a
  // password-derived token) and register only its HASH + the (public) salt with
  // the Worker, so the Worker can gate comments on password-knowledge without
  // ever seeing the password or the AES key.
  let accessHash = null;
  let accessSalt = null;
  if (password) {
    const enc = encryptToEnvelope(content, password);
    content = buildGatePage(enc.envelope);
    accessHash = enc.accessHash;
    accessSalt = enc.salt;
    console.log(`Encrypting ${filename} with password protection...`);
  }

  const url = getFileUrl(config, filename);
  let privateAccessUpdated = false;
  if (isEncrypted && feedbackAuthorKey && feedbackWorkerUrl) {
    // Fail closed before deploying: the previous public Worker copy must stop
    // being served first. Register the old identity too when --new-doc replaces
    // it, since both identities previously pointed to this publication URL.
    const privateTargets = new Map();
    if (docId) privateTargets.set(`${feedbackWorkerUrl}\0${docId}`, { id: docId, workerUrl: feedbackWorkerUrl });
    if (priorEntry?.docId) {
      const priorWorkerUrl = priorEntry.workerUrl || feedbackWorkerUrl;
      privateTargets.set(`${priorWorkerUrl}\0${priorEntry.docId}`, { id: priorEntry.docId, workerUrl: priorWorkerUrl });
    }
    for (const target of privateTargets.values()) {
      try {
        const res = await fetch(`${target.workerUrl}/api/register/${target.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${feedbackAuthorKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, accessHash, salt: accessSalt }),
        });
        if (!res.ok) throw new Error('Registration rejected');
        privateAccessUpdated = true;
      } catch {
        throw new Error('Could not protect the feedback URL with the feedback worker. Private publication was aborted before deployment; restore worker access and retry.');
      }
    }
  }

  const destPath = join(siteDir, filename);

  // Update manifest
  const existingIndex = manifest.files.findIndex((f) => f.name === filename);
  const entry = {
    name: filename,
    date: new Date().toISOString(),
    size: fileSizeBytes,
    encrypted: isEncrypted,
    noindex: Boolean(options.noindex),
    feedback: Boolean(options.feedback),
    docId: docId || (!options.newDoc ? priorEntry?.docId : undefined),
    workerUrl: feedbackWorkerUrl || priorEntry?.workerUrl,
    historyId: history.id,
    historyVersion: history.version,
  };

  if (existingIndex >= 0) {
    manifest.files[existingIndex] = entry;
  } else {
    manifest.files.push(entry);
  }

  // Regenerate gallery — stored as _gallery.html to avoid overwriting user's index.html
  // Surge serves index.html at root by default, so if user has no index.html,
  // we symlink/copy _gallery.html as index.html
  const galleryHtml = generateGallery(manifest.files, config);

  // Only use gallery as index.html if user hasn't pushed their own index.html
  const userHasIndex = manifest.files.some((f) => f.name === 'index.html');

  // Deploy to surge
  const domain = `${config.subdomain}.surge.sh`;
  const surgeCmd = getSurgeCommand();
  // Surge publishes the entire staging directory. Roll back every changed
  // staging file on failure so a later push cannot accidentally publish this
  // failed attempt with an unrelated document's successful deployment.
  ensureSiteDir();
  const stagedPaths = new Set([destPath, join(siteDir, '_gallery.html'), ...(!userHasIndex ? [join(siteDir, 'index.html')] : [])]);
  const previousStaging = [...stagedPaths].map((path) => ({ path, content: existsSync(path) ? readFileSync(path) : null }));
  try {
    writeFileSync(destPath, content, 'utf-8');
    console.log(`Added ${filename} to site directory.`);
    writeFileSync(join(siteDir, '_gallery.html'), galleryHtml, 'utf-8');
    if (!userHasIndex) writeFileSync(join(siteDir, 'index.html'), galleryHtml, 'utf-8');
    console.log('Regenerated gallery.');
    console.log(`\nDeploying to ${domain}...`);
    const [cmd, ...pre] = surgeCmd.split(' ');
    execFileSync(cmd, [...pre, siteDir, '--domain', domain], { stdio: 'inherit' });
  } catch {
    for (const previous of previousStaging) {
      if (previous.content !== null) writeFileSync(previous.path, previous.content);
      else if (existsSync(previous.path)) unlinkSync(previous.path);
    }
    throw new Error(
      'Surge deploy failed. Make sure you are logged in (run `htmldrop init`).' +
      (privateAccessUpdated ? ' Private review access was updated before deployment; retry this same push to synchronize it. Local staging/history unchanged.' : '')
    );
  }

  // Only successful deployments become durable local history revisions.
  saveHistory(history);
  saveManifest(manifest);

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

  // Public feedback registration follows deployment. Private access was already
  // registered above so any failure could prevent the deployment.
  if (!isEncrypted && docId && feedbackAuthorKey && feedbackWorkerUrl) {
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
    console.log(passwordNotice({ url, password, source: passwordSource }));
  }

  // Open in browser if --open flag
  if (options.open) {
    await open(url);
    console.log('Opened in browser.');
  }

  return url;
}
