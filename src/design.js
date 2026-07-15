import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESIGN_CONTRACT_PATH = join(__dirname, '..', 'templates', 'design-contract.md');

const SECTION_HEADINGS = {
  source_priority_rule: '## 1. Source-priority rule',
  cdn_snippets: '## 2. Copy-paste CDN snippets',
  layout_safety_css: '## 3. Layout-safety CSS block',
  theme_aware_mermaid: '## 4. Theme-aware Mermaid re-render snippet',
};

function extractSection(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';

  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    collected.push(lines[i]);
  }

  return collected.join('\n').trim();
}

function parseDesignContract(body) {
  return {
    source_priority_rule: extractSection(body, SECTION_HEADINGS.source_priority_rule),
    cdn_snippets: extractSection(body, SECTION_HEADINGS.cdn_snippets),
    layout_safety_css: extractSection(body, SECTION_HEADINGS.layout_safety_css),
    theme_aware_mermaid: extractSection(body, SECTION_HEADINGS.theme_aware_mermaid),
    body,
  };
}

function writeStdout(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export async function design(options = {}) {
  const body = readFileSync(DESIGN_CONTRACT_PATH, 'utf-8');

  if (options.json) {
    console.log(JSON.stringify(parseDesignContract(body), null, 2));
    return;
  }

  writeStdout(body);
}
