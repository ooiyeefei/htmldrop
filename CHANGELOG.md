# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Adds **edit mode** — a local, real-time loop to refine a doc *with your AI agent*
before publishing. The asynchronous publish/feedback/converge flow is unchanged.
Not yet on npm; on release this becomes the next minor version.

### Features

- **Edit mode (`htmldrop edit`).** A new command group, fully local and separate
  from the publish flow:
  - `edit start <file>` serves the file on `127.0.0.1` with a conversation panel
    (chat with the agent) beside the existing comment widget, and **live-reloads**
    the page whenever the file changes. `--with-feedback` pulls the published
    doc's reviewer comments into the session to work through with the agent;
    `--no-open` skips the browser.
  - `edit poll <file> --json` is the agent's listen call — it long-polls until you
    send a chat message **or leave a comment on the page**, then returns them with
    the page's comments and any layout warnings as context. `edit reply <file>
    --text …` posts the agent's response back into the conversation.
    `edit layout <file>` reports render problems on demand. `edit end` / `edit
    stop` tear the session/server down.
  - **Layout QA.** The injected auditor measures the rendered page (after load
    and on resize) and reports horizontal overflow, clipped text, and oversize
    elements as structured `{selector, kind, detail, severity}` warnings — so the
    agent can fix layout bugs it can't see from source. Delivered on the poll and
    via `edit layout`.
  - **Re-engage from the UI.** A Send reopens an ended session (no terminal trip),
    and the composer honestly shows whether a listener caught the message
    (delivered) or it's queued for the next poll, with a best-effort OS nudge.
  - **Two channels:** the conversation is transient instructions to the agent
    (a drain-on-delivery queue); comments are persistent annotations (the reused
    widget, served same-origin). The composer **locks while the agent is working**
    (unlocks on its reply or next poll) so messages can't pile up mid-edit, and an
    unsent draft is saved to `sessionStorage` so a live-reload never loses what you
    were typing. No new dependencies — a detached `node:http` server, `fs.watch` →
    SSE live-reload, sessions keyed by file path under `~/.htmldrop/edit/`.
- **Localhost hardening.** The edit server rejects non-loopback `Host` headers
  (DNS-rebinding), rejects cross-origin writes (CSRF), and serves only
  `.html`/`.htm` resolved by realpath.

## [1.7.0] — 2026-06-11

Commenters can now edit and delete their own comments, and anchor "text updated"
detection is no longer a substring guess — comments are pinned to a fingerprint
of the doc state they were made against. Requires a Worker redeploy; Surge docs
pick up the new widget on next re-push.

### Features

- **Edit/delete your own comments.** The widget mints a per-browser CSPRNG edit
  token, sent with every comment/reply; the Worker stores only its SHA-256 hash.
  `DELETE`/`PATCH /api/feedback/:docId/:commentId` authorize via the token (or
  the author key, which can act on any comment). Deleting a top-level comment
  removes its reply thread; edits stamp `editedAt` (shown as "· edited"). The
  Edit/Delete buttons render only for comments posted from that browser.
- **Doc-version stamping + revision trail.** The widget fingerprints the doc's
  normalized visible text at load (FNV-1a — versioning, not security) and stamps
  every comment with `docHash`. "Has the text changed since this comment?" is now
  an exact hash comparison, not an inference: identical fingerprint → the widget
  can never claim "text updated" (fail-safe against matcher bugs). The Worker
  appends distinct fingerprints to `revisions:<docId>` (capped at 50) as an audit
  trail of doc states commenters observed — `GET /api/revisions/:docId`, gated
  like feedback reads.

### Fixes

- **False "text updated since this comment" on pretty-printed docs.** Anchor
  matching compared rendered selection text (whitespace collapsed) against raw
  text nodes (source newlines/indentation kept), so any selection spanning a
  source line break failed to match, falsely orphaned the comment, and tinted its
  whole paragraph. Matching now runs in whitespace-normalized space with an
  offset map back to raw text-node positions, shared by orphan detection and
  highlight placement so the two can never disagree.

### Upgrade

- **Redeploy the Worker**, then **re-push Surge-published docs** (the widget is
  baked in at push time). Comments posted before 1.7.0 carry no edit token, so
  they can't be deleted/edited by their commenter — only by the doc author.

## [1.6.0] — 2026-05-25

Changes the **feedback access contract** for private docs and the client/Worker
protocol. Requires a Worker redeploy + a one-time owner migration (see Upgrade).

### Security / Features

- **The password is now the access capability for private docs.** For a
  password-protected (`--feedback --password`) doc, the Worker now requires
  proof-of-password to **read, post, and list** comments — not just to decrypt the
  page. The CLI derives a token from the password (an independent second half of
  the existing PBKDF2 output — the AES key is byte-unchanged) and registers only
  its `SHA-256` hash + the (public) salt; the browser gate and the teammate CLI
  send the token in an `X-HTMLDrop-Access` header. The Worker never sees the
  password or the AES key. Public docs stay openly commentable. Closes the
  "anyone with the link can comment on a private doc" gap.
- **Set-once document ownership.** Registering a docId binds it to the first
  author key (`owner:<docId> = SHA-256(key)`); a different key gets `409`. Owner
  actions (converge / clear / content / segments / insights) authorize against
  that record, so knowing a public docId can no longer seize ownership. A guarded
  one-time `POST /admin/migrate-owners` backfills ownership for pre-existing docs.
- **Shared-origin isolation.** Uploaded public docs are served at `/doc/*` with
  `Content-Security-Policy: sandbox allow-scripts`, so a malicious doc can't run
  as same-origin script and read dashboard state. The dashboard author key moved
  from `localStorage` to `sessionStorage`.
- **No server-funded AI.** The `env.ANTHROPIC_API_KEY` fallback in insights/
  converge is removed — AI is strictly bring-your-own-key.
- **Pinned surge fallback.** `npx surge` → `npx --yes surge@0.27.4`.
- New teammate flags: `htmldrop feedback read/add --password` derive the access
  token to read/comment on a private doc from the terminal.

### Upgrade

- **Redeploy the Worker** for the access gate, set-once ownership, CSP, and BYOK
  changes to take effect. Then set `ADMIN_SECRET` (`npx wrangler secret put
  ADMIN_SECRET`) and call `POST /admin/migrate-owners` once **before sharing new
  links**.
- Backward compatible: v1.5.2 encrypted docs still decrypt (AES key unchanged);
  pre-existing public docs are unaffected; older docs become owner-locked via the
  migration or on next re-push.
- Verified end-to-end against a local Worker: private no-token → 401, password
  token → 2xx, owner key → 200, public open, set-once → 409, CSP present.

## [1.5.2] — 2026-05-25

### Security

- **Stronger password encryption.** Password-protected docs now use **AES-256-GCM**
  with the key derived via **PBKDF2 (SHA-256, 600,000 iterations)** plus a random
  salt + IV, computed with built-in WebCrypto (browser gate) / Node `crypto` (CLI).
  This replaces crypto-js passphrase mode (OpenSSL `EVP_BytesToKey` = MD5, a single
  iteration), whose weak KDF made the *public* ciphertext cheap to brute-force for
  memorable passwords. New docs use a self-describing `v2:` envelope; `fetch` still
  decrypts older docs (crypto-js fallback retained). The browser password-gate no
  longer loads crypto-js from a CDN, removing a missing-SRI third-party dependency.
- **Gallery filename XSS** — the public index page now HTML-escapes file names and
  URL-encodes hrefs, so a crafted filename can't inject markup into your Surge origin.
- **Worker — unauthenticated logout fixed.** `/agent/auth/revoke` now verifies the
  logout token's issuer **and signature** before deleting any credential; previously
  an unsigned token could force-logout / orphan another user's docs.
- **Worker — per-doc comment counter** now carries the 90-day TTL and resets on
  `feedback clear`, so a doc is no longer permanently frozen at the lifetime cap.
- **Worker — 2 MB cap** on uploaded document HTML (KV-bloat guard).
- **Hardening.** Author-key config written `0600` (dir `0700`); Surge invoked via
  `execFileSync` (array args, no shell); `docId` URL-encoded and `--save`/`--out`
  paths confined to the working directory; injected widget config escapes `</script>`;
  `converge --api-key` help notes it's visible in shell history / process list
  (prefer the env var).

### Docs

- Security model + Example B updated to describe AES-256-GCM + PBKDF2. The skill's
  teammate example now uses the bare `--password` form (keeps secrets out of history).

### Note

The **Worker** fixes take effect only after a redeploy (`wrangler deploy`); the CLI,
template, and docs fixes ship with this npm release.

## [1.5.1] — 2026-05-25

### Docs

- Added a **"No account needed"** section to the README (no signup/login/dashboard —
  just install + `init` + `auth setup`; the only external account is Surge, and the
  local author key has no email/verification/server). Clarified that the optional AI
  key and doc password are bring-your-own and stored by neither.
- Explicit **password-storage** clarification: the doc password is held in memory only
  to encrypt at push time, then discarded — written nowhere (`config.json` holds just
  `subdomain`/`email`/`authorKey`), uploaded nowhere, so it can't be recovered if lost
  (just re-push). Mirrored the note into the skill (ccc) README.

## [1.5.0] — 2026-05-24

### Added

- **`HTMLDROP_WORKER_URL` env var** — point the CLI at a self-hosted Worker
  (`export HTMLDROP_WORKER_URL=https://your-worker.workers.dev`). Applies to
  push, feedback, and studio, and published docs' widgets talk to your Worker.
  This makes the "own-your-data" / self-host path actually usable (previously
  only the shared default was reachable).
- **`htmldrop feedback pull <file> --save [--out <path>]`** — writes comments to
  `<file>.feedback.json` in your repo, so comments become owned, versioned, and
  private. The Worker is the live inbox; your repo is the system of record.

### Docs

- README rewritten to clearly explain the two tiers — **free shared Worker**
  (our Cloudflare, 90-day auto-expiry, honest "not zero-knowledge" messaging) vs.
  **self-hosted Worker** (your Cloudflare, we see nothing) — with simple data-flow
  diagrams. No Supabase/database is or was used; storage is Cloudflare KV only.

## [1.4.0] — 2026-05-24

### Added

- **Drag-to-annotate an area.** The widget now has an ▢ toggle in the panel
  header: click it, then drag a rectangle over any region of the document to
  comment on that area (like a design-review tool) — useful for images, layouts,
  or anything that isn't a clean text run. The box is stored as percentages of
  the document so it re-renders at the same spot on any screen, and clicking a
  box ↔ its comment scrolls/flashes both ways. Anchors use the `element_rect`
  type (a `rect` field was added to the feedback schema). Verified end-to-end
  with Playwright: drawn box persists and re-renders at the exact coordinates.

## [1.3.2] — 2026-05-24

### Fixed

- **Highlights now render on text that spans inline tags.** Commenting on a
  sentence containing `<strong>`/`<a>`/`<em>` (e.g. “Nobody has done this for
  **data and documents**.”) saved the comment but drew no highlight, because the
  re-highlighter only searched within a single text node. It now flattens the
  page text, locates the match across nodes, and wraps each overlapping text-node
  segment in its own `<mark>` (verified end-to-end: a 3-segment highlight that
  reconstructs the full sentence while keeping the bold word bold). Click-to-scroll
  flashes all segments of an anchor.

## [1.3.1] — 2026-05-24

### Changed (security hardening)

- **Passwords can stay out of shell history.** `--password` now takes an optional
  value: pass `--password <pw>` (as before), or use a bare `--password` to read
  from the `HTMLDROP_PASSWORD` env var, or — if neither is set — be prompted with
  a hidden (non-echoing) input. Applies to both `push` and `fetch`.

### Fixed

- `fetch` with a wrong password now reports **“Incorrect password — could not
  decrypt this page.”** instead of the cryptic crypto-js `Malformed UTF-8 data`.
  `decryptHtml()` catches the decode failure and returns empty.

## [1.3.0] — 2026-05-23

### Added

- **Feedback on password-protected docs.** `push --feedback --password <pw>` now
  injects the annotation widget *before* encryption, so a private (AES-encrypted)
  doc shows the widget after the viewer decrypts it. The Worker only ever receives
  the docId registration — never the plaintext — and the review link is the
  password-gated Surge URL.
- **Agent-native teammate commands** (no document ownership required):
  - `htmldrop feedback read <docId|url> [--json]` — read feedback for any doc by
    id or link (public; no author key, no local manifest).
  - `htmldrop feedback add [file] --doc-id <id|url>` — comment on a doc you didn’t
    publish (the `<file>` argument is now optional when `--doc-id` is given).
  - `htmldrop fetch <url> [--password <pw>] [--out <file>]` — fetch a published
    doc and decrypt a password-protected page, so an agent can read/analyze the
    content. Adds `decryptHtml()` to the encryption module.

### Notes

- These formalize the two-role model: **reviewers** (anyone with the link) read
  and comment via public endpoints; **owners** (author-key holder) additionally
  `converge` and `clear`. No Worker change was needed — its endpoints already
  supported public read/comment.

## [1.2.1] — 2026-05-23

### Changed

- **Updated default models** (verified against provider docs) for a cost/quality
  balance: OpenAI `gpt-5.4-mini` and Gemini `gemini-3.1-flash-lite` (Anthropic
  stays `claude-sonnet-4-6`). Override any of them with `--model` / the model field.
  - Fixes an invalid placeholder: `gemini-3.1-flash` does not exist (the 3.1
    family is flash-lite / pro), which would have 404'd on every Gemini call.
  - For maximum converge quality on OpenAI, override with `--model gpt-5.4`.

## [1.2.0] — 2026-05-23

### Added

- **Multi-provider LLM support for `converge` and AI insights.** Anthropic,
  OpenAI, and Gemini are all supported. The provider is **auto-detected from the
  API key prefix** (`sk-ant-` → Anthropic, `AIza` → Gemini, `sk-` → OpenAI), with
  optional explicit override.
  - CLI: `htmldrop converge <file> [--provider <p>] [--model <m>] [--api-key <k>]`.
    Key is read from `LLM_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
    `GEMINI_API_KEY` if not passed.
  - Dashboard Settings: paste any provider's key (provider shown as detected),
    with a provider dropdown and model field to override.
  - Sensible default models per provider (claude-sonnet-4-6 / gpt-4o /
    gemini-2.0-flash), overridable with `--model` or the model field.

### Changed

- **Dropped the `@anthropic-ai/sdk` dependency.** `converge` now uses raw `fetch`,
  which works uniformly across all providers and removes an optional peer dep.

### Fixed

- **`converge` strips Markdown code fences** from model output, so the written
  `.converged.html` is valid HTML rather than starting with ` ```html `.

## [1.1.4] — 2026-05-23

### Fixed

- **`feedback pull` / `feedback add` / `feedback clear` now accept absolute and
  relative paths**, not just the bare filename. They normalize the file argument
  to its basename before looking it up in the manifest — matching how `push`
  accepts paths. Previously passing an absolute path (as the skill docs show)
  failed with "not found in published files".

## [1.1.3] — 2026-05-23

### Fixed

- **Highlight → "+ Comment" now actually opens the comment popover.** The
  document `mouseup` handler removed the selection tooltip before its own click
  could fire, so clicking "+ Comment" did nothing and reviewers could only leave
  page-level comments via the compose box. The handler now ignores mouseup events
  on its own UI. Verified end-to-end in a real browser (anchored `text_range`
  comment confirmed).

## [1.1.2] — 2026-05-23

### Fixed

- **Anchored comments now capture the selected text.** The annotation widget
  read the selection inside the tooltip click handler, but clicking the tooltip
  clears the page selection — so comments silently fell back to page-level.
  The selection is now captured at `mouseup`.
- **No more double-injected widget.** `push --feedback` uploaded the
  widget-injected HTML to the Worker, which then injected its own widget again
  (two panels, two sets of handlers). The CLI now uploads clean content; the
  Worker is the single injector for the `/doc/<id>` URL.

## [1.1.1] — 2026-05-23

### Fixed

- `htmldrop --version` now reads the version dynamically from `package.json`
  instead of a hardcoded string, so it always matches the installed package
  (was reporting `1.0.0` regardless of the real version).

## [1.1.0] — 2026-05-23

First public release under the `@yeefeiooi/htmldrop` scope. Adds a complete
collaborative feedback + AI synthesis system on top of the original sharing CLI.

### Added

- **`htmldrop push <file> --feedback`** — publish an HTML file with an embedded
  annotation widget. Returns a single shareable `/doc/<id>` URL that serves both
  reviewers (who highlight text and comment) and the author. Re-pushing the same
  file reuses its `docId`, so the link stays stable and existing comments remain
  attached. `--new-doc` forces a fresh doc/link.
- **`htmldrop auth setup [--force]`** — generate an author API key (stored in
  `~/.htmldrop/config.json`) used to retrieve and manage feedback.
- **`htmldrop feedback pull <file> [--json]`** — retrieve all comments and replies.
- **`htmldrop feedback list`** — list which published files have feedback enabled.
- **`htmldrop feedback add <file> --text … [--name …] [--on …] [--parent-id …]`** —
  post a comment programmatically. This is the agent-facing write path: an AI agent
  can inject evidence-backed comments, optionally anchored to specific text (`--on`)
  or as a reply (`--parent-id`).
- **`htmldrop feedback clear <file>`** — delete all feedback for a file (author only).
- **`htmldrop converge <file> [--dry-run]`** — pull all feedback, send it to Claude,
  and write an improved `<file>.converged.html`. `--dry-run` prints the prompt without
  calling the API. Requires `ANTHROPIC_API_KEY` and the optional `@anthropic-ai/sdk`
  peer dependency.
- **`htmldrop studio`** — local "Converge Studio" dashboard to review feedback and
  trigger AI insights/convergence in the browser.
- **Annotation widget** — Shadow-DOM-isolated, Stripe-inspired panel: text-selection
  comments, click-to-scroll between a comment and its highlighted text (bidirectional),
  reply threading, page-level comments, and a manual refresh button.
- **Cloudflare Worker backend** — anonymous reviewer submission, IP + per-doc rate
  limiting, 90-day TTL auto-expiry, single-URL document serving, and persisted AI
  insights. Self-hostable.
- **auth.md (WorkOS) protocol support** — discovery documents at
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
  plus `/agent/auth` for anonymous and ID-JAG (identity-assertion) agent registration
  with JWKS signature verification. Lays the groundwork for cloud-hosted agents to
  authenticate on a user's behalf; the existing local-key auth continues to work.

### Changed

- **Package renamed to `@yeefeiooi/htmldrop`** (scoped). The unscoped `htmldrop`
  name on npm is owned by an unrelated account; the scoped name is publishable and
  owned by us. The installed binary is still `htmldrop`.
- Reviewer Anthropic API key (for AI features) is held in `sessionStorage` only —
  never persisted to disk or sent to our servers (bring-your-own-key model).

### Security

- npm package ships only `bin/`, `src/`, and `templates/` via a `files` whitelist —
  the Worker backend, deployment config (Cloudflare KV IDs), and dev tooling are
  excluded so nothing sensitive is published.

## [1.0.0]

Initial CLI: publish HTML files as shareable links via Surge.sh.

### Added

- `htmldrop init` — set up Surge account and pick a subdomain.
- `htmldrop push <file>` — publish a file; `--password` for client-side AES
  encryption, `--noindex` to block crawlers, `--open` to open after deploy.
- `htmldrop list` — list published files with public/private badges.
- `htmldrop delete <file>` — remove a file and redeploy.
- `htmldrop open <file>` — open a published file in the browser.

[1.6.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.6.0
[1.5.2]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.5.2
[1.5.1]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.5.1
[1.5.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.5.0
[1.4.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.4.0
[1.3.2]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.3.2
[1.3.1]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.3.1
[1.3.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.3.0
[1.2.1]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.2.1
[1.2.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.2.0
[1.1.4]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.4
[1.1.3]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.3
[1.1.2]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.2
[1.1.1]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.1
[1.1.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.0
[1.0.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.0.0
