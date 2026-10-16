import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const id = z.string().uuid();
const base = { baseRevisionId: id, baseSourceHash: z.string().regex(/^[a-f0-9]{64}$/) };
const candidate = {
  ...base, title: z.string().min(1).max(500), scene: z.record(z.string(), z.unknown()),
  svg: z.string().max(4 * 1024 * 1024).optional(), summary: z.string().max(4000).optional(),
};

// The transport owns identity and authority. Neither is a tool argument.
export function createMcpServer({ request, key, role = 'reviewer', version = '1.0.0' }) {
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error('Invalid registered artifact key');
  if (!['owner', 'reviewer'].includes(role)) throw new Error('Role must be owner or reviewer');
  const server = new McpServer({ name: 'htmldrop', version }, { maxToolInputElements: 100000 });
  const root = `/api/edit/${key}/diagrams`;
  const path = diagramId => `${root}/${encodeURIComponent(diagramId)}`;
  const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const tool = (name, description, schema, fn, readOnly = false) => server.registerTool(name, {
    description, inputSchema: z.object(schema).strict(),
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
  }, async args => {
    try { return output(await fn(args)); }
    catch (error) {
      return { ...output({ error: { message: error.message, statusCode: error.statusCode || 500, ...(error.details ? { details: error.details } : {}) } }), isError: true };
    }
  });
  tool('diagram_list', 'List diagrams in the bound HTML artifact.', {}, () => request('GET', root), true);
  tool('diagram_read', 'Read a diagram, its native scene, proposals and revisions.', { diagramId: id }, a => request('GET', path(a.diagramId)), true);
  tool('diagram_history', 'Read diagram revisions and proposals. Reviewers see only the current accepted revision and proposals based on it; owners can read private history.', { diagramId: id }, async a => {
    const data = await request('GET', path(a.diagramId));
    return { diagramId: a.diagramId, revisionId: data.revisionId, sourceHash: data.sourceHash, revisions: data.revisions, proposals: data.proposals };
  }, true);
  tool('diagram_propose', 'Propose a scene against the current revision without changing accepted HTML. SVG is optional.', { diagramId: id, ...candidate }, ({ diagramId, ...body }) => request('POST', `${path(diagramId)}/proposals`, body));
  tool('diagram_comments', 'Read shape-anchored comments for a diagram.', { diagramId: id }, a => request('GET', `${path(a.diagramId)}/comments`), true);
  tool('diagram_comment', 'Add a comment to a stable shape in the current revision.', {
    diagramId: id, ...base, shapeId: z.string().min(1).max(200), text: z.string().min(1).max(10000), authorName: z.string().min(1).max(100).optional(),
  }, ({ diagramId, ...body }) => request('POST', `${path(diagramId)}/comments`, body));
  tool('diagram_export', 'Export a precise accepted revision as native JSON or its stored SVG preview. Returns content without writing a file.', {
    diagramId: id, format: z.enum(['excalidraw', 'svg']), revisionId: id.optional(),
  }, a => request('GET', `${path(a.diagramId)}/export?${new URLSearchParams({ format: a.format, ...(a.revisionId ? { revisionId: a.revisionId } : {}) })}`), true);
  if (role === 'owner') {
    tool('diagram_create', 'Create an accepted diagram. Supply a fresh safe SVG rendered from the scene.', {
      baseSourceHash: base.baseSourceHash, title: candidate.title, scene: candidate.scene, svg: z.string().min(1).max(4 * 1024 * 1024), summary: candidate.summary,
    }, body => request('POST', root, body));
    tool('diagram_save', 'Save an accepted scene. Supply a fresh safe SVG rendered from the scene; stale revisions are refused.', {
      diagramId: id, ...candidate, svg: z.string().min(1).max(4 * 1024 * 1024),
    }, ({ diagramId, ...body }) => request('POST', `${path(diagramId)}/save`, body));
    tool('diagram_accept', 'Accept a proposal using its stored scene and a freshly rendered safe SVG.', {
      diagramId: id, proposalId: id, ...base, svg: z.string().min(1).max(4 * 1024 * 1024), summary: candidate.summary,
    }, ({ diagramId, proposalId, ...body }) => request('POST', `${path(diagramId)}/proposals/${proposalId}/accept`, body));
    tool('diagram_reject', 'Reject a pending proposal against the current revision.', {
      diagramId: id, proposalId: id, ...base,
    }, ({ diagramId, proposalId, ...body }) => request('POST', `${path(diagramId)}/proposals/${proposalId}/reject`, body));
  }
  const uri = `htmldrop://artifact/${key}/diagrams`;
  server.registerResource('diagrams', uri, { mimeType: 'application/json', description: 'Diagrams in the explicitly bound HTML artifact' }, async resourceUri => ({
    contents: [{ uri: resourceUri.href, mimeType: 'application/json', text: JSON.stringify(await request('GET', root)) }],
  }));
  server.registerResource('diagram-revisions', `${uri}/revisions`, { mimeType: 'application/json', description: 'Accepted revisions and proposals in the bound artifact' }, async resourceUri => {
    const data = await request('GET', root);
    const diagrams = await Promise.all(data.diagrams.map(async item => {
      const d = await request('GET', path(item.diagramId));
      return { diagramId: d.diagramId, revisionId: d.revisionId, revisions: d.revisions, proposals: d.proposals };
    }));
    return { contents: [{ uri: resourceUri.href, mimeType: 'application/json', text: JSON.stringify({ diagrams }) }] };
  });
  return server;
}
