import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir, ensureConfigDir } from './config.js';

function getManifestPath() {
  return join(getConfigDir(), 'manifest.json');
}

export function loadManifest() {
  const manifestPath = getManifestPath();
  if (!existsSync(manifestPath)) {
    return { files: [] };
  }
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { files: [] };
  }
}

export function saveManifest(manifest) {
  ensureConfigDir();
  const manifestPath = getManifestPath();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}
