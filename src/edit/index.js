// Command handlers for `htmldrop edit …` (edit mode).
//
//   edit start <file>  → serve the file locally with live annotations + reload
//   edit poll  <file>  → block until the reviewer leaves feedback (agent-facing)
//   edit end   <file>  → close the session
//   edit stop          → shut the background server down
//
// The loop: run `edit start report.html`, annotate in the browser; the agent
// runs `edit poll report.html --json`, gets the comments, rewrites the file,
// and the page live-reloads with comments re-anchored. Repeat until happy, then
// `htmldrop push --feedback` to publish for external review.

import { existsSync, statSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import open from 'open';
import { ensureServerRunning, runningPort, postJson, getJson, pollFeedback } from './client.js';
import { sessionKeyFor } from './store.js';
import { feedbackPull } from '../feedback/pull.js';
import { loadManifest } from '../manifest.js';

function assertHtmlFile(file) {
  const abs = resolve(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`File not found: ${file}`);
  }
  if (!/\.html?$/i.test(abs)) {
    throw new Error(`Not an HTML file: ${file}`);
  }
  return abs;
}

export async function editStart(file, options = {}) {
  const abs = assertHtmlFile(file);
  const port = await ensureServerRunning();
  const { key, url } = await postJson(port, '/__edit/sessions', { file: abs });

  console.log(`\nEdit mode is live for ${file}`);
  console.log(`  ${url}`);

  if (options.withFeedback) await importPublishedFeedback(port, key, abs);
  else hintPublishedFeedback(abs);

  console.log(`\nChat with the agent in the left panel; read/annotate comments on the right.`);
  console.log(`For the agent to listen, it runs (and keeps re-running):`);
  console.log(`  htmldrop edit poll ${file} --json      # blocks until you send a message`);
  console.log(`  htmldrop edit reply ${file} --text ... # agent replies after editing`);
  console.log(`\nThe page live-reloads whenever the file changes. Stop with \`htmldrop edit stop\`.\n`);

  if (options.open !== false) {
    try { await open(url); } catch { /* headless / no browser — the URL above still works */ }
  }
  return url;
}

// Pull the published doc's reviewer comments (manifest → Worker) and seed them
// into the edit session, so the author can work through real feedback with the
// agent. Best-effort: an unpublished file, missing author key, or network hiccup
// just skips with a note — edit mode still works fully without it.
async function importPublishedFeedback(port, key, abs) {
  try {
    const data = await feedbackPull(basename(abs), { silent: true });
    if (data?.items?.length) {
      const { imported } = await postJson(port, `/__edit/${key}/import`, { comments: data.items });
      console.log(`  Loaded ${imported} published reviewer comment(s) — shown in the comments panel and included in the agent's context.`);
    } else {
      console.log('  No published reviewer comments found for this file yet.');
    }
  } catch (e) {
    console.log(`  (Skipped loading published feedback: ${e.message})`);
  }
}

// When --with-feedback wasn't passed but the file DOES have published comments,
// nudge the author toward loading them.
function hintPublishedFeedback(abs) {
  try {
    const entry = loadManifest().files.find((f) => f.name === basename(abs));
    if (entry?.feedback && entry?.docId) {
      console.log('  Tip: this file has published comments — re-run with --with-feedback to load them for iteration.');
    }
  } catch { /* no manifest — nothing to hint */ }
}

export async function editPoll(file, options = {}) {
  const abs = assertHtmlFile(file);
  const port = await ensureServerRunning();
  // Make poll self-sufficient: ensure the session (and its file watcher) exist
  // even if `edit start` was never run in this shell.
  await postJson(port, '/__edit/sessions', { file: abs });

  const data = await pollFeedback(port, abs);

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return data;
  }

  if (data.status === 'ended') {
    console.log('Session ended. Stop polling.');
    return data;
  }
  if (data.status === 'missing') {
    console.log('No edit session for this file. Run `htmldrop edit start` first.');
    return data;
  }
  // An answer to a question the agent asked (highest priority — it's the reply
  // to a decision the agent was waiting on).
  if (data.answer) {
    const a = data.answer;
    console.log(`\nThe author answered your question${a.question ? ` ("${a.question.slice(0, 60)}")` : ''}:`);
    if (a.choice) console.log(`  → chose: ${a.choice}`);
    if (a.text) console.log(`  → note: ${a.text}`);
    return data;
  }

  const msgs = data.messages || [];
  const fresh = data.newComments || [];
  if (data.status !== 'feedback' || (!msgs.length && !fresh.length)) {
    console.log('No new messages.');
    return data;
  }

  if (msgs.length) {
    console.log(`\n${msgs.length} chat message(s) from the author on ${file}:\n`);
    for (const m of msgs) {
      const ctx = m.context?.text
        ? `\n     ↳ re: "${m.context.text.slice(0, 80)}"${m.context.selector ? ` (${m.context.selector})` : ''}`
        : '';
      console.log(`  • ${m.text}${ctx}`);
    }
  }

  // Comments now reach the agent directly (posting a comment on the page wakes
  // this poll), so surface them as actionable feedback, not just context.
  if (fresh.length) {
    console.log(`\n${fresh.length} new comment(s) on the page:\n`);
    for (const c of fresh) {
      const a = c.anchor || {};
      const on = a.selectedText
        ? ` [on: "${a.selectedText.slice(0, 60)}"]`
        : a.type === 'element_rect'
          ? (a.capturedText ? ` [on: area — "${a.capturedText.slice(0, 60)}"]` : ' [on: area]')
          : c.parentId ? ' [reply]' : '';
      console.log(`  • ${c.author?.displayName || 'Anonymous'}${on}`);
      console.log(`    ${c.content?.text || '(no text)'}`);
    }
  }

  const others = (data.comments?.length || 0) - fresh.length;
  if (others > 0) console.log(`\n  (${others} earlier annotation(s) on the page for context)`);
  printLayoutWarnings(data.layoutWarnings);
  console.log(`\nEdit ${file} to address these — the page reloads live. Then let the author know:`);
  console.log(`  htmldrop edit reply ${file} --text "<what you changed>"`);
  return data;
}

// Shared renderer for layout-QA warnings (poll output + `edit layout`).
function printLayoutWarnings(warnings) {
  if (!warnings?.length) return;
  console.log(`\n⚠ ${warnings.length} layout issue(s) detected in the rendered page:`);
  for (const w of warnings) {
    const sev = w.severity === 'high' ? '[HIGH]' : w.severity === 'medium' ? '[med]' : '[low]';
    console.log(`  ${sev} ${w.kind} — ${w.selector}`);
    console.log(`     ${w.detail}${w.text ? `  (text: "${w.text}")` : ''}`);
  }
}

// On-demand layout check (agent QA before/after edits, no message needed).
export async function editLayout(file, options = {}) {
  const abs = assertHtmlFile(file);
  const port = await ensureServerRunning();
  await postJson(port, '/__edit/sessions', { file: abs });
  const { key } = sessionKeyFor(abs);
  const data = await getJson(port, `/api/edit/${key}/layout`);
  if (options.json) { console.log(JSON.stringify(data, null, 2)); return data; }
  if (!data.warnings?.length) {
    console.log(data.at ? 'No layout issues detected in the current render.' : 'No layout audit yet — open the page in the browser first so it can be measured.');
    return data;
  }
  printLayoutWarnings(data.warnings);
  return data;
}

// The agent's voice in the conversation. After acting on a message, it replies
// so the author sees what changed (and the live-reloaded page reflects it).
export async function editReply(file, options = {}) {
  const abs = assertHtmlFile(file);
  const port = runningPort();
  if (!port) { console.log('No edit server running. Run `htmldrop edit start` first.'); return; }
  const { key } = sessionKeyFor(abs);
  try {
    await postJson(port, `/api/edit/${key}/reply`, { text: options.text });
    console.log('Replied in the edit conversation.');
  } catch (e) {
    console.log(`Could not send reply: ${e.message}`);
  }
}

// Ask the author a question in the browser (reverse channel). The page pops a
// card with the prompt + optional clickable options + a free-text note; the
// author's answer arrives on the next `edit poll`. `--options` is a pipe-list.
export async function editAsk(file, options = {}) {
  const abs = assertHtmlFile(file);
  const port = await ensureServerRunning();
  await postJson(port, '/__edit/sessions', { file: abs });
  const { key } = sessionKeyFor(abs);
  const opts = (options.options || '').split('|').map((s) => s.trim()).filter(Boolean);
  try {
    await postJson(port, `/api/edit/${key}/question`, { text: options.text, options: opts });
    console.log(`Asked the author on the page${opts.length ? ` (options: ${opts.join(', ')})` : ''}.`);
    console.log(`Now poll for their answer:  htmldrop edit poll ${file} --json`);
  } catch (e) {
    console.log(`Could not ask: ${e.message}`);
  }
}

export async function editEnd(file) {
  const abs = assertHtmlFile(file);
  const port = runningPort();
  if (!port) { console.log('No edit server running.'); return; }
  const { key } = sessionKeyFor(abs);
  try { await postJson(port, `/__edit/${key}/end`, {}); console.log(`Ended edit session for ${file}.`); }
  catch (e) { console.log(`Could not end session: ${e.message}`); }
}

export async function editStop() {
  const port = runningPort();
  if (!port) { console.log('No edit server running.'); return; }
  try { await postJson(port, '/shutdown', {}); console.log('Edit-mode server stopped.'); }
  catch { console.log('Edit-mode server stopped.'); }
}
