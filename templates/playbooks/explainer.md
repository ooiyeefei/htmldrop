use_when: teaching a concept/mechanism/how-something-works
# Explainer playbook

Every htmldrop learning artifact gets this shape. Use it when teaching a concept, mechanism, system behavior, or how something works.

## The htmldrop explainer shape

1. Lead with the **ONE idea that explains everything**. Write it as a plain sentence before any details.
2. Add a **feel-the-difference interactive micro-demo** that simulates the mechanism with the smallest honest code. A `450ms setTimeout` IS network lag. A toggle IS a mode switch. A counter IS pressure. Do not fake complexity when a tiny simulation makes the point.
3. Add a **looping before/after animation** of the same scenario under both designs so the viewer can compare motion, timing, state, or outcome without reading.
4. Put the **cheat-sheet table LAST**, including the honest trade-off. The table summarizes after the viewer has felt the mechanism; it does not replace the demo.

## Required discipline

- Keep the mechanism visible: name the state, event, delay, queue, cache, permission, or constraint that drives the behavior.
- Use native controls for the demo unless the concept truly needs custom interaction.
- Label both designs in before/after loops and keep the scenario identical.
- Include the cost of the better design in the final table.

## Mini scaffold

```html
<h1>One idea: latency is not slowness; it is waiting for distance.</h1>
<button id="run">Feel 450ms network lag</button>
<p id="state">Idle</p>
<script>
  run.addEventListener('click', () => {
    state.textContent = 'Request sent…';
    setTimeout(() => { state.textContent = 'Response arrived after 450ms'; }, 450);
  });
</script>
```
