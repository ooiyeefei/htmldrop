// Provider-agnostic LLM caller. Supports Anthropic, OpenAI, and Gemini via raw
// fetch (no SDK). Provider is auto-detected from the key prefix unless overridden.

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

const ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  // gemini endpoint includes the model + key, built per-call
};

// Detect provider from the key's prefix. sk-ant- must be checked before sk-.
export function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

export async function callLLM({ apiKey, provider, model, system, user, maxTokens = 8000 }) {
  const resolvedProvider = provider || detectProvider(apiKey);
  if (!resolvedProvider) {
    throw new Error(
      'Could not determine the LLM provider from your API key. ' +
      'Pass --provider anthropic|openai|gemini explicitly.'
    );
  }
  const resolvedModel = model || DEFAULT_MODELS[resolvedProvider];

  if (resolvedProvider === 'anthropic') {
    return callAnthropic(apiKey, resolvedModel, system, user, maxTokens);
  }
  if (resolvedProvider === 'openai') {
    return callOpenAI(apiKey, resolvedModel, system, user, maxTokens);
  }
  if (resolvedProvider === 'gemini') {
    return callGemini(apiKey, resolvedModel, system, user, maxTokens);
  }
  throw new Error(`Unsupported provider: ${resolvedProvider}`);
}

async function callAnthropic(apiKey, model, system, user, maxTokens) {
  const res = await fetch(ENDPOINTS.anthropic, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API error (${res.status})`);
  return data?.content?.[0]?.text || '';
}

async function callOpenAI(apiKey, model, system, user, maxTokens) {
  const res = await fetch(ENDPOINTS.openai, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  return data?.choices?.[0]?.message?.content || '';
}

async function callGemini(apiKey, model, system, user, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
