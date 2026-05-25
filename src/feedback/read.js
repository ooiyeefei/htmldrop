const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

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

  // Public read — no auth header, no manifest lookup.
  const res = await fetch(`${workerUrl}/api/feedback/${encodeURIComponent(docId)}`);

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
