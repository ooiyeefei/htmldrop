import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { feedbackPull } from './pull.js';
import { callLLM, detectProvider, DEFAULT_MODELS } from './llm.js';

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
        : item.anchor?.capturedText
          ? `Area selection over: "${item.anchor.capturedText.slice(0, 500)}"${item.anchor.selector ? ' (element ' + item.anchor.selector + ')' : ''}`
          : item.anchor?.selector
            ? `Area selection on element: ${item.anchor.selector}`
            : 'Area selection (no captured text — infer the target from the comment wording)';
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

  // Resolve API key (any provider) + provider/model (auto-detect, overridable)
  const apiKey = options.apiKey
    || process.env.LLM_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one of LLM_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY,\n' +
      'or pass --api-key. Anthropic: https://console.anthropic.com/settings/keys'
    );
  }

  const provider = options.provider || detectProvider(apiKey);
  const model = options.model || (provider ? DEFAULT_MODELS[provider] : undefined);
  console.log(`Synthesizing feedback via ${provider || 'auto-detect'}${model ? ` (${model})` : ''}...`);

  let revisedHtml = await callLLM({
    apiKey,
    provider: options.provider,
    model: options.model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 16000,
  });

  if (!revisedHtml) {
    throw new Error('The model returned an empty response.');
  }

  // Models sometimes wrap the HTML in a ```html ... ``` fence despite instructions.
  // Strip it so the output file is valid HTML, not literal backticks.
  revisedHtml = revisedHtml.trim()
    .replace(/^```(?:html)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  // Write the converged output
  const outputPath = join(dirname(filePath), `${basename(filename, '.html')}.converged.html`);
  writeFileSync(outputPath, revisedHtml, 'utf-8');
  console.log(`\nConverged output written to: ${outputPath}`);
  console.log(`Original: ${filename}`);
  console.log(`Feedback items synthesized: ${data.items.length}`);

  return outputPath;
}
