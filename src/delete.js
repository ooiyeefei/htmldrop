import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { requireConfig, getSiteDir } from './config.js';
import { loadManifest, saveManifest } from './manifest.js';
import { generateGallery } from './gallery.js';

function getSurgeCommand() {
  try {
    execSync('which surge', { stdio: 'ignore' });
    return 'surge';
  } catch {
    return 'npx surge';
  }
}

export async function deleteFile(filename) {
  const config = requireConfig();
  const siteDir = getSiteDir();
  const manifest = loadManifest();

  const fileIndex = manifest.files.findIndex((f) => f.name === filename);
  if (fileIndex === -1) {
    throw new Error(
      `File "${filename}" not found. Run \`htmldrop list\` to see published files.`
    );
  }

  // Remove from site directory
  const filePath = join(siteDir, filename);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  // Remove from manifest
  manifest.files.splice(fileIndex, 1);
  saveManifest(manifest);

  // Regenerate gallery
  const galleryHtml = generateGallery(manifest.files, config);
  writeFileSync(join(siteDir, '_gallery.html'), galleryHtml, 'utf-8');

  const userHasIndex = manifest.files.some((f) => f.name === 'index.html');
  if (!userHasIndex) {
    writeFileSync(join(siteDir, 'index.html'), galleryHtml, 'utf-8');
  }

  // Redeploy to remove the file from Surge
  const domain = `${config.subdomain}.surge.sh`;
  const surgeCmd = getSurgeCommand();
  console.log(`Removing ${filename} and redeploying...`);

  try {
    const [cmd, ...pre] = surgeCmd.split(' ');
    execFileSync(cmd, [...pre, siteDir, '--domain', domain], { stdio: 'inherit' });
  } catch {
    throw new Error('Surge deploy failed. The file was removed locally but may still be live.');
  }

  console.log(`\nDeleted: ${filename}`);
  console.log(`Remaining files: ${manifest.files.length}`);
}
