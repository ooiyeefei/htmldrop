import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'gallery.html');
const DEFAULT_WORKER_URL = 'https://htmldrop-feedback.htmldrop.workers.dev';

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function formatRelativeTime(isoString, now = Date.now()) {
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

function generateFileCards(files) {
  return files
    .map((file) => {
      const isPrivate = file.encrypted;
      const hasFeedback = file.feedback && file.docId;
      const badge = isPrivate
        ? '<span class="badge badge-private">Private</span>'
        : '<span class="badge badge-public">Public</span>';
      const size = formatFileSize(file.size);
      const date = formatDate(file.date);
      const relativeDate = formatRelativeTime(file.date);
      const docIdAttribute = hasFeedback ? ` data-doc-id="${escHtml(file.docId)}"` : '';
      const feedbackLabel = !hasFeedback
        ? 'Comments off'
        : isPrivate
          ? 'Comments private'
          : 'Comments —';

      return `
      <article class="card"${docIdAttribute} data-private="${isPrivate ? 'true' : 'false'}">
        <input class="card-select" type="checkbox" value="${escHtml(file.name)}" aria-label="Select ${escHtml(file.name)} for deletion">
        <a href="${escHtml(encodeURIComponent(file.name))}" class="card-link">
          <div class="card-header">
            <span class="card-title">${escHtml(file.name)}</span>
            ${badge}
          </div>
          <div class="card-meta">
            <span class="card-date" data-relative-time="${escHtml(file.date)}" title="Pushed ${escHtml(date)}">Pushed ${relativeDate}</span>
            <span class="card-size">${size}</span>
            <span class="card-comments" data-feedback-metric>${feedbackLabel}</span>
          </div>
        </a>
      </article>`;
    })
    .join('\n');
}

export function generateGallery(files, config) {
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  // Exclude the gallery itself from the file list
  const userFiles = files.filter((f) => f.name !== '_gallery.html');
  const cards = generateFileCards(userFiles);
  const fileCount = userFiles.length;
  const lastUpdated = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const workerUrl = (
    process.env.HTMLDROP_WORKER_URL || DEFAULT_WORKER_URL
  ).replace(/\/+$/, '');

  const emptyDisplay = fileCount === 0 ? 'block' : 'none';
  const toolbarDisplay = fileCount === 0 ? 'none' : 'flex';

  return template
    .replaceAll('{{SUBDOMAIN}}', escHtml(config.subdomain))
    .replaceAll('{{FILE_CARDS}}', cards)
    .replaceAll('{{FILE_COUNT}}', String(fileCount))
    .replaceAll('{{LAST_UPDATED}}', lastUpdated)
    .replaceAll('{{EMPTY_DISPLAY}}', emptyDisplay)
    .replaceAll('{{TOOLBAR_DISPLAY}}', toolbarDisplay)
    .replaceAll('{{WORKER_URL}}', escHtml(workerUrl));
}
