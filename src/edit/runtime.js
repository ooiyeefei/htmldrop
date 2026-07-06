// The edit-mode browser runtime, injected alongside the annotation widget.
//
// ONE surface, not two. Earlier this injected a separate "Conversation" chat
// panel next to the annotation widget — which split "annotate" (widget) from
// "send live" (chat) and let you reach the agent two confusingly-different ways.
// Now the annotation widget is the single surface for everything: a page-level
// comment is a message to the agent, a threaded reply is the agent's answer.
//
// This runtime adds only the thin control layer the widget doesn't have:
//   * a Live ⇄ Async mode toggle (Live = an agent poll is attached, comments
//     reach it in real time; Async = collect comments for a later pull, nothing
//     sent) — this is the batch-hold flag, surfaced as the mode the user asked for
//   * presence (idle / listening / working) + agent-reply notifications
//   * live reload on file change, scroll preservation, layout QA, auto-heal
//   * auto-open the comment input on text selection (lavish-like), and a
//     View toggle for clean reading
//
// It lives in its own shadow root so the artifact's CSS can't touch it.

export function injectEditRuntime(html, { key }) {
  const keyJson = JSON.stringify(String(key));
  const runtime = `<style id="htmldrop-edit-style">
:root.htmldrop-view #htmldrop-widget-host,
:root.htmldrop-view #htmldrop-edit-host,
:root.htmldrop-view .hd-area-overlay { display: none !important; }
:root.htmldrop-view body { margin-right: 0 !important; margin-bottom: 0 !important; }
:root.htmldrop-view mark.hd-hl { background: transparent !important; border-bottom-color: transparent !important; }
</style>
<script>
(function () {
  var KEY = ${keyJson};
  var SCROLL_KEY = 'htmldrop_edit_scroll:' + KEY;
  var WORKER = ''; // same-origin

  // Restore scroll after a live reload.
  try {
    var _y = sessionStorage.getItem(SCROLL_KEY);
    if (_y !== null) window.addEventListener('load', function () {
      window.scrollTo(0, parseInt(_y, 10) || 0);
      try { sessionStorage.removeItem(SCROLL_KEY); } catch (e) {}
    });
  } catch (e) {}

  // --- control bar (shadow-hosted, top-right, above the annotation widget) ---
  var host = document.createElement('div');
  host.id = 'htmldrop-edit-host';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; }',
    ".bar { position: fixed; top: 12px; right: 12px; z-index: 999992; width: 360px; max-width: calc(100vw - 24px);",
    "  background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.10);",
    "  font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif; font-size: 13px; color: #111827; overflow: hidden; }",
    '.row1 { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }',
    '.brand { font-weight: 700; letter-spacing: -.2px; font-size: 12px; color: #4f46e5; }',
    '.pr { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #6b7280; }',
    '.dt { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; transition: background .2s; }',
    '.spacer { margin-left: auto; }',
    // Live/Async segmented toggle
    '.seg { display: inline-flex; border: 1px solid #e5e7eb; border-radius: 999px; overflow: hidden; }',
    '.seg button { border: none; background: #fff; color: #6b7280; font: inherit; font-size: 11px; font-weight: 600;',
    '  padding: 5px 11px; cursor: pointer; }',
    '.seg button.on { background: #6366f1; color: #fff; }',
    '.ib { border: none; background: transparent; cursor: pointer; color: #9ca3af; border-radius: 6px;',
    '  width: 26px; height: 26px; font-size: 14px; display: flex; align-items: center; justify-content: center; }',
    '.ib:hover { background: #f3f4f6; color: #374151; }',
    '.hint { padding: 0 12px 10px; font-size: 11px; line-height: 1.45; color: #6b7280; }',
    '.hint b { color: #111827; }',
    // agent reply feed (collapsible)
    '.feed { border-top: 1px solid #f3f4f6; max-height: 40vh; overflow-y: auto; padding: 8px 12px; display: none; }',
    '.feed.show { display: block; }',
    '.msg { margin-bottom: 8px; }',
    '.msg .who { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #9ca3af; margin-bottom: 2px; }',
    '.msg.a .who { color: #4f46e5; }',
    '.msg .tx { line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }',
    '.batch { width: 100%; margin-top: 6px; background: #6366f1; color: #fff; border: none; border-radius: 8px;',
    '  padding: 8px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }',
    '.batch:hover { background: #4f46e5; } .batch:disabled { opacity: .5; cursor: not-allowed; }',
    '.status { margin: 0 12px 10px; font-size: 11px; line-height: 1.4; color: #b45309; background: #fef3c7; border-radius: 6px; padding: 6px 9px; display: none; }',
    '@media (max-width: 768px) { .bar { top: auto; bottom: 12px; right: 12px; left: 12px; width: auto; } }'
  ].join('\\n');
  shadow.appendChild(style);

  var bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML =
    '<div class="row1">' +
      '<span class="brand">Edit</span>' +
      '<span class="pr"><span class="dt" id="dt"></span><span id="pl">idle</span></span>' +
      '<span class="spacer"></span>' +
      '<span class="seg"><button id="mLive" class="on">\\u25cf Live</button><button id="mAsync">Async</button></span>' +
      '<button class="ib" id="feedToggle" title="Show/hide agent replies">\\u{1F4AC}</button>' +
      '<button class="ib" id="view" title="Toggle view / annotate"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
    '</div>' +
    '<div class="hint" id="hint"></div>' +
    '<div class="status" id="status"></div>' +
    '<div class="feed" id="feed"></div>';
  shadow.appendChild(bar);

  var dt = shadow.getElementById('dt');
  var pl = shadow.getElementById('pl');
  var mLive = shadow.getElementById('mLive');
  var mAsync = shadow.getElementById('mAsync');
  var hint = shadow.getElementById('hint');
  var statusEl = shadow.getElementById('status');
  var feed = shadow.getElementById('feed');

  var agentPresence = 'waiting';
  var ended = false;
  var holdOn = false; // Async mode === hold comments (don't wake the agent)

  var statusTimer;
  function flashStatus(text) {
    statusEl.textContent = text; statusEl.style.display = 'block';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { if (statusEl.dataset.sticky !== '1') statusEl.style.display = 'none'; }, 6000);
  }

  // --- mode (Live ⇄ Async) --------------------------------------------------
  // Live: an agent poll is attached; comments reach it in real time (hold off).
  // Async: collect comments for a later pull; nothing is sent (hold on). A
  // "Send N to agent" button appears in Async so you can flush a batch on demand.
  function renderMode() {
    mLive.classList.toggle('on', !holdOn);
    mAsync.classList.toggle('on', holdOn);
    if (holdOn) {
      fetch(WORKER + '/api/edit/' + KEY + '/hold').then(function (r) { return r.json(); }).then(function (d) {
        var n = (d && d.pending) || 0;
        hint.innerHTML = '<b>Async</b> — comments are collected on the page for a later pull. Nothing is sent to the agent until you send the batch.' +
          '<button class="batch" id="batch"' + (n ? '' : ' disabled') + '>Send ' + n + ' comment(s) to agent \\u2192</button>';
        var b = shadow.getElementById('batch');
        if (b) b.addEventListener('click', function () {
          b.disabled = true;
          fetch(WORKER + '/api/edit/' + KEY + '/flush', { method: 'POST', headers: { 'content-type': 'application/json' } })
            .then(function () { flashStatus('Batch sent to the agent.'); setTimeout(renderMode, 400); })
            .catch(function () { renderMode(); });
        });
      }).catch(function () {});
    } else {
      hint.innerHTML = '<b>Live</b> — comment or reply anywhere on the page (select text to comment on it) and it reaches the listening agent right away. The page reloads as the agent edits.';
    }
  }
  function setMode(live) {
    holdOn = !live;
    fetch(WORKER + '/api/edit/' + KEY + '/hold', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: holdOn })
    }).then(function () { renderMode(); }).catch(function () {});
  }
  mLive.addEventListener('click', function () { setMode(true); });
  mAsync.addEventListener('click', function () { setMode(false); });

  // --- agent reply feed -----------------------------------------------------
  // The agent's replies (via edit reply) show here so the human sees responses
  // without leaving the page. Reviewer comments live in the annotation widget.
  function renderFeed(chat) {
    var agentMsgs = (chat || []).filter(function (m) { return m.role === 'agent'; });
    feed.replaceChildren();
    if (!agentMsgs.length) { feed.classList.remove('show'); return; }
    agentMsgs.slice(-12).forEach(function (m) {
      var d = document.createElement('div'); d.className = 'msg a';
      var w = document.createElement('div'); w.className = 'who'; w.textContent = 'Agent';
      var t = document.createElement('div'); t.className = 'tx'; t.textContent = m.text || '';
      d.appendChild(w); d.appendChild(t); feed.appendChild(d);
    });
  }
  var feedManualToggle = false;
  shadow.getElementById('feedToggle').addEventListener('click', function () {
    feedManualToggle = !feed.classList.contains('show');
    feed.classList.toggle('show');
  });
  function loadChat() {
    fetch(WORKER + '/api/edit/' + KEY + '/chat').then(function (r) { return r.json(); })
      .then(function (d) { renderFeed(d.chat || []); }).catch(function () {});
  }

  // --- presence -------------------------------------------------------------
  var STATES = { waiting: ['#9ca3af', 'idle'], listening: ['#22c55e', 'listening'], working: ['#f59e0b', 'working'] };
  function setState(s) {
    agentPresence = (s === 'listening' || s === 'working') ? s : 'waiting';
    var v = STATES[agentPresence]; dt.style.background = v[0]; pl.textContent = v[1];
  }

  // --- View toggle ----------------------------------------------------------
  shadow.getElementById('view').addEventListener('click', function () {
    document.documentElement.classList.toggle('htmldrop-view');
  });

  // --- Layout QA ------------------------------------------------------------
  function cssPath(el) {
    if (!el || el === document.body || !el.tagName) return 'body';
    var parts = [], n = el, depth = 0;
    while (n && n !== document.body && n.tagName && depth < 6) {
      var part = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + n.id); return parts.join(' > '); }
      var p = n.parentElement;
      if (p) { var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName; }); if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      parts.unshift(part); n = p; depth++;
    }
    return parts.join(' > ');
  }
  function isHidden(el) {
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return true;
    var r = el.getBoundingClientRect(); return r.width < 1 && r.height < 1;
  }
  function shortText(el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60); }
  function auditLayout() {
    var out = [];
    var docW = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > docW + 2)
      out.push({ kind: 'page-overflow', selector: 'html', detail: 'Page scrolls horizontally: content is ' + (document.documentElement.scrollWidth - docW) + 'px wider than the viewport (' + docW + 'px).', severity: 'high' });
    var all = document.body ? document.body.querySelectorAll('*') : [], seen = 0;
    for (var i = 0; i < all.length && seen < 4000; i++) {
      var el = all[i]; seen++;
      if (host.contains(el) || (el.closest && el.closest('#htmldrop-edit-host'))) continue;
      if (el.id === 'htmldrop-widget-host' || (el.closest && el.closest('#htmldrop-widget-host'))) continue;
      if (isHidden(el)) continue;
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (r.width > docW + 2 && el.parentElement === document.body)
        out.push({ kind: 'element-overflow', selector: cssPath(el), detail: 'Element is ' + Math.round(r.width) + 'px wide, past the ' + docW + 'px viewport.', text: shortText(el), severity: 'high' });
      var clipsY = el.scrollHeight - el.clientHeight > 4 && (cs.overflowY === 'hidden' || cs.overflow === 'hidden');
      var clipsX = el.scrollWidth - el.clientWidth > 4 && (cs.overflowX === 'hidden' || cs.overflow === 'hidden');
      if ((clipsY || clipsX) && (el.textContent || '').trim())
        out.push({ kind: 'clipped-text', selector: cssPath(el), detail: 'Text is clipped by a fixed-size container.', text: shortText(el), severity: 'medium' });
      if (out.length >= 60) break;
    }
    return out;
  }
  var layoutTimer;
  function runAudit() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(function () {
      var warnings; try { warnings = auditLayout(); } catch (e) { return; }
      var docHash = null;
      try { var h = document.getElementById('htmldrop-widget-host'); docHash = h && h.dataset ? h.dataset.docHash : null; } catch (e) {}
      fetch(WORKER + '/api/edit/' + KEY + '/layout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ warnings: warnings, docHash: docHash }) }).catch(function () {});
    }, 350);
  }
  window.addEventListener('load', runAudit);
  window.addEventListener('resize', runAudit);

  // --- SSE ------------------------------------------------------------------
  try {
    var es = new EventSource('/__edit/events/' + KEY);
    es.addEventListener('chat', function (e) {
      try { var chat = JSON.parse(e.data).chat || []; renderFeed(chat);
        // auto-reveal the feed when a new agent reply arrives
        if (chat.some(function (m) { return m.role === 'agent'; })) feed.classList.add('show');
      } catch (_) {}
    });
    es.addEventListener('presence', function (e) { try { setState(JSON.parse(e.data).state); } catch (_) {} });
    es.addEventListener('reload', function () {
      try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || window.pageYOffset || 0)); } catch (e) {}
      location.reload();
    });
    es.addEventListener('ended', function () { ended = true; setState('waiting'); pl.textContent = 'ended'; });
    es.addEventListener('hold', function (e) { try { holdOn = !!JSON.parse(e.data).hold; renderMode(); } catch (_) {} });
  } catch (e) {}

  // Refresh the Async batch count on a light interval while in Async mode.
  setInterval(function () { if (holdOn && !ended) renderMode(); }, 2500);

  // --- auto-heal on a dropped/restarted server ------------------------------
  var sawOutage = false;
  setInterval(function () {
    fetch('/health', { cache: 'no-store' }).then(function (r) {
      if (r.ok && sawOutage) { location.reload(); return; }
      if (r.ok && statusEl.dataset.sticky === '1') { statusEl.dataset.sticky = ''; statusEl.style.display = 'none'; }
    }).catch(function () {
      sawOutage = true; statusEl.dataset.sticky = '1';
      statusEl.textContent = 'Local server unreachable — comments won\\u2019t save until it\\u2019s back. Keep this tab open; it reconnects automatically.';
      statusEl.style.display = 'block';
    });
  }, 3000);

  // Adopt current mode from the server (survives reload) + initial render.
  fetch(WORKER + '/api/edit/' + KEY + '/hold').then(function (r) { return r.json(); })
    .then(function (d) { holdOn = !!(d && d.hold); renderMode(); }).catch(function () { renderMode(); });
  loadChat();
})();
</script>`;

  if (html.includes('</body>')) return html.replace('</body>', `${runtime}\n</body>`);
  if (html.includes('</html>')) return html.replace('</html>', `${runtime}\n</html>`);
  return html + `\n${runtime}`;
}
