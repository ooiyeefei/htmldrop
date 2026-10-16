# Excalidraw milestone 2

Deliver editable Excalidraw diagrams, comments attached to stable shapes, reviewable diagram revisions/proposals, and a local stdio MCP server together. Automatic publication history remains independent of optional feedback. No blog post, simultaneous multiplayer, publicly hosted remote MCP, or arbitrary lossless canvas-to-Mermaid conversion.

## Shared contract (implementation boundary)

Accepted diagrams are authoritative inside the HTML source. Use one `<meta name="htmldrop-document-id" content="UUID">` and managed blocks:

```html
<!-- htmldrop:diagram:DIAGRAM_ID:start -->
<figure data-htmldrop-diagram="DIAGRAM_ID">
  <img alt="Diagram title" src="data:image/svg+xml;base64,...">
  <script type="application/json" data-htmldrop-scene="DIAGRAM_ID">ESCAPED_JSON</script>
</figure>
<!-- htmldrop:diagram:DIAGRAM_ID:end -->
```

Embedded JSON: `{version:1, documentId, diagramId, revisionId, parentRevisionId, title, scene}`. `scene` is native `{type:'excalidraw',version:2,elements,appState,files}`. Escape `<` in JSON. UUID identifiers are server-assigned except stable Excalidraw element IDs. Preserve comments for deleted shapes, visibly marking them removed. Managed scenes and SVG previews survive single-file publication and pull. Full diagram edit history and pending proposals stay in private local profile state; published document history retains earlier published diagram source.

Shared service (browser and MCP call the same HTTP adapter):

- `GET /api/edit/:key/diagrams` -> `{documentId,sourceHash,diagrams:[{diagramId,revisionId,title}],permissions:{create,save,accept,propose}}`.
- `POST /api/edit/:key/diagrams` owner create -> body `{baseSourceHash,title,scene,svg,summary}`; returns read payload.
- `GET /api/edit/:key/diagrams/:diagramId` -> `{documentId,diagramId,revisionId,parentRevisionId,sourceHash,title,scene,svg,proposals,revisions,permissions}`.
- `POST .../:diagramId/save` -> `{baseRevisionId,baseSourceHash,title,scene,svg,summary}`.
- `POST .../:diagramId/proposals` -> same fields but SVG optional. Immutable proposal; no source write.
- `POST .../:diagramId/proposals/:proposalId/accept` -> `{baseRevisionId,baseSourceHash,svg,summary}`; acceptance uses stored candidate scene and its original base, generates new revision. UI regenerates SVG using Excalidraw before accept.
- `POST .../:diagramId/proposals/:proposalId/reject` -> `{baseRevisionId,baseSourceHash}`.
- `GET .../:diagramId/export?format=excalidraw|svg&revisionId=...` -> JSON `{format,content,mimeType,revisionId}`. SVG is the validated stored preview for precisely that revision. Never return stale preview.
- Existing `/api/feedback/:key` threads accept `anchor:{type:'diagram_shape',documentId,diagramId,shapeId,revisionId}`. MCP comment mutation supplies baseRevision/sourceHash and HTTP adapter checks them before inserting via existing store.
- `POST .../:diagramId/comments` -> `{baseRevisionId,baseSourceHash,shapeId,text,authorName}`; validates shape membership and returns created comment. `GET .../:diagramId/comments` returns `{items}` filtered to diagram.

Actor comes from authenticated transport, never body fields. Same-origin local author browser can save; remote gateway reviewer cannot create/save/accept/reject at both gateway and backend. Reviewer can read/propose/export/comment for the current revision. Reviewer projections must omit older local scenes and outdated proposals; noncurrent revision export is owner-only, preventing removed confidential content from leaking through a new share. CLI/stdio agent controls keep their separate local discovery credential. Every mutation checks current diagram revision plus source SHA256 inside a per-file serialized mutation. Stale writes and proposals return409 with actionable conflict state; no silent overwrite. Preserve source around managed block and use temp+rename. Recheck source bytes immediately before rename to detect external edits. API errors carry `statusCode` and safe `message`.

## Module ownership

- `src/diagrams/document.js`, `src/diagrams/service.js` (core lane): parse/validate/serialize accepted document blocks, safe SVG preview, bounded native scenes, atomic serialized source writes, proposal and revision state. Export `createDiagramService({getSession,configDir})`. Returned methods: `list(key,actor)`, `read(key,id,actor)`, `create(key,body,actor)`, `save(key,id,body,actor)`, `propose(key,id,body,actor)`, `accept(key,id,proposalId,body,actor)`, `reject(key,id,proposalId,body,actor)`, `exportDiagram(key,id,{format,revisionId},actor)`, `checkAnchor(key,id,body,actor)` (validates base+shape, returns canonical anchor). `actor` is `'owner'|'reviewer'`. No source writes for read/list/export/comment checks. Parent can add optional nonbreaking exports as needed.
- `src/edit/diagrams.js`, edit/server.js + remote.js, templates/annotation-widget.html + worker mirror and worker/src/schema.ts (HTTP/annotation lane): route shared service, comments validation and highlighting, SSE, gateway permissions.
- `src/edit/browser/`, `src/edit/editor-assets.js`, `scripts/build-editor.mjs` (editor lane): pinned locally built Excalidraw, lazy iframe editor, diagram toolbar in injected edit runtime, selection/comments, revision/proposal controls, JSON/SVG import/export and optional one-way Mermaid import. No CDN or runtime external requests. Dist files `src/edit/editor-dist/` are reproducible build outputs (not committed), included in npm tarball via prepack.
- `src/mcp/`, Commander command in bin/htmldrop.js and test/mcp.test.mjs (MCP lane): SDK1.32.1 + Zod4.6.7 preserves Node>=18. `htmldrop mcp --artifact /abs/file.html --role reviewer|owner` binds an explicitly registered HTML session, default reviewer. No per-tool path/URL/role arguments. Tools/resources expose list/read/create(owner)/save(owner)/propose/accept(owner)/reject(owner)/history/comments/export. Stdout is JSON-RPC only.
- Parent owns package.json/lock, plan/docs/release integration, final review and verification. No concurrent edits to another lane's owned files; coordinate small seams through parent.

## Rendering and limits

Native browser `exportToSvg` is authoritative for graphical rendering. Require fresh SVG on accepted writes; proposals can omit it. MCP exports native scene JSON without a renderer; scene save requires caller-provided safe SVG, with a clear error if absent. The owner acceptance UI regenerates reviewer previews. Embed as SVG data-URL image, never active inline SVG. Reject scripts, event handlers, foreignObject, external URLs, unsafe CSS, invalid XML, ambiguous markers/IDs and unsupported scenes. Raster images are bounded data URLs only; no SVG attachments or web embeds. Enforce finite geometry, unique shape IDs, supported types, per-field/file/scene/HTML byte and element limits. Disabled editor embeds/AI/library links must not cause outbound requests. CSP constrains all editor assets/fonts/network to self/data/blob as needed.

## Acceptance evidence

Execute real browser Excalidraw edits and shape selection/comment/replies, proposal/accept/reject, revision preview/export, stale conflict and remote owner-route denial. Actual SDK Client/StdioClientTransport must discover/call tools and read resources without protocol stdout pollution. Verify scene+SVG single-file publish/pull, encrypted private history, deleted-shape anchors, SVG/JSON injection, source conflicts, asset isolation and lazy/offline browser loading. Run existing Node20/22 regression suites, Worker typecheck/dry build, npm pack/install checks, independent high-reasoning review, PR CI and runtime proof before release. Distinguish built/tested/merged/deployed/registry-available proof. Preserve dirty original main checkout and existing shared daemons.
