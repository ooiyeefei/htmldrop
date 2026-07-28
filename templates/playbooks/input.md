use_when: you need a decision/answer from the viewer inside the artifact
# Input playbook

Use this when the artifact needs a decision, answer, prioritization, approval, or missing requirement from the viewer.

## Required shape

- Ask inside the artifact with native controls: radio groups, checkboxes, select, textarea, or a form submit.
- Keep the *selection* in local state so the control feels immediate — but the button must **deliver** the answer, not merely store it. The single action per question **sends the decision to the agent through the feedback channel** (the same path a typed comment uses): in edit mode it wakes the agent's `edit poll` live; on a published doc it lands as a comment the owner pulls. Never leave the answer as local-only "queued" state that never reaches anyone.
- Exactly one explicit **send** action per question. No duplicate submit buttons, no hidden side channels.
- Label the action as delivery ("Send answer"), and after a successful send show a clear **sent ✓** state. On failure, let the viewer retry.
- Make the unanswered state visually obvious.

## How delivery works

The page is injected with `<script type="application/json" id="htmldrop-config">{ "docId": …, "workerUrl": … }</script>`. Post a page-level comment to `${workerUrl || ''}/api/feedback/${docId}` — `workerUrl` is empty in edit mode (same-origin local server) and set on a published doc, so the *same* code works in both. The decision arrives on the agent's next `edit poll` as a `newComment`, and respects the control bar's Live/Async toggle exactly like a typed comment (Live pings immediately; Async holds until the batch is sent).

Include the helper + wiring **once per page**, not per card.

## Pattern

```html
<form data-question="How should WhatsApp get in?">
  <fieldset>
    <legend>How should WhatsApp get in?</legend>
    <label><input type="radio" name="answer" value="Paste text + screenshots (OCR)"> Paste text + screenshots (OCR)</label>
    <label><input type="radio" name="answer" value="WhatsApp Cloud API webhook"> WhatsApp Cloud API webhook</label>
  </fieldset>
  <textarea name="note" placeholder="Optional note…"></textarea>
  <button type="submit">Send answer</button>
  <span data-sent hidden>✓ sent to the agent</span>
</form>

<script>
// Deliver a decision to the agent via the feedback channel. Reads the injected
// {docId, workerUrl}; posts a page-level comment. Edit mode -> wakes the poll
// live; published -> a comment the owner pulls. One helper for every card.
window.htmldropSend = window.htmldropSend || function (text) {
  var cfg = {}; try { cfg = JSON.parse(document.getElementById('htmldrop-config').textContent); } catch (e) {}
  if (!cfg.docId) return Promise.reject(new Error('no htmldrop session'));
  var headers = { 'Content-Type': 'application/json' };
  var access = null; try { access = sessionStorage.getItem('htmldrop_access'); } catch (e) {}
  if (access) headers['X-HTMLDrop-Access'] = access; // encrypted published docs
  return fetch((cfg.workerUrl || '') + '/api/feedback/' + cfg.docId, {
    method: 'POST', headers: headers,
    body: JSON.stringify({ anchor: { type: 'page_level' }, content: { type: 'text', text: text }, author: { displayName: 'Author' }, parentId: null }),
  }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
};

document.querySelectorAll('form[data-question]').forEach(function (form) {
  if (form.dataset.hdWired) return; form.dataset.hdWired = '1'; // idempotent
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var choice = (form.querySelector('input[name="answer"]:checked') || {}).value || '';
    var note = ((form.querySelector('[name="note"]') || {}).value || '').trim();
    if (!choice && !note) return; // need a selection or a note
    var text = 'Decision — ' + form.getAttribute('data-question') + (choice ? ': ' + choice : '') + (note ? '\n' + note : '');
    var btn = form.querySelector('button[type="submit"]');
    var sent = form.querySelector('[data-sent]');
    btn.disabled = true; btn.textContent = 'Sending…';
    window.htmldropSend(text).then(function () {
      btn.textContent = 'Send answer'; btn.disabled = false;
      if (sent) sent.hidden = false;
    }).catch(function () {
      btn.disabled = false; btn.textContent = 'Retry send';
    });
  });
});
</script>
```
