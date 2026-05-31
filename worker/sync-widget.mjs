// Predeploy guard: keep the Worker's bundled widget identical to the CLI's.
//
// The annotation widget ships via TWO paths — the CLI bakes templates/annotation-widget.html
// into Surge HTML at push time, and the Worker injects worker/src/annotation-widget.html on
// the public /doc/:docId route. They MUST stay identical, or public docs get a stale widget.
// (That drift shipped a 3-release-old widget on /doc/ before it was caught — see UAT 1.6.3.)
//
// wrangler runs this via [build].command before every `wrangler deploy`, so the copy can
// never lag again. templates/ is the single source of truth.
import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // worker/
const SRC = join(here, '../templates/annotation-widget.html'); // CLI source of truth
const DST = join(here, 'src/annotation-widget.html');          // worker's bundled copy

copyFileSync(SRC, DST);

// Fail loudly if the copy didn't take (don't deploy a stale widget).
if (readFileSync(SRC, 'utf-8') !== readFileSync(DST, 'utf-8')) {
  console.error('[sync-widget] FAILED: worker copy does not match templates/ after copy');
  process.exit(1);
}
console.log('[sync-widget] OK — worker/src/annotation-widget.html ← templates/annotation-widget.html');
