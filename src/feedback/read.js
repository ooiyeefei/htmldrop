import { deriveAccessToken } from '../encrypt.js';
import { resolvePassword } from '../prompt.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

// Probe whether a doc is password-gated and, if so, derive the feedback access
// token from the password (+ the doc's public salt) so the Worker authorizes
// the read/post. Returns request headers: `{ 'X-HTMLDrop-Access': token }` for a
// gated doc, or `{}` for an open doc / an old worker without /api/access.
//
// The salt is not secret (it's also in the public envelope); storing it on the
// Worker lets the CLI derive the token without fetching the Surge gate page.
export async function resolveAccessHeaders(workerUrl, docId, options = {}) {
  let access;
  try {
    const res = await fetch(`${workerUrl}/api/access/${encodeURIComponent(docId)}`);
    if (res.status === 404) return {}; // old worker / unknown doc -> behave as today
    if (!res.ok) return {};
    access = await res.json();
  } catch {
    return {}; // network/parse issue -> fall through to public behavior
  }

  if (!access || access.scheme !== 'v2-capability' || !access.salt) {
    return {}; // open doc (or unrecognized) -> no token
  }

  const password = await resolvePassword(options.password);
  if (!password) {
    throw new Error('This doc is password-protected — pass --password (or set $HTMLDROP_PASSWORD).');
  }
  const token = deriveAccessToken(password, access.salt);
  return { 'X-HTMLDrop-Access': token };
}

// Extract a docId from a bare id or a full URL like
// https://.../doc/<uuid> or https://.../api/feedback/<uuid>
export function extractDocId(docIdOrUrl) {
  if (!docIdOrUrl || typeof docIdOrUrl !== 'string') {
    throw new Error('A docId or URL is required.');
  }
  const arg = docIdOrUrl.trim();
  const match = arg.match(/\/(?:doc|api\/feedback)\/([^/?#]+)/);
  if (match) {
    return match[1];
  }
  return arg;
}

export async function feedbackRead(docIdOrUrl, options = {}) {
  const docId = extractDocId(docIdOrUrl);
  const workerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL;

  // Gated doc -> derive the access token from --password; open doc -> no header
  // (unchanged public behavior).
  const accessHeaders = await resolveAccessHeaders(workerUrl, docId, options);
  const res = await fetch(`${workerUrl}/api/feedback/${encodeURIComponent(docId)}`, { headers: accessHeaders });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to read feedback (${res.status})`);
  }

  const data = await res.json();

  if (options.silent) {
    return data;
  }

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return data;
  }

  if (!data.items || data.items.length === 0) {
    console.log(`No feedback for ${docId} yet.`);
    return data;
  }

  console.log(`\n${data.items.length} feedback item(s) for ${docId}:\n`);
  for (const item of data.items) {
    const anchor = item.anchor?.selectedText
      ? ` [on: "${item.anchor.selectedText.slice(0, 60)}"]`
      : '';
    console.log(`  ${item.author?.displayName || 'Anonymous'}${anchor}`);
    console.log(`    ${item.content?.text || '(no text)'}`);
    console.log(`    ${new Date(item.createdAt).toLocaleString()}\n`);
  }

  return data;
}
