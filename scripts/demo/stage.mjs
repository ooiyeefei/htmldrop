// Stage the demo: publish the brief with a generated password, seed the reviewer
// thread, and write a manifest the recorder consumes.
//
// Kept separate from record.mjs so the recording never has to improvise, and so
// every URL/password in the video is one this script actually produced.
//
// Usage:  node scripts/demo/stage.mjs
// Env:    none required (surge auth is read from ~/.htmldrop/config.json)

import { execFileSync } from 'node:child_process';
import { writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const source = 'docs/demo/openai-build-week-decision-brief.html';
// Push under a short, quotable name — it appears on screen in the terminal beat.
const published = 'docs/demo/decision-brief.html';
copyFileSync(resolve(source), resolve(published));

const run = (args) => execFileSync(process.execPath, ['bin/htmldrop.js', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

console.log('→ publishing with a generated password + feedback enabled');
const pushOut = run(['push', published, '--generate-password', '--feedback']);
process.stdout.write(pushOut);

// Strip ANSI before parsing; the CLI colourises these lines.
const clean = pushOut.replace(/\[[0-9;]*m/g, '');
const url = clean.match(/Published:\s*(\S+)/)?.[1];
const password = clean.match(/^\s{2,}([a-z]+-[a-z]+-\d+)\s*$/m)?.[1]
  || clean.match(/Password:\s*(\S+)/)?.[1];

if (!url) throw new Error(`Could not parse a published URL from:\n${clean}`);
if (!password) throw new Error(`Could not parse the generated password from:\n${clean}`);

// Only the comments that must already exist when the reviewer arrives. The
// rollout objection and the area comment on the diagram are left for the
// recording to create on camera — a thread that is merely pre-seeded shows the
// product's output but never shows anyone using it.
const thread = [
  {
    name: 'Sam',
    on: 'reduce clarification loops and “where is the latest version?” messages, and make decisions faster',
    text: 'This is not measurable as written. Add the current weekly clarification-loop count and a target percentage, or we cannot tell whether the rollout worked.',
  },
  {
    name: 'Priya',
    on: 'Require a human owner to make the final trade-off call.',
    text: 'Strongly agree, but say who. "A human owner" is exactly the ambiguity that stalls decisions today.',
  },
];

// Comments accumulate server-side per docId, so a re-stage without this would
// stack another copy of the thread on top of the previous run's.
console.log('\n→ clearing any previous thread on this document');
try {
  run(['feedback', 'clear', published]);
  console.log('   cleared');
} catch (err) {
  // Surfaced, not swallowed: a silent failure here stacks a duplicate thread
  // onto the document and the recording shows five comments instead of two.
  const first = String(err.stderr || err.message).trim().split('\n')[0];
  console.log(`   (clear failed: ${first})`);
}

console.log('\n→ seeding the reviewer thread');
const seeded = [];
for (const c of thread) {
  const out = run([
    'feedback', 'add', published,
    '--text', c.text, '--name', c.name, '--on', c.on, '-p', password,
  ]);
  seeded.push({ ...c, ok: /added|posted|✓/i.test(out) });
  console.log(`   ${c.name}: ${c.on.slice(0, 52)}…`);
}

const manifest = {
  source, published, url, password,
  thread: seeded,
  stagedAt: new Date().toISOString(),
};
writeFileSync(resolve('docs/demo/.demo-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n✓ staged`);
console.log(`  url:      ${url}`);
console.log(`  password: ${password}`);
console.log(`  manifest: docs/demo/.demo-manifest.json`);
console.log(`\nNext: node scripts/demo/record.mjs`);
