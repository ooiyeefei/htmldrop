import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'gallery.html');

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function generateFileCards(files) {
  return files
    .map((file) => {
      const lockIcon = file.encrypted
        ? '<span class="lock-icon" title="Password-protected">&#128274;</span>'
        : '';
      const size = formatFileSize(file.size);
      const date = formatDate(file.date);

      return `
      <a href="${file.name}" class="card">
        <div class="card-header">
          <span class="card-title">${file.name}</span>
          ${lockIcon}
        </div>
        <div class="card-meta">
          <span class="card-date">${date}</span>
          <span class="card-size">${size}</span>
        </div>
      </a>`;
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

  const emptyDisplay = fileCount === 0 ? 'block' : 'none';

  return template
    .replaceAll('{{SUBDOMAIN}}', config.subdomain)
    .replaceAll('{{FILE_CARDS}}', cards)
    .replaceAll('{{FILE_COUNT}}', String(fileCount))
    .replaceAll('{{LAST_UPDATED}}', lastUpdated)
    .replaceAll('{{EMPTY_DISPLAY}}', emptyDisplay);
}
