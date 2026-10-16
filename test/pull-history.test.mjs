import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { injectHistoryWidget } from '../src/history/index.js';
import { injectFeedbackWidget } from '../src/feedback/inject.js';
import { reconstructSource } from '../src/pull.js';
import { encryptHtml } from '../src/encrypt.js';

const source = '<!doctype html><html><body><h1>Current source</h1></body></html>';
const previous = '<!doctype html><html><body><h1>Previous source</h1></body></html>';
const revision = (number, html) => ({ number, html, encrypted: false,
  date: '2026-10-16T00:00:00.000Z', hash: createHash('sha256').update(html).digest('hex') });
const history = { id: 'pull-history-fixture', version: 2, revisions: [revision(1, previous), revision(2, source)] };

test('source reconstruction strips history independently of feedback and password gates', () => {
  for (const feedback of [false, true]) {
    const page = feedback ? injectFeedbackWidget(injectHistoryWidget(source, history), { docId: 'same-feedback-id', workerUrl: 'https://example.invalid' }) : injectHistoryWidget(source, history);
    for (const password of [undefined, 'fixture-password']) {
      const result = reconstructSource(password ? encryptHtml(page, password) : page, password);
      assert.equal(result.cleanHtml.trim(), source);
      assert.equal(result.docId, feedback ? 'same-feedback-id' : undefined);
      assert.equal(result.history.id, history.id);
      assert.equal(result.history.version, 2);
      assert.equal(result.history.revisions.length, 2);
    }
  }
});

test('pull on another machine preserves default history and next revision with feedback disabled', () => {
  const scratch = resolve('.scratch'); mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(join(scratch, 'pull-history-'));
  writeFileSync(join(fixture, 'published.html'), injectHistoryWidget(source, history));
  const moduleUrl = name => JSON.stringify(pathToFileURL(resolve('src', name)).href);
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { pull } from ${moduleUrl('pull.js')};
    import { loadManifest } from ${moduleUrl('manifest.js')};
    import { prepareHistory } from ${moduleUrl('history/index.js')};
    const published = readFileSync('published.html','utf8');
    globalThis.fetch = async () => ({status:200,text:async()=>published});
    const result = await pull('https://example.invalid/report.html',{open:false,output:'pulled.html'});
    const entry = loadManifest().files[0];
    assert.equal(entry.historyId,'pull-history-fixture');
    assert.equal(entry.historyVersion,2);
    assert.equal(entry.feedback,false);
    assert.equal(entry.docId,undefined);
    assert.equal(readFileSync('pulled.html','utf8').trim(),${JSON.stringify(source)});
    const next = prepareHistory({html:'<h1>Third source</h1>',priorEntry:entry});
    assert.equal(next.id,entry.historyId);
    assert.equal(next.version,3);
    assert.equal(next.revisions[0].html,${JSON.stringify(previous)});
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture, env: { ...process.env, HTMLDROP_CONFIG_DIR: join(fixture, 'config') }, stdio: 'pipe',
  });
  assert.equal(JSON.parse(readFileSync(join(fixture, 'config', 'history', `${history.id}.json`))).revisions.length, 2);
});
