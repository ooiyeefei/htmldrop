// Cinematography helpers for browser-recorded product demos.
//
// The failure mode this exists to prevent: a capture can be 100% real browser
// video and still read as a slideshow, because scrollIntoViewIfNeeded() teleports,
// fill() inserts text in one frame, and Playwright never draws a cursor. Every
// helper here turns a discrete state change into continuous on-screen motion.
//
// It also records a beat timeline from real elapsed capture time, so narration
// timestamps come from the finished video instead of from planned waits.

const CHROME = '__hd_cinema';

/** Eased motion shared by the cursor and the scroller. */
const EASE = 'cubic-bezier(.22,.61,.36,1)';

export class Timeline {
  constructor() {
    this.start = process.hrtime.bigint();
    this.beats = [];
  }

  /** Stamp a named beat at the current real elapsed time. */
  mark(name, note) {
    const at = Number(process.hrtime.bigint() - this.start) / 1e9;
    this.beats.push({ name, note, at });
    console.log(`  ${fmt(at)}  ${name}`);
    return at;
  }

  get elapsed() {
    return Number(process.hrtime.bigint() - this.start) / 1e9;
  }

  /**
   * Beats become narration slots, so each one needs an end. The last beat runs
   * to the capture's end, which the caller supplies once recording stops.
   */
  toSlots(totalDuration) {
    return this.beats.map((b, i) => {
      const end = i + 1 < this.beats.length ? this.beats[i + 1].at : totalDuration;
      return { ...b, end, duration: end - b.at };
    });
  }
}

export function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Inject the cursor + callout layer. Must be re-run after every navigation,
 * since a page load discards it.
 */
export async function installChrome(page) {
  await page.evaluate((ns) => {
    if (document.getElementById(ns)) return;
    const layer = document.createElement('div');
    layer.id = ns;
    Object.assign(layer.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none',
    });

    const cursor = document.createElement('div');
    cursor.id = `${ns}-cursor`;
    // A pointer drawn as SVG so it stays crisp at any scale and never depends
    // on the host page's fonts or theme.
    cursor.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26" fill="none">
      <path d="M5 2.5L20.5 12L13.2 13.6L9.6 20.6L5 2.5Z" fill="#0f172a" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;
    Object.assign(cursor.style, {
      position: 'absolute', top: '0', left: '0', width: '26px', height: '26px',
      transform: 'translate3d(-100px,-100px,0)', filter: 'drop-shadow(0 2px 6px rgba(15,23,42,.45))',
      opacity: '0', transition: 'opacity .25s ease',
    });

    const ripple = document.createElement('div');
    ripple.id = `${ns}-ripple`;
    Object.assign(ripple.style, {
      position: 'absolute', top: '0', left: '0', width: '38px', height: '38px',
      marginLeft: '-19px', marginTop: '-19px', borderRadius: '50%',
      border: '2px solid #38bdf8', opacity: '0', transform: 'translate3d(-100px,-100px,0) scale(.3)',
    });

    layer.append(ripple, cursor);
    document.documentElement.append(layer);
    window[ns] = { x: -100, y: -100 };
  }, CHROME);
}

/** Move the drawn cursor along an eased path. Does not dispatch real events. */
export async function moveCursor(page, x, y, duration = 650) {
  await page.evaluate(
    ([ns, x, y, duration, ease]) => {
      const cursor = document.getElementById(`${ns}-cursor`);
      if (!cursor) return;
      cursor.style.opacity = '1';
      cursor.style.transition = `transform ${duration}ms ${ease}, opacity .25s ease`;
      cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
      window[ns] = { x, y };
    },
    [CHROME, x, y, duration, EASE],
  );
  await page.mouse.move(x, y);
  await page.waitForTimeout(duration);
}

async function centerOf(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot locate element for cursor move — it has no box.');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Move to an element, show a click ripple, then actually click it. */
export async function clickLike(page, locator, { settle = 700 } = {}) {
  const { x, y } = await centerOf(page, locator);
  await moveCursor(page, x, y);
  await page.evaluate(
    ([ns, x, y]) => {
      const r = document.getElementById(`${ns}-ripple`);
      if (!r) return;
      r.style.transition = 'none';
      r.style.transform = `translate3d(${x}px,${y}px,0) scale(.3)`;
      r.style.opacity = '.9';
      requestAnimationFrame(() => {
        r.style.transition = 'transform .5s ease-out, opacity .5s ease-out';
        r.style.transform = `translate3d(${x}px,${y}px,0) scale(1.5)`;
        r.style.opacity = '0';
      });
    },
    [CHROME, x, y],
  );
  await page.waitForTimeout(180);
  await locator.click();
  await page.waitForTimeout(settle);
}

/**
 * Eased scroll driven by rAF. The whole point of this file: scrollIntoView()
 * jumps between two still frames, which is perceptually a cut, not a camera move.
 */
export async function glideTo(page, selector, { duration = 1400, offset = 90 } = {}) {
  await page.evaluate(
    async ([selector, duration, offset]) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`glideTo: no element for ${selector}`);
      const from = window.scrollY;
      const to = Math.max(0, from + el.getBoundingClientRect().top - offset);
      const delta = to - from;
      if (Math.abs(delta) < 2) return;
      const started = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          const p = Math.min(1, (now - started) / duration);
          // easeInOutCubic — accelerates away and settles, which reads as intent.
          const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          window.scrollTo(0, from + delta * eased);
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    [selector, duration, offset],
  );
  await page.waitForTimeout(160);
}

/** Type character by character so the viewer sees a person composing. */
export async function typeLike(page, locator, text, { delay = 34 } = {}) {
  await clickLike(page, locator, { settle: 220 });
  await locator.pressSequentially(text, { delay });
  await page.waitForTimeout(400);
}

/**
 * Drag-select a run of text with real mouse events. This is what makes the
 * widget's auto-open comment box fire the way it does for a human.
 */
export async function dragSelect(page, selector, { duration = 700 } = {}) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`dragSelect: no box for ${selector}`);
  const y = Math.round(box.y + box.height / 2);
  const x0 = Math.round(box.x + 4);
  const x1 = Math.round(box.x + box.width - 4);

  await moveCursor(page, x0, y, 450);
  await page.mouse.down();
  const steps = 26;
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    await moveCursor(page, x, y, duration / steps);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** Drag a rectangle — used for the widget's ▢ area-comment mode. */
export async function dragBox(page, from, to, { duration = 900 } = {}) {
  await moveCursor(page, from.x, from.y, 500);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    await moveCursor(
      page,
      Math.round(from.x + ((to.x - from.x) * i) / steps),
      Math.round(from.y + ((to.y - from.y) * i) / steps),
      duration / steps,
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/**
 * A labelled pointer anchored to an element, so the video explains itself on
 * mute. Auto-hides; never leaves residue that a later beat would capture.
 */
export async function callout(page, selector, text, { side = 'right', hold = 2600 } = {}) {
  const id = await page.evaluate(
    ([ns, selector, text, side]) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`callout: no element for ${selector}`);
      const r = el.getBoundingClientRect();
      const id = `${ns}-c-${Math.round(r.top)}-${text.length}`;
      const layer = document.getElementById(ns);
      if (!layer) return null;

      const wrap = document.createElement('div');
      wrap.id = id;
      Object.assign(wrap.style, {
        position: 'absolute', opacity: '0', transform: 'translateY(6px)',
        transition: 'opacity .45s ease, transform .45s ease',
        display: 'flex', alignItems: 'center', gap: '8px',
      });

      const chip = document.createElement('div');
      chip.textContent = text;
      Object.assign(chip.style, {
        background: '#0f172a', color: '#f1f5f9', font: '600 15px/1.35 ui-sans-serif,system-ui,sans-serif',
        padding: '10px 14px', borderRadius: '10px', maxWidth: '330px',
        boxShadow: '0 10px 30px rgba(15,23,42,.35)', border: '1px solid #334155',
      });

      const arrow = document.createElement('div');
      arrow.textContent = side === 'top' ? '▼' : side === 'right' ? '◀' : '▶';
      Object.assign(arrow.style, { color: '#38bdf8', fontSize: '17px', lineHeight: '1' });

      // Highlight ring on the referenced element, so the label is unambiguous.
      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position: 'absolute', left: `${r.left - 5}px`, top: `${r.top - 5}px`,
        width: `${r.width + 10}px`, height: `${r.height + 10}px`,
        border: '2px solid #38bdf8', borderRadius: '9px', opacity: '0',
        transition: 'opacity .45s ease', boxShadow: '0 0 0 4000px rgba(2,6,23,.10)',
      });
      wrap.dataset.ring = '1';

      if (side === 'top') {
        // Sit above the target, stacked, so a label over dense UI covers nothing.
        wrap.style.flexDirection = 'column';
        wrap.append(chip, arrow);
        wrap.style.left = `${Math.max(14, Math.min(r.left + r.width / 2 - 165, window.innerWidth - 344))}px`;
        wrap.style.top = `${Math.max(12, r.top - 76)}px`;
      } else {
        // Flip to whichever side has room, so a label never clips off-frame.
        const fitsLeft = r.left > 360;
        const place = side === 'left' && fitsLeft ? 'left' : fitsLeft && r.right + 360 > window.innerWidth ? 'left' : 'right';
        if (place === 'right') {
          wrap.append(arrow, chip);
          wrap.style.left = `${Math.min(r.right + 14, window.innerWidth - 356)}px`;
        } else {
          wrap.append(chip, arrow);
          wrap.style.left = `${Math.max(14, r.left - 352)}px`;
        }
        wrap.style.top = `${Math.max(12, r.top + r.height / 2 - 24)}px`;
      }

      layer.append(ring, wrap);
      requestAnimationFrame(() => {
        wrap.style.opacity = '1';
        wrap.style.transform = 'translateY(0)';
        ring.style.opacity = '1';
      });
      wrap._ring = ring;
      return id;
    },
    [CHROME, selector, text, side],
  );

  await page.waitForTimeout(hold);
  await page.evaluate(
    ([id]) => {
      const wrap = document.getElementById(id);
      if (!wrap) return;
      const ring = wrap._ring;
      wrap.style.opacity = '0';
      if (ring) ring.style.opacity = '0';
      setTimeout(() => { wrap.remove(); if (ring) ring.remove(); }, 500);
    },
    [id],
  );
  await page.waitForTimeout(520);
}

/**
 * Scale an element up and dim everything around it, then release. A Mermaid
 * diagram sized for a 940px document column is unreadable at video scale; this
 * gives it the frame for the length of its beat.
 */
export async function spotlight(page, selector, { scale = 1.55, hold = 3200, rise = 900 } = {}) {
  await page.evaluate(
    ([ns, selector, scale, rise]) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`spotlight: no element for ${selector}`);

      const dim = document.createElement('div');
      dim.id = `${ns}-dim`;
      Object.assign(dim.style, {
        position: 'fixed', inset: '0', background: 'rgba(12,20,18,.68)', opacity: '0',
        zIndex: '2147483644', pointerEvents: 'none', transition: `opacity ${rise}ms ease`,
      });

      // Present a clone rather than transforming the original: scaling in place
      // grows the element over its siblings and reads as a broken layout.
      const r = el.getBoundingClientRect();
      const card = document.createElement('div');
      card.id = `${ns}-spot`;
      Object.assign(card.style, {
        position: 'fixed', zIndex: '2147483645', pointerEvents: 'none',
        left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`,
        background: '#fffdf8', border: '1px solid #e4ddd0', borderRadius: '16px',
        padding: '22px', boxShadow: '0 30px 80px rgba(12,20,18,.45)',
        transformOrigin: 'center center', opacity: '0',
        transition: `transform ${rise}ms cubic-bezier(.22,.61,.36,1), opacity ${rise * 0.6}ms ease`,
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      });
      const clone = el.cloneNode(true);
      // A cloned mount is a flex item with no width, so an SVG sized at width:100%
      // collapses toward its viewBox minimum. Pin both explicitly.
      Object.assign(clone.style, { width: '100%', minHeight: '0', display: 'block' });
      for (const svg of clone.querySelectorAll('svg')) {
        Object.assign(svg.style, { width: '100%', height: 'auto', maxWidth: 'none', display: 'block' });
        svg.removeAttribute('height');
      }
      card.append(clone);

      document.documentElement.append(dim, card);

      // Measure after insertion so the scale accounts for the card's padding.
      const cr = card.getBoundingClientRect();
      const dx = window.innerWidth / 2 - (cr.left + cr.width / 2);
      const dy = window.innerHeight / 2 - (cr.top + cr.height / 2);
      // Never scale past the viewport.
      const fit = Math.min(scale, (window.innerWidth - 80) / cr.width, (window.innerHeight - 80) / cr.height);

      requestAnimationFrame(() => {
        dim.style.opacity = '1';
        card.style.opacity = '1';
        card.style.transform = `translate(${dx}px, ${dy}px) scale(${Math.max(1, fit)})`;
      });
    },
    [CHROME, selector, scale, rise],
  );
  await page.waitForTimeout(rise + hold);

  await page.evaluate(
    ([ns, rise]) => {
      const dim = document.getElementById(`${ns}-dim`);
      const card = document.getElementById(`${ns}-spot`);
      if (dim) { dim.style.opacity = '0'; setTimeout(() => dim.remove(), rise); }
      if (card) {
        card.style.transform = 'translate(0,0) scale(1)';
        card.style.opacity = '0';
        setTimeout(() => card.remove(), rise);
      }
    },
    [CHROME, rise],
  );
  await page.waitForTimeout(rise + 120);
}

/**
 * Fade the frame to near-black and back. Navigations are hard cuts; a short
 * dip makes them read as an intentional edit instead of a dropped frame.
 */
export async function fadeOut(page, duration = 420) {
  await page.evaluate(
    ([ns, duration]) => {
      let veil = document.getElementById(`${ns}-veil`);
      if (!veil) {
        veil = document.createElement('div');
        veil.id = `${ns}-veil`;
        Object.assign(veil.style, {
          position: 'fixed', inset: '0', background: '#0b1211', opacity: '0',
          zIndex: '2147483646', pointerEvents: 'none',
        });
        document.documentElement.append(veil);
      }
      veil.style.transition = `opacity ${duration}ms ease`;
      requestAnimationFrame(() => { veil.style.opacity = '1'; });
    },
    [CHROME, duration],
  );
  await page.waitForTimeout(duration + 90);
}

export async function fadeIn(page, duration = 480) {
  await page.evaluate(
    ([ns, duration]) => {
      let veil = document.getElementById(`${ns}-veil`);
      if (!veil) {
        veil = document.createElement('div');
        veil.id = `${ns}-veil`;
        Object.assign(veil.style, {
          position: 'fixed', inset: '0', background: '#0b1211', opacity: '1',
          zIndex: '2147483646', pointerEvents: 'none',
        });
        document.documentElement.append(veil);
      }
      veil.style.opacity = '1';
      veil.style.transition = `opacity ${duration}ms ease`;
      requestAnimationFrame(() => { veil.style.opacity = '0'; });
    },
    [CHROME, duration],
  );
  await page.waitForTimeout(duration + 90);
}

/**
 * A floating terminal panel over the page. htmldrop *is* a CLI, so the command
 * surface has to be on screen — and keeping it as an overlay means the whole
 * demo stays one continuous capture instead of stitched clips.
 *
 * `lines` must be output actually produced by running the command.
 */
export async function terminal(page, command, lines, { hold = 2200, typeDelay = 42, lineDelay = 230 } = {}) {
  await page.evaluate(
    ([ns]) => {
      const layer = document.getElementById(ns);
      if (!layer || document.getElementById(`${ns}-term`)) return;
      const term = document.createElement('div');
      term.id = `${ns}-term`;
      Object.assign(term.style, {
        position: 'absolute', left: '50%', bottom: '46px', transform: 'translate(-50%,26px)',
        width: 'min(980px, 76vw)', background: '#0c1a17', color: '#dff2e8',
        border: '1px solid #2c4a42', borderRadius: '14px', opacity: '0',
        boxShadow: '0 26px 70px rgba(4,12,10,.55)', overflow: 'hidden',
        transition: 'opacity .42s ease, transform .42s cubic-bezier(.22,.61,.36,1)',
        font: '14.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
      });
      const bar = document.createElement('div');
      Object.assign(bar.style, {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '11px 14px',
        background: '#123028', color: '#9dc4b5', fontSize: '12px',
      });
      for (const c of ['#e99472', '#e8c471', '#82c29a']) {
        const d = document.createElement('i');
        Object.assign(d.style, { width: '9px', height: '9px', borderRadius: '50%', background: c });
        bar.append(d);
      }
      const label = document.createElement('span');
      label.textContent = 'zsh — htmldrop';
      label.style.marginLeft = '6px';
      bar.append(label);

      const body = document.createElement('pre');
      body.id = `${ns}-term-body`;
      Object.assign(body.style, {
        margin: '0', padding: '18px 20px 22px', maxHeight: '330px', overflow: 'hidden',
        whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: '1.6',
      });
      term.append(bar, body);
      layer.append(term);
      requestAnimationFrame(() => {
        term.style.opacity = '1';
        term.style.transform = 'translate(-50%,0)';
      });
    },
    [CHROME],
  );
  await page.waitForTimeout(520);

  // Type the prompt + command a character at a time.
  await page.evaluate(([ns]) => {
    const b = document.getElementById(`${ns}-term-body`);
    if (b) b.innerHTML = '<span style="color:#82c29a">$</span> <span id="' + ns + '-cmd"></span><span id="' + ns + '-caret">▋</span>';
  }, [CHROME]);

  for (const ch of command) {
    await page.evaluate(
      ([ns, ch]) => { const c = document.getElementById(`${ns}-cmd`); if (c) c.textContent += ch; },
      [CHROME, ch],
    );
    await page.waitForTimeout(typeDelay);
  }
  await page.waitForTimeout(560);
  await page.evaluate(([ns]) => {
    const caret = document.getElementById(`${ns}-caret`);
    if (caret) caret.remove();
  }, [CHROME]);

  // Stream the real output line by line.
  for (const line of lines) {
    await page.evaluate(
      ([ns, line]) => {
        const b = document.getElementById(`${ns}-term-body`);
        if (!b) return;
        const el = document.createElement('div');
        el.textContent = line;
        el.style.opacity = '0';
        el.style.transition = 'opacity .2s ease';
        // Colourise the way the CLI does, without re-parsing ANSI.
        if (/^(Published|Feedback URL|Converged output written)/.test(line)) el.style.color = '#7fd3a6';
        else if (/^\s*(-----|Save this password)/.test(line)) el.style.color = '#e8c471';
        else if (/^\s{2,}\S/.test(line)) el.style.color = '#9dc4b5';
        b.append(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; });
      },
      [CHROME, line],
    );
    await page.waitForTimeout(lineDelay);
  }

  await page.waitForTimeout(hold);
  await page.evaluate(([ns]) => {
    const t = document.getElementById(`${ns}-term`);
    if (!t) return;
    t.style.opacity = '0';
    t.style.transform = 'translate(-50%,26px)';
    setTimeout(() => t.remove(), 460);
  }, [CHROME]);
  await page.waitForTimeout(500);
}

/**
 * Wait for the artifact's Mermaid diagrams to finish rendering. Mermaid runs in
 * the reader's browser from CDN, so a capture that scrolls too early films an
 * empty mount.
 */
export async function waitForDiagrams(page, count = 1, timeout = 20000) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-mermaid-mount] svg').length >= n,
    count,
    { timeout },
  );
  await page.waitForTimeout(400);
}
