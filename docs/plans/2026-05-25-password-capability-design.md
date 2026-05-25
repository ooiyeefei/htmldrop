# Password-as-Capability for Private-Doc Feedback (v1.6.0)

**Status:** approved design — 2026-05-25
**Closes audit findings:** F1 (shared-origin key theft), F2 (ownership land-grab), F3 (server LLM key), F5 (unpinned surge).

## Goal

Make the password the real access control for **private** docs: only holders of the
author-issued password can view the doc, post comments, and read existing comments.
**Public** (no-password) docs stay openly commentable. **Ownership** (converge / clear /
content-overwrite) becomes a separate, set-once authorization path keyed on the author key.

The Worker must enforce password-knowledge **without ever learning the password or the
AES key** (preserves the v1.5.2 zero-plaintext property).

## Trust model (three roles)

| Role | Private doc | Public doc |
|---|---|---|
| **Stranger** (docId only) | no view, no read/post comments | view + read/post comments |
| **Reviewer** (has password) | view + read/post comments | (same as stranger) |
| **Owner** (has author key) | everything + converge/clear/content | everything + converge/clear/content |

## Crypto — token derivation (client-side only)

`encrypt.js` already runs `PBKDF2(password, salt, 600_000, SHA-256)` for the AES key.
Derive **64 bytes** instead of 32 and split:

- `bytes[0:32]` -> AES-256-GCM key (**unchanged** — PBKDF2's first block is identical to a
  32-byte derivation, so v1.5.2 docs still decrypt byte-for-byte).
- `bytes[32:64]` -> **access token** (independent block; revealing it never reveals the key).

`accessToken = base64(bytes[32:64])`. `accessHash = SHA-256(accessToken)`.

Node (`node:crypto` `pbkdf2Sync`) and browser (`crypto.subtle.deriveBits`, 512 bits) MUST
produce identical bytes — verified by the integration test.

## Worker storage (KV)

- `access:<docId>` = `{ scheme: "v2-capability", salt: "<b64>", tokenHash: "<hex>" }` — set at
  registration for private docs. Salt is **not secret** (also in the public envelope); storing
  it lets the CLI derive the token without fetching the Surge envelope.
- `owner:<docId>` = `"<hex sha256(authorKey)>"` — **set-once** at registration.

## Worker access control

- **Feedback read / post / reply** on `docId`:
  - `access:<docId>` present (**private**) -> require header `X-HTMLDrop-Access: <token>` whose
    `SHA-256` equals `tokenHash` (constant-time) **OR** a valid owner key. Else `401` with body
    `{ scheme, salt }` so a CLI client can derive the token and retry.
  - absent (**public**) -> open (unchanged).
- **Owner actions** (`converge`, `clear`/DELETE, `POST /doc/:id/content`, `segments`, `insights` POST):
  require `SHA-256(presentedKey) == owner:<docId>` (constant-time). For private docs this is
  in addition to the access gate.
- **New:** `GET /api/access/:docId` -> `{ scheme: "v2-capability", salt }` if gated, else
  `{ scheme: "open" }`. Public (salt isn't secret). Lets the CLI learn the salt.

### Constant-time comparison (refinement #2)
Always hash both sides to fixed 32-byte `SHA-256` digests, then compare with an
XOR-accumulate loop over the 32 bytes. Never compare variable-length strings directly.

## Registration + set-once owner + migration (refinement #4)

`registerAuthorKey(env, key, docId, { accessHash?, salt? })`:
- `owner:<docId>` exists -> proceed iff `SHA-256(key) == owner` else **409**.
- absent -> set `owner:<docId> = SHA-256(key)` (set-once) and append `docId` to the key's
  `AUTHORS` record (back-compat).
- if `accessHash`/`salt` given (private) -> write `access:<docId>`.

**Migration (close the land-grab window):** one-time idempotent `migrateOwners(env)` — `KV.list`
over `AUTHORS`, and for each `(key, docId)` set `owner:<docId> = SHA-256(key)` when absent
(earliest `createdAt` wins on collision). Exposed as guarded `POST /admin/migrate-owners`
(constant-time check of `env.ADMIN_SECRET`). **Run once right after deploy, before sharing new
links.** Without it, a legacy doc has no owner record and the first authenticated `register`
would claim it; a re-push by the true owner also establishes ownership. Document both paths.

## F1 — CSP sandbox (scope carefully, refinement #3)

- Add `Content-Security-Policy: sandbox allow-scripts` to **Worker `/doc/*` only** (public docs)
  -> opaque origin, cannot read `workers.dev` `localStorage`.
- Do **not** sandbox the password gate (Surge): it needs same-origin `sessionStorage` for the
  gate->widget token handoff and the page-replacement write (StatiCrypt pattern). Private docs
  live on per-author Surge subdomains, already isolated from the shared origin.
- Verify the injected widget still `fetch`es the Worker API from an opaque origin: `ACAO: *`,
  `Access-Control-Allow-Headers` includes `X-HTMLDrop-Access`, OPTIONS preflight handled.
  Non-credentialed `fetch` with `Origin: null` is allowed under `ACAO: *`.
- Dashboard: move author key `localStorage -> sessionStorage`; stop seeding it from `?key=`
  query (use `#fragment` / paste only).

## F3 / F5

- Remove the `|| env.ANTHROPIC_API_KEY` fallback in insights/converge -> require BYOK (matches
  the project's "your key, your cost" ethos; eliminates the cost-attack).
- Pin the surge fallback: `npx --yes surge@<pinned>` (or require the locally installed peer dep).

## Gate -> widget handoff

- Gate (has password + envelope): extract `salt` from the `v2:` envelope, derive the token via
  WebCrypto (byte-identical to `encrypt.js`), `sessionStorage.setItem('htmldrop_access', token)`,
  then replace the page with the decrypted HTML (StatiCrypt page-replacement pattern).
- Widget: on load, read `sessionStorage['htmldrop_access']`; send it as `X-HTMLDrop-Access` on
  every Worker fetch (GET feedback `?since`, POST feedback, POST reply).

## CLI

- `push` (encrypted + `--feedback`): derive token, register `{ accessHash, salt }`.
- `feedback read` / `feedback add --doc-id`: add `--password`. If `GET /api/access` reports
  `v2-capability`, derive the token from password + salt and send the header; without a password
  on a gated doc, fail with a clear message.
- `feedback pull` / `clear` / `converge` (owner): use the author key (owner bypass) — no password.

## Verification (integration test, run against `wrangler dev`)

1. Private doc, **no token** -> `401/403` on GET + POST feedback.
2. Private doc, **correct token** -> `200` read + post.
3. Private doc, **owner key** -> `200` (bypass).
4. **Public** doc -> open read + post unaffected.
5. **Set-once:** a second key registering an already-owned docId -> `409`.
6. **Crypto:** Node `deriveAccessToken` == WebCrypto `deriveAccessToken` (byte-compat); v1.5.2
   envelopes still decrypt; wrong password -> `''`.
7. **Sandboxed public doc:** widget `fetch` to the Worker API succeeds (CORS + preflight OK).

## Version

**v1.6.0** — security-contract + client/Worker protocol change. Requires Worker redeploy and a
one-time `migrate-owners` run. Old encrypted docs keep decrypting; old docs become owner-locked
via migration (or on next re-push); pre-existing public docs are unaffected.
