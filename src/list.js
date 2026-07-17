import { getAuthorKey } from './auth.js';
import { requireConfig, getFileUrl } from './config.js';
import { loadManifest } from './manifest.js';

const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';
const FEEDBACK_TIMEOUT_MS = 2500;

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(isoString, now = Date.now()) {
  const timestamp = new Date(isoString).getTime();
  const nowTimestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowTimestamp)) return 'unknown';

  const deltaSeconds = (timestamp - nowTimestamp) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  if (absoluteSeconds < 45) return 'just now';

  const units = [
    ['year', 365 * 24 * 60 * 60],
    ['month', 30 * 24 * 60 * 60],
    ['day', 24 * 60 * 60],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];
  const [unit, seconds] = units.find(([, unitSeconds]) => absoluteSeconds >= unitSeconds);
  const amount = Math.max(1, Math.round(absoluteSeconds / seconds));
  const label = `${unit}${amount === 1 ? '' : 's'}`;
  return deltaSeconds < 0 ? `${amount} ${label} ago` : `in ${amount} ${label}`;
}

export async function fetchFeedbackMetrics(files, options = {}) {
  const authorKey = options.authorKey;
  if (!authorKey) return new Map();

  const workerUrl = (
    options.workerUrl || process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL
  ).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || FEEDBACK_TIMEOUT_MS;
  const feedbackFiles = files.filter((file) => file.feedback && file.docId);

  const metrics = await Promise.all(
    feedbackFiles.map(async (file) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(
          `${workerUrl}/api/feedback/${encodeURIComponent(file.docId)}`,
          {
            headers: { 'Authorization': `Bearer ${authorKey}` },
            signal: controller.signal,
          }
        );
        if (!response.ok) return null;

        const data = await response.json();
        const items = Array.isArray(data.items) ? data.items : [];
        const parsedCount = Number(data.count);
        const count = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : items.length;
        const lastCommentAt = items.reduce((latest, item) => {
          const timestamp = new Date(item?.createdAt).getTime();
          if (!Number.isFinite(timestamp)) return latest;
          if (!latest || timestamp > new Date(latest).getTime()) return item.createdAt;
          return latest;
        }, null);

        return [file.docId, { count, lastCommentAt }];
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  return new Map(metrics.filter(Boolean));
}

function formatFeedbackMetric(file, feedbackMetrics) {
  if (!file.feedback || !file.docId) return 'Comments: off';

  const metric = feedbackMetrics.get(file.docId);
  if (!metric) return 'Comments: —';
  if (!metric.lastCommentAt) return `Comments: ${metric.count} • no comments yet`;

  return `Comments: ${metric.count} • last ${formatRelativeTime(metric.lastCommentAt)} (${formatDate(metric.lastCommentAt)})`;
}

export async function list() {
  const config = requireConfig();
  const manifest = loadManifest();

  if (manifest.files.length === 0) {
    console.log('No files published yet. Run `htmldrop push <file.html>` to publish one.');
    return;
  }

  let authorKey;
  try {
    authorKey = getAuthorKey();
  } catch {
    // Listing files should still work when auth has not been set up yet.
  }
  const feedbackMetrics = await fetchFeedbackMetrics(manifest.files, { authorKey });

  console.log(`\nPublished files (${config.subdomain}.surge.sh):\n`);
  console.log('─'.repeat(70));

  for (const file of manifest.files) {
    const lock = file.encrypted ? ' [locked]' : '';
    const url = getFileUrl(config, file.name);
    const size = formatFileSize(file.size);
    const date = formatDate(file.date);
    const relativeDate = formatRelativeTime(file.date);

    console.log(`  ${file.name}${lock}`);
    console.log(`    ${url}`);
    console.log(`    Pushed ${relativeDate} (${date})  •  ${size}`);
    console.log(`    ${formatFeedbackMetric(file, feedbackMetrics)}`);
    console.log('');
  }

  console.log('─'.repeat(70));
  console.log(`  Gallery: https://${config.subdomain}.surge.sh/`);
  console.log(`  Total files: ${manifest.files.length}`);
  console.log('');
}
