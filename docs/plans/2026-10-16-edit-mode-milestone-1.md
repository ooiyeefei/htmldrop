# Edit mode milestone 1

Deliver safe local assets and dependency reload, private remote review, a visible layout issue inbox, and automatic document history on every publish. Feedback remains optional. Excalidraw and MCP will ship together in milestone 2.

## Boundaries and behavior

- Open HTML entrypoints, serving only their declared safe HTML/CSS dependencies. Reject traversal, hidden/credential files, undeclared files and symlinks. Live reload follows HTML and declared dependency changes. Publication preflight refuses unsupported local dependencies instead of publishing broken links.
- Retain the loopback author/agent server. Authenticate agent controls using a private discovery credential. A separate expiring per-session reviewer gateway exposes selected review routes behind an exact configured HTTPS origin. One-use bootstrap links create a browser session cookie; revoke disconnects live streams. No remote session enumeration, registration, agent poll/reply, publication, or shutdown.
- Track layout findings by rule, selector and exact viewport. Queueing is not resolution. Only a complete, current render check at the matching viewport verifies a fix. Source/dependency revision changes invalidate earlier measurements. Ignore reasons are scoped to a render revision.
- Every publish retains document history and injects a history viewer independently of feedback. Unchanged source deduplicates. View prior versions and readable-text additions/deletions; preview runs no scripts or external resources. Private revisions remain encrypted under their original passwords. Pull preserves history identity and records; failed deploys restore local staging and do not advance history.

## Milestone 2 contract

Use stable document, diagram, shape and revision IDs. The browser Excalidraw editor and MCP tools will share scene read/propose/save/export operations and comment threads. Reviewer suggestions and owner-accepted revisions remain distinct. Changes must carry a base revision and reject stale writes. Do not claim arbitrary lossless canvas-to-Mermaid conversion. Simultaneous multiplayer and publicly hosted remote MCP are separate work.

## Delivery and verification

Implementation uses medium-reasoning agents for bounded assets/UI work and higher reasoning for the security boundary and versioning. Independent high-reasoning review and browser UAT exercise actual file reads, authentication, private review/comment/poll/reply/reload, layout lifecycle, and history/privacy/source roundtrips. Project state and fixtures stay inside the repository. Preserve pre-existing dirty main-branch work in its original checkout.

Ship through a feature PR with tests on Node 20/22 and a reviewed npm package. Verify a private HTTPS session using the existing tailnet without replacing other Serve services. Verify registry publication and installed version separately. npm publication needs valid registry authentication; the initial credential check returned HTTP 401 and the user is signing in.
