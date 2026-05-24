# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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
