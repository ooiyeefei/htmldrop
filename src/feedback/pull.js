import { basename, resolve, sep } from 'node:path';
import { writeFileSync } from 'node:fs';
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

  // Worker URL: explicit flag > HTMLDROP_WORKER_URL env (self-host) > our shared Worker.
  const workerUrl = options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL;
  const authorKey = getAuthorKey();

  const res = await fetch(`${workerUrl}/api/feedback/${encodeURIComponent(entry.docId)}`, {
    headers: { 'Authorization': `Bearer ${authorKey}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to pull feedback (${res.status})`);
  }

  const data = await res.json();
  const outputData = {
    ...data,
    next_step: data.items?.length
      ? `Address each comment, edit the file, then re-run to confirm none remain unaddressed. To iterate locally with these comments loaded: \`htmldrop edit start ${file} --with-feedback\`.`
      : 'No feedback yet — nothing to address.',
  };

  // --save: write comments into the repo as JSON so they're owned + versioned by the user.
  if (options.save) {
    const outPath = options.out || `${name.replace(/\.html?$/i, '')}.feedback.json`;
    // Confine the output to the current working directory (the --out value is user-supplied).
    const resolved = resolve(process.cwd(), outPath);
    if (resolved !== resolve(process.cwd()) && !resolved.startsWith(resolve(process.cwd()) + sep)) {
      throw new Error('Refusing to write outside the current directory');
    }
    const snapshot = {
      docId: entry.docId,
      file: name,
      pulledAt: new Date().toISOString(),
      count: data.count,
      comments: data.items,
    };
    writeFileSync(resolved, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
    if (!options.silent && !options.json) {
      console.log(`Saved ${data.count} comment(s) to ${outPath} (commit it to keep them in your repo).`);
    }
    if (options.silent) return outputData;
  }

  if (options.silent) {
    return outputData;
  }

  if (options.json) {
    console.log(JSON.stringify(outputData, null, 2));
    return outputData;
  }

  if (data.items.length === 0) {
    console.log(`No feedback for ${file} yet.`);
    return outputData;
  }

  console.log(`\n${data.items.length} feedback item(s) for ${file}:\n`);
  for (const item of data.items) {
    const anchor = item.anchor?.selectedText
      ? ` [on: "${item.anchor.selectedText.slice(0, 60)}"]`
      : item.anchor?.type === 'element_rect'
        ? item.anchor.capturedText
          ? ` [on: area — "${item.anchor.capturedText.slice(0, 60)}"]`
          : item.anchor.selector
            ? ` [on: area → ${item.anchor.selector}]`
            : ' [on: area]'
        : '';
    console.log(`  ${item.author?.displayName || 'Anonymous'}${anchor}`);
    console.log(`    ${item.content?.text || '(no text)'}`);
    console.log(`    ${new Date(item.createdAt).toLocaleString()}\n`);
  }

  return outputData;
}
