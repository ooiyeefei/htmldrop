// Provider-agnostic LLM caller for the Worker. Mirrors src/feedback/llm.js.
// Auto-detects provider from key prefix unless explicitly overridden.

export type Provider = 'anthropic' | 'openai' | 'gemini';

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

export function detectProvider(key: string | undefined): Provider | null {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

export async function callLLM(opts: {
  apiKey: string;
  provider?: string;
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const provider = (opts.provider as Provider) || detectProvider(opts.apiKey);
  if (!provider) {
    throw new Error('Could not determine provider from API key. Select a provider explicitly.');
  }
  const model = opts.model || DEFAULT_MODELS[provider];
  const maxTokens = opts.maxTokens ?? 8000;

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }] }),
    });
    const data = await res.json() as { content?: { text: string }[]; error?: { message: string } };
    if (!res.ok) throw new Error(data?.error?.message || `Anthropic API error (${res.status})`);
    return data?.content?.[0]?.text || '';
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }] }),
    });
    const data = await res.json() as { choices?: { message: { content: string } }[]; error?: { message: string } };
    if (!res.ok) throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
    return data?.choices?.[0]?.message?.content || '';
  }

  // gemini
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ parts: [{ text: opts.user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json() as { candidates?: { content: { parts: { text: string }[] } }[]; error?: { message: string } };
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
