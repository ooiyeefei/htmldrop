import { realpathSync, readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readServerInfo } from '../edit/discovery.js';
import { listSessions } from '../edit/store.js';
import { createMcpServer } from './server.js';

export function createLocalRequest({ port, agentToken, role }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof agentToken !== 'string' || agentToken.length < 32) throw new Error('Edit server credentials unavailable; run htmldrop edit start first');
  if (!['owner', 'reviewer'].includes(role)) throw new Error('Role must be owner or reviewer');
  return async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { authorization: `Bearer ${agentToken}`, ...(role === 'reviewer' ? { 'x-htmldrop-reviewer': '1' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    });
    let data;
    try { data = await response.json(); } catch { throw Object.assign(new Error('Malformed response from local edit server'), { statusCode: response.status }); }
    if (!response.ok) throw Object.assign(new Error(data.message || (typeof data.error === 'string' ? data.error : data.error?.message) || `Local edit request failed (${response.status})`), { statusCode: response.status, details: data });
    return data;
  };
}

export async function startMcp({ artifact, role = 'reviewer' }) {
  if (!['owner', 'reviewer'].includes(role)) throw new Error('Role must be owner or reviewer');
  let file;
  try { file = realpathSync(artifact); } catch { throw new Error('Artifact must be an existing registered HTML file; run htmldrop edit start <file> first'); }
  const session = listSessions().find(item => item.file === file && item.status === 'open');
  if (!session || !/\.html?$/i.test(file)) throw new Error('Artifact is not an open registered HTML session; run htmldrop edit start <file> first');
  const info = readServerInfo();
  const request = createLocalRequest({ ...info, role });
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const server = createMcpServer({ request, key: session.key, role, version: pkg.version });
  // Verify the binding and credential before opening the protocol stream.
  await request('GET', `/api/edit/${session.key}/diagrams`);
  await server.connect(new StdioServerTransport());
  return server;
}
