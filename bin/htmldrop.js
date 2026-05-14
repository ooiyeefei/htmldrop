#!/usr/bin/env node

import { program } from 'commander';
import { init } from '../src/init.js';
import { push } from '../src/push.js';
import { list } from '../src/list.js';
import { deleteFile } from '../src/delete.js';
import { openFile } from '../src/index.js';

program
  .name('htmldrop')
  .description('Publish HTML files and get shareable links via Surge.sh')
  .version('1.0.0');

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

program.parse();
