# CLAUDE.md

Instructions for any agent working in this repository. Read the frozen-assets
rule before running anything under `scripts/demo/`.

---

## FROZEN UNTIL 2026-08-06: the judged demo assets

This project is entered in a hackathon whose judging period runs to
**5 August 2026**. The rules require the project to stay testable by judges for
that whole period:

> The Entrant must make the Project available free of charge and without any
> restriction, for testing, evaluation and use by the Sponsor, Administrator and
> Judges until the Judging Period ends.

Three things are load-bearing for that and are **frozen until 6 August 2026**:

| Asset | Why it is frozen |
|---|---|
| `https://yooi.surge.sh/decision-brief.html` | The live document judges test |
| Its password, currently `fern-ocean-10` | Printed in the README, spoken in the demo video, and rendered into the video's closing card |
| `@yeefeiooi/htmldrop@1.12.0` on npm | The install path the README tells judges to use |

### Do not run these before 2026-08-06

- **`node scripts/demo/stage.mjs`** publishes with `--generate-password`, which
  **rotates the password on every run**. One run silently invalidates the README,
  the closing card baked into the published video, and the Devpost testing
  instructions, all at once, with no error. The video cannot be re-rendered
  without re-recording, so this is effectively unrecoverable before the deadline.
- **`htmldrop push docs/demo/decision-brief.html --generate-password ...`**, for
  the same reason.
- **`htmldrop feedback clear docs/demo/decision-brief.html`**, which destroys the
  review thread judges are meant to see on that page.
- **`htmldrop delete`** against `decision-brief.html`, which unpublishes it.
- Publishing an npm version that regresses the OpenAI path off
  `gpt-5.6-luna` / the Responses API.

`scripts/demo/stage.mjs` enforces this in code and will refuse to run. Do not
remove the guard or set its override to get past it. If a task seems to require
re-staging, stop and ask the repo owner instead.

### What is safe

Normal development is unaffected. Ship features, fix bugs, refactor, publish new
npm versions, and push to `main` as usual. Only the four commands above are
frozen, and only against the demo document.

Recording a *new* demo for other purposes is fine as long as it uses a different
filename, so it never touches `decision-brief.html` or its published link.

After 6 August 2026 this whole section can be deleted, along with the guard in
`stage.mjs`.

---

## Repository conventions

- Commit as `ooiyeefei`. Do not add AI co-author trailers.
- This is a public MIT repository. Do not name third-party or competing tools in
  committed files, code comments, commit messages, or the published npm package.
  Describe what code does rather than where an idea came from.
- `artifacts/` holds demo video renders and is gitignored. Videos belong on
  YouTube, not in git.
- Secrets live in `.env.local` (gitignored). Never pass a key inline on a command
  line; source the file instead.
