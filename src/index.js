import open from 'open';
import { requireConfig, getFileUrl } from './config.js';
import { loadManifest } from './manifest.js';

export { init } from './init.js';
export { push } from './push.js';
export { list } from './list.js';
export { generateGallery } from './gallery.js';
export { encryptHtml } from './encrypt.js';
export { readConfig, writeConfig, requireConfig, getFileUrl } from './config.js';

export async function openFile(filename) {
  const config = requireConfig();
  const manifest = loadManifest();

  const file = manifest.files.find((f) => f.name === filename);
  if (!file) {
    throw new Error(
      `File "${filename}" not found in published files. Run \`htmldrop list\` to see available files.`
    );
  }

  const url = getFileUrl(config, filename);
  console.log(`Opening: ${url}`);
  await open(url);
}
