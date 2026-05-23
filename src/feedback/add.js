import { basename } from 'node:path';
import { loadManifest } from '../manifest.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

export async function feedbackAdd(file, options = {}) {
  // Accept absolute path, relative path, or bare name — match how push stores it (basename).
  const name = basename(file);
  const manifest = loadManifest();
  const entry = manifest.files.find((f) => f.name === name);

  if (!entry) {
    throw new Error(`File "${file}" not found in published files. Run \`htmldrop list\` to see files.`);
  }
  if (!entry.feedback || !entry.docId) {
    throw new Error(`File "${file}" does not have feedback enabled. Push with --feedback flag.`);
  }
  if (!options.text || !options.text.trim()) {
    throw new Error('Comment text is required. Use --text "your comment".');
  }

  const workerUrl = options.workerUrl || DEFAULT_WORKER_URL;
  const displayName = options.name || 'AI Agent';

  // Anchored to specific text (--on) or page-level (default)
  const anchor = options.on
    ? { type: 'text_range', selectedText: options.on.slice(0, 2000) }
    : { type: 'page_level' };

  const body = {
    anchor,
    content: { type: 'text', text: options.text.trim() },
    author: { displayName },
    parentId: options.parentId || null,
  };

  const res = await fetch(`${workerUrl}/api/feedback/${entry.docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to add comment (${res.status})`);
  }

  const data = await res.json();
  console.log(`Comment added to ${file} by "${displayName}".`);
  if (options.on) {
    console.log(`  Anchored to: "${options.on.slice(0, 60)}"`);
  }
  console.log(`  Comment ID: ${data.id}`);
  return data;
}
