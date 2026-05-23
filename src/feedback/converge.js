import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { feedbackPull } from './pull.js';

const SYSTEM_PROMPT = `You are an expert HTML document editor. You receive an original HTML document and feedback from multiple reviewers. Your job is to produce an improved version of the HTML.

Rules:
- Where reviewers agree, implement their consensus changes
- Where reviewers disagree, find a balanced middle ground or pick the stronger argument
- Preserve the document's overall style, tone, and structure unless feedback explicitly asks for structural changes
- Each feedback item has an "anchor" showing what text/element it refers to — use this to make targeted edits
- Keep all existing HTML structure intact unless a change is specifically requested
- Output ONLY the revised HTML document, no explanations or commentary
- If feedback is purely positive (no changes requested), return the original unchanged`;

export async function converge(file, options = {}) {
  const filePath = resolve(file);
  const originalHtml = readFileSync(filePath, 'utf-8');
  const filename = basename(filePath);

  // Pull feedback
  const data = await feedbackPull(filename, { json: true, silent: true, ...options });

  if (!data.items || data.items.length === 0) {
    console.log('No feedback to converge. Share the file and collect feedback first.');
    return;
  }

  console.log(`Converging ${data.items.length} feedback item(s) for ${filename}...`);

  // Build the prompt
  const feedbackSummary = data.items.map((item, i) => {
    const anchor = item.anchor?.selectedText
      ? `Refers to: "${item.anchor.selectedText}"`
      : item.anchor?.type === 'page_level'
        ? 'Page-level feedback'
        : `Element: ${item.anchor?.selector || 'unknown'}`;
    return `[${i + 1}] ${item.author?.displayName || 'Anonymous'}: ${item.content?.text || ''}\n   ${anchor}`;
  }).join('\n\n');

  const userPrompt = `Here is the original HTML document:\n\n\`\`\`html\n${originalHtml}\n\`\`\`\n\nHere is the feedback from reviewers:\n\n${feedbackSummary}\n\nPlease produce the improved HTML document based on this feedback.`;

  if (options.dryRun) {
    console.log('\n--- SYSTEM PROMPT ---');
    console.log(SYSTEM_PROMPT);
    console.log('\n--- USER PROMPT ---');
    console.log(userPrompt);
    console.log('\n--- END DRY RUN ---');
    console.log(`\nTotal prompt length: ~${(SYSTEM_PROMPT.length + userPrompt.length).toLocaleString()} chars`);
    return;
  }

  // Dynamic import of Anthropic SDK
  let Anthropic;
  try {
    const sdk = await import('@anthropic-ai/sdk');
    Anthropic = sdk.default || sdk.Anthropic;
  } catch {
    throw new Error(
      'The @anthropic-ai/sdk package is required for converge.\n' +
      'Install it: npm install @anthropic-ai/sdk\n' +
      'Set your API key: export ANTHROPIC_API_KEY=sk-...'
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required.\n' +
      'Get one at: https://console.anthropic.com/settings/keys'
    );
  }

  const client = new Anthropic();
  console.log('Calling Claude to synthesize feedback...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const revisedHtml = response.content[0]?.text || '';

  if (!revisedHtml) {
    throw new Error('Claude returned an empty response.');
  }

  // Write the converged output
  const outputPath = join(dirname(filePath), `${basename(filename, '.html')}.converged.html`);
  writeFileSync(outputPath, revisedHtml, 'utf-8');
  console.log(`\nConverged output written to: ${outputPath}`);
  console.log(`Original: ${filename}`);
  console.log(`Feedback items synthesized: ${data.items.length}`);

  return outputPath;
}
