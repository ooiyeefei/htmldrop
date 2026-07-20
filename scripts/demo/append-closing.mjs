// Append the closing card to the recorded take, and emit the YouTube upload.
//
// Kept separate from record.mjs on purpose: the card exists because the closing
// narration runs a few seconds past the last frame, and fixing that must never
// mean re-recording the journey. This script only ever adds to the tail.
//
// Usage: node scripts/demo/append-closing.mjs [holdSeconds]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const HOLD = Number(process.argv[2] || 7.5);
const dir = resolve('artifacts/openai-build-week');
const take = resolve(dir, 'htmldrop-journey-v4.mp4');
const cardPng = resolve(dir, 'closing-card.png');
const master = resolve(dir, 'htmldrop-journey-final.mp4');
const youtube = resolve(dir, 'htmldrop-journey-final-youtube.mp4');

if (!existsSync(take)) throw new Error(`Missing ${take} — run record.mjs first.`);
mkdirSync(dir, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (args) => execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();

// --- render the card at the take's exact resolution -------------------------
const [w, h] = probe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height',
  '-of', 'csv=p=0', take]).split(',').map(Number);

console.log(`→ rendering closing card at ${w}x${h}`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.goto(`file://${resolve('docs/demo/closing-card.html')}`, { waitUntil: 'load' });
await page.waitForTimeout(400);
await page.screenshot({ path: cardPng });
await browser.close();

// --- card → video segment, fading up from the take's closing black ----------
// The take already ends on a fade to black, so a fade-in here is seamless.
const cardMp4 = resolve(dir, '.closing-card.mp4');
console.log(`→ building a ${HOLD}s closing segment`);
ff([
  '-loop', '1', '-i', cardPng,
  '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
  '-t', String(HOLD),
  '-filter_complex', `[0:v]scale=${w}:${h},fade=t=in:st=0:d=0.7,format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-r', '25', '-g', '50',
  '-c:a', 'aac', '-b:a', '128k',
  cardMp4, '-y',
]);

// --- concat ------------------------------------------------------------------
// The take has no audio track, so a silent one is added to it first; concat
// requires both inputs to carry the same streams.
// The silent track must be exactly as long as the take. An over-long one makes
// concat pad the video out to the audio's length instead of the other way round.
const takeDuration = Number(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', take]));
console.log(`→ appending to the take (${takeDuration.toFixed(2)}s)`);
ff([
  '-i', take,
  '-f', 'lavfi', '-t', String(takeDuration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-i', cardMp4,
  '-filter_complex',
  '[0:v]format=yuv420p[v0];[1:a]anull[a0];'
  + '[2:v]format=yuv420p[v1];[2:a]anull[a1];'
  + '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-r', '25', '-g', '50', '-keyint_min', '25',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
  master, '-y',
]);

// --- YouTube upload: true 16:9, widely compatible profile -------------------
console.log('→ encoding the YouTube version');
ff([
  '-i', master,
  '-filter_complex',
  '[0:v]scale=1728:1080:force_original_aspect_ratio=decrease,'
  + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v]',
  '-map', '[v]', '-map', '0:a',
  '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-preset', 'slow', '-crf', '20',
  '-r', '25', '-g', '50', '-keyint_min', '25',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
  youtube, '-y',
]);

for (const f of [master, youtube]) {
  const d = Number(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', f]));
  const [fw, fh] = probe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', f]).split(',');
  const m = Math.floor(d / 60);
  console.log(`  ${f.split('/').pop().padEnd(38)} ${fw}x${fh}  ${m}:${(d - m * 60).toFixed(2).padStart(5, '0')}`);
}
console.log(`\n  card image: ${cardPng}`);
