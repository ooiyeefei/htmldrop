import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { requireConfig, getSiteDir } from './config.js';
import { loadManifest, saveManifest } from './manifest.js';
import { generateGallery } from './gallery.js';
import { pickFiles } from './pick.js';

function getSurgeCommand() {
  try {
    execSync('which surge', { stdio: 'ignore' });
    return 'surge';
  } catch {
    return 'npx --yes surge@0.27.4';
  }
}

export function resolveDeletePlan(filenames, manifest) {
  const requested = [...new Set(filenames)];
  const published = new Set(manifest.files.map((file) => file.name));

  return {
    found: requested.filter((filename) => published.has(filename)),
    notFound: requested.filter((filename) => !published.has(filename)),
  };
}

export function applyDeletePlan(plan, { config, siteDir, manifest }) {
  const deleted = new Set(plan.found);

  for (const filename of plan.found) {
    const filePath = join(siteDir, filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  manifest.files = manifest.files.filter((file) => !deleted.has(file.name));
  saveManifest(manifest);

  const galleryHtml = generateGallery(manifest.files, config);
  writeFileSync(join(siteDir, '_gallery.html'), galleryHtml, 'utf-8');

  const userHasIndex = manifest.files.some((file) => file.name === 'index.html');
  if (!userHasIndex) {
    writeFileSync(join(siteDir, 'index.html'), galleryHtml, 'utf-8');
  }

  return manifest.files.length;
}

function redeploySite(siteDir, config) {
  const domain = `${config.subdomain}.surge.sh`;
  const surgeCmd = getSurgeCommand();
  console.log(`Removing files and redeploying to ${domain}...`);

  try {
    const [cmd, ...pre] = surgeCmd.split(' ');
    execFileSync(cmd, [...pre, siteDir, '--domain', domain], { stdio: 'inherit' });
  } catch {
    throw new Error(
      'Surge deploy failed. The files were removed locally but may still be live.'
    );
  }
}

function printList(label, filenames) {
  console.log(`${label} (${filenames.length}):`);
  for (const filename of filenames) {
    console.log(`  - ${filename}`);
  }
}

async function confirmDeletion(input, output) {
  if (!input.isTTY) {
    throw new Error(
      'Confirmation requires an interactive terminal. Pass --yes to delete non-interactively.'
    );
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = await new Promise((resolve) => {
      rl.question('Continue? (y/N) ', resolve);
    });
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function pickerItems(manifest) {
  // Generated index.html is not recorded in the manifest. An index entry here
  // is therefore a user-published file and must remain selectable.
  return manifest.files
    .filter((file) => file.name !== '_gallery.html')
    .map((file) => file.name);
}

export async function deleteFiles(filenames = [], options = {}) {
  const config = requireConfig();
  const siteDir = getSiteDir();
  const manifest = loadManifest();
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  let requested = filenames;

  if (options.pick || requested.length === 0) {
    requested = await pickFiles(pickerItems(manifest), {
      label: 'Select files to delete',
      input,
      output,
    });

    if (requested === null) {
      console.log('Delete cancelled.');
      return { deleted: [], skipped: [], remaining: manifest.files.length, cancelled: true };
    }
    if (requested.length === 0) {
      console.log('No files selected.');
      return { deleted: [], skipped: [], remaining: manifest.files.length, cancelled: true };
    }
  }

  const plan = resolveDeletePlan(requested, manifest);
  if (plan.notFound.length > 0) {
    printList('Skipped (not found)', plan.notFound);
  }
  if (plan.found.length === 0) {
    throw new Error(
      'None of the requested files were found. Run `htmldrop list` to see published files.'
    );
  }

  printList('Files to delete', plan.found);
  if (!options.yes && !await confirmDeletion(input, output)) {
    console.log('Delete cancelled.');
    return {
      deleted: [],
      skipped: plan.notFound,
      remaining: manifest.files.length,
      cancelled: true,
    };
  }

  const remaining = applyDeletePlan(plan, { config, siteDir, manifest });
  const redeploy = options.redeploy || redeploySite;
  await redeploy(siteDir, config);

  console.log('');
  printList('Deleted', plan.found);
  if (plan.notFound.length > 0) {
    printList('Skipped (not found)', plan.notFound);
  }
  console.log(`Remaining files: ${remaining}`);

  return {
    deleted: plan.found,
    skipped: plan.notFound,
    remaining,
    cancelled: false,
  };
}

export async function deleteFile(filename) {
  return deleteFiles([filename]);
}
