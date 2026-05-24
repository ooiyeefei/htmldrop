# htmldrop

Publish HTML files as shareable links — and optionally collect inline feedback on them and synthesize it with AI.

htmldrop has two modes:

1. **Simple share** — publish any HTML file and get a public (or password-protected) link, hosted free on [Surge.sh](https://surge.sh).
2. **Collaborative feedback + converge** — publish with an embedded annotation widget so reviewers can highlight text and comment (no account needed), then pull that feedback and let an LLM synthesize an improved version.

```
npm install -g @yeefeiooi/htmldrop
```

(The installed command is `htmldrop`. Requires Node.js ≥ 18.)

---

## Table of contents

- [Setup](#setup)
- [Command reference](#command-reference)
- [Example walkthroughs](#example-walkthroughs)
- [The agent loop](#the-agent-loop)
- [Multi-provider AI (Anthropic / OpenAI / Gemini)](#multi-provider-ai)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Self-hosting the feedback backend](#self-hosting-the-feedback-backend)
- [Config](#config)

---

## Setup

```bash
# 1. Install the CLI
npm install -g @yeefeiooi/htmldrop

# 2. One-time: log in to Surge and pick a subdomain (for simple share)
htmldrop init

# 3. One-time: generate an author key (only needed for feedback/converge)
htmldrop auth setup
```

`init` runs `surge login` and saves your subdomain to `~/.htmldrop/config.json`.
`auth setup` generates an author API key (also stored there) that identifies you as the document owner when pulling, clearing, or converging feedback.

For AI converge you also need an LLM API key in your environment — see [Multi-provider AI](#multi-provider-ai).

---

## Command reference

| Command | What it does |
|---|---|
| `htmldrop init` | One-time setup: Surge login + subdomain |
| `htmldrop auth setup [--force]` | Generate the author API key (`--force` regenerates) |
| `htmldrop push <file>` | Publish a file. Flags: `--password <p>`, `--noindex`, `--open` |
| `htmldrop push <file> --feedback` | Publish with the annotation widget. `--new-doc` forces a fresh link. Combine with `--password` for a feedback-enabled *private* doc |
| `htmldrop list` | List published files with their URLs |
| `htmldrop open <file>` | Open a published file in the browser |
| `htmldrop delete <file>` | Remove a file and redeploy |
| `htmldrop feedback pull <file> [--json]` | Retrieve feedback for **your own** published file (uses the local manifest) |
| `htmldrop feedback read <docId\|url> [--json]` | Read feedback for **any** doc by id or link — no ownership, no manifest (for teammates/agents) |
| `htmldrop feedback list` | List which files have feedback enabled |
| `htmldrop feedback add [file] --text <t>` | Post a comment. Use `--doc-id <id\|url>` to comment on a doc you didn't publish. `--name <n>`, `--on <anchor>`, `--parent-id <id>` |
| `htmldrop feedback clear <file>` | Delete all feedback (owner only) |
| `htmldrop fetch <url> [--password <p>] [--out <f>]` | Fetch a published doc, decrypting password-protected pages — lets an agent read the content |
| `htmldrop converge <file>` | Synthesize feedback → improved HTML (owner). `--dry-run`, `--provider`, `--model`, `--api-key` |
| `htmldrop studio` | Open the Converge Studio dashboard locally. `--port <n>`, `--no-browser` |

File arguments accept an absolute path, a relative path, or the bare filename — they all resolve to the same published file. Commands that act on **your own** doc (`pull`, `clear`, `converge`) use the local manifest + author key; the **teammate-facing** commands (`read`, `add --doc-id`, `fetch`) work from just a link.

---

## Example walkthroughs

Each example is a self-contained sequence of steps you can copy.

### Example A — Share a report publicly

```bash
htmldrop push report.html
# → Published: https://your-subdomain.surge.sh/report.html
```

Add `--noindex` to block search engines/AI crawlers, or `--open` to open it after deploy.

### Example B — Share something privately (password)

```bash
htmldrop push private-spec.html --password coral-sunset-42
# → Published (AES-256 encrypted). Share BOTH the URL and the password.
```

The content is encrypted client-side; viewers must enter the password to decrypt it.

### Example C — Collaborative review, end to end

This is the full feedback → converge loop, broken into steps.

**C1. Publish with feedback enabled**

```bash
htmldrop push spec.html --feedback
# → Feedback URL: https://htmldrop-feedback.htmldrop.workers.dev/doc/<uuid>
```

That single URL is for everyone — reviewers and you.

**C2. Reviewers comment (in the browser)**

Share the Feedback URL. A reviewer opens it, selects text, clicks the **“+ Comment”** tooltip, and leaves a comment anchored to that text — no account, no login. They can also leave page-level comments and reply to others. New comments appear via the panel’s refresh button.

**C3. Read the feedback from the CLI**

```bash
htmldrop feedback pull spec.html
# Lists every comment with author, anchor text, and timestamp.
htmldrop feedback pull spec.html --json   # machine-readable
```

**C4. Add an evidence-backed comment (optional)**

You — or an AI agent acting for you — can add a comment, optionally anchored to specific text:

```bash
htmldrop feedback add spec.html \
  --text "Benchmarks show PostgreSQL ~3x the write throughput here." \
  --name "AI Research" \
  --on "PostgreSQL"
```

**C5. Converge the feedback into an improved version**

```bash
# Preview the prompt without calling the model:
htmldrop converge spec.html --dry-run

# Real run (needs an LLM API key — see Multi-provider AI):
export ANTHROPIC_API_KEY=sk-ant-...
htmldrop converge spec.html
# → Writes spec.converged.html incorporating the feedback.
```

**C6. Re-publish to the same link**

```bash
htmldrop push spec.converged.html --feedback   # or re-push spec.html after editing
```

Re-pushing a file that already has feedback **reuses the same docId**, so the link stays stable and existing comments stay attached. Use `--new-doc` only when you want a clean slate.

### Example D — Review feedback in a visual dashboard

```bash
htmldrop studio
```

Opens **Converge Studio** locally: the document on the left, comments grouped into segments on the right, with debate detection and per-segment AI insights/converge actions.

---

## The agent loop

htmldrop is designed so an AI coding agent (e.g. Claude Code) can drive the whole review cycle on your behalf:

```
Agent generates a doc  →  htmldrop push spec.html --feedback  →  shares the link
                                          │
                       reviewers comment on the link
                                          │
Agent: htmldrop feedback pull spec.html   →  reads the feedback
Agent: htmldrop feedback add … --on "…"   →  injects researched, anchored context
Agent: htmldrop converge spec.html        →  synthesizes an improved version
Agent: htmldrop push spec.html --feedback →  updates the SAME link, comments intact
```

Because re-push keeps the same URL, the document can iterate in place while reviewers keep using the link they already have.

---

## Teammates & roles

htmldrop has two implicit roles, enforced by the architecture rather than an account system:

| Role | Who | Can do | How |
|---|---|---|---|
| **Reviewer** | anyone with the link (your teammate, or their agent) | read the doc, read comments, add comments & replies | public Worker endpoints — no key needed |
| **Owner** | whoever holds the author key that registered the doc | everything above **+** `converge`, `feedback clear` | author key in `~/.htmldrop/config.json` |

**A teammate (or their Claude Code / Codex session) reviews without owning anything.** You share the link — and the password if the doc is encrypted. They:

```bash
# Read the document (decrypts a password-protected page so the agent can analyze it)
htmldrop fetch https://you.surge.sh/spec.html --password coral-sunset-42

# Read all reviewer comments — by link or docId, no ownership
htmldrop feedback read https://htmldrop-feedback.htmldrop.workers.dev/doc/<id>

# Add their own comment, optionally anchored to text
htmldrop feedback add --doc-id <id|url> --text "Consider X here" --on "the exact phrase" --name "Alex"
```

It’s symmetric: when your teammate publishes *their* doc, they’re the owner and you’re the reviewer.

**Only the owner converges.** `converge` and `clear` require the author key, so synthesizing/rewriting a doc stays with whoever published it — teammates contribute feedback, the owner decides when to converge. This is the role boundary you want today, with no extra setup.

**Where auth.md fits (forward-looking).** The boundary above is keyed to a local author key. When AI agents run in the cloud (not on your machine), the [auth.md](https://workos.com/auth-md) endpoints this Worker already exposes (`/.well-known/oauth-authorization-server`, `/agent/auth`) let an agent provider (Anthropic/OpenAI/…) vouch for a user’s identity via an ID-JAG — so a teammate’s cloud agent could authenticate as a *reviewer* (or be granted *owner*) without anyone sharing a key. That’s the path to real multi-user roles; today the link + password + author-key model covers a trusted team.

---

## Multi-provider AI

> ### The AI key is optional — and bring-your-own
>
> **You only need an LLM API key for the AI features** (`htmldrop converge` and the dashboard’s AI insights). Everything else works without one.
>
> | Without an AI key | With an AI key |
> |---|---|
> | Publish, password-protect, `list`, `delete`; enable `--feedback`; collect, `pull`, `list`, `add`, reply to, and `clear` comments; view everything in Converge Studio | All of the above **plus** `converge` (AI synthesis into an improved doc) and per-segment AI research insights |
>
> If you don’t set a key, the AI commands simply tell you one is required and stop — nothing else is affected. If you do set one, it unlocks converge + insights.
>
> - **Your key, your cost.** It’s bring-your-own-key: you pay your provider (Anthropic / OpenAI / Gemini) directly at their published rates. htmldrop adds no markup and ships no key of its own.
> - **We never store your key.** The CLI reads it from your terminal environment (or `--api-key`) for that single run only. The browser dashboard holds it in session memory and wipes it when you close the tab. The Worker uses it for one request and forgets it — it is never written to disk or KV.
> - **Handle it securely — it lives in your terminal.** Keep it in an environment variable, don’t commit it to git, don’t paste it into shared logs or chats, and rotate it at your provider if it’s ever exposed.

`converge` and the dashboard’s AI insights work with **Anthropic, OpenAI, or Gemini**. The provider is auto-detected from your API key’s prefix, and you can override it.

**Key resolution (CLI):** `--api-key`, else `LLM_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`.

**Auto-detection by prefix:**

| Prefix | Provider |
|---|---|
| `sk-ant-…` | Anthropic |
| `sk-…` | OpenAI |
| `AIza…` | Gemini |

**Default models** (override with `--model` or the dashboard’s model field):

| Provider | Default model | Approx. cost (in / out per 1M) |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | ~$3 / ~$15 |
| OpenAI | `gpt-5.4-mini` | $0.75 / $4.50 |
| Gemini | `gemini-3.1-flash-lite` | $0.25 / $1.50 |

```bash
# Auto-detected from the key:
ANTHROPIC_API_KEY=sk-ant-... htmldrop converge spec.html

# Explicit override (e.g. flagship OpenAI for top quality):
htmldrop converge spec.html --provider openai --model gpt-5.4 --api-key sk-...
```

No SDKs are required — htmldrop calls each provider’s HTTP API directly.

---

## Architecture

**Simple share** → files are staged in `~/.htmldrop/site/`, an index gallery is generated, and the whole directory is deployed to your Surge subdomain.

**Feedback** → a Cloudflare Worker (`htmldrop-feedback.htmldrop.workers.dev`) stores comments in KV and serves the document at one URL:

- `GET /doc/:docId` — serves your HTML with the annotation widget injected (same URL for reviewers and author)
- `POST /api/feedback/:docId` — anonymous comment submission (rate-limited per IP + per doc)
- `GET /api/feedback/:docId` — public read (with `?since=` for incremental fetch)
- `POST /api/feedback/:docId/:commentId/reply` — threaded replies
- `POST/GET /api/insights/:docId`, `POST /api/converge/:docId` — AI insights/synthesis (bring-your-own-key)
- `.well-known/oauth-authorization-server` + `/agent/auth` — [auth.md](https://workos.com/auth-md) discovery + agent registration, so future cloud-hosted agents can authenticate via ID-JAG (the local author key continues to work today)

Documents and feedback auto-expire after 90 days of inactivity.

---

## Security model

- **No reviewer accounts.** Reviewers comment anonymously; abuse is bounded by per-IP and per-doc rate limits.
- **Author key** lives only in `~/.htmldrop/config.json` on your machine.
- **LLM API key (bring-your-own):** in the dashboard it’s held in `sessionStorage` and cleared when you close the browser — never persisted to disk or stored on the server. The Worker uses it for the single request and forgets it.
- **Password-protected shares** are AES-256 encrypted client-side (StatiCrypt pattern); the password is never sent to a server.

---

## Self-hosting the feedback backend

The Worker is in `worker/`. To run your own instead of the default:

```bash
cd worker
npx wrangler kv namespace create FEEDBACK
npx wrangler kv namespace create RATE_LIMITS
npx wrangler kv namespace create AUTHORS
# put the namespace IDs into wrangler.toml, then:
npx wrangler deploy
```

Point the CLI at it with `--worker-url https://your-worker.workers.dev` (or set it per command).

---

## Config

Stored at `~/.htmldrop/config.json`:

```json
{
  "subdomain": "your-subdomain",
  "email": "you@example.com",
  "authorKey": "…"
}
```

---

## License

MIT
