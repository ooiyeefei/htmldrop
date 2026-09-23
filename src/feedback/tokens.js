import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir, ensureConfigDir } from '../config.js';

// Edit tokens for comments posted from this machine. The worker stores only a
// SHA-256 of each token, so this file is the only way to edit or delete a
// comment later. Kept owner-readable only, keyed by comment id.
const TOKENS_FILE = () => join(getConfigDir(), 'feedback-tokens.json');

function load() {
  const file = TOKENS_FILE();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function newEditToken() {
  return randomUUID();
}

export function saveEditToken(commentId, docId, token) {
  ensureConfigDir();
  const tokens = load();
  tokens[commentId] = { docId, token, savedAt: new Date().toISOString() };
  const file = TOKENS_FILE();
  writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function getEditToken(commentId) {
  return load()[commentId] || null;
}

export function forgetEditToken(commentId) {
  const tokens = load();
  if (!tokens[commentId]) return;
  delete tokens[commentId];
  writeFileSync(TOKENS_FILE(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
