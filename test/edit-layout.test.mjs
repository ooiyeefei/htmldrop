import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconcileLayout } from '../src/edit/layout.js';
import { injectEditRuntime } from '../src/edit/runtime.js';

const warning = { kind: 'clipped-text', selector: '#title', detail: 'Text clipped by 4px', severity: 'medium' };
const desktop = { width: 1280, height: 800, dpr: 1 };
const mobile = { width: 390, height: 844, dpr: 1 };
const scan = (previous, warnings, viewport = desktop, sourceHash = 'revision-a', complete = true) => reconcileLayout(previous, warnings, sourceHash, { sourceHash, viewport, complete });

test('stable identity ignores magnitude, complete same viewport resolves, recurrence reopens', () => {
  let state = scan(null, [warning]);
  const id = state.issues[0].id;
  state = scan(state, [{ ...warning, detail: 'Text clipped by 12px' }]);
  assert.equal(state.issues.length, 1);
  assert.equal(state.issues[0].id, id);
  state = scan(state, []);
  assert.equal(state.issues[0].status, 'resolved');
  state = scan(state, [warning]);
  assert.equal(state.issues[0].status, 'open');
});

test('mobile and changed dimensions cannot clear desktop evidence', () => {
  let state = scan(null, [warning]);
  state = scan(state, [], mobile);
  assert.equal(state.issues[0].status, 'open');
  state = scan(state, [], { ...desktop, width: 1200 });
  assert.equal(state.issues[0].status, 'open');
  state = scan(state, [], desktop, 'revision-b', false);
  assert.equal(state.issues[0].status, 'unverified');
  assert.equal(state.complete, false);
});

test('findings at two desktop widths keep independent evidence through clean checks', () => {
  const narrow = { ...desktop, width: 1200 };
  let state = scan(null, [warning]);
  const wideId = state.issues[0].id;
  state = scan(state, [warning], narrow);
  assert.equal(state.issues.length, 2);
  assert.notEqual(state.issues[1].id, wideId);
  state = scan(state, [], narrow);
  assert.equal(state.issues.find((i) => i.id === wideId).status, 'open');
  assert.equal(state.issues.find((i) => i.viewport.width === 1200).status, 'resolved');
  state = scan(state, [], narrow, 'revision-b');
  assert.equal(state.issues.find((i) => i.id === wideId).status, 'unverified');
  state = scan(state, [], desktop, 'revision-b');
  assert.equal(state.issues.find((i) => i.id === wideId).status, 'resolved');
});

test('unknown source and capped results cannot assert clean', () => {
  const initial = scan(null, [warning]);
  const unknown = reconcileLayout(initial, [], 'legacy', { viewport: desktop, complete: true });
  assert.equal(unknown.complete, false);
  assert.equal(unknown.issues[0].status, 'unverified');
  assert.equal(scan(initial, Array(101).fill(warning)).complete, false);
});

test('ignore persists on same revision and reopens on changed source', () => {
  const initial = scan(null, [warning]);
  Object.assign(initial.issues[0], { status: 'ignored', ignoredSourceHash: 'revision-a', ignoreReason: 'Intentional crop' });
  const repeated = scan(initial, [warning]);
  assert.equal(repeated.issues[0].status, 'ignored');
  assert.equal(scan(repeated, []).issues[0].status, 'ignored');
  const changed = scan(repeated, [warning], desktop, 'revision-b');
  assert.equal(changed.issues[0].status, 'open');
});

test('changed dependency revision invalidates old evidence and revision-scoped ignores', () => {
  const measure = (previous, warnings, renderRevision, complete = true, viewport = desktop) => reconcileLayout(previous, warnings, 'raw-html', {
    sourceHash: 'raw-html', renderRevision, viewport, complete,
  });
  let state = measure(null, [warning], 'html-and-css-a');
  Object.assign(state.issues[0], { status: 'ignored', ignoredSourceHash: 'raw-html', ignoredRenderRevision: 'html-and-css-a' });
  state = measure(state, [], 'html-and-css-b', false);
  assert.equal(state.issues[0].status, 'unverified');
  state = measure(state, [warning], 'html-and-css-b');
  assert.equal(state.issues[0].status, 'open');
  assert.equal(state.issues[0].sourceHash, 'raw-html');
  assert.equal(state.issues[0].renderRevision, 'html-and-css-b');
  state = measure(state, [], 'html-and-css-c', true, mobile);
  assert.equal(state.issues[0].status, 'unverified');
  state = measure(state, [], 'html-and-css-c');
  assert.equal(state.issues[0].status, 'resolved');
  assert.equal(state.issues[0].resolvedRenderRevision, 'html-and-css-c');
});

test('store persists issue state and queue is once per unresolved repair', () => {
  const scratch = resolve('.scratch/edit-layout-tests');
  mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(join(scratch, 'session-'));
  const file = join(fixture, 'artifact.html');
  writeFileSync(file, '<html><body>fixture</body></html>');
  const script = `
    import assert from 'node:assert/strict';
    import * as store from './src/edit/store.js';
    const session = store.upsertSession(${JSON.stringify(file)});
    const meta = {sourceHash:'a',viewport:${JSON.stringify(desktop)},complete:true};
    store.setLayout(session.key,[${JSON.stringify(warning)}],'a',meta);
    const id=store.getLayout(session.key).issues[0].id;
    assert.equal(store.queueLayoutIssues(session.key,[id,id],{actor:'reviewer'}).queued,1);
    assert.equal(store.getChat(session.key).chat[0].context.actor,'reviewer');
    assert.equal(store.getLayout(session.key).issues[0].status,'queued');
    assert.equal(store.queueLayoutIssues(session.key,[id]).queued,0);
    assert.equal(store.takeQueuedMessages(session.key).length,1);
    assert.equal(store.getLayout(session.key).issues[0].status,'queued');
    store.setLayout(session.key,[],'a',{...meta,complete:false});
    assert.equal(store.getLayout(session.key).issues[0].status,'unverified');
    assert.equal(store.queueLayoutIssues(session.key,[id]).queued,0);
    assert.equal(store.ignoreLayoutIssue(session.key,id,''),null);
    store.ignoreLayoutIssue(session.key,id,'Intentional crop');
    assert.equal(store.getLayout(session.key).issues[0].status,'ignored');
    store.addComment(session.key,{content:{type:'text',text:'Reviewer note'},agent:true,context:{actor:'reviewer'}});
    const comment=store.getComments(session.key).items[0];
    assert.equal(comment.agent,false);
    assert.equal(comment.context.actor,'reviewer');
    store.setQuestion(session.key,{text:'Which spacing?'});
    store.answerQuestion(session.key,{text:'More spacing',context:{actor:'reviewer'}});
    assert.equal(store.takeAnswer(session.key).context.actor,'reviewer');
    console.log(session.key);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, HOME: fixture }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const key = result.stdout.trim();
  const persisted = JSON.parse(readFileSync(join(fixture, '.htmldrop/edit/sessions', key + '.json'), 'utf8'));
  assert.equal(persisted.layout.issues[0].status, 'ignored');
  assert.equal(persisted.layout.issues[0].ignoreReason, 'Intentional crop');
  assert.match(persisted.chat[0].text, /1280×800, source a/);
});

test('injected runtime parses and uses raw source hash with accessible inbox', () => {
  const html = injectEditRuntime('<html><head></head><body></body></html>', { key: 'session', sourceHash: 'raw-sha256', renderRevision: 'html-and-css' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  assert.match(html, /var SOURCE_HASH = "raw-sha256"/);
  assert.match(html, /var RENDER_REVISION = "html-and-css"/);
  assert.match(html, /renderRevision: RENDER_REVISION/);
  assert.match(html, /aria-controls="inbox"/);
  assert.match(html, /\/layout.*path/);
  assert.doesNotMatch(html, /dataset\.docHash/);
});

test('reviewer runtime removes publish and guards the publish card', () => {
  const reviewer = injectEditRuntime('<html><head></head><body></body></html>', { key: 'session', reviewer: true });
  const author = injectEditRuntime('<html><head></head><body></body></html>', { key: 'session' });
  assert.match(reviewer, /var IS_REVIEWER = true/);
  assert.match(author, /var IS_REVIEWER = false/);
  assert.match(reviewer, /if \(IS_REVIEWER\) pub\.remove\(\)/);
  assert.match(reviewer, /if \(IS_REVIEWER\) \{ pubcard\.classList\.remove\('show'\); return; \}/);
  assert.match(reviewer, /if \(!IS_REVIEWER\) pub\.addEventListener/);
  assert.match(reviewer, /fetch\(IS_REVIEWER \? WORKER \+ '\/api\/edit\/' \+ KEY \+ '\/health' : '\/health'/);
});
