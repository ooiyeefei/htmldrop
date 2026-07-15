# Collaborative editing without git

Track B has two separate axes:

1. **Source** — how a teammate gets editable HTML.
   - No shared repo: run `htmldrop pull <url>` to reconstruct clean source from the published page.
   - Shared repo: use git for the source file and merge changes normally.
2. **Authority** — who can push back to the same link and manage feedback.
   - Use one shared htmldrop team identity: `config.subdomain` + `config.authorKey` in `~/.htmldrop/config.json`.

The no-git model is: **shared team identity + `htmldrop pull`**.

## Security requirement: dedicated team identity only

The shared identity includes the htmldrop author key. Anyone with it has full co-owner power for **every doc published under that identity**, including updating links and deleting feedback.

Create a dedicated team account for collaboration:

```sh
htmldrop init
htmldrop auth setup
```

Do **not** export or import a personal identity.

## Onboard a teammate

On the team machine that owns the dedicated identity:

```sh
htmldrop identity export
```

Send the token through a secure channel. On the teammate machine:

```sh
htmldrop identity import <token>
```

If the teammate already has a different htmldrop identity configured, import refuses to overwrite it unless they pass `--force`.

## Sequential hand-off flow

```sh
A: htmldrop push plan.html --feedback --password <pw>

B: htmldrop pull <team-link> --password <pw> -o plan.html
   ...edit plan.html with B's agent...

B: htmldrop push plan.html --feedback --password <pw>   # SAME link, comments intact
```

`htmldrop pull` decrypts password-gated docs when given the password, strips the published feedback widget, writes clean editable HTML, and records the original `docId` in the local manifest. Because `push --feedback` reuses the manifest `docId`, the next push updates the same review thread.

To load the published comments during local iteration:

```sh
htmldrop edit start plan.html --with-feedback
```

## Concurrency caveat

This no-git loop is **last-write-wins**. It is ideal for sequential hand-off: A finishes, then B pulls, edits, and pushes.

For concurrent editing of the same file, use git for the source so edits can be merged. The shared htmldrop identity still handles publishing to the same link and feedback thread.

## Deferred: scoped external collaborator roles

Per-doc scoped tokens and capability roles for external collaborators are not part of this flow yet. See `docs/plans/2026-05-25-password-capability-design.md` for the existing password capability design; the broader item 8 role model is deferred.
