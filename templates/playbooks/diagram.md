use_when: relationships/flows/architecture/sequences
# Diagram playbook

Use Mermaid for relationships, flows, architecture maps, state charts, and sequences. Do not hand-build node-and-arrow diagrams with nested div boxes: they drift out of alignment, fail on small screens, and are harder for agents to maintain.

## Required shape

- Start from the smallest honest Mermaid diagram that explains the relationship.
- Put the Mermaid source in the artifact as text (for example, a `<script type="text/plain">` block) and render into an empty mount.
- Use the design contract's pinned Mermaid **v11.16.0** CDN snippet.
- Make the diagram responsive by wrapping the rendered SVG in a container with `max-width: 100%`.

## Theme rule

Mermaid never restyles an already-drawn SVG. When the artifact flips between light and dark, re-run `mermaid.render` from the original source text with the new Mermaid theme; do not expect CSS variables to recolor the old SVG.

## Minimal Mermaid usage note

```html
<script type="text/plain" id="flow-source">
flowchart LR
  A[Request] --> B{Cached?}
  B -- yes --> C[Serve instantly]
  B -- no --> D[Fetch + store]
</script>
<div id="flow-output" aria-label="Request cache flow"></div>
<script>
  (async () => {
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
    const source = document.getElementById('flow-source').textContent.trim();
    const { svg } = await mermaid.render('flow-1', source);
    document.getElementById('flow-output').innerHTML = svg;
  })();
</script>
```
