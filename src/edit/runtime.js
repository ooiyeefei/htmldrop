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
//   * auto-open the comment input on text selection, and a
//     View toggle for clean reading
//
// It lives in its own shadow root so the artifact's CSS can't touch it.

export function injectEditRuntime(html, { key, version = '0' }) {
  const keyJson = JSON.stringify(String(key));
  const verJson = JSON.stringify(String(version));
  const runtime = `<style id="htmldrop-edit-style">
:root.htmldrop-view #htmldrop-widget-host,
:root.htmldrop-view .hd-area-overlay { display: none !important; }
:root.htmldrop-view body { margin-right: 0 !important; margin-bottom: 0 !important; }
:root.htmldrop-view mark.hd-hl { background: transparent !important; border-bottom-color: transparent !important; }
</style>
<script>
(function () {
  var KEY = ${keyJson};
  var BUILT_VERSION = ${verJson}; // version this runtime was served from
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
    '.ib.pubib { background: #eef2ff; color: #4f46e5; }',
    '.ib.pubib:hover { background: #e0e7ff; color: #4338ca; }',
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
    // Agent → user question card (dynamic UI rendered from the agent-sent spec)
    '.qcard { border-top: 1px solid #f3f4f6; padding: 12px; display: none; background: #f5f3ff; }',
    '.qcard.show { display: block; }',
    '.qcard .qlabel { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #6d28d9; margin-bottom: 5px; }',
    '.qcard .qtext { font-size: 13px; line-height: 1.45; color: #111827; margin-bottom: 10px; }',
    '.qopts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }',
    '.qopt { border: 1px solid #c4b5fd; background: #fff; color: #5b21b6; border-radius: 8px; padding: 6px 12px;',
    '  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }',
    '.qopt:hover { background: #ede9fe; } .qopt.sel { background: #6d28d9; color: #fff; border-color: #6d28d9; }',
    '.qnote { width: 100%; border: 1px solid #ddd6fe; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 12px;',
    '  resize: vertical; min-height: 40px; outline: none; }',
    '.qnote:focus { border-color: #6d28d9; }',
    '.qsend { width: 100%; margin-top: 8px; background: #6d28d9; color: #fff; border: none; border-radius: 8px;',
    '  padding: 8px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }',
    '.qsend:hover { background: #5b21b6; } .qsend:disabled { opacity: .5; cursor: not-allowed; }',
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
      '<button class="ib" id="area" title="Comment on an area — click, then drag a box on the page">\\u25a2</button>' +
      '<button class="ib" id="feedToggle" title="Show/hide agent replies">\\u{1F4AC}</button>' +
      '<button class="ib" id="theme" title="Toggle light / dark theme">\\u263E</button>' +
      '<button class="ib" id="view" title="Toggle view / annotate"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
      '<button class="ib pubib" id="pub" title="Publish this document\\u2026">\\u{1F680}</button>' +
    '</div>' +
    '<div class="hint" id="hint"></div>' +
    '<div class="status" id="status"></div>' +
    '<div class="qcard" id="qcard"></div>' +
    '<div class="qcard" id="pubcard"></div>' +
    '<div class="feed" id="feed"></div>';
  shadow.appendChild(bar);

  var dt = shadow.getElementById('dt');
  var pl = shadow.getElementById('pl');
  var mLive = shadow.getElementById('mLive');
  var mAsync = shadow.getElementById('mAsync');
  var hint = shadow.getElementById('hint');
  var statusEl = shadow.getElementById('status');
  var feed = shadow.getElementById('feed');
  var qcard = shadow.getElementById('qcard');
  var pub = shadow.getElementById('pub');
  var pubcard = shadow.getElementById('pubcard');

  var agentPresence = 'waiting';
  var ended = false;
  var holdOn = false; // Async mode === hold comments (don't wake the agent)

  // Keep the comment panel clear of the floating bar. The panel lives in the
  // widget's shadow DOM, so we can't style it directly — but CSS custom props
  // inherit THROUGH shadow boundaries, so we publish the bar's bottom edge as
  // --htmldrop-edit-top on :root and the widget's .hd-panel reads it for its top
  // offset. Re-measured whenever the bar's size changes (mode/feed/question).
  function syncBarHeight() {
    try {
      var top = bar.getBoundingClientRect().bottom + 8; // 12px top + height + gap
      document.documentElement.style.setProperty('--htmldrop-edit-top', Math.round(top) + 'px');
    } catch (e) {}
  }
  window.addEventListener('resize', syncBarHeight);
  try { new ResizeObserver(syncBarHeight).observe(bar); } catch (e) {}

  var statusTimer;
  function flashStatus(text) {
    statusEl.textContent = text; statusEl.style.display = 'block';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { if (statusEl.dataset.sticky !== '1') statusEl.style.display = 'none'; }, 6000);
  }

  // --- mode (Live ⇄ Async) --------------------------------------------------
  // BOTH modes save your comment on the page — the difference is only WHEN the
  // agent is pinged about it:
  //   Live  — each comment pings the agent's poll immediately (real-time).
  //   Async — comments pile up quietly; the agent isn't pinged until you click
  //           "Send N to agent". Use it to leave a whole review pass, then send once.
  // (Whether the agent actually RECEIVES the ping depends on it running
  //  edit poll — the presence dot shows "listening" when it is.)
  function renderMode() {
    mLive.classList.toggle('on', !holdOn);
    mAsync.classList.toggle('on', holdOn);
    if (holdOn) {
      fetch(WORKER + '/api/edit/' + KEY + '/hold').then(function (r) { return r.json(); }).then(function (d) {
        var n = (d && d.pending) || 0;
        var h = document.createElement('div');
        var p = document.createElement('div');
        p.innerHTML = '<b>Async</b> — comments are collected on the page and held. The agent is <b>not</b> notified until you send the batch below.';
        h.appendChild(p);
        var b = document.createElement('button');
        b.className = 'batch'; b.id = 'batch';
        b.textContent = n ? ('Send ' + n + ' comment(s) to agent →') : 'No new comments to send';
        b.disabled = !n;
        b.addEventListener('click', function () {
          b.disabled = true; b.textContent = 'Sending…';
          fetch(WORKER + '/api/edit/' + KEY + '/flush', { method: 'POST', headers: { 'content-type': 'application/json' } })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (res) {
              // Honest: only claim "sent" if an agent was actually listening.
              if (res && res.delivered) flashStatus('Batch delivered to the agent.');
              else flashStatus('No agent is listening (presence: idle). Your comments stay queued — they\\u2019ll arrive when the agent runs edit poll.');
              setTimeout(renderMode, 500);
            })
            .catch(function () { renderMode(); });
        });
        h.appendChild(b);
        hint.replaceChildren(h);
      }).catch(function () {});
    } else {
      hint.innerHTML = '<b>Live</b> — each comment pings the listening agent right away, and the page reloads as it edits. (Comments still appear in the panel either way — Live vs Async only changes <i>when</i> the agent is notified.)';
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

  // --- area-box button (drives the widget's area mode across the shadow boundary)
  var areaBtn = shadow.getElementById('area');
  areaBtn.addEventListener('click', function () { window.postMessage({ type: 'htmldrop:area' }, '*'); });
  // Reflect the widget's area on/off state on the button.
  window.addEventListener('message', function (e) {
    if (e.source === window && e.data && e.data.type === 'htmldrop:areaState') {
      areaBtn.style.background = e.data.on ? '#6366f1' : '';
      areaBtn.style.color = e.data.on ? '#fff' : '';
    }
  });

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

  // --- Theme toggle (light ⇄ dark), persisted across live reloads -----------
  // The artifact owns its palette; we only stamp data-theme + color-scheme on
  // :root (the design-contract convention its CSS already honors). The choice is
  // saved to localStorage and re-applied pre-paint on every reload (head boot
  // script in injectEditRuntime), so a live reload never snaps back to the
  // artifact's default. Stored per-user (one key), not per-doc — a theme
  // preference is about you, not the document.
  var THEME_KEY = 'htmldrop_edit_theme';
  var themeBtn = shadow.getElementById('theme');
  function effectiveTheme() {
    var t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
    // No explicit choice yet — read what the artifact is actually showing.
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function syncThemeBtn(mode) {
    // Show the icon for the theme the click will switch TO.
    themeBtn.textContent = mode === 'dark' ? '\\u2600' : '\\u263E'; // \\u2600 = sun (\\u2192 light), \\u263E = moon (\\u2192 dark)
    themeBtn.title = 'Switch to ' + (mode === 'dark' ? 'light' : 'dark') + ' theme';
  }
  function applyTheme(mode) {
    var r = document.documentElement;
    r.dataset.theme = mode;
    r.style.colorScheme = mode;
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
    syncThemeBtn(mode);
  }
  // nextTheme(cur) — THE UX decision here. 2-state (light ⇄ dark) as asked. To
  // give a way back to OS-following, make this a 3-state cycle whose third value
  // clears the override: dark -> light -> 'system' (then applyTheme removes
  // data-theme/color-scheme instead of setting them) -> dark.
  function nextTheme(cur) { return cur === 'dark' ? 'light' : 'dark'; }
  themeBtn.addEventListener('click', function () { applyTheme(nextTheme(effectiveTheme())); });
  syncThemeBtn(effectiveTheme());

  // --- Publish (finish -> ask the agent to push it live) --------------------
  // The browser can't run the push itself (no shell). This sends a publish
  // REQUEST through the message channel; it lands on the agent's next edit poll,
  // the agent runs the actual push and replies with the URL. The choices map to
  // htmldrop's standard privacy levels (public / password-protected).
  function renderPublish(show) {
    pubcard.replaceChildren();
    if (!show) { pubcard.classList.remove('show'); syncBarHeight(); return; }
    var lab = document.createElement('div'); lab.className = 'qlabel'; lab.textContent = 'Publish';
    var txt = document.createElement('div'); txt.className = 'qtext';
    txt.textContent = 'Done editing? Ask the agent to publish this \\u2014 choose how people get in:';
    var opts = document.createElement('div'); opts.className = 'qopts';
    function option(label, instruction) {
      var b = document.createElement('button'); b.className = 'qopt'; b.textContent = label;
      b.addEventListener('click', function () {
        fetch(WORKER + '/api/edit/' + KEY + '/message', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: instruction })
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (res) {
            renderPublish(false);
            flashStatus(res && res.delivered
              ? 'Publish request sent \\u2014 the agent is pushing it and will reply with the link.'
              : 'Publish request queued \\u2014 it reaches the agent on its next edit poll, then it pushes and replies.');
          })
          .catch(function () { flashStatus('Couldn\\u2019t send the publish request \\u2014 try again.'); });
      });
      return b;
    }
    opts.appendChild(option('Public link',
      'The author finished editing and wants to PUBLISH this document as a PUBLIC link. Run htmldrop push for this file (public, no password), then reply with the URL.'));
    opts.appendChild(option('Password-protected',
      'The author finished editing and wants to PUBLISH this document PASSWORD-PROTECTED (private). Run htmldrop push with --generate-password for this file, then reply with the URL and the generated password.'));
    pubcard.appendChild(lab); pubcard.appendChild(txt); pubcard.appendChild(opts);
    pubcard.classList.add('show'); syncBarHeight();
  }
  pub.addEventListener('click', function () { renderPublish(!pubcard.classList.contains('show')); });

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
  // Severity protocol: errors block (fix before involving the human); warnings may ship with a note.
  function layoutWarning(kind, selector, detail, text, severity) {
    var w = { kind: kind, selector: selector, detail: detail };
    if (text) w.text = text;
    w.severity = severity;
    w.level = (severity === 'high' || severity === 'error') ? 'error' : 'warning';
    w.persistent = true;
    return w;
  }
  function isPositionedForOverlap(cs) {
    return cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky';
  }
  function isBlockLikeForOverlap(cs) {
    var d = cs.display || '';
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'table' || d === 'list-item' || d === 'flow-root' || d.indexOf('table-') === 0;
  }
  function isNormalInlineForOverlap(cs) {
    var d = cs.display || '';
    return cs.position === 'static' && (d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid');
  }
  function hasVisibleTextChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (!isHidden(child) && shortText(child)) return true;
    }
    return false;
  }
  function isTextOverlapCandidate(el, cs, r) {
    if (!shortText(el) || r.width < 2 || r.height < 2) return false;
    if (hasVisibleTextChild(el)) return false; // leaf-ish: avoid parent/child text boxes.
    return isPositionedForOverlap(cs) || isBlockLikeForOverlap(cs);
  }
  function overlapRect(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w <= 2 || h <= 2) return null;
    var area = w * h;
    var minArea = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
    if (area < 24 || area / minArea < 0.15) return null;
    return { width: w, height: h, area: area };
  }
  function sameNormalTextLine(a, b) {
    if (!a.normalInline || !b.normalInline) return false;
    var y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
    return y > Math.min(a.rect.height, b.rect.height) * 0.6;
  }
  function auditLayout() {
    var out = [];
    var docW = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > docW + 2)
      out.push(layoutWarning('page-overflow', 'html', 'Page scrolls horizontally: content is ' + (document.documentElement.scrollWidth - docW) + 'px wider than the viewport (' + docW + 'px).', '', 'high'));
    var all = document.body ? document.body.querySelectorAll('*') : [], seen = 0;
    var textCandidates = [];
    for (var i = 0; i < all.length && seen < 4000; i++) {
      var el = all[i]; seen++;
      if (host.contains(el) || (el.closest && el.closest('#htmldrop-edit-host'))) continue;
      if (el.id === 'htmldrop-widget-host' || (el.closest && el.closest('#htmldrop-widget-host'))) continue;
      if (isHidden(el)) continue;
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (r.width > docW + 2 && el.parentElement === document.body)
        out.push(layoutWarning('element-overflow', cssPath(el), 'Element is ' + Math.round(r.width) + 'px wide, past the ' + docW + 'px viewport.', shortText(el), 'high'));
      var clipsY = el.scrollHeight - el.clientHeight > 4 && (cs.overflowY === 'hidden' || cs.overflow === 'hidden');
      var clipsX = el.scrollWidth - el.clientWidth > 4 && (cs.overflowX === 'hidden' || cs.overflow === 'hidden');
      if ((clipsY || clipsX) && (el.textContent || '').trim())
        out.push(layoutWarning('clipped-text', cssPath(el), 'Text is clipped by a fixed-size container.', shortText(el), 'medium'));
      if (isTextOverlapCandidate(el, cs, r)) {
        var candidate = { el: el, rect: r, selector: cssPath(el), text: shortText(el), normalInline: isNormalInlineForOverlap(cs) };
        for (var j = textCandidates.length - 1, checked = 0; j >= 0 && checked < 30; j--, checked++) {
          var prev = textCandidates[j];
          if (prev.el.contains(candidate.el) || candidate.el.contains(prev.el)) continue;
          var overlap = overlapRect(candidate.rect, prev.rect);
          if (!overlap || sameNormalTextLine(candidate, prev)) continue;
          out.push(layoutWarning('overlapping-text', candidate.selector, 'Text overlaps ' + prev.selector + ' by about ' + Math.round(overlap.width) + '×' + Math.round(overlap.height) + 'px; this often means stacked duplicate text or hidden animation frames are visible.', candidate.text, 'high'));
          break;
        }
        textCandidates.push(candidate);
        if (textCandidates.length > 80) textCandidates.shift();
      }
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

  // --- agent → user question (dynamic card) ---------------------------------
  // Renders the agent-sent spec into a card: prompt + option buttons (chosen
  // one highlights) + a free-text note + Answer. Built with textContent (the
  // prompt/options are agent-authored) so there's no injection surface. The
  // answer POSTs back and wakes the agent's poll.
  function renderQuestion(q) {
    qcard.replaceChildren();
    if (!q) { qcard.classList.remove('show'); return; }
    var chosen = null;
    var lab = document.createElement('div'); lab.className = 'qlabel'; lab.textContent = 'Agent asks';
    var txt = document.createElement('div'); txt.className = 'qtext'; txt.textContent = q.text || '';
    qcard.appendChild(lab); qcard.appendChild(txt);
    if (q.options && q.options.length) {
      var opts = document.createElement('div'); opts.className = 'qopts';
      q.options.forEach(function (o) {
        var b = document.createElement('button'); b.className = 'qopt'; b.textContent = o;
        b.addEventListener('click', function () {
          chosen = (chosen === o) ? null : o; // toggle
          Array.prototype.forEach.call(opts.children, function (c) { c.classList.toggle('sel', c === b && chosen === o); });
        });
        opts.appendChild(b);
      });
      qcard.appendChild(opts);
    }
    var note = document.createElement('textarea'); note.className = 'qnote';
    note.placeholder = q.options && q.options.length ? 'or add a note…' : 'your answer…';
    qcard.appendChild(note);
    var send = document.createElement('button'); send.className = 'qsend'; send.textContent = 'Answer →';
    send.addEventListener('click', function () {
      var t = note.value.trim();
      if (!chosen && !t) { note.focus(); return; } // need a choice or a note
      send.disabled = true;
      fetch(WORKER + '/api/edit/' + KEY + '/answer', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: chosen || undefined, text: t || undefined })
      }).then(function () { renderQuestion(null); flashStatus('Answer sent to the agent.'); })
        .catch(function () { send.disabled = false; flashStatus('Couldn\\u2019t send answer — try again.'); });
    });
    qcard.appendChild(send);
    qcard.classList.add('show');
  }

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
    es.addEventListener('question', function (e) { try { renderQuestion(JSON.parse(e.data).question); } catch (_) {} });
  } catch (e) {}

  // Refresh the Async batch count on a light interval while in Async mode.
  setInterval(function () { if (holdOn && !ended) renderMode(); }, 2500);

  // --- auto-heal on a dropped/restarted server, and on a NEW version --------
  // Reload the tab when the server (a) recovers after an outage, or (b) reports
  // a different version than this runtime was built from — so restarting onto
  // upgraded code updates open tabs instead of leaving them on stale UI.
  var sawOutage = false, reloading = false;
  setInterval(function () {
    fetch('/health', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) return;
      if (sawOutage) { location.reload(); return; }
      if (statusEl.dataset.sticky === '1') { statusEl.dataset.sticky = ''; statusEl.style.display = 'none'; }
      return r.json().then(function (h) {
        if (h && h.version && h.version !== BUILT_VERSION && !reloading) {
          reloading = true;
          try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || window.pageYOffset || 0)); } catch (e) {}
          location.reload();
        }
      });
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
  syncBarHeight();
  setTimeout(syncBarHeight, 300); // after fonts/layout settle
})();
</script>`;

  // Pre-paint theme restore. A live reload re-serves the RAW artifact, which
  // re-inits to its own default (often dark) and drops whatever theme the author
  // picked. We stamp the saved theme on <html> as the first thing in <head>, so
  // [data-theme]/color-scheme styles resolve on the first painted frame — no dark
  // flash, and the choice survives every reload. Mirrors the scroll-restore in
  // the runtime below. (Artifacts that theme purely off @media prefers-color-
  // scheme can't be overridden from JS; those parts keep following the OS. We
  // drive data-theme + color-scheme, the design-contract convention.)
  const themeBoot =
    "<script>(function(){try{var t=localStorage.getItem('htmldrop_edit_theme');"
    + "if(t==='light'||t==='dark'){var r=document.documentElement;"
    + "r.dataset.theme=t;r.style.colorScheme=t;}}catch(e){}})();</script>";

  let out = html;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${themeBoot}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${themeBoot}</head>`);
  else out = `${themeBoot}\n${out}`;

  if (out.includes('</body>')) return out.replace('</body>', `${runtime}\n</body>`);
  if (out.includes('</html>')) return out.replace('</html>', `${runtime}\n</html>`);
  return out + `\n${runtime}`;
}
