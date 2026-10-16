// HTTP client + process supervisor shared by the edit-mode CLI commands.
//
// `ensureServerRunning` is the important bit: it makes `edit start` and
// `edit poll` independent invocations that both "just work" — either finds the
// live server or spawns a fresh detached one and waits for it to come up.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readServerInfo, removeServerInfo } from './discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, 'server-runner.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentHeaders(port) {
  const info = readServerInfo();
  if (info?.port !== port || typeof info.agentToken !== 'string' || info.agentToken.length < 32) throw new Error('Edit server credentials are unavailable; restart edit mode');
  return { authorization: `Bearer ${info.agentToken}` };
}

async function isHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: agentHeaders(port), signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = await res.json();
    return body.app === 'htmldrop-edit' && body.authenticated === true;
  } catch {
    return false;
  }
}

// Return the port of a running server, spawning one if needed. The server binds
// an ephemeral port and publishes it via the discovery file once listening, so
// we poll for a healthy fresh entry after spawn.
export async function ensureServerRunning() {
  const existing = readServerInfo();
  if (existing?.port && (await isHealthy(existing.port))) return existing.port;
  if (existing) removeServerInfo(); // stale — the process is gone

  const child = spawn(process.execPath, [RUNNER], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(120);
    const info = readServerInfo();
    if (info?.port && (await isHealthy(info.port))) return info.port;
  }
  throw new Error('edit-mode server did not start within 8s. Try `htmldrop edit stop` then retry.');
}

export function runningPort() {
  const info = readServerInfo();
  return info?.port || null;
}

export async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: agentHeaders(port) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export async function postJson(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { ...agentHeaders(port), 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

// Long-poll the agent feedback stream. The server keeps the connection open
// (whitespace heartbeats) until a batch is ready or the session ends, then ends
// with a single JSON object — recover it by trimming the leading heartbeats.
export async function pollFeedback(port, absFile) {
  const res = await fetch(`http://127.0.0.1:${port}/api/poll?file=${encodeURIComponent(absFile)}`, { headers: agentHeaders(port) });
  const text = await res.text();
  if (!res.ok) throw new Error(`poll failed (${res.status})`);
  try { return JSON.parse(text.trim() || '{}'); }
  catch { return { status: 'error', error: 'malformed poll response' }; }
}

export async function deleteJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE', headers: { ...agentHeaders(port), 'content-type': 'application/json' }, body: '{}',
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data;
}
