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
    return 'npx --yes surge@0.27.4';
  }
}

export async function deleteFiles(filenames) {
  const config = requireConfig();
  const siteDir = getSiteDir();
  const manifest = loadManifest();
  const uniqueFilenames = [...new Set(filenames)];
  if (uniqueFilenames.length === 0) {
    throw new Error('At least one file is required.');
  }

  const missingFile = uniqueFilenames.find(
    (filename) => !manifest.files.some((file) => file.name === filename)
  );
  if (missingFile) {
    throw new Error(
      `File "${missingFile}" not found. Run \`htmldrop list\` to see published files.`
    );
  }

  // Validate the full selection before changing anything, then remove every file
  // and deploy once so one invalid name cannot cause a predictable partial batch.
  for (const filename of uniqueFilenames) {
    const filePath = join(siteDir, filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  const selected = new Set(uniqueFilenames);
  manifest.files = manifest.files.filter((file) => !selected.has(file.name));
  saveManifest(manifest);

  // Regenerate gallery
  const galleryHtml = generateGallery(manifest.files, config);
  writeFileSync(join(siteDir, '_gallery.html'), galleryHtml, 'utf-8');

  const userHasIndex = manifest.files.some((f) => f.name === 'index.html');
  if (!userHasIndex) {
    writeFileSync(join(siteDir, 'index.html'), galleryHtml, 'utf-8');
  }

  // Redeploy to remove the files from Surge
  const domain = `${config.subdomain}.surge.sh`;
  const surgeCmd = getSurgeCommand();
  const noun = uniqueFilenames.length === 1 ? 'file was' : 'files were';
  console.log(`Removing ${uniqueFilenames.join(', ')} and redeploying...`);

  try {
    const [cmd, ...pre] = surgeCmd.split(' ');
    execFileSync(cmd, [...pre, siteDir, '--domain', domain], { stdio: 'inherit' });
  } catch {
    throw new Error(`Surge deploy failed. The ${noun} removed locally but may still be live.`);
  }

  console.log(`\nDeleted: ${uniqueFilenames.join(', ')}`);
  console.log(`Remaining files: ${manifest.files.length}`);
}

export async function deleteFile(filename) {
  return deleteFiles([filename]);
}
