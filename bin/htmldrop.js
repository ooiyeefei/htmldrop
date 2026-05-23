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
import { feedbackAdd } from '../src/feedback/add.js';
import { feedbackList } from '../src/feedback/list.js';
import { feedbackClear } from '../src/feedback/clear.js';
import { converge } from '../src/feedback/converge.js';
import { studio } from '../src/studio.js';

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
  .option('-p, --password <password>', 'Password-protect the file with client-side encryption')
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

const feedback = program
  .command('feedback')
  .description('Manage feedback on published files');

feedback
  .command('pull <file>')
  .description('Retrieve all feedback for a published file')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      await feedbackPull(file, options);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

feedback
  .command('add <file>')
  .description('Add a comment programmatically (for agents/automation)')
  .requiredOption('--text <text>', 'The comment text')
  .option('--name <name>', 'Display name for the comment author', 'AI Agent')
  .option('--on <text>', 'Anchor the comment to specific text in the document')
  .option('--parent-id <id>', 'Reply to an existing comment by its ID')
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
