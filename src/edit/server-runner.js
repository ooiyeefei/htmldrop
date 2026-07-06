// Entry point for the detached edit-mode server process.
//
// `htmldrop edit start` spawns this with { detached: true, stdio: 'ignore' } and
// unrefs it, so the CLI returns immediately while the server lives on in the
// background. It publishes its port for client commands and cleans up on exit.

import { startServer } from './server.js';
import { writeServerInfo, removeServerInfo } from './discovery.js';

const idleMs = process.env.HTMLDROP_EDIT_IDLE_MS
  ? Number(process.env.HTMLDROP_EDIT_IDLE_MS)
  : 30 * 60 * 1000;

// Prefer a STABLE default port so an already-open browser tab keeps working
// across server restarts (an ephemeral port would move and strand the tab on a
// dead address). Override with HTMLDROP_EDIT_PORT; fall back to an ephemeral
// port only if the stable one is already taken.
const STABLE_PORT = Number(process.env.HTMLDROP_EDIT_PORT) || 7391;
const timeout = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : null;

let srv;
try {
  srv = await startServer({ port: STABLE_PORT, idleTimeoutMs: timeout });
} catch (e) {
  // EADDRINUSE (or any bind error on the stable port) → take any free port.
  srv = await startServer({ port: 0, idleTimeoutMs: timeout });
}
writeServerInfo({ port: srv.port, pid: process.pid, startedAt: Date.now() });

// The server resolves `done` when it shuts down (idle timeout or explicit
// /shutdown). Clean up the discovery file so stale info never misleads a client.
srv.done.then(() => { removeServerInfo(); process.exit(0); });

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { removeServerInfo(); process.exit(0); });
}
