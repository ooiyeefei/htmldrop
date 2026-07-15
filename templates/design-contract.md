# htmldrop design contract

Use this contract before hand-rolling design primitives. Prefer the user's or target project's system first; use the neutral stack only when no system is named or discoverable.

## 1. Source-priority rule

Source priority: (1) user-named system → (2) the target project's design system (tailwind config / CSS tokens / component lib / brand assets) → (3) one recommended clean neutral CDN stack.

## 2. Copy-paste CDN snippets

The neutral stack is intentionally small: a modern CSS reset/base, the pinned Mermaid renderer used by the `diagram` playbook, and a system font stack. Every CDN `<link>` or `<script>` tag includes SRI and `crossorigin="anonymous"`.

```html
<!--
SRI hashes were produced with:
curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
then prefixed with sha384-. Each pinned URL was verified to return HTTP 200.
-->
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/modern-normalize@3.0.1/modern-normalize.min.css"
  integrity="sha384-uo/9/s/Ns8DTg4kjkjex8GezUcgMlKD99gTqxvMkIsaG4lSUbeJ0dVELljipv94t"
  crossorigin="anonymous"
>
<script
  defer
  src="https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js"
  integrity="sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E"
  crossorigin="anonymous"
></script>
<style>
  :root {
    color-scheme: light dark;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5;
    text-rendering: optimizeLegibility;
  }
</style>
```

## 3. Layout-safety CSS block

Use this block in portable artifacts to prevent accidental horizontal overflow. For grids, prefer `grid-template-columns: repeat(auto-fit, minmax(0, 1fr))` or another `minmax(0, ...)` track so content is allowed to shrink.

```css
*,*::before,*::after{box-sizing:border-box}
html{overflow-x:hidden}
body{margin:0;min-width:0;overflow-x:hidden}
img,svg,video{max-width:100%;height:auto}
canvas,iframe,pre,code{max-width:100%}
pre{overflow:auto;white-space:pre-wrap}
.grid,.cards,[data-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr))}
.flex,.row,[data-flex]{display:flex;min-width:0}
.grid>*,.cards>*,.flex>*,.row>*,main,section,article,aside,header,footer{min-width:0}
p,li,figcaption,blockquote,td,th,.text,.copy,[data-text]{overflow-wrap:break-word}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

## 4. Theme-aware Mermaid re-render snippet

Initialize Mermaid with `startOnLoad: false`, keep the original diagram source, and re-render from source on every light/dark change. Mermaid never restyles an already-drawn SVG — you must re-run `mermaid.render` with the new theme.

```html
<button type="button" data-theme-toggle>Toggle theme</button>
<script type="text/plain" id="diagram-source">
flowchart LR
  Idea[Source text] --> Render[mermaid.render]
  Render --> SVG[Theme-specific SVG]
</script>
<div id="diagram-output" aria-label="Theme-aware Mermaid diagram"></div>
<script>
  (() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const source = document.getElementById('diagram-source').textContent.trim();
    const output = document.getElementById('diagram-output');
    let renderCount = 0;

    const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && media.matches);

    async function renderDiagram() {
      const theme = isDark() ? 'dark' : 'default';
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
      const { svg } = await mermaid.render(`diagram-${theme}-${++renderCount}`, source);
      output.innerHTML = svg;
    }

    document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
      root.dataset.theme = isDark() ? 'light' : 'dark';
      renderDiagram();
    });

    media.addEventListener?.('change', () => {
      if (!root.dataset.theme) renderDiagram();
    });

    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', renderDiagram, { once: true });
    } else {
      renderDiagram();
    }
  })();
</script>
```
