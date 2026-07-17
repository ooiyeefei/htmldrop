# Opt-in View Tracking (Deferred Proposal)

**Status:** proposed, deferred — 2026-07-17
**Decision owner:** yeefei
**Scope:** aggregate page-load count and last-viewed time; no viewer identity

## Summary

htmldrop can show when a document was pushed and when it last received feedback from data it already
has. It cannot truthfully show when it was viewed: Surge serves a static file, exposes no usable
request log to htmldrop, and the page sends no view event. If demand justifies the privacy and
maintenance cost, add a small, **explicitly opt-in** beacon backed by the existing Worker and KV.
V1 should record only an aggregate count and server-generated last-viewed timestamp—never unique
viewers, a view history, an analytics cookie, referrer, or location.

## Problem

The requested gallery/list context has three superficially similar timestamps, but they do not
have the same cost:

| Metric | Existing source | New reader instrumentation? |
|---|---|---:|
| Last modified/pushed | local manifest written by `push` | No |
| Comment count / last commented | feedback already sent to Worker KV | No |
| View count / last viewed | no source; Surge page load is invisible to htmldrop | **Yes** |

Last viewed helps answer modest questions: “Has anyone opened this since I pushed it?”, “Is this
review link still active?”, and “Which gallery items are being read?” It is not precise readership.
A “view” means an accepted page-load beacon: reloads, authors, and some bots count; disabled
JavaScript, blockers, offline loads, and failed requests do not. V1 is not an audit trail.

## Proposed mechanism

On `push --track-views`, inject a small standalone beacon into the published HTML. If the feedback
widget is present, its configuration can enable the same behavior instead of injecting twice.
Tracking must not be coupled to `--feedback`: comments do not imply consent to tracking, and a
tracked document need not have comments enabled.

The script sends one best-effort request after the document is available:

```text
POST /api/view/:docId
Content-Length: 0
```

Use `navigator.sendBeacon` where no custom header is needed, or `fetch` with `keepalive: true` and
`referrerPolicy: "no-referrer"`. Send no body, page URL, title, referrer, user agent, or client
timestamp. For a private doc, `sendBeacon` cannot attach the capability header, so use `fetch`
after successful decryption with the existing `X-HTMLDrop-Access` token.

`--track-views` requires a stable `docId`. Today only feedback creates one; tracked-only pushes must
create/reuse one and register its owner without enabling feedback. Registration also marks tracking
enabled. Reject or ignore unregistered/disabled IDs so callers cannot fill arbitrary KV keys.

A minimal KV record in the existing `FEEDBACK` namespace could be:

```text
views:<docId> = {
  "count": 42,
  "lastViewedAt": "2026-07-17T14:23:01.000Z"
}
```

Use the same 90-day inactivity retention as other document data unless another policy is chosen and
documented. After expiry, this is a retained-period count, not a lifetime count. Disable/delete
must remove the view record and registration.

KV read-modify-write is not atomic, so concurrent beacons can lose increments. That is acceptable
only for an explicitly best-effort metric. Exact counts require a primitive such as a Durable
Object, outside V1.

## Reading metrics

Provide a single-document response and a batch form to avoid one request per gallery card:

```text
GET /api/views/:docId
GET /api/views?docId=<id>&docId=<id>...

{
  "docId": "...",
  "count": 42,
  "lastViewedAt": "2026-07-17T14:23:01.000Z"
}
```

Confirm exact routing and namespace placement against `worker/src/index.ts` and
`worker/src/storage.ts` during implementation.

`htmldrop list` can make an owner-authenticated batch request using manifest doc IDs and the author
key. The static Surge gallery cannot safely contain that key. Its browser may read live aggregates
**only for public documents**, making those metrics public metadata. Private metrics remain
owner-only and absent from the public gallery; never embed an owner key or password capability.
If public aggregates are also undesirable, omit live gallery metrics rather than weaken auth.

## Privacy is the core decision

A beacon is not “just another timestamp”: htmldrop begins observing readers. That is a philosophical
shift from no reviewer accounts, anonymous comments, and client-side decryption that keeps private
content from the server. Judge aggregate tracking against that promise, not only implementation size.

### Privacy spectrum

| Option | Data required | Cost / risk | Recommendation |
|---|---|---|---|
| Count-only | one aggregate count and latest timestamp | Worker learns that a doc was loaded and when | **V1 default, if built** |
| Unique views | stable IP-derived value or browser cookie | creates a viewer identifier; inaccurate under NAT, rotation, blocking, or cookie clearing | Do not build in V1 |
| Rich analytics | per-event time, referrer, user agent, coarse geo, etc. | creates behavioral history and expands disclosure/retention duties | Reject for htmldrop's current purpose |

Hashing an IP is not a privacy escape hatch: the input is guessable, addresses rotate, and many
people share one. A keyed HMAC is harder to reverse but remains pseudonymous. A random cookie
recognizes a browser over time and adds storage and consent questions. Neither is needed here.

V1 should keep no per-view event or viewer field. Cloudflare and the Worker necessarily receive
network metadata; the application must not copy it into view records or logs. Any transient
abuse-control identifier is a disclosed exception with the shortest practical TTL.

### Opt-in and default-off

Tracking is off unless the author chooses `push --track-views` (or an explicit, visible, reversible
per-site setting). `--feedback` must never enable it. Private docs should require the per-push flag
rather than silently inherit a broad setting.

Default-off is warranted because the reader did not choose htmldrop. It avoids changing existing
HTML, spending Worker writes unnecessarily, and becoming an analytics product by accident. The
opt-in should be inspectable, and docs must state what is sent and how long it is retained.

### Private documents

For a password-gated document, run the beacon only after successful client-side decryption. Gate
the endpoint with the existing password-derived access capability so someone who merely discovers
the doc ID cannot manufacture plausible private views without the password.

This preserves content secrecy, not access-event secrecy: the Worker learns that a private doc was
viewed and when, plus unavoidable request metadata, though not its content or intentionally who
viewed it. Either support private tracking under that explicit model or initially prohibit
`--track-views` with `--password`. Recommend support only with per-push opt-in and plain disclosure.

### Consent and data protection

This is not legal advice. Short-retention aggregate data is lower-risk, but the request is not
legally irrelevant. GDPR/ePrivacy and similar duties depend on operator, audience, purpose, and
jurisdiction. Per-viewer IDs, cookies, or retained IP-derived values are more likely to need notice,
a lawful basis, and possibly consent; obtain legal guidance before adding them.

## Rate limiting and abuse

`POST /api/view/:docId` is public for public documents, so anyone can replay it and inflate the
count. Treat counts as directional, not audited.

`worker/src/rate-limit.ts` already has soft per-IP/per-doc and per-doc comment limits in
`RATE_LIMITS`. Views need separate keys and thresholds so traffic cannot block comments. Bound
per-IP/per-doc traffic and per-doc bursts over short windows, return a cheap `204`, and require a
registered tracking-enabled doc.

The current limiter puts raw `CF-Connecting-IP` in a short-lived KV key. Copying it weakens the
count-only claim. Prefer a short-lived, secret-keyed daily bucket (or supported edge rate limit),
scoped to doc ID, with no source IP in analytics. This temporary pseudonymous abuse data must be
documented and expire promptly. Confirm thresholds/facilities against the deployment.

KV limits are soft and eventually consistent. A distributed attacker can inflate counts, while a
strict cap can undercount a genuinely popular link. Do not solve that tension with fingerprints or
long-lived identity in V1.

## Alternatives considered

1. **Surge or Cloudflare analytics/logs.** Surge exposes no usable request log/API. Cloudflare sees
   Worker requests, not direct Surge loads; its analytics help only after a beacon or proxy. Revisit
   if Surge adds a privacy-appropriate API.
2. **Third-party analytics script.** This sends readers to another party, adds supply-chain risk,
   and often assumes an account, cookie, or dashboard. It contradicts the no-account ethos. Reject.
3. **Route every document through the Worker.** This changes static hosting, counts bots/prefetches,
   adds a serving dependency, and misses already-shared direct Surge URLs. Reject.
4. **Do nothing.** Keep existing activity, label views unavailable, and avoid observing readers.
   Prefer this until users show that view metrics materially improve their workflow.

## Scope and phasing

### V1

- Add `--track-views`, manifest state, stable doc ID registration, and an explicit disable path.
- Inject one count-only beacon; support post-decryption sending for opted-in private docs.
- Add aggregate KV storage with bounded retention and deletion.
- Add POST, owner/public read, batch read, CORS, and view-specific soft rate limits.
- Show live owner-authorized metrics in `list`; show public-doc aggregates in the gallery only if
  public disclosure is accepted.
- Test disabled-by-default behavior, duplicate injection, private access, expiry/deletion, CORS,
  malformed IDs, rate limiting, and partial batch failures.

Rough effort: **3–5 focused engineering days** for Worker endpoint/storage, beacon injection,
flag/manifest/registration changes, gallery/list reads, tests, and documentation. This excludes
legal review, production rollout, and any migration/backfill (historical views cannot be recovered).

### Possible V2

Only after evidence of need: date-bucketed aggregate counts, a “since last push” count, configurable
retention, or owner-only export. Each adds writes or retained history and needs a fresh privacy
review. Unique viewers, cookies, IP-based identity, referrers, geo, and per-view event logs are not
a natural V2; they are a separate product decision.

## Recommendation

**Defer this feature until users repeatedly ask for view metrics and can explain the decision it
helps them make.** Last-modified and comment activity should ship independently because they use
existing data and do not observe page loads.

If demand is real, build only the V1 above: explicit per-document opt-in, count-only plus
last-viewed timestamp, bounded retention, owner-only private metrics, no viewer identity, and
best-effort semantics stated in the UI. Do not trade htmldrop's privacy posture for unique-view or
rich analytics. If aggregate, default-off tracking is not useful enough, leave view tracking out
rather than collecting more reader data.
