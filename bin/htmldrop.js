#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { program } from 'commander';
import { init } from '../src/init.js';
import { push } from '../src/push.js';
import { list } from '../src/list.js';
import { deleteFile } from '../src/delete.js';
import { openFile } from '../src/index.js';
import { authSetup, authSetupForce } from '../src/auth.js';
import { feedbackPull } from '../src/feedback/pull.js';
import { feedbackRead } from '../src/feedback/read.js';
import { feedbackAdd } from '../src/feedback/add.js';
import { fetchDoc } from '../src/fetch.js';
import { playbook } from '../src/playbook.js';
import { design } from '../src/design.js';
import { feedbackList } from '../src/feedback/list.js';
import { feedbackClear } from '../src/feedback/clear.js';
import { converge } from '../src/feedback/converge.js';
import { studio } from '../src/studio.js';
import { editStart, editPoll, editReply, editAsk, editLayout, editEnd, editStop } from '../src/edit/index.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf-8')
);

program
  .name('htmldrop')
  .description('Publish HTML files and get shareable links via Surge.sh')
  .version(pkg.version);

program
  .command('init')
  .description('Set up htmldrop (login to Surge and pick a subdomain)')
  .action(async () => {
    try {
      await init();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('push <file>')
  .description('Publish an HTML file')
  .option('-p, --password [password]', 'Password-protect the file. Omit the value to use $HTMLDROP_PASSWORD or a hidden prompt (keeps it out of shell history)')
  .option('-n, --noindex', 'Block search engines and AI crawlers from indexing this file')
  .option('-f, --feedback', 'Enable inline feedback annotations for reviewers')
  .option('--new-doc', 'Force a fresh feedback doc/link instead of reusing the existing one')
  .option('-o, --open', 'Open the URL in browser after deploy')
  .action(async (file, options) => {
    try {
      await push(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all published files')
  .action(async () => {
    try {
      await list();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('delete <file>')
  .description('Remove a published file and redeploy')
  .action(async (file) => {
    try {
      await deleteFile(file);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('open <file>')
  .description('Open a published file in your default browser')
  .action(async (file) => {
    try {
      await openFile(file);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('fetch <url>')
  .description('Fetch a published doc, decrypting password-protected pages (for agents)')
  .option('-p, --password [password]', 'Password to decrypt a protected page. Omit the value to use $HTMLDROP_PASSWORD or a hidden prompt')
  .option('-o, --out <file>', 'Write output to a file instead of stdout')
  .action(async (url, options) => {
    try {
      await fetchDoc(url, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('playbook [id]')
  .description('List artifact playbooks or print a playbook by id')
  .option('--json', 'Output as JSON')
  .action(async (id, options) => {
    try {
      await playbook(id, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('design')
  .description('Print the htmldrop design contract')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await design(options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

const feedback = program
  .command('feedback')
  .description('Manage feedback on published files');

feedback
  .command('pull <file>')
  .description('Retrieve all feedback for a published file')
  .option('--json', 'Output as JSON')
  .option('--save', 'Write the comments into your repo as <file>.feedback.json (you own + version them)')
  .option('--out <path>', 'Path for --save output (default: <file>.feedback.json)')
  .action(async (file, options) => {
    try {
      await feedbackPull(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

feedback
  .command('read <docIdOrUrl>')
  .description('Read feedback for any doc by docId or URL (public, no auth or manifest needed)')
  .option('--json', 'Output as JSON')
  .option('-p, --password [password]', 'Password for a protected doc (its feedback is gated). Omit the value to use $HTMLDROP_PASSWORD or a hidden prompt')
  .action(async (docIdOrUrl, options) => {
    try {
      await feedbackRead(docIdOrUrl, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

feedback
  .command('add [file]')
  .description('Add a comment programmatically (for agents/automation)')
  .requiredOption('--text <text>', 'The comment text')
  .option('--doc-id <idOrUrl>', 'Comment on any doc by docId or URL (skips local manifest lookup)')
  .option('--name <name>', 'Display name for the comment author', 'AI Agent')
  .option('--on <text>', 'Anchor the comment to specific text in the document')
  .option('--parent-id <id>', 'Reply to an existing comment by its ID')
  .option('-p, --password [password]', 'Password for a protected doc (its feedback is gated). Omit the value to use $HTMLDROP_PASSWORD or a hidden prompt')
  .action(async (file, options) => {
    try {
      await feedbackAdd(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

feedback
  .command('list')
  .description('List files that have feedback enabled')
  .action(async () => {
    try {
      await feedbackList();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

feedback
  .command('clear <file>')
  .description('Delete all feedback for a file')
  .action(async (file) => {
    try {
      await feedbackClear(file);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('converge <file>')
  .description('Synthesize reviewer feedback into an improved HTML version via AI')
  .option('--dry-run', 'Show the prompt without calling the LLM')
  .option('--provider <provider>', 'LLM provider: anthropic | openai | gemini (auto-detected from key if omitted)')
  .option('--model <model>', 'Model id (defaults to a sensible model for the provider)')
  .option('--api-key <key>', 'API key (read from LLM_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY if omitted; prefer the env var — a key passed here is visible in your shell history and process list)')
  .action(async (file, options) => {
    try {
      await converge(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('studio')
  .description('Open Converge Studio — visual dashboard for feedback and AI insights')
  .option('--port <port>', 'Port to serve on', '3456')
  .option('--no-browser', 'Don\'t auto-open browser')
  .action(async (options) => {
    try {
      await studio(options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

const edit = program
  .command('edit')
  .description('Local live edit mode — annotate + iterate on an HTML file before publishing (no Surge)');

edit
  .command('start <file>')
  .description('Serve an HTML file locally with live annotations and hot reload')
  .option('--no-open', "Don't open the browser automatically")
  .option('--with-feedback', "Load this file's published reviewer comments into edit mode (if it was published with --feedback)")
  .action(async (file, options) => {
    try {
      await editStart(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

edit
  .command('poll <file>')
  .description('Wait for the next chat message from the author (for the agent to listen)')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      await editPoll(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

edit
  .command('reply <file>')
  .description('Reply into the edit conversation after acting on a message (for the agent)')
  .requiredOption('--text <text>', 'The reply text')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      await editReply(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

edit
  .command('ask <file>')
  .description('Ask the author a question in the browser and get a structured answer (for agents)')
  .requiredOption('--text <text>', 'The question to ask')
  .option('--options <list>', 'Pipe-separated clickable options, e.g. "Yes|No|Both"')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      await editAsk(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

edit
  .command('layout <file>')
  .description('Report layout issues (overflow, clipped/overlapping text) in the rendered page (for agents)')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      await editLayout(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

edit
  .command('end <file>')
  .description('End a live edit session')
  .action(async (file) => {
    try {
      await editEnd(file);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

edit
  .command('stop')
  .description('Shut down the background edit-mode server')
  .action(async () => {
    try {
      await editStop();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

const auth = program
  .command('auth')
  .description('Manage author authentication');

auth
  .command('setup')
  .description('Generate an author API key for feedback retrieval')
  .option('-f, --force', 'Regenerate key even if one exists')
  .action(async (options) => {
    try {
      if (options.force) {
        await authSetupForce();
      } else {
        await authSetup();
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
