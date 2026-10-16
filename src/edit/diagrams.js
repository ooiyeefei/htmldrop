// HTTP adapter shared by the local editor and the stdio MCP client. Authority
// belongs to the transport; JSON fields never select an actor.
export function diagramActor(req) {
  return req.headers['x-htmldrop-reviewer'] === '1' ? 'reviewer' : 'owner';
}

function invalid(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

export function createDiagramRoutes({ service, store, events, readJsonBody, sendJson }) {
  async function checkFeedbackAnchor(key, body, actor) {
    if (body?.anchor?.type !== 'diagram_shape') return body;
    const a = body.anchor;
    const current = await service.list(key, actor);
    const anchor = await service.checkAnchor(key, a.diagramId, {
      shapeId: a.shapeId,
      baseRevisionId: a.revisionId,
      baseSourceHash: body.baseSourceHash ?? current.sourceHash,
    }, actor);
    if (a.documentId !== anchor.documentId || a.diagramId !== anchor.diagramId || a.revisionId !== anchor.revisionId) invalid('Diagram anchor does not match this document');
    return { ...body, anchor };
  }

  async function handle(req, res, url) {
    const match = url.pathname.match(/^\/api\/edit\/([a-f0-9]{16})\/diagrams(?:\/([^/]+))?(?:\/(save|proposals|export|comments))?(?:\/([^/]+)\/(accept|reject))?$/);
    if (!match) return false;
    const [, key, id, operation, proposalId, decision] = match;
    const method = req.method, actor = diagramActor(req);
    // Repeat this guard in the backend even though the gateway only forwards
    // reviewer-safe routes. A reviewer MCP credential is also downgraded here.
    if (actor === 'reviewer' && method === 'POST' && ((!id && !operation) || operation === 'save' || decision)) invalid('Diagram changes require local author authorization', 403);
    let result, status = 200;
    if (method === 'GET' && !id) result = await service.list(key, actor);
    else if (method === 'GET' && !operation) result = await service.read(key, id, actor);
    else if (method === 'GET' && operation === 'export') result = await service.exportDiagram(key, id, {
      format: url.searchParams.get('format') || 'excalidraw', revisionId: url.searchParams.get('revisionId') || undefined,
    }, actor);
    else if (method === 'GET' && operation === 'comments') {
      const diagram = await service.read(key, id, actor);
      const all = store.getComments(key).items;
      const roots = new Set(all.filter(item => item.anchor?.type === 'diagram_shape' && item.anchor.documentId === diagram.documentId && item.anchor.diagramId === id).map(item => item.id));
      result = { items: all.filter(item => roots.has(item.id) || roots.has(item.parentId)) };
    } else if (method === 'POST') {
      const body = await readJsonBody(req, 16 * 1024 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object');
      if (!id) { result = await service.create(key, body, actor); status = 201; }
      else if (operation === 'save' && !proposalId) result = await service.save(key, id, body, actor);
      else if (operation === 'proposals' && !proposalId) { result = await service.propose(key, id, body, actor); status = 201; }
      else if (operation === 'proposals' && decision === 'accept') result = await service.accept(key, id, proposalId, body, actor);
      else if (operation === 'proposals' && decision === 'reject') result = await service.reject(key, id, proposalId, body, actor);
      else if (operation === 'comments' && !proposalId) {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) invalid('Comment text must contain 1 to 10000 characters');
        if (body.authorName !== undefined && (typeof body.authorName !== 'string' || body.authorName.length > 100)) invalid('Author name must be at most 100 characters');
        if (body.editToken !== undefined && (typeof body.editToken !== 'string' || body.editToken.length < 16 || body.editToken.length > 128)) invalid('Invalid comment edit token');
        const anchor = await service.checkAnchor(key, id, body, actor);
        result = store.addComment(key, {
          anchor, content: { type: 'text', text: body.text }, author: { displayName: body.authorName || 'Anonymous' },
          editToken: body.editToken,
          context: actor === 'reviewer' ? { actor: 'reviewer', authority: 'review-only' } : { actor: 'owner' },
        });
        if (!result) invalid('Session not found', 404);
        events.emit('feedback', key);
        if (!store.getHold(key)) events.emit('comment', key);
        status = 201;
      } else { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    } else { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    sendJson(res, status, result);
    return true;
  }
  return { handle, checkFeedbackAnchor };
}
