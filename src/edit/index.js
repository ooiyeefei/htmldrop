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
import { listSessions, pendingCount, sessionKeyFor, undeliveredComments } from './store.js';
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

const POLL_GOLDEN_RULES = [
  'Fix error-severity layout findings before involving the human.',
  'A dead poll is re-run, never mourned.',
];

async function liveEditPort() {
  const port = runningPort();
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok ? port : null;
  } catch {
    return null;
  }
}

function summarizeSession(session, port) {
  const abs = session.file || '';
  const pendingMessages = session.key ? pendingCount(session.key) : (session.queue || []).length;
  const undelivered = session.key ? undeliveredComments(session.key).length : 0;
  const pendingQuestion = !!(session.question && !session.answer);
  return {
    file: abs ? basename(abs) : '(unknown)',
    path: abs,
    status: session.status || 'unknown',
    pendingMessages,
    undeliveredComments: undelivered,
    pendingQuestion,
    totalComments: (session.comments || []).length,
    updatedAt: session.updatedAt || session.createdAt || null,
    url: port && session.key ? `http://127.0.0.1:${port}/s/${session.key}/` : null,
  };
}

function needsAttention(session) {
  return session.status === 'open'
    && (session.pendingMessages > 0 || session.undeliveredComments > 0 || session.pendingQuestion);
}

export async function editLs(options = {}) {
  const port = await liveEditPort();
  const sessions = listSessions().map((session) => summarizeSession(session, port));
  const attention = sessions.filter(needsAttention);
  const payload = { sessions, summary: { total: sessions.length, needsAttention: attention.length } };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  if (!sessions.length) {
    console.log('No edit sessions.');
    return payload;
  }

  if (attention.length) console.log(`${attention.length} session(s) with unaddressed input.`);
  console.log('Edit sessions:');
  for (const s of sessions) {
    const marker = needsAttention(s) ? '!' : ' ';
    const question = s.pendingQuestion ? 'yes' : 'no';
    console.log(`${marker} ${s.file}  [${s.status}] pending=${s.pendingMessages} new-comments=${s.undeliveredComments} question=${question} total-comments=${s.totalComments} updated=${s.updatedAt || 'unknown'}`);
    console.log(`    ${s.path || '(unknown path)'}`);
    if (s.url) console.log(`    ${s.url}`);
  }
  return payload;
}

function jsonError(error, agent_hint) {
  const message = error?.message || String(error);
  console.log(JSON.stringify({ error: message, agent_hint }, null, 2));
  throw error instanceof Error ? error : new Error(message);
}

function editAgentHint(file, command) {
  return `Run \`htmldrop edit start ${file}\` first (or \`htmldrop edit stop\` if the server is stale), then retry \`${command}\`.`;
}

function hasBlockingLayoutWarnings(warnings = []) {
  return (warnings || []).some((w) => w?.level === 'error' || w?.severity === 'error' || w?.severity === 'high');
}

function layoutNextStep(warnings = []) {
  return hasBlockingLayoutWarnings(warnings)
    ? 'Fix these error-severity (level:error) findings before involving the human; warnings may ship with a note.'
    : 'No blocking layout issues — safe to proceed.';
}

function pollNextStep(file, data = {}) {
  const pollCmd = `htmldrop edit poll ${file} --json`;
  const replyCmd = `htmldrop edit reply ${file} --text ...`;
  const rules = `Golden rules: ${POLL_GOLDEN_RULES[0]} ${POLL_GOLDEN_RULES[1]}`;
  const blockingLayout = hasBlockingLayoutWarnings(data.layoutWarnings)
    ? ' Fix error-severity (level:error) layout findings BEFORE involving the human.'
    : '';

  if (data.status === 'ended') {
    return `Session ended — stop polling this edit session.${blockingLayout} ${rules}`;
  }
  if (data.status === 'missing') {
    return `No edit session is active for this file — run \`htmldrop edit start ${file}\` first, then run \`${pollCmd}\`.${blockingLayout} ${rules}`;
  }
  if (data.answer) {
    return `Act on the author's decision, edit the file as needed, then run \`${replyCmd}\`. Then run \`${pollCmd}\` again to keep listening. If the poll returns nothing, re-run it — a dead poll is re-run, never mourned.${blockingLayout} ${rules}`;
  }

  const msgs = data.messages || [];
  const fresh = data.newComments || [];
  if (data.status === 'feedback' && (msgs.length || fresh.length)) {
    return `Do not respond to the user yet.${blockingLayout} Address the messages/comments, then run \`${replyCmd}\`. Then run \`${pollCmd}\` again to keep listening. If the poll returns nothing, re-run it — a dead poll is re-run, never mourned. ${rules}`;
  }
  return `No actionable messages were returned. Run \`${pollCmd}\` again to keep listening. If the poll returns nothing, re-run it — a dead poll is re-run, never mourned.${blockingLayout} ${rules}`;
}

export async function editPoll(file, options = {}) {
  try {
    const abs = assertHtmlFile(file);
    const port = await ensureServerRunning();
    // Make poll self-sufficient: ensure the session (and its file watcher) exist
    // even if `edit start` was never run in this shell.
    await postJson(port, '/__edit/sessions', { file: abs });

    const data = await pollFeedback(port, abs);

    if (options.json) {
      const output = { ...(data || {}), next_step: pollNextStep(file, data || {}) };
      console.log(JSON.stringify(output, null, 2));
      return output;
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
  } catch (e) {
    if (options.json) jsonError(e, editAgentHint(file, `htmldrop edit poll ${file} --json`));
    throw e;
  }
}

// Shared renderer for layout-QA warnings (poll output + `edit layout`).
function printLayoutWarnings(warnings) {
  if (!warnings?.length) return;
  console.log(`\n⚠ ${warnings.length} layout issue(s) detected in the rendered page:`);
  for (const w of warnings) {
    const level = w.level || (w.severity === 'high' || w.severity === 'error' ? 'error' : 'warning');
    const levelLabel = level === 'error' ? 'ERROR' : 'warn';
    const sev = w.severity === 'high' ? '[HIGH]' : w.severity === 'medium' ? '[med]' : '[low]';
    console.log(`  [${levelLabel}] ${sev} ${w.kind} — ${w.selector}`);
    console.log(`     ${w.detail}${w.text ? `  (text: "${w.text}")` : ''}`);
  }
}

// On-demand layout check (agent QA before/after edits, no message needed).
export async function editLayout(file, options = {}) {
  try {
    const abs = assertHtmlFile(file);
    const port = await ensureServerRunning();
    await postJson(port, '/__edit/sessions', { file: abs });
    const { key } = sessionKeyFor(abs);
    const data = await getJson(port, `/api/edit/${key}/layout`);
    if (options.json) {
      const output = { ...(data || {}), next_step: layoutNextStep(data?.warnings || []) };
      console.log(JSON.stringify(output, null, 2));
      return output;
    }
    if (!data.warnings?.length) {
      console.log(data.at ? 'No layout issues detected in the current render.' : 'No layout audit yet — open the page in the browser first so it can be measured.');
      return data;
    }
    printLayoutWarnings(data.warnings);
    return data;
  } catch (e) {
    if (options.json) jsonError(e, editAgentHint(file, `htmldrop edit layout ${file} --json`));
    throw e;
  }
}

// The agent's voice in the conversation. After acting on a message, it replies
// so the author sees what changed (and the live-reloaded page reflects it).
export async function editReply(file, options = {}) {
  let abs;
  try {
    abs = assertHtmlFile(file);
  } catch (e) {
    if (options.json) jsonError(e, editAgentHint(file, `htmldrop edit reply ${file} --text ... --json`));
    throw e;
  }
  const port = runningPort();
  if (!port) {
    const message = 'No edit server running. Run `htmldrop edit start` first.';
    if (options.json) jsonError(new Error(message), editAgentHint(file, `htmldrop edit reply ${file} --text ... --json`));
    console.log(message);
    return;
  }
  const { key } = sessionKeyFor(abs);
  try {
    await postJson(port, `/api/edit/${key}/reply`, { text: options.text });
    if (options.json) {
      const output = {
        replied: true,
        next_step: `Continue the loop: run \`htmldrop edit poll ${file} --json\` to keep listening.`,
      };
      console.log(JSON.stringify(output, null, 2));
      return output;
    }
    console.log('Replied in the edit conversation.');
  } catch (e) {
    if (options.json) jsonError(e, editAgentHint(file, `htmldrop edit reply ${file} --text ... --json`));
    console.log(`Could not send reply: ${e.message}`);
  }
}

// Ask the author a question in the browser (reverse channel). The page pops a
// card with the prompt + optional clickable options + a free-text note; the
// author's answer arrives on the next `edit poll`. `--options` is a pipe-list.
export async function editAsk(file, options = {}) {
  let abs;
  let port;
  try {
    abs = assertHtmlFile(file);
    port = await ensureServerRunning();
    await postJson(port, '/__edit/sessions', { file: abs });
  } catch (e) {
    if (options.json) jsonError(e, editAgentHint(file, `htmldrop edit ask ${file} --text ... --json`));
    throw e;
  }
  const { key } = sessionKeyFor(abs);
  const opts = (options.options || '').split('|').map((s) => s.trim()).filter(Boolean);
  try {
    await postJson(port, `/api/edit/${key}/question`, { text: options.text, options: opts });
    if (options.json) {
      const output = {
        asked: true,
        question: options.text,
        options: opts,
        next_step: `Now run \`htmldrop edit poll ${file} --json\` and wait for the author's answer.`,
      };
      console.log(JSON.stringify(output, null, 2));
      return output;
    }
    console.log(`Asked the author on the page${opts.length ? ` (options: ${opts.join(', ')})` : ''}.`);
    console.log(`Now poll for their answer:  htmldrop edit poll ${file} --json`);
  } catch (e) {
    if (options.json) jsonError(e, editAgentHint(file, `htmldrop edit ask ${file} --text ... --json`));
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
