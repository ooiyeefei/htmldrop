// Bounded word comparison. For very large documents use a prefix/suffix diff
// instead of allocating a quadratic matrix. Values are always rendered as text.
export function diffWords(before, after) {
  const a = before.match(/\s+|[^\s]+/g) || [];
  const b = after.match(/\s+|[^\s]+/g) || [];
  if (a.length * b.length > 300000) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    return [
      { type: 'same', text: a.slice(0, start).join('') },
      { type: 'removed', text: a.slice(start, a.length - end).join('') },
      { type: 'added', text: b.slice(start, b.length - end).join('') },
      { type: 'same', text: a.slice(a.length - end).join('') },
    ].filter((part) => part.text);
  }
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  }
  const result = [];
  function add(type, text) {
    if (result.at(-1)?.type === type) result.at(-1).text += text;
    else result.push({ type, text });
  }
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { add('same', a[i++]); j++; }
    else if (j < b.length && (i === a.length || matrix[i][j + 1] >= matrix[i + 1][j])) add('added', b[j++]);
    else add('removed', a[i++]);
  }
  return result;
}

export function historyRuntime(diffWords) {
  'use strict';
  const dataElement = document.getElementById('htmldrop-history-data');
  if (!dataElement || document.getElementById('htmldrop-history')) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => historyRuntime(diffWords), { once: true });
    return;
  }
  let data;
  try { data = JSON.parse(dataElement.textContent); } catch { return; }
  const host = document.createElement('div');
  host.id = 'htmldrop-history';
  const root = host.attachShadow({ mode: 'open' });
  // Only this fixed interface uses innerHTML. Document and revision content is
  // handled separately through textContent or an isolated, CSP-restricted frame.
  root.innerHTML = `<style>
    :host{all:initial;font:14px/1.5 system-ui,sans-serif;color:#17202b;position:fixed;bottom:16px;left:16px;z-index:2147483646}
    button,select,input{font:inherit}button{cursor:pointer;padding:7px 12px;border:1px solid #9ca8b5;border-radius:7px;background:white;color:#17202b}
    #toggle{box-shadow:0 3px 14px #0002}#panel{background:#fff;border:1px solid #9ca8b5;border-radius:10px;box-shadow:0 10px 50px #0004;width:min(850px,calc(100vw - 32px));max-height:calc(100vh - 90px);overflow:auto;padding:16px;box-sizing:border-box;margin-bottom:8px}
    [hidden]{display:none!important}.bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}h2{font-size:19px;margin:0 auto 0 0}p{margin:10px 0}select{max-width:100%;padding:6px}#changes{white-space:pre-wrap;overflow-wrap:anywhere;max-height:38vh;overflow:auto;padding:12px;background:#f4f6f8}ins{background:#c6f4d4;color:#143c24;text-decoration:underline}del{background:#fbd2d2;color:#652020}iframe{width:100%;height:40vh;border:1px solid #aab4bf}input{padding:7px;max-width:100%}#status{color:#4c5967}#lock{margin:12px 0}#close{margin-left:auto}
  </style><section id="panel" hidden aria-label="Document history"><div class="bar"><h2>Document history</h2><button id="close" aria-label="Close history">Close</button></div><p id="summary"></p><label>Version <select id="versions"></select></label><p id="status" role="status"></p><form id="lock" hidden><label>Password for this version <input id="password" type="password" autocomplete="off" required></label> <button>Unlock version</button></form><div class="bar"><button id="changes-tab">Changes since this version</button><button id="preview-tab">View this version</button></div><p id="legend">Added text is underlined in green. Removed text is crossed out in red.</p><div id="changes"></div><iframe id="preview" title="Previous document version" sandbox="" hidden></iframe></section><button id="toggle" aria-expanded="false">History</button>`;
  document.body.appendChild(host);
  const el = (id) => root.getElementById(id);
  const cache = new Map([[data.version, data.currentHtml]]);
  let selectedHtml = null;
  let generation = 0;
  let password = '';
  el('summary').textContent = `Current version: ${data.version}. History begins with publishes made using a history-enabled htmldrop.`;
  [...data.revisions].reverse().forEach((revision) => {
    const option = document.createElement('option');
    option.value = revision.number;
    option.textContent = `Version ${revision.number}${revision.number === data.version ? ' (current)' : ''} · ${new Date(revision.date).toLocaleString()}${revision.encrypted ? ' · protected' : ''}${revision.unavailable ? ' · unavailable' : ''}`;
    el('versions').appendChild(option);
  });
  if (data.revisions.length > 1) el('versions').value = data.revisions.at(-2).number;
  function textOf(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script,style,noscript,template').forEach((node) => node.remove());
    template.content.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,section,article,header,footer,aside,nav,li,tr,td,th,br').forEach((node) => {
      node.before(document.createTextNode(' '));
      node.after(document.createTextNode(' '));
    });
    return template.content.textContent.replace(/\s+/g, ' ').trim();
  }
  function render(html) {
    selectedHtml = html;
    el('changes').replaceChildren();
    const previous = textOf(html);
    const current = textOf(data.currentHtml);
    if (previous === current) el('changes').textContent = 'No text changes. Layout, styling, or script changes may still differ.';
    else diffWords(previous, current).forEach((part) => {
      const node = document.createElement(part.type === 'added' ? 'ins' : part.type === 'removed' ? 'del' : 'span');
      node.textContent = part.text;
      el('changes').appendChild(node);
    });
    // The first CSP applies to the whole preview, including any later policies.
    // sandbox has no allowances: scripts, forms, popups and parent access cannot run.
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">`;
    const preview = document.createElement('template');
    preview.innerHTML = html;
    // CSP blocks resource loads; removing navigation features also prevents a
    // historical refresh/link from navigating the frame to an external page.
    preview.content.querySelectorAll('script,iframe,frame,object,embed,base,meta[http-equiv],link').forEach((node) => node.remove());
    preview.content.querySelectorAll('*').forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name) || /^(?:href|xlink:href|action|formaction|ping|srcdoc)$/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
    });
    el('preview').srcdoc = policy + preview.innerHTML;
    el('status').textContent = 'Preview disables scripts and external resources. Changes compare readable text with the current version.';
  }
  async function decrypt(envelope, secret) {
    const [version, salt, iv, ciphertext] = envelope.split(':');
    if (version !== 'v2') throw new Error('Unsupported history encryption');
    const bytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, key, bytes(ciphertext)));
  }
  async function select() {
    const attempt = ++generation;
    const revision = data.revisions.find((item) => item.number === Number(el('versions').value));
    selectedHtml = null;
    el('changes').replaceChildren();
    el('preview').removeAttribute('srcdoc');
    el('lock').hidden = true;
    if (revision.unavailable) { el('status').textContent = 'This earlier version is unavailable. The publisher must restore its history archive.'; return; }
    if (cache.has(revision.number)) { render(cache.get(revision.number)); return; }
    if (!revision.encrypted) { cache.set(revision.number, revision.html); render(revision.html); return; }
    if (password) {
      el('status').textContent = 'Unlocking earlier version…';
      try {
        const html = await decrypt(revision.envelope, password);
        if (attempt !== generation) return;
        cache.set(revision.number, html);
        render(html);
        return;
      } catch { if (attempt !== generation) return; }
    }
    el('status').textContent = 'This version is protected. Enter the password used when it was published; it may differ from the current password.';
    el('lock').hidden = false;
  }
  function panel(open) {
    el('panel').hidden = !open;
    el('toggle').setAttribute('aria-expanded', String(open));
    if (open) select();
    else { password = ''; el('password').value = ''; }
  }
  el('toggle').onclick = () => panel(el('panel').hidden);
  el('close').onclick = () => panel(false);
  el('versions').onchange = select;
  el('lock').onsubmit = (event) => { event.preventDefault(); password = el('password').value; el('password').value = ''; select(); };
  el('changes-tab').onclick = () => { el('changes').hidden = false; el('legend').hidden = false; el('preview').hidden = true; };
  el('preview-tab').onclick = () => { el('changes').hidden = true; el('legend').hidden = true; el('preview').hidden = !selectedHtml; };
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') panel(false); });
}
