import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_DIR = join(__dirname, '..', 'templates', 'playbooks');

export const ROUTER_RULE = 'MUST open each matching playbook before writing HTML; match against the use_when trigger; one artifact often combines several.';

const PLAYBOOK_ORDER = [
  'diagram',
  'comparison',
  'input',
  'plan',
  'table',
  'slides',
  'explainer',
];

function playbookSort(a, b) {
  const ai = PLAYBOOK_ORDER.indexOf(a.id);
  const bi = PLAYBOOK_ORDER.indexOf(b.id);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return a.id.localeCompare(b.id);
}

function parsePlaybook(id, markdown) {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const firstNewline = normalized.search(/\r?\n/);
  const firstLine = firstNewline === -1 ? normalized : normalized.slice(0, firstNewline);
  const body = firstNewline === -1
    ? ''
    : normalized.slice(firstLine.length).replace(/^\r?\n/, '').replace(/^\r?\n/, '');
  const match = firstLine.match(/^use_when:\s*(.+)$/);

  if (!match) {
    throw new Error(`Playbook ${id} is missing a first-line use_when trigger.`);
  }

  return {
    id,
    use_when: match[1].trim(),
    body,
  };
}

function loadPlaybooks() {
  return readdirSync(PLAYBOOK_DIR)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const id = basename(file, '.md');
      const markdown = readFileSync(join(PLAYBOOK_DIR, file), 'utf-8');
      return parsePlaybook(id, markdown);
    })
    .sort(playbookSort);
}

function writeStdout(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export async function playbook(id, options = {}) {
  const playbooks = loadPlaybooks();

  if (!id) {
    const list = playbooks.map(({ id: playbookId, use_when }) => ({ id: playbookId, use_when }));

    if (options.json) {
      console.log(JSON.stringify({ router: ROUTER_RULE, playbooks: list }, null, 2));
      return;
    }

    console.log(ROUTER_RULE);
    console.log('');
    for (const item of list) {
      console.log(`${item.id}: ${item.use_when}`);
    }
    return;
  }

  const selected = playbooks.find((item) => item.id === id);
  if (!selected) {
    const validIds = playbooks.map((item) => item.id).join(', ');
    throw new Error(`Unknown playbook "${id}". Valid playbook ids: ${validIds}.`);
  }

  if (options.json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  writeStdout(selected.body);
}
