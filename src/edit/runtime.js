// The edit-mode browser runtime, injected beside the (untouched) comment widget.
//
// Edit mode is the author sitting WITH the agent, in real time, before/between
// rounds of external feedback. So this adds a conversation panel on the LEFT
// (you talk to the agent; it edits the live doc and replies) while the comment
// widget stays on the RIGHT (read reviewers' notes, highlight, annotate). Two
// channels, cleanly split:
//
//   * Comments (right, the reused widget) — persistent annotations, shared with
//     reviewers when published. Not modified here.
//   * Chat (left, this file) — transient instructions to the agent, delivered
//     via the poll and answered with `htmldrop edit reply`.
//
// Plus: live reload on file change (agent edits → page updates, comments
// re-anchor via the widget's docHash guard), a presence dot, and an
// Annotate⇄View toggle that hides both panels for clean reading.
//
// The panel lives in a shadow root (like the widget) so the artifact's CSS can
// neither style nor break it. Plain, defensive JS — it runs inside arbitrary
// user HTML.

export function injectEditRuntime(html, { key }) {
  const keyJson = JSON.stringify(String(key));
  const runtime = `<style id="htmldrop-edit-style">
:root.htmldrop-view #htmldrop-widget-host,
:root.htmldrop-view #htmldrop-edit-chat-host,
:root.htmldrop-view .hd-area-overlay { display: none !important; }
:root.htmldrop-view body { margin-left: 0 !important; margin-right: 0 !important; margin-bottom: 0 !important; }
:root.htmldrop-view mark.hd-hl { background: transparent !important; border-bottom-color: transparent !important; }
</style>
<script>
(function () {
  var KEY = ${keyJson};
  var SCROLL_KEY = 'htmldrop_edit_scroll:' + KEY;
  var DRAFT_KEY = 'htmldrop_edit_draft:' + KEY;
  var WORKER = ''; // same-origin

  // Restore scroll after a live reload.
  try {
    var _y = sessionStorage.getItem(SCROLL_KEY);
    if (_y !== null) window.addEventListener('load', function () {
      window.scrollTo(0, parseInt(_y, 10) || 0);
      try { sessionStorage.removeItem(SCROLL_KEY); } catch (e) {}
    });
  } catch (e) {}

  // Track the last non-empty text selection made in the DOCUMENT (not our
  // panels) so "Attach selection" can pin a chat message to it.
  var lastSel = null;
  function buildSelector(node) {
    if (!node || node === document.body) return '';
    var parts = [], n = node;
    while (n && n !== document.body && parts.length < 6) {
      if (!n.tagName) break;
      var part = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + n.id); break; }
      var p = n.parentElement;
      if (p) {
        var sib = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName; });
        if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      }
      parts.unshift(part); n = p;
    }
    return parts.join(' > ');
  }
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var t = sel.toString().trim();
    if (!t) return;
    var node = sel.anchorNode;
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el) return;
    if (host.contains(el) || (el.closest && el.closest('#htmldrop-widget-host'))) return; // ignore panel selections
    lastSel = { kind: 'selection', text: t.slice(0, 500), selector: buildSelector(el) };
  });

  // --- shadow-hosted conversation panel (left) ------------------------------
  var host = document.createElement('div');
  host.id = 'htmldrop-edit-chat-host';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; }',
    '.p { position: fixed; top: 0; left: 0; width: 360px; height: 100vh; background: #fff;',
    '  border-right: 1px solid #e5e7eb; z-index: 999980; display: flex; flex-direction: column;',
    "  font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;",
    '  font-size: 13px; color: #111827; box-shadow: 1px 0 3px rgba(0,0,0,.04); }',
    '.hd { padding: 14px 16px; border-bottom: 1px solid #f3f4f6; display: flex; align-items: center; gap: 8px; }',
    '.ti { font-weight: 600; letter-spacing: -.2px; }',
    '.pr { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 11px; color: #6b7280; }',
    '.dt { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; transition: background .2s; }',
    '.ib { border: none; background: transparent; cursor: pointer; color: #9ca3af; border-radius: 6px;',
    '  width: 26px; height: 26px; font-size: 15px; display: flex; align-items: center; justify-content: center; }',
    '.ib:hover { background: #f3f4f6; color: #374151; }',
    '.lg { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }',
    '.b { max-width: 88%; padding: 8px 11px; border-radius: 12px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }',
    '.b.u { align-self: flex-end; background: #6366f1; color: #fff; border-bottom-right-radius: 3px; }',
    '.b.a { align-self: flex-start; background: #f3f4f6; color: #111827; border-bottom-left-radius: 3px; }',
    '.rl { font-size: 10px; opacity: .65; margin-bottom: 2px; }',
    '.cx { align-self: flex-end; max-width: 88%; font-size: 11px; color: #4f46e5; background: #eef2ff;',
    '  border-radius: 6px; padding: 3px 8px; margin-bottom: -4px; }',
    '.em { margin: auto 0; text-align: center; color: #9ca3af; font-size: 12px; padding: 24px; line-height: 1.6; }',
    '.co { border-top: 1px solid #f3f4f6; padding: 12px; }',
    '.chip { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #4f46e5; background: #eef2ff;',
    '  border-radius: 6px; padding: 4px 8px; margin-bottom: 8px; }',
    '.chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.chip button { border: none; background: transparent; color: #6b7280; cursor: pointer; margin-left: auto; font-size: 13px; }',
    '.ta { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 9px 11px; font: inherit;',
    '  resize: vertical; min-height: 64px; outline: none; line-height: 1.45; }',
    '.ta:focus { border-color: #6366f1; }',
    '.status { margin-top: 8px; font-size: 11.5px; line-height: 1.4; color: #b45309; background: #fef3c7;',
    '  border-radius: 6px; padding: 6px 9px; }',
    '.row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }',
    '.att { border: 1px solid #e5e7eb; background: #fff; color: #6b7280; border-radius: 6px; padding: 7px 10px;',
    '  font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }',
    '.att:hover { border-color: #6366f1; color: #4f46e5; }',
    '.sn { margin-left: auto; background: #6366f1; color: #fff; border: none; border-radius: 8px; padding: 8px 16px;',
    '  font: inherit; font-weight: 600; cursor: pointer; }',
    '.sn:hover { background: #4f46e5; } .sn:disabled { opacity: .5; cursor: not-allowed; }',
    '.launch { position: fixed; left: 16px; bottom: 16px; background: #6366f1; color: #fff; border: none;',
    '  border-radius: 999px; padding: 10px 15px; font: 600 12px system-ui; cursor: pointer;',
    '  box-shadow: 0 2px 10px rgba(0,0,0,.18); display: none; align-items: center; gap: 7px; }',
    '@media (max-width: 820px) { .p { width: 86vw; } }'
  ].join('\\n');
  shadow.appendChild(style);

  var panel = document.createElement('div');
  panel.className = 'p';
  panel.innerHTML =
    '<div class="hd"><span class="ti">Conversation</span>' +
    '<span class="pr"><span class="dt" id="dt"></span><span id="pl">idle</span></span>' +
    '<button class="ib" id="view" title="Toggle view / annotate"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
    '<button class="ib" id="min" title="Minimize">\\u2013</button></div>' +
    '<div class="lg" id="lg"></div>' +
    '<div class="co">' +
    '<div class="chip" id="chip" style="display:none"><span id="chiptext"></span><button id="chipx">\\u00d7</button></div>' +
    '<textarea class="ta" id="ta" placeholder="Ask the agent to refine the page..."></textarea>' +
    '<div class="status" id="status" style="display:none"></div>' +
    '<div class="row"><button class="att" id="att">\\u2295 Attach selection</button>' +
    '<button class="sn" id="sn">Send to agent</button></div></div>';
  shadow.appendChild(panel);

  var launch = document.createElement('button');
  launch.className = 'launch';
  launch.textContent = '\\u{1F4AC} Chat with agent';
  shadow.appendChild(launch);

  var lg = shadow.getElementById('lg');
  var ta = shadow.getElementById('ta');
  var sn = shadow.getElementById('sn');
  var att = shadow.getElementById('att');
  var chip = shadow.getElementById('chip');
  var chipText = shadow.getElementById('chiptext');
  var dt = shadow.getElementById('dt');
  var pl = shadow.getElementById('pl');
  var statusEl = shadow.getElementById('status');

  document.body.style.marginLeft = '360px';
  var pendingContext = null;
  var agentPresence = 'waiting';
  var ended = false;

  // --- chat rendering -------------------------------------------------------
  function renderChat(chat) {
    lg.replaceChildren();
    if (!chat || !chat.length) {
      var e = document.createElement('div');
      e.className = 'em';
      e.textContent = 'Talk to the agent about this page. Select text and Attach it to point at a spot. The page updates live as the agent edits.';
      lg.appendChild(e);
      return;
    }
    chat.forEach(function (m) {
      if (m.context && m.context.text) {
        var cx = document.createElement('div');
        cx.className = 'cx';
        cx.textContent = 're: "' + m.context.text.slice(0, 60) + '"';
        lg.appendChild(cx);
      }
      var b = document.createElement('div');
      b.className = 'b ' + (m.role === 'agent' ? 'a' : 'u');
      var r = document.createElement('div');
      r.className = 'rl';
      r.textContent = m.role === 'agent' ? 'Agent' : 'You';
      var t = document.createElement('div');
      t.textContent = m.text || '';
      b.appendChild(r); b.appendChild(t);
      lg.appendChild(b);
    });
    lg.scrollTop = lg.scrollHeight;
  }

  function loadChat() {
    fetch(WORKER + '/api/edit/' + KEY + '/chat')
      .then(function (r) { return r.json(); })
      .then(function (d) { renderChat(d.chat || []); })
      .catch(function () {});
  }

  function send() {
    if (sn.disabled) return; // locked (agent working); note: NOT blocked when ended (C)
    var text = ta.value.trim();
    if (!text) return;
    var body = { text: text, context: pendingContext };
    sn.disabled = true; // in-flight guard against double-send
    ended = false; // C: sending reopens an ended session (server reopens too)
    fetch(WORKER + '/api/edit/' + KEY + '/message', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
      ta.value = ''; clearChip();
      // B: honest feedback about whether a listener actually caught it.
      if (d && d.delivered) {
        // Agent was polling — it just took this. Lock composer; 'working' SSE confirms.
        setState('working');
      } else {
        // No poll open — the message is queued and will reach the agent on its
        // next poll. Say so plainly instead of pretending it was received.
        flashStatus('Queued — agent isn\\u2019t listening yet. It\\u2019ll arrive on the next poll.');
        updateSendState();
      }
    }).catch(function () { flashStatus('Send failed — check the connection.'); updateSendState(); });
  }

  function clearChip() { pendingContext = null; chip.style.display = 'none'; chipText.textContent = ''; persistDraft(); }

  // Persist the in-progress draft (unsent text + attached context) to
  // sessionStorage so a live-reload — or a refresh / connectivity blip — never
  // loses what you were typing. Same pattern as the scroll restore above; sent
  // messages already survive on the server, this covers the unsent tail.
  function persistDraft() {
    try {
      if (ta.value || pendingContext) {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text: ta.value, context: pendingContext }));
      } else {
        sessionStorage.removeItem(DRAFT_KEY);
      }
    } catch (e) { /* storage unavailable — the in-memory draft still works */ }
  }
  function restoreDraft() {
    try {
      var raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && typeof d.text === 'string') ta.value = d.text;
      if (d && d.context && d.context.text) {
        pendingContext = d.context;
        chipText.textContent = 're: "' + d.context.text.slice(0, 48) + '"';
        chip.style.display = 'flex';
      }
    } catch (e) { /* malformed draft — ignore */ }
  }

  att.addEventListener('click', function () {
    if (!lastSel || !lastSel.text) { att.textContent = '\\u2295 Select text first'; setTimeout(function () { att.textContent = '\\u2295 Attach selection'; }, 1500); return; }
    pendingContext = lastSel;
    chipText.textContent = 're: "' + lastSel.text.slice(0, 48) + '"';
    chip.style.display = 'flex';
    persistDraft();
  });
  shadow.getElementById('chipx').addEventListener('click', clearChip);
  sn.addEventListener('click', send);
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', persistDraft);

  // --- minimize + view ------------------------------------------------------
  function setMinimized(on) {
    panel.style.display = on ? 'none' : 'flex';
    launch.style.display = on ? 'flex' : 'none';
    document.body.style.marginLeft = on ? '0' : '360px';
  }
  shadow.getElementById('min').addEventListener('click', function () { setMinimized(true); });
  launch.addEventListener('click', function () { setMinimized(false); });
  shadow.getElementById('view').addEventListener('click', function () {
    document.documentElement.classList.toggle('htmldrop-view');
  });

  // --- presence + send lock -------------------------------------------------
  // While the agent is "working" (it took your last message and hasn't replied
  // or re-polled), lock the composer so messages can't pile up mid-edit — the
  // same rule Lavish uses. Unlocks on the agent's reply or its next poll.
  var STATES = { waiting: ['#9ca3af', 'idle'], listening: ['#22c55e', 'listening'], working: ['#f59e0b', 'working'] };
  function updateSendState() {
    var working = agentPresence === 'working';
    // C: when ended, the composer stays ALIVE — a Send reopens the session
    // (server-side too) so you re-engage from the page, no terminal trip. Only
    // "working" locks it (a message is in flight to the agent).
    sn.disabled = working;
    att.disabled = working;
    ta.disabled = false;
    sn.textContent = working ? 'Agent working…' : (ended ? 'Re-engage agent' : 'Send to agent');
  }
  // Transient one-line status under the composer (honest send feedback — B).
  var statusTimer;
  function flashStatus(text) {
    statusEl.textContent = text;
    statusEl.style.display = 'block';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { statusEl.style.display = 'none'; }, 6000);
  }
  function setState(s) {
    agentPresence = (s === 'listening' || s === 'working') ? s : 'waiting';
    var v = STATES[agentPresence];
    dt.style.background = v[0];
    pl.textContent = v[1];
    updateSendState();
  }

  // --- Layout QA ------------------------------------------------------------
  // Measure the RENDERED page and report layout problems the agent can't "see"
  // from source: horizontal overflow (the big one for narrow review panels),
  // text clipped by its container, and overlapping text runs. Runs after load
  // and on debounced resize; posts the current warning set to the server, which
  // hands it to the agent on the next poll. Read-only — never mutates the page.
  function cssPath(el) {
    if (!el || el === document.body || !el.tagName) return 'body';
    var parts = [], n = el, depth = 0;
    while (n && n !== document.body && n.tagName && depth < 6) {
      var part = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + n.id); return parts.join(' > '); }
      var p = n.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part); n = p; depth++;
    }
    return parts.join(' > ');
  }
  function isHidden(el) {
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return true;
    var r = el.getBoundingClientRect();
    return r.width < 1 && r.height < 1;
  }
  function shortText(el) {
    return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  }
  function auditLayout() {
    var out = [];
    var seen = 0;
    // 1) Horizontal overflow — page or any element wider than the viewport, or a
    //    child spilling past a non-scroll parent. Highest severity: it's the most
    //    common rich-artifact bug and the hardest to notice at desk width.
    var docW = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > docW + 2) {
      out.push({ kind: 'page-overflow', selector: 'html', detail: 'Page scrolls horizontally: content is ' + (document.documentElement.scrollWidth - docW) + 'px wider than the viewport (' + docW + 'px).', severity: 'high' });
    }
    var all = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length && seen < 4000; i++) {
      var el = all[i];
      seen++;
      if (host.contains(el) || (el.closest && el.closest('#htmldrop-edit-chat-host'))) continue; // skip our own UI
      if (el.id === 'htmldrop-widget-host' || (el.closest && el.closest('#htmldrop-widget-host'))) continue;
      if (isHidden(el)) continue;
      var cs = getComputedStyle(el);
      // element wider than viewport
      var r = el.getBoundingClientRect();
      if (r.width > docW + 2 && el.parentElement === document.body) {
        out.push({ kind: 'element-overflow', selector: cssPath(el), detail: 'Element is ' + Math.round(r.width) + 'px wide, past the ' + docW + 'px viewport.', text: shortText(el), severity: 'high' });
      }
      // 2) Clipped text — content taller/wider than a fixed, non-scrolling box.
      var clipsY = el.scrollHeight - el.clientHeight > 4 && (cs.overflowY === 'hidden' || cs.overflow === 'hidden');
      var clipsX = el.scrollWidth - el.clientWidth > 4 && (cs.overflowX === 'hidden' || cs.overflow === 'hidden');
      if ((clipsY || clipsX) && (el.textContent || '').trim()) {
        out.push({ kind: 'clipped-text', selector: cssPath(el), detail: 'Text is clipped by a fixed-size container (overflow:hidden hides ' + (clipsY ? (el.scrollHeight - el.clientHeight) + 'px vertically' : (el.scrollWidth - el.clientWidth) + 'px horizontally') + ').', text: shortText(el), severity: 'medium' });
      }
      if (out.length >= 60) break;
    }
    return out;
  }
  var layoutTimer;
  function runAudit() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(function () {
      var warnings;
      try { warnings = auditLayout(); } catch (e) { return; }
      var docHash = null;
      try { var h = document.getElementById('htmldrop-widget-host'); docHash = h && h.dataset ? h.dataset.docHash : null; } catch (e) {}
      fetch(WORKER + '/api/edit/' + KEY + '/layout', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warnings: warnings, docHash: docHash })
      }).catch(function () {});
    }, 350);
  }
  window.addEventListener('load', runAudit);
  window.addEventListener('resize', runAudit);

  // --- SSE ------------------------------------------------------------------
  try {
    var es = new EventSource('/__edit/events/' + KEY);
    es.addEventListener('chat', function (e) { try { renderChat(JSON.parse(e.data).chat || []); } catch (_) {} });
    es.addEventListener('presence', function (e) { try { setState(JSON.parse(e.data).state); } catch (_) {} });
    es.addEventListener('reload', function () {
      try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || window.pageYOffset || 0)); } catch (e) {}
      location.reload();
    });
    es.addEventListener('ended', function () {
      ended = true; setState('waiting'); pl.textContent = 'ended';
      // C: don't lock the composer — a Send will reopen the session from here.
      flashStatus('Session ended. Type a message to re-engage the agent.');
    });
  } catch (e) {}

  restoreDraft();
  updateSendState();
  loadChat();
})();
</script>`;

  if (html.includes('</body>')) return html.replace('</body>', `${runtime}\n</body>`);
  if (html.includes('</html>')) return html.replace('</html>', `${runtime}\n</html>`);
  return html + `\n${runtime}`;
}
