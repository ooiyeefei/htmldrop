import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.htmldrop');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const SITE_DIR = join(CONFIG_DIR, 'site');

export function getConfigDir() {
  return CONFIG_DIR;
}

export function getSiteDir() {
  return SITE_DIR;
}

export function getConfigFile() {
  return CONFIG_FILE;
}

export function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function ensureSiteDir() {
  ensureConfigDir();
  if (!existsSync(SITE_DIR)) {
    mkdirSync(SITE_DIR, { recursive: true });
  }
}

export function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function requireConfig() {
  const config = readConfig();
  if (!config || !config.subdomain) {
    throw new Error(
      'htmldrop is not configured. Run `htmldrop init` first.'
    );
  }
  return config;
}

export function getFileUrl(config, filename) {
  return `https://${config.subdomain}.surge.sh/${filename}`;
}
