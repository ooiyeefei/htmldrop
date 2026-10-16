import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(repo, '.scratch', 'm2-publication');
mkdirSync(scratch, { recursive: true });

test('accepted diagrams survive self-contained publishing, source hand-off and encrypted history', () => {
  const fixture = mkdtempSync(join(scratch, 'run-'));
  const bin = join(fixture, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'surge'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'surge'), 0o755);
  const program = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { createDiagramService } from './src/diagrams/service.js';
    import { writeConfig, getSiteDir, getConfigDir } from './src/config.js';
    import { push } from './src/push.js';
    import { reconstructSource } from './src/pull.js';
    import { readHistoryConfig } from './src/history/index.js';
    import { decryptHtml } from './src/encrypt.js';
    const file=join(process.env.HTMLDROP_M2_FIXTURE,'diagram.html');
    writeFileSync(file,'<!doctype html><html><head><title>Diagram hand-off</title></head><body><h1>Architecture review</h1></body></html>');
    const key='a'.repeat(16);
    const service=createDiagramService({getSession:k=>k===key?{key,file}:null,configDir:getConfigDir()});
    const sourceHash=(await service.list(key,'owner')).sourceHash;
    const scene={type:'excalidraw',version:2,elements:[{id:'service-box',type:'rectangle',x:20,y:20,width:180,height:90,angle:0,strokeColor:'#1e293b',backgroundColor:'#ffffff',fillStyle:'solid',strokeWidth:2,strokeStyle:'solid',roughness:1,opacity:100,groupIds:[],frameId:null,roundness:null,seed:1,version:1,versionNonce:1,isDeleted:false,boundElements:null,updated:1,link:null,locked:false}],appState:{viewBackgroundColor:'#ffffff'},files:{}};
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="220" height="130" viewBox="0 0 220 130"><rect x="20" y="20" width="180" height="90" fill="white" stroke="#1e293b"/></svg>';
    const created=await service.create(key,{baseSourceHash:sourceHash,title:'Service overview',scene,svg,summary:'Initial diagram'},'owner');
    const source=readFileSync(file,'utf8');
    assert.match(source,/data-htmldrop-diagram/);
    assert.ok(source.includes('data:image/svg+xml;base64,'));
    writeConfig({subdomain:'isolated-m2-publication',authorKey:'synthetic-fixture-owner'});
    await push(file);
    const staged=()=>readFileSync(join(getSiteDir(),'diagram.html'),'utf8');
    const publicHtml=staged();
    assert.equal(readHistoryConfig(publicHtml).version,1);
    assert.equal(reconstructSource(publicHtml).cleanHtml,source);
    // Open the handed-off source with a new service/profile. Portable IDs and
    // current accepted native scene are carried by the HTML, not old state.
    const handed=join(process.env.HTMLDROP_M2_FIXTURE,'handed.html');
    writeFileSync(handed,reconstructSource(publicHtml).cleanHtml);
    const other=createDiagramService({getSession:k=>k===key?{key,file:handed}:null,configDir:join(process.env.HTMLDROP_M2_FIXTURE,'other-profile')});
    const restored=await other.read(key,created.diagramId,'owner');
    assert.equal(restored.documentId,created.documentId);
    assert.equal(restored.revisionId,created.revisionId);
    assert.equal(restored.scene.elements[0].id,'service-box');
    assert.equal((await other.exportDiagram(key,created.diagramId,{format:'excalidraw'},'owner')).content.includes('service-box'),true);
    await push(file,{password:'private-diagram-fixture'});
    const gate=staged();
    assert.doesNotMatch(gate,/service-box|Service overview/);
    const envelope=/var\\s+encryptedContent\\s*=\\s*"([^"]*)"/.exec(gate)[1];
    const unlocked=decryptHtml(envelope,'private-diagram-fixture');
    assert.equal(readHistoryConfig(unlocked).version,2);
    assert.equal(reconstructSource(gate,'private-diagram-fixture').cleanHtml,source);
    await push(file);
    const publicAgain=readHistoryConfig(staged());
    assert.equal(publicAgain.version,3);
    assert.equal(publicAgain.revisions[1].encrypted,true);
    assert.equal(decryptHtml(publicAgain.revisions[1].envelope,'private-diagram-fixture'),source);
    for(const name of readdirSync(join(getConfigDir(),'history'))){
      const archive=readFileSync(join(getConfigDir(),'history',name),'utf8');
      assert.doesNotMatch(archive,/private-diagram-fixture/);
    }
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: repo,
    env: { ...process.env, HTMLDROP_CONFIG_DIR: join(fixture, 'config'), HTMLDROP_M2_FIXTURE: fixture, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.match(output, /Published:/);
});
