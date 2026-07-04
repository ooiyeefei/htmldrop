// How client commands (`edit poll`, `edit end`, `edit stop`) find the running
// server. The detached server writes its chosen ephemeral port + pid here on
// listen and removes the file on shutdown; clients read it and health-check.
// Same idea as Lavish's ~/.lavish-axi state, minus the session data (that lives
// per-file in store.js).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.js';
import { ensureEditDir } from './store.js';

function serverFile() {
  return join(getConfigDir(), 'edit', 'server.json');
}

export function readServerInfo() {
  const p = serverFile();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

export function writeServerInfo(info) {
  ensureEditDir();
  writeFileSync(serverFile(), JSON.stringify(info, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

export function removeServerInfo() {
  try { unlinkSync(serverFile()); } catch { /* already gone */ }
}
