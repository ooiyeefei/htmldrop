use_when: dense structured/tabular data, many attributes across items
# Table playbook

Use this when the artifact contains dense structured data or many attributes across items.

## Required shape

- Use a real `<table>` with `<thead>`, `<tbody>`, `<th scope="col">`, and meaningful captions when needed.
- Align columns so the eye can scan values down the page.
- Highlight the decision-relevant column: recommendation, status, risk, owner, cost, or next action.
- Avoid horizontal overflow. Use `table-layout: fixed` when appropriate, `min-width: 0` on wrappers/grid children, and wrap or truncate long cells deliberately.
- Keep long prose out of cells; link or expand it below the table.

## Layout reminders

```css
.table-shell { max-width: 100%; min-width: 0; overflow-x: hidden; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { min-width: 0; overflow-wrap: break-word; vertical-align: top; }
.decision-col { background: color-mix(in srgb, currentColor 8%, transparent); }
```
