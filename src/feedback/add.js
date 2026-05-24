import { basename } from 'node:path';
import { loadManifest } from '../manifest.js';
import { extractDocId } from './read.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

export async function feedbackAdd(file, options = {}) {
  if (!options.text || !options.text.trim()) {
    throw new Error('Comment text is required. Use --text "your comment".');
  }

  const workerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL;
  const displayName = options.name || 'AI Agent';

  // Resolve the target docId: either from an explicit --doc-id (idOrUrl) so a
  // teammate can comment on a doc not in their manifest, or by looking up the
  // file's basename in the local manifest (original behavior).
  let docId;
  let target;
  if (options.docId) {
    docId = extractDocId(options.docId);
    target = docId;
  } else {
    if (!file) {
      throw new Error('Provide a <file> from your published files, or --doc-id <idOrUrl> to comment on any doc.');
    }
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
    docId = entry.docId;
    target = file;
  }

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

  const res = await fetch(`${workerUrl}/api/feedback/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to add comment (${res.status})`);
  }

  const data = await res.json();
  console.log(`Comment added to ${target} by "${displayName}".`);
  if (options.on) {
    console.log(`  Anchored to: "${options.on.slice(0, 60)}"`);
  }
  console.log(`  Comment ID: ${data.id}`);
  return data;
}
