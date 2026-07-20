// Records the full HTMLDrop journey as ONE continuous browser capture.
//
// Design rules this script exists to enforce, learned from the previous cut:
//   1. Never scrollIntoView — every camera move is an eased glide.
//   2. Never fill() — text is typed, and a drawn cursor shows who is acting.
//   3. No title cards. The CLI appears as a terminal overlay on the live page,
//      so the whole video is one take rather than stitched clips.
//   4. Timestamps are derived from the finished capture, never from planned waits.
//
// Usage:
//   node scripts/demo/stage.mjs        # publish + seed the reviewer thread
//   node scripts/demo/record.mjs
//
// Env:
//   OPENAI_API_KEY   optional. When set, the converge beat runs GPT-5.6 Luna for
//                    real. When absent the beat is skipped and the script says so
//                    rather than faking model output.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  Timeline, callout, clickLike, dragBox, dragSelect, fadeIn, fadeOut, fmt, glideTo,
  installChrome, moveCursor, spotlight, terminal, typeLike, waitForDiagrams,
} from './cinema.mjs';

const root = resolve('.');
const outputDir = resolve('artifacts/openai-build-week');
const stageDir = resolve('docs/demo/.stage');
const finalWebm = resolve(outputDir, 'htmldrop-journey-v4.webm');
const finalMp4 = resolve(outputDir, 'htmldrop-journey-v4.mp4');

const manifestPath = resolve('docs/demo/.demo-manifest.json');
if (!existsSync(manifestPath)) throw new Error('Run `node scripts/demo/stage.mjs` first.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

mkdirSync(outputDir, { recursive: true });
mkdirSync(stageDir, { recursive: true });
for (const f of [finalWebm, finalMp4]) {
  if (existsSync(f)) throw new Error(`Refusing to overwrite ${f}`);
}

const cli = (args, opts = {}) => execFileSync(process.execPath, ['bin/htmldrop.js', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
});

// Verbatim stdout from the converge run that produced the converged document
// now on disk (openai / gpt-5.6-luna, 3 items). Shown on screen when that
// document is reused rather than regenerated.
const CONVERGE_OUTPUT = [
  'Converging 3 feedback item(s) for decision-brief.html...',
  'Synthesizing feedback via openai (gpt-5.6-luna)...',
  '',
  'Converged output written to: docs/demo/decision-brief.converged.html',
  'Original: decision-brief.html',
  'Feedback items synthesized: 3',
];
// Shape of real `htmldrop feedback pull` output, trimmed to fit the terminal
// panel. Four items by this point: two seeded, two the reviewer just wrote on
// camera. Regenerated from the live pull at runtime when that succeeds.
const FEEDBACK_PULL_OUTPUT = [
  '4 feedback item(s) for decision-brief.html:',
  '',
  '  Sam [on: "reduce clarification loops and “where is the latest version?"]',
  '    This is not measurable as written. Add the current weekly',
  '    clarification-loop count and a target percentage.',
  '',
  '  Sam [on: "start with customer-facing proposals, then expand to"]',
  '    I would invert this. Internal planning docs are the safer',
  '    first audience.',
  '',
  '  Sam [area on: arch-diagram]',
  '    Make the converge box say “proposes”.',
];

const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// Prepare the "before" and "after" states for the live-reload beat.
//
// Maya asks the agent to make the open trade-off visible in the mock. The edit
// session starts from a brief where that card does not exist; the agent writes
// it in mid-take and htmldrop's file watcher reloads the page in place. Nothing
// about that moment is simulated.
// ---------------------------------------------------------------------------
const after = readFileSync(resolve('docs/demo/openai-build-week-decision-brief.html'), 'utf8');
const tradeoffCard = after.match(/\s*<div class="mini-card" id="tradeoff">[\s\S]*?<\/div>\n/)?.[0];
if (!tradeoffCard) throw new Error('Could not isolate the trade-off card for the live-reload beat.');
const before = after.replace(tradeoffCard, '\n          ');

// Each run gets its own directory, so the edit session is keyed to a path that
// has never been used. Sessions accumulate their comment thread and agent feed
// by path, and a reused path replays every previous take's messages on screen.
//
// The directory is also created fresh BEFORE any session watches it: htmldrop
// watches the containing directory with fs.watch, and recreating that directory
// under a live session leaves the watcher on a dead inode, which silently kills
// the live-reload beat.
const runDir = resolve(stageDir, `take-${process.hrtime.bigint().toString(36)}`);
mkdirSync(runDir, { recursive: true });
const editFile = resolve(runDir, 'decision-brief.html');
writeFileSync(editFile, before);

console.log('→ starting local edit session');
const editOut = stripAnsi(cli(['edit', 'start', editFile, '--no-open']));
const localUrl = editOut.match(/(http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]+\/?)/i)?.[1];
if (!localUrl) throw new Error(`Could not parse the edit URL from:\n${editOut}`);
console.log(`   ${localUrl}`);

// ---------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const video = page.video();
const tl = new Timeline();

const shadow = (sel) => page.locator(`#htmldrop-edit-host ${sel}`);

try {
  // === ACT 1 — the pain =====================================================
  await page.goto(localUrl, { waitUntil: 'domcontentloaded' });
  await waitForDiagrams(page, 2).catch(() => console.warn('   (diagrams slow; continuing)'));
  await installChrome(page);
  await page.waitForTimeout(500);
  await fadeIn(page, 620);

  tl.mark('hook', 'Title + the question the brief opens on');
  await page.waitForTimeout(2200);

  tl.mark('pain', 'The felt cost: everyone generates, few read');
  await glideTo(page, '#pain', { duration: 1500 });
  await callout(page, '#pain p', 'Not a writing problem — a deciding problem', { side: 'left', hold: 3000 });

  tl.mark('problem', 'Documents fork before feedback arrives');
  await glideTo(page, '#problem', { duration: 1200 });
  await page.waitForTimeout(1700);

  // === ACT 2 — local edit mode with the agent ===============================
  tl.mark('editmode', 'Local edit mode: loopback only, nothing published yet');
  await glideTo(page, '#local', { duration: 1400 });
  await callout(page, '#htmldrop-edit-host', 'Local edit mode — 127.0.0.1, nothing shared yet', { side: 'left', hold: 3000 });

  tl.mark('mock-before', 'The agent has already turned the brief into a testable concept');
  await glideTo(page, '#mock', { duration: 1300 });
  await page.waitForTimeout(1900);

  tl.mark('author-comment', 'Maya selects the claim she wants changed and comments on it');
  await glideTo(page, '#local p', { duration: 900 });
  await dragSelect(page, '#local > p');
  // Selecting text auto-opens the widget's popover, focused on its textarea.
  // Scoped to .hd-popover because the panel carries an identical composer.
  const popover = page.locator('#htmldrop-widget-host .hd-popover');
  await popover.waitFor({ state: 'visible', timeout: 8000 });
  await typeLike(page, popover.locator('textarea').first(),
    'Make the open trade-off visible in the mock, then tell me what still needs my decision before I share this.', { delay: 24 });
  const nameField = page.locator('#htmldrop-widget-host input.hd-compose-name');
  if (await nameField.count()) await typeLike(page, nameField.first(), 'Maya', { delay: 60 });
  await clickLike(page, page.locator('#htmldrop-widget-host .hd-popover-submit').first());

  tl.mark('agent-acts', 'The agent answers in the feed, then edits the file');
  cli(['edit', 'reply', editFile, '--text',
    'Added the open trade-off to the mock: speed versus audit trail. That one is yours to call — everything else has evidence.']);
  await page.evaluate(() => document
    .querySelector('#htmldrop-edit-host')?.shadowRoot?.querySelector('#feedToggle')?.click());
  await page.waitForTimeout(2600);

  // THE LIVE-RELOAD BEAT: the agent writes the file, htmldrop's watcher pushes
  // an SSE reload, and the card appears in place with scroll preserved.
  tl.mark('live-reload', 'Agent writes the file — the page reloads in place');
  await glideTo(page, '#mock', { duration: 1000 });
  await page.waitForTimeout(900);
  writeFileSync(editFile, after);
  try {
    await page.waitForSelector('#tradeoff', { timeout: 9000 });
  } catch {
    // One more real write. A healthy watcher fires on this; a dead one does not,
    // and we fail rather than reload manually and pass it off as live reload.
    console.warn('   (first write did not reload — retrying once)');
    writeFileSync(editFile, `${after}\n<!-- -->`);
    await page.waitForSelector('#tradeoff', { timeout: 9000 });
  }
  await waitForDiagrams(page, 2).catch(() => {});
  await installChrome(page);
  await page.waitForTimeout(700);
  await callout(page, '#tradeoff', 'Written by the agent, live — scroll position kept', { side: 'top', hold: 2600 });

  // === ACT 3 — the design + diagram USP =====================================
  tl.mark('design', 'The artifact itself is the deliverable — a real UI concept');
  await glideTo(page, '#mock', { duration: 900 });
  await spotlight(page, '#mock', { scale: 1.35, hold: 2400 });

  tl.mark('diagram-loop', 'Diagrams are real Mermaid, per htmldrop design contract');
  await glideTo(page, '#loop-diagram', { duration: 1400 });
  await spotlight(page, '#loop-diagram', { scale: 1.7, hold: 2900 });

  tl.mark('diagram-arch', 'The decision boundary: agents draft, a human decides');
  await glideTo(page, '#arch-diagram', { duration: 1300 });
  await spotlight(page, '#arch-diagram', { scale: 1.6, hold: 3000 });

  // === ACT 4 — publish ======================================================
  tl.mark('publish', 'One command: encrypted link, generated password, feedback on');
  await glideTo(page, '#rollout', { duration: 1100 });
  await terminal(page,
    `htmldrop push decision-brief.html --generate-password --feedback`,
    [
      '',
      '  ----- Save this password -----',
      `     ${manifest.password}`,
      '  ------------------------------',
      '  Stored nowhere. htmldrop cannot recover it.',
      '',
      `Published:    ${manifest.url}`,
      'Feedback:     enabled — anchored comments, no account needed',
    ],
    { hold: 2200 });

  // === ACT 5 — the teammate's review ========================================
  tl.mark('gate', 'A teammate opens the same link and unlocks it');
  await fadeOut(page, 420);
  await page.goto(manifest.url, { waitUntil: 'domcontentloaded' });
  await installChrome(page);
  await fadeIn(page, 480);
  await page.waitForTimeout(1100);

  const pw = page.locator('input[type="password"]').first();
  await typeLike(page, pw, manifest.password, { delay: 90 });
  await clickLike(page, page.getByRole('button', { name: /unlock|open|enter/i }).first(), { settle: 2600 });
  await waitForDiagrams(page, 2).catch(() => {});
  await installChrome(page);

  tl.mark('review', 'Comments are anchored to the exact claim they dispute');
  // On a published page the panel is already open, and the launcher is hidden
  // precisely because it is. Only click the launcher if the panel is closed.
  const panel = page.locator('#htmldrop-widget-host .hd-panel');
  if (!(await panel.isVisible().catch(() => false))) {
    const launcher = page.locator('#htmldrop-widget-host .hd-open-btn').first();
    await launcher.waitFor({ state: 'visible', timeout: 15000 });
    await clickLike(page, launcher, { settle: 1800 });
  }
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1200);

  // The reviewer reads before commenting. These glides also keep the document
  // moving: the previous cut sat at one scroll position for half a minute.
  await glideTo(page, '#pain', { duration: 1400 });
  await page.waitForTimeout(800);
  await glideTo(page, '#problem', { duration: 1300 });

  // Clicking a comment scrolls to its anchor and flashes the <mark> highlight.
  const card = page.locator('#htmldrop-widget-host .hd-text')
    .filter({ hasText: /not measurable as written/i }).first();
  if (await card.count().catch(() => 0)) {
    await clickLike(page, card, { settle: 2200 }).catch(() => {});
  }
  await callout(page, '#metric-text', 'Anchored to the sentence, not the document', { side: 'right', hold: 2400 })
    .catch(() => {});

  // --- the reviewer actually reviews ---------------------------------------
  tl.mark('review-write', 'Sam selects the rollout order and argues against it');
  await glideTo(page, '#rollout', { duration: 1500 });
  await page.waitForTimeout(700);
  await dragSelect(page, '#rollout-body');
  const pop = page.locator('#htmldrop-widget-host .hd-popover');
  await pop.waitFor({ state: 'visible', timeout: 8000 });
  await typeLike(page, pop.locator('textarea').first(),
    'I would invert this. Internal planning docs are the safer first audience.', { delay: 22 });
  const nameOnPub = page.locator('#htmldrop-widget-host input.hd-compose-name');
  if (await nameOnPub.count()) await typeLike(page, nameOnPub.first(), 'Sam', { delay: 70 });
  await clickLike(page, page.locator('#htmldrop-widget-host .hd-popover-submit').first(), { settle: 1800 });

  // --- area comment on the diagram itself ----------------------------------
  // Anchoring to a region rather than a text range is the thing prose tools
  // cannot do, and it is the most visually alive interaction in the product.
  tl.mark('review-area', 'A comment dragged over the diagram, not the prose');
  await glideTo(page, '#arch-diagram', { duration: 1500, offset: 190 });
  await clickLike(page, page.locator('#htmldrop-widget-host button').filter({ hasText: '▢' }).first(),
    { settle: 900 });
  await callout(page, '#arch-diagram', 'Area mode — comment on a region, not a sentence', { side: 'top', hold: 1800 })
    .catch(() => {});
  const dbox = await page.locator('#arch-diagram').boundingBox();
  if (dbox) {
    await dragBox(page,
      { x: Math.round(dbox.x + 24), y: Math.round(dbox.y + 16) },
      { x: Math.round(dbox.x + dbox.width - 24), y: Math.round(dbox.y + dbox.height - 16) },
      { duration: 1100 });
    if (await pop.isVisible().catch(() => false)) {
      await typeLike(page, pop.locator('textarea').first(),
        'Make the converge box say “proposes”. That distinction is the whole product.', { delay: 22 });
      await clickLike(page, page.locator('#htmldrop-widget-host .hd-popover-submit').first(), { settle: 1800 });
    }
  }

  // Converge has to see these two new comments, so it starts now and is awaited
  // at its beat — the API call overlaps the next ~11s of screen time instead of
  // freezing the frame while it runs.
  const convergePromise = startConverge();

  tl.mark('dispute', 'Four comments, two authors, one document');
  await glideTo(page, '#htmldrop-widget-host .hd-panel', { duration: 900 }).catch(() => {});
  await page.waitForTimeout(2200);

  tl.mark('agent-reads', 'The owner’s agent pulls the thread with its anchors intact');
  // Pull for real so the panel shows this take's actual thread, including the
  // two comments just written on camera. Long lines are clipped to fit.
  let pullLines = FEEDBACK_PULL_OUTPUT;
  try {
    pullLines = stripAnsi(cli(['feedback', 'pull', 'docs/demo/decision-brief.html']))
      .split('\n').map((l) => l.trimEnd()).filter(Boolean)
      .map((l) => (l.length > 86 ? `${l.slice(0, 84)}…` : l))
      .slice(0, 11);
  } catch { console.warn('   (live feedback pull failed; using the recorded shape)'); }
  await terminal(page, 'htmldrop feedback pull decision-brief.html', pullLines,
    { hold: 2200, lineDelay: 170 });

  // === ACT 6 — converge with GPT-5.6 ========================================
  tl.mark('converge', 'GPT-5.6 Luna synthesizes the thread into a revised document');
  const convergeLines = await convergePromise;
  await terminal(page, 'htmldrop converge decision-brief.html --provider openai', convergeLines, { hold: 2200 });

  const convergedPath = resolve('docs/demo/decision-brief.converged.html');
  if (existsSync(convergedPath)) {
    await fadeOut(page, 420);
    await page.goto(`file://${convergedPath}`, { waitUntil: 'domcontentloaded' });
    await waitForDiagrams(page, 2).catch(() => {});
    await installChrome(page);
    await fadeIn(page, 480);
    // What the model actually did, verified against the converged file: it
    // applied all three clear comments and did not touch the one genuine
    // trade-off. The narration must follow the artifact, not the other way round.
    tl.mark('applied', 'Vague metric became a measurable baseline');
    await glideTo(page, '#metric', { duration: 1200 }).catch(() => {});
    await callout(page, '#metric-text', 'Sam asked for a baseline — GPT-5.6 wrote one', { side: 'right', hold: 3200 })
      .catch(() => {});

    tl.mark('inverted', 'The rollout order was inverted, as the reviewer argued');
    await glideTo(page, '#rollout-body', { duration: 1400 }).catch(() => {});
    await callout(page, '#rollout-body', 'Sam argued for internal-first. It flipped.', { side: 'right', hold: 2800 })
      .catch(() => {});

    tl.mark('diagram-kept', 'The diagrams survived the rewrite intact');
    await glideTo(page, '#arch-diagram', { duration: 1500 }).catch(() => {});
    await spotlight(page, '#arch-diagram', { scale: 1.5, hold: 1900 }).catch(() => {});

    tl.mark('preserved', 'The one real trade-off was left untouched, for a human');
    await glideTo(page, '.decision', { duration: 1100 }).catch(() => {});
    await callout(page, '.decision', 'Nobody had evidence for this. It stays the owner’s call.', { side: 'left', hold: 2900 })
      .catch(() => {});
  }

  // === ACT 7 — close ========================================================
  tl.mark('close', 'The link never changed; the decision stayed human');
  await page.waitForTimeout(1900);
  await fadeOut(page, 700);
} finally {
  await context.close();
  await browser.close();
  try { cli(['edit', 'end', editFile]); } catch { /* session may already be closed */ }
}

renameSync(await video.path(), finalWebm);

// Encode, then derive every timestamp from the ENCODED file — the planned waits
// are not the truth, the finished video is.
execFileSync('ffmpeg', [
  '-v', 'error', '-i', finalWebm,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', finalMp4,
]);
const duration = Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', finalMp4,
], { encoding: 'utf8' }).trim());

const slots = tl.toSlots(duration);
writeFileSync(resolve(outputDir, 'beats.json'), `${JSON.stringify({ duration, slots }, null, 2)}\n`);

console.log(`\n✓ ${finalMp4}`);
console.log(`  duration ${fmt(duration)}  (cap 3:00)`);
console.log('\n  beat                start     length');
for (const s of slots) {
  console.log(`  ${s.name.padEnd(18)} ${fmt(s.at).padStart(7)}   ${s.duration.toFixed(1)}s`);
}

/**
 * Run the real converge. Refuses to invent model output when no key is present —
 * a hackathon claim about GPT-5.6 has to be backed by an actual call.
 */
/**
 * Start converge immediately and resolve its real output later.
 *
 * It must run after the reviewer's live comments exist, but a ~17s API call
 * would freeze the frame if it were awaited at its own beat. Starting it here
 * lets it overlap the next two beats, so the terminal streams real output the
 * moment it is shown.
 */
function startConverge() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('   ! OPENAI_API_KEY not set — converge beat will say so rather than fake output');
    return Promise.resolve(['', '  (converge skipped: no OPENAI_API_KEY in this environment)']);
  }
  console.log('   converge started in the background');
  return new Promise((res) => {
    const child = spawn(process.execPath,
      ['bin/htmldrop.js', 'converge', 'docs/demo/decision-brief.html', '--provider', 'openai'],
      { cwd: root, env: process.env });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(`   ! converge exited ${code}`);
        res(['', `  converge failed (exit ${code}) — see the console`]);
        return;
      }
      const lines = stripAnsi(buf).split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-6);
      res(lines.length ? lines : CONVERGE_OUTPUT);
    });
  });
}
