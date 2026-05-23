# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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

[1.1.4]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.4
[1.1.3]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.3
[1.1.2]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.2
[1.1.1]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.1
[1.1.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.1.0
[1.0.0]: https://github.com/ooiyeefei/htmldrop/releases/tag/v1.0.0
