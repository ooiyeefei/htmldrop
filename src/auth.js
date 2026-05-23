import { randomBytes } from 'node:crypto';
import { readConfig, writeConfig, ensureConfigDir } from './config.js';

export async function authSetup() {
  ensureConfigDir();
  const config = readConfig() || {};

  if (config.authorKey) {
    console.log('Author key already configured.');
    console.log(`Key: ${config.authorKey.slice(0, 8)}...${config.authorKey.slice(-4)}`);
    console.log('\nTo regenerate, run: htmldrop auth setup --force');
    return config.authorKey;
  }

  const key = randomBytes(32).toString('hex');
  config.authorKey = key;
  writeConfig(config);

  console.log('Author API key generated and saved to ~/.htmldrop/config.json');
  console.log(`Key: ${key.slice(0, 8)}...${key.slice(-4)}`);
  console.log('\nThis key identifies you as the document author when retrieving/deleting feedback.');
  return key;
}

export async function authSetupForce() {
  ensureConfigDir();
  const config = readConfig() || {};

  const key = randomBytes(32).toString('hex');
  config.authorKey = key;
  writeConfig(config);

  console.log('New author API key generated and saved to ~/.htmldrop/config.json');
  console.log(`Key: ${key.slice(0, 8)}...${key.slice(-4)}`);
  return key;
}

export function getAuthorKey() {
  const config = readConfig();
  if (!config || !config.authorKey) {
    throw new Error(
      'No author key found. Run `htmldrop auth setup` first.'
    );
  }
  return config.authorKey;
}
