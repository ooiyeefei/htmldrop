import { readConfig, writeConfig } from './config.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

const IDENTITY_WARNING = `SECURITY WARNING: this shared identity contains the htmldrop author key.
Anyone who imports it has full co-owner power for EVERY doc published under this identity, including updating links and deleting feedback.
Use a DEDICATED team account only (fresh \`htmldrop init\` + \`htmldrop auth setup\` for the team). Never export or import a personal identity.`;

function encodeToken(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeToken(blob) {
  if (!blob || typeof blob !== 'string') {
    throw new Error('A team-identity token is required.');
  }

  const token = blob.trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token)) {
    throw new Error('Invalid team-identity token: expected base64url JSON.');
  }

  let payload;
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    throw new Error('Invalid team-identity token: could not decode JSON.');
  }

  if (!payload || payload.v !== 1) {
    throw new Error('Invalid team-identity token: unsupported version.');
  }
  if (typeof payload.subdomain !== 'string' || payload.subdomain.length === 0) {
    throw new Error('Invalid team-identity token: missing subdomain.');
  }
  if (typeof payload.authorKey !== 'string' || payload.authorKey.length === 0) {
    throw new Error('Invalid team-identity token: missing authorKey.');
  }
  if (payload.workerUrl !== undefined && typeof payload.workerUrl !== 'string') {
    throw new Error('Invalid team-identity token: workerUrl must be a string.');
  }

  return payload;
}

function printWarning() {
  console.warn(IDENTITY_WARNING);
}

export async function identityExport(options = {}) {
  const config = readConfig();
  const missing = [];
  if (!config?.subdomain) missing.push('subdomain (run `htmldrop init`)');
  if (!config?.authorKey) missing.push('authorKey (run `htmldrop auth setup`)');
  if (missing.length) {
    throw new Error(`Cannot export identity: missing ${missing.join(' and ')}.`);
  }

  const token = encodeToken({
    v: 1,
    subdomain: config.subdomain,
    authorKey: config.authorKey,
    workerUrl: config.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL,
  });

  printWarning();
  if (options.json) {
    console.log(JSON.stringify({ token }, null, 2));
  } else {
    console.log('\nTeam identity token:');
    console.log(token);
  }

  return token;
}

export async function identityImport(blob, options = {}) {
  const incoming = decodeToken(blob);
  const config = readConfig() || {};

  const conflicts = [];
  if (config.subdomain && config.subdomain !== incoming.subdomain) {
    conflicts.push(`subdomain (${config.subdomain} -> ${incoming.subdomain})`);
  }
  if (config.authorKey && config.authorKey !== incoming.authorKey) {
    conflicts.push('author key');
  }

  if (conflicts.length && !options.force) {
    throw new Error(`Refusing to overwrite an existing different identity (${conflicts.join(', ')}). Re-run with --force to replace it.`);
  }
  if (conflicts.length) {
    console.warn(`Warning: replacing previous htmldrop identity (${conflicts.join(', ')}).`);
  }

  const next = {
    ...config,
    subdomain: incoming.subdomain,
    authorKey: incoming.authorKey,
  };
  if (incoming.workerUrl !== undefined) {
    next.workerUrl = incoming.workerUrl;
  }

  writeConfig(next);

  printWarning();
  console.log(`Imported shared team identity for ${incoming.subdomain}.`);
  return next;
}
