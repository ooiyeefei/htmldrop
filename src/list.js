import { requireConfig, getFileUrl } from './config.js';
import { loadManifest } from './manifest.js';

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
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function list() {
  const config = requireConfig();
  const manifest = loadManifest();

  if (manifest.files.length === 0) {
    console.log('No files published yet. Run `htmldrop push <file.html>` to publish one.');
    return;
  }

  console.log(`\nPublished files (${config.subdomain}.surge.sh):\n`);
  console.log('─'.repeat(70));

  for (const file of manifest.files) {
    const lock = file.encrypted ? ' [locked]' : '';
    const url = getFileUrl(config, file.name);
    const size = formatFileSize(file.size);
    const date = formatDate(file.date);

    console.log(`  ${file.name}${lock}`);
    console.log(`    ${url}`);
    console.log(`    ${date}  •  ${size}`);
    console.log('');
  }

  console.log('─'.repeat(70));
  console.log(`  Gallery: https://${config.subdomain}.surge.sh/`);
  console.log(`  Total files: ${manifest.files.length}`);
  console.log('');
}
