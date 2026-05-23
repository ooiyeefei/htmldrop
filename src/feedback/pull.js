import { basename } from 'node:path';
import { getAuthorKey } from '../auth.js';
import { loadManifest } from '../manifest.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

export async function feedbackPull(file, options = {}) {
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

  const workerUrl = options.workerUrl || DEFAULT_WORKER_URL;
  const authorKey = getAuthorKey();

  const res = await fetch(`${workerUrl}/api/feedback/${entry.docId}`, {
    headers: { 'Authorization': `Bearer ${authorKey}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to pull feedback (${res.status})`);
  }

  const data = await res.json();

  if (options.silent) {
    return data;
  }

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return data;
  }

  if (data.items.length === 0) {
    console.log(`No feedback for ${file} yet.`);
    return data;
  }

  console.log(`\n${data.items.length} feedback item(s) for ${file}:\n`);
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
