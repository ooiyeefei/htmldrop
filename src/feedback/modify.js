import { extractDocId, resolveAccessHeaders } from './read.js';
import { getEditToken, forgetEditToken } from './tokens.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

// Edit or delete one comment this machine posted with `feedback add`. The saved
// edit token proves authorship; comments posted before tokens were saved (or
// from another machine) can only be removed by the document owner.
async function prepare(commentId, options) {
  const saved = getEditToken(commentId);
  if (!saved) {
    throw new Error(`No edit token saved for comment ${commentId}. Only comments posted from this machine with htmldrop 1.15+ can be edited or deleted here; ask the document owner otherwise.`);
  }
  const docId = options.docId ? extractDocId(options.docId) : saved.docId;
  const workerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL;
  const accessHeaders = await resolveAccessHeaders(workerUrl, docId, options);
  return {
    url: `${workerUrl}/api/feedback/${encodeURIComponent(docId)}/${encodeURIComponent(commentId)}`,
    headers: { ...accessHeaders, 'X-HTMLDrop-Edit-Token': saved.token },
  };
}

async function fail(res, verb) {
  const err = await res.json().catch(() => ({}));
  throw new Error(err.error || `Failed to ${verb} comment (${res.status})`);
}

export async function feedbackEdit(commentId, options = {}) {
  if (!options.text || !options.text.trim()) {
    throw new Error('New text is required. Use --text "your comment".');
  }
  const { url, headers } = await prepare(commentId, options);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ content: { type: 'text', text: options.text.trim() } }),
  });
  if (!res.ok) await fail(res, 'edit');
  console.log(`Comment ${commentId} edited.`);
  return res.json();
}

export async function feedbackDeleteOne(commentId, options = {}) {
  const { url, headers } = await prepare(commentId, options);
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok) await fail(res, 'delete');
  forgetEditToken(commentId);
  const data = await res.json();
  console.log(`Comment ${commentId} deleted${data.removed > 1 ? ` (with ${data.removed - 1} repl${data.removed === 2 ? 'y' : 'ies'})` : ''}.`);
  return data;
}
