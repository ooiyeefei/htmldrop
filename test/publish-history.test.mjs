import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffWords } from '../src/history/runtime.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(repo, '.scratch');
mkdirSync(scratch, { recursive: true });

test('word comparison retains both sources and highlights independent edits', () => {
  const before = 'The blue house has two windows.';
  const after = 'The red house has three windows.';
  const diff = diffWords(before, after);
  assert.equal(diff.filter((part) => part.type !== 'added').map((part) => part.text).join(''), before);
  assert.equal(diff.filter((part) => part.type !== 'removed').map((part) => part.text).join(''), after);
  assert.match(diff.filter((part) => part.type === 'removed').map((part) => part.text).join(''), /blue.*two/);
  assert.match(diff.filter((part) => part.type === 'added').map((part) => part.text).join(''), /red.*three/);
  const large = diffWords('before '.repeat(1000), 'after '.repeat(1000));
  assert.equal(large.filter((part) => part.type !== 'added').map((part) => part.text).join(''), 'before '.repeat(1000));
  assert.deepEqual(diffWords('', ''), []);
});

test('every staged publication has deduplicated history independent of feedback, without private plaintext artifacts', () => {
  const fixture = mkdtempSync(join(scratch, 'history-publish-'));
  const bin = join(fixture, 'bin');
  mkdirSync(bin);
  const surge = join(bin, 'surge');
  writeFileSync(surge, '#!/bin/sh\necho deploy >> "$HTMLDROP_TEST_DEPLOY_LOG"\nif [ -f "$HTMLDROP_TEST_FAIL_DEPLOY" ]; then exit 1; fi\nexit 0\n');
  chmodSync(surge, 0o755);
  const program = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { push } from './src/push.js';
    import { writeConfig, getSiteDir, getConfigDir } from './src/config.js';
    import { loadManifest } from './src/manifest.js';
    import { readHistoryConfig, stripHistoryWidget, importHistory, injectHistoryWidget } from './src/history/index.js';
    import { decryptHtml } from './src/encrypt.js';
    writeConfig({ subdomain:'isolated-history-test',authorKey:'test-key' });
    const uploads=[];
    let registrationMode='ok';
    const deployCount=()=>existsSync(process.env.HTMLDROP_TEST_DEPLOY_LOG)?readFileSync(process.env.HTMLDROP_TEST_DEPLOY_LOG,'utf8').trim().split('\\n').length:0;
    globalThis.fetch=async(url,options)=>{
      uploads.push({url,...options,deployCount:deployCount()});
      if(url.includes('/api/register/')&&registrationMode==='unreachable')throw new Error('test network unavailable');
      return {ok:registrationMode!=='rejected'};
    };
    const filename=join(process.env.HTMLDROP_TEST_DATA_DIR,'document.html');
    // Sibling assets can be reviewed locally, but single-file push must fail
    // before deploy, staging or manifest/archive mutations would happen.
    writeFileSync(join(process.env.HTMLDROP_TEST_DATA_DIR,'local.png'),'benign fixture');
    for (const html of ['<img src="local.png">','<img src="missing.png">','<img src="../outside.png">']) {
      writeFileSync(filename,html);
      await assert.rejects(push(filename),/self-contained page.*Embed local assets/);
      assert.equal(existsSync(process.env.HTMLDROP_TEST_DEPLOY_LOG),false);
      assert.equal(existsSync(join(getConfigDir(),'manifest.json')),false);
      assert.equal(existsSync(join(getConfigDir(),'history')),false);
      assert.equal(existsSync(getSiteDir()),false);
    }
    const one='<html><body><h1>First public draft</h1></body></html>';
    const two='<html><body><h1>Second public draft</h1></body></html>';
    const staged=()=>readFileSync(join(getSiteDir(),'document.html'),'utf8');
    const entry=()=>loadManifest().files[0];
    const envelope=(html)=>/var\\s+encryptedContent\\s*=\\s*"([^"]*)"/.exec(html)[1];
    writeFileSync(filename,one);
    const url=await push(filename);
    assert.equal(entry().historyVersion,1);
    const id=entry().historyId;
    assert.equal(readHistoryConfig(staged()).revisions[0].html,one);
    assert.equal(stripHistoryWidget(staged()),one);
    const authoredMarkers='<!-- htmldrop:history:start -->Author note<!-- htmldrop:history:end --><body>Source</body>';
    assert.equal(stripHistoryWidget(authoredMarkers),authoredMarkers);
    assert.equal(stripHistoryWidget(injectHistoryWidget(authoredMarkers,{id,version:1,revisions:readHistoryConfig(staged()).revisions})),authoredMarkers);
    await push(filename,{feedback:true});
    const docId=entry().docId;
    assert.equal(entry().historyVersion,1);
    assert.equal(entry().historyId,id);
    assert.match(uploads.find(item=>item.url.includes('/content')).body,/htmldrop-history-data/);
    writeFileSync(filename,two);
    assert.equal(await push(filename),url);
    assert.equal(entry().historyVersion,2);
    assert.equal(entry().docId,docId);
    await push(filename,{feedback:true});
    assert.equal(entry().docId,docId);
    assert.equal(entry().historyVersion,2);
    const privateOne='<html><body><h1>PRIVATE-FIRST-UNIQUE-TEXT</h1></body></html>';
    const privateTwo='<html><body><h1>PRIVATE-SECOND-UNIQUE-TEXT</h1></body></html>';
    writeFileSync(filename,privateOne);
    const publicState=JSON.stringify(entry());
    const publicStaging=staged();
    const publicArchive=readFileSync(join(getConfigDir(),'history',id+'.json'),'utf8');
    const publicDeployCount=deployCount();
    writeConfig({subdomain:'isolated-history-test'});
    await assert.rejects(push(filename,{password:'old-password'}),/existing feedback URL.*author credentials/);
    assert.equal(deployCount(),publicDeployCount);
    writeConfig({subdomain:'isolated-history-test',authorKey:'test-key'});
    for (const mode of ['rejected','unreachable']) {
      registrationMode=mode;
      await assert.rejects(push(filename,{password:'old-password'}),/Private publication was aborted before deployment/);
      assert.equal(deployCount(),publicDeployCount);
      assert.equal(JSON.stringify(entry()),publicState);
      assert.equal(staged(),publicStaging);
      assert.equal(readFileSync(join(getConfigDir(),'history',id+'.json'),'utf8'),publicArchive);
    }
    registrationMode='ok';
    const beforePrivateUploads=uploads.length;
    await push(filename,{password:'old-password'});
    const privateRequests=uploads.slice(beforePrivateUploads);
    assert.equal(privateRequests.length,1);
    assert.equal(privateRequests[0].url.endsWith('/api/register/'+docId),true);
    assert.equal(privateRequests[0].deployCount,publicDeployCount);
    const privateRegistration=JSON.parse(privateRequests[0].body);
    assert.match(privateRegistration.accessHash,/^[a-f0-9]{64}$/);
    assert.equal(typeof privateRegistration.salt,'string');
    assert.equal(entry().feedback,false);
    assert.equal(entry().docId,docId);
    const privateGate=staged();
    assert.doesNotMatch(privateGate,/PRIVATE-FIRST-UNIQUE-TEXT/);
    assert.equal(entry().historyVersion,3);
    const privateManifestBeforeFailure=JSON.stringify(entry());
    const privateArchiveBeforeFailure=readFileSync(join(getConfigDir(),'history',id+'.json'),'utf8');
    writeFileSync(process.env.HTMLDROP_TEST_FAIL_DEPLOY,'fail');
    await assert.rejects(push(filename,{password:'old-password'}),(error)=>error.message.includes('Private review access was updated before deployment; retry this same push to synchronize it. Local staging/history unchanged.'));
    assert.equal(staged(),privateGate);
    assert.equal(JSON.stringify(entry()),privateManifestBeforeFailure);
    assert.equal(readFileSync(join(getConfigDir(),'history',id+'.json'),'utf8'),privateArchiveBeforeFailure);
    unlinkSync(process.env.HTMLDROP_TEST_FAIL_DEPLOY);
    await push(filename,{password:'old-password'});
    assert.equal(entry().historyVersion,3);
    const beforePrivateFeedback=uploads.length;
    await push(filename,{password:'old-password',feedback:true});
    assert.equal(entry().historyVersion,3);
    assert.equal(entry().feedback,true);
    assert.equal(uploads.slice(beforePrivateFeedback).some(item=>item.url.includes('/content')),false);
    writeFileSync(filename,privateTwo);
    await push(filename,{password:'new-password'});
    assert.equal(entry().historyVersion,4);
    const unlocked=decryptHtml(envelope(staged()),'new-password');
    const history=readHistoryConfig(unlocked);
    assert.equal(history.id,id);
    assert.equal(decryptHtml(history.revisions[2].envelope,'old-password'),privateOne);
    assert.equal(decryptHtml(history.revisions[2].envelope,'new-password'),'');
    assert.equal(decryptHtml(history.revisions[3].envelope,'new-password'),privateTwo);
    assert.equal(stripHistoryWidget(unlocked),privateTwo);
    for (const name of readdirSync(join(getConfigDir(),'history'))) {
      const archive=readFileSync(join(getConfigDir(),'history',name),'utf8');
      assert.doesNotMatch(archive,/PRIVATE-FIRST-UNIQUE-TEXT|PRIVATE-SECOND-UNIQUE-TEXT|old-password|new-password/);
    }
    // Going public carries opaque old private envelopes, never old plaintext.
    writeFileSync(filename,two);
    await push(filename);
    assert.equal(entry().historyVersion,5);
    assert.doesNotMatch(staged(),/PRIVATE-FIRST-UNIQUE-TEXT|PRIVATE-SECOND-UNIQUE-TEXT/);
    assert.equal(readHistoryConfig(staged()).revisions[2].encrypted,true);
    assert.deepEqual(readdirSync(getSiteDir()).sort(),['_gallery.html','document.html','index.html']);
    // A missing local archive is visible and cannot reset the version counter.
    unlinkSync(join(getConfigDir(),'history',id+'.json'));
    writeFileSync(filename,one);
    await push(filename);
    assert.equal(entry().historyVersion,6);
    assert.equal(readHistoryConfig(staged()).revisions[0].unavailable,true);
    // Explicit new-doc is a fresh history and a fresh feedback thread.
    await push(filename,{feedback:true,newDoc:true});
    assert.equal(entry().historyVersion,1);
    assert.notEqual(entry().historyId,id);
    assert.notEqual(entry().docId,docId);
    const imported=readHistoryConfig(staged());
    const archivePath=join(getConfigDir(),'history',imported.id+'.json');
    unlinkSync(archivePath);
    assert.equal(importHistory(imported).version,1);
    const immutable=readFileSync(archivePath,'utf8');
    assert.equal(importHistory(imported).id,imported.id);
    assert.throws(()=>importHistory({...imported,id:'../escape'}),/Invalid/);
    assert.throws(()=>importHistory({...imported,version:4}),/does not match/);
    const conflict=structuredClone(imported);
    conflict.revisions[0].html='changed immutable source';
    delete conflict.revisions[0].hash;
    assert.throws(()=>importHistory(conflict),/conflict/);
    assert.equal(readFileSync(archivePath,'utf8'),immutable);
    const invalidPrivate=structuredClone(imported);
    invalidPrivate.revisions[0]={...history.revisions[2],number:1,html:'PRIVATE-PLAINTEXT'};
    assert.throws(()=>importHistory(invalidPrivate),/Invalid encrypted/);
    assert.equal(readFileSync(archivePath,'utf8'),immutable);
    const beforeFailure=JSON.stringify(entry());
    const stagedBeforeFailure=staged();
    const galleryBeforeFailure=readFileSync(join(getSiteDir(),'_gallery.html'),'utf8');
    const indexBeforeFailure=readFileSync(join(getSiteDir(),'index.html'),'utf8');
    writeFileSync(filename,two);
    writeFileSync(process.env.HTMLDROP_TEST_FAIL_DEPLOY,'fail');
    await assert.rejects(push(filename),/Surge deploy failed/);
    assert.equal(JSON.stringify(entry()),beforeFailure);
    assert.equal(readFileSync(archivePath,'utf8'),immutable);
    assert.equal(staged(),stagedBeforeFailure);
    assert.equal(readFileSync(join(getSiteDir(),'_gallery.html'),'utf8'),galleryBeforeFailure);
    assert.equal(readFileSync(join(getSiteDir(),'index.html'),'utf8'),indexBeforeFailure);
    unlinkSync(process.env.HTMLDROP_TEST_FAIL_DEPLOY);
    const secondFile=join(process.env.HTMLDROP_TEST_DATA_DIR,'second.html');
    writeFileSync(secondFile,'<h1>Unrelated successful publication</h1>');
    await push(secondFile);
    assert.equal(staged(),stagedBeforeFailure);
    assert.equal(readFileSync(archivePath,'utf8'),immutable);
    assert.equal(entry().historyVersion,1);
    await push(filename);
    assert.equal(entry().historyVersion,2);
    console.log('HISTORY_ASSERTIONS_PASSED');
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: repo,
    env: { ...process.env, HTMLDROP_CONFIG_DIR: join(fixture, 'config'), HTMLDROP_TEST_DATA_DIR: fixture, PATH: `${bin}:${process.env.PATH}`, HTMLDROP_TEST_FAIL_DEPLOY: join(fixture, 'fail-deploy'), HTMLDROP_TEST_DEPLOY_LOG: join(fixture, 'deploy.log') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /HISTORY_ASSERTIONS_PASSED/);
});

test('published history UI renders hostile archived HTML inertly and highlights text', async () => {
  const { chromium } = await import('playwright');
  const { injectHistoryWidget } = await import('../src/history/index.js');
  const before = '<html><head><meta http-equiv="refresh" content="0;url=https://history-attack.invalid/refresh"></head><body><h1>Old wording</h1><script>window.HISTORY_ATTACK=true</script><img src="https://history-attack.invalid/x" onerror="window.HISTORY_ATTACK=true"><a href="https://history-attack.invalid/navigation">Link</a></body></html>';
  const after = '<html><body><h1>New wording</h1></body></html>';
  const history = { id: 'test-document', version: 2, revisions: [
    { number: 1, date: '2026-10-16T00:00:00Z', encrypted: false, html: before },
    { number: 2, date: '2026-10-16T01:00:00Z', encrypted: false, html: after },
  ] };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route('**/*', (route) => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent(injectHistoryWidget(after, history));
    await page.locator('#htmldrop-history').getByRole('button', { name: 'History', exact: true }).click();
    assert.match((await page.locator('#htmldrop-history').locator('del').allTextContents()).join(' '), /Old.*Link/);
    assert.equal((await page.locator('#htmldrop-history').locator('ins').allTextContents()).join(''), 'New');
    await page.locator('#htmldrop-history').getByRole('button', { name: 'View this version' }).click();
    const preview = page.locator('#htmldrop-history').locator('iframe');
    assert.equal(await preview.getAttribute('sandbox'), '');
    assert.match(await preview.getAttribute('srcdoc'), /default-src 'none'/);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.HISTORY_ATTACK), undefined);
    assert.deepEqual(requests, []);
    assert.equal(await preview.contentFrame().locator('h1').textContent(), 'Old wording');
    assert.equal(await preview.contentFrame().locator('body').evaluate(() => window.HISTORY_ATTACK), undefined);
    assert.equal(await preview.contentFrame().locator('a').getAttribute('href'), null);
    assert.equal(await preview.contentFrame().locator('meta[http-equiv="refresh"]').count(), 0);
    const headOnly = '<html><head><title>Head only</title></head></html>';
    await page.setContent(injectHistoryWidget(headOnly, history));
    await page.locator('#htmldrop-history').getByRole('button', { name: 'History', exact: true }).click();
    assert.equal(await page.locator('#htmldrop-history').locator('#panel').isVisible(), true);
    // A rotated password leaves older snapshots decryptable only with their
    // original password; failed attempts do not display protected source.
    const { encryptToEnvelope } = await import('../src/encrypt.js');
    const oldPrivate = '<h1>Protected old wording</h1>';
    const locked = { id: 'protected-document', version: 2, revisions: [
      { number: 1, date: '2026-10-16T00:00:00Z', encrypted: true, envelope: encryptToEnvelope(oldPrivate, 'original-secret').envelope },
      { number: 2, date: '2026-10-16T01:00:00Z', encrypted: true, envelope: encryptToEnvelope(after, 'rotated-secret').envelope },
    ] };
    const privatePage = await browser.newPage();
    await privatePage.route('https://history.test/', (route) => route.fulfill({ contentType: 'text/html', body: injectHistoryWidget(after, locked) }));
    await privatePage.goto('https://history.test/');
    const ui = privatePage.locator('#htmldrop-history');
    await ui.getByRole('button', { name: 'History', exact: true }).click();
    await ui.locator('#password').fill('rotated-secret');
    await ui.getByRole('button', { name: 'Unlock version' }).click();
    await ui.locator('#lock').waitFor({ state: 'visible' });
    assert.equal(await ui.locator('del').count(), 0);
    await ui.locator('#password').fill('original-secret');
    await ui.getByRole('button', { name: 'Unlock version' }).click();
    await ui.locator('del').first().waitFor();
    assert.match((await ui.locator('del').allTextContents()).join(' '), /Protected old/);
  } finally {
    await browser.close();
  }
});
