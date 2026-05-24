import { basename } from 'node:path';
import { getAuthorKey } from '../auth.js';
import { loadManifest } from '../manifest.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

export async function feedbackClear(file, options = {}) {
  // Accept absolute path, relative path, or bare name — match how push stores it (basename).
  const name = basename(file);
  const manifest = loadManifest();
  const entry = manifest.files.find((f) => f.name === name);

  if (!entry) {
    throw new Error(`File "${file}" not found in published files.`);
  }
  if (!entry.feedback || !entry.docId) {
    throw new Error(`File "${file}" does not have feedback enabled.`);
  }

  const workerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL;
  const authorKey = getAuthorKey();

  const res = await fetch(`${workerUrl}/api/feedback/${entry.docId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${authorKey}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to clear feedback (${res.status})`);
  }

  console.log(`All feedback cleared for ${file}.`);
}
