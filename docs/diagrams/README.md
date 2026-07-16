# Diagrams

User-facing diagrams for the README and release notes. Rendered from Mermaid
source to committed image assets so they display on GitHub **and** npm (neither
runs JavaScript in a README, so an inline `mermaid` fence or interactive embed
won't render on npm — a static image does).

## Files

- `collab-flow.mmd` — Mermaid source (the source of truth).
- `theme.json` — brand theme variables (blue actors, green notes).
- `puppeteer.json` — points mermaid-cli at the system Chrome with `--no-sandbox`.
- Output → `../assets/collab-flow.svg` (crisp source) and `../assets/collab-flow.png`
  (2x, universally reliable on GitHub camo + npm). The README references the PNG.

## Regenerate

```bash
npm install          # installs @mermaid-js/mermaid-cli (devDependency)
npm run diagrams     # re-renders both SVG and PNG from the .mmd source
```

If Chrome lives elsewhere, edit `executablePath` in `puppeteer.json`.

## Release-note practice

Each release also ships an htmldrop-published, user-facing release note (the
interactive version of this diagram lives there). The README links the diagram
image to that page. Keep both **end-user framing only** — what shipped, why it's
useful, and how to upgrade.
