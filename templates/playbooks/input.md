use_when: you need a decision/answer from the viewer inside the artifact
# Input playbook

Use this when the artifact needs a decision, answer, prioritization, approval, or missing requirement from the viewer.

## Required shape

- Ask inside the artifact with native controls: buttons, radio groups, checkboxes, textarea, select, or form submit.
- Keep answers in local state so the artifact feels immediate and works without a backend.
- Provide exactly one explicit **queue answer** action per question. Do not scatter duplicate submit buttons or hidden side channels.
- Show what will be queued before the viewer commits.
- Make the unanswered state visually obvious and the answered state confirmable.

## Pattern

```html
<form data-question="launch-window">
  <fieldset>
    <legend>Which launch window should we plan around?</legend>
    <label><input type="radio" name="window" value="This week"> This week</label>
    <label><input type="radio" name="window" value="Next sprint"> Next sprint</label>
  </fieldset>
  <button type="submit">Queue answer</button>
</form>
```
