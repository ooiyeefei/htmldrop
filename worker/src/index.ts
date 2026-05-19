import { FeedbackItemSchema, type FeedbackStored } from './schema';
import { type Env, getFeedback, addFeedback, deleteFeedback } from './storage';
import { checkRateLimit, incrementRateLimit } from './rate-limit';
import { isAuthorOfDoc, registerAuthorKey, getAuthorDocs } from './auth';
import DASHBOARD_HTML from './dashboard.html';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Serve dashboard at root
      if (path === '/' && request.method === 'GET') {
        return new Response(DASHBOARD_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (path === '/api/author/files' && request.method === 'GET') {
        return handleAuthorFiles(request, env, corsHeaders);
      }

      const registerMatch = path.match(/^\/api\/register\/([a-zA-Z0-9_-]+)$/);
      if (registerMatch && request.method === 'POST') {
        return handleRegister(request, env, registerMatch[1], corsHeaders);
      }

      const segmentsMatch = path.match(/^\/api\/segments\/([a-zA-Z0-9_-]+)$/);
      if (segmentsMatch && request.method === 'POST') {
        return handleSegments(request, env, segmentsMatch[1], corsHeaders);
      }

      const insightsMatch = path.match(/^\/api\/insights\/([a-zA-Z0-9_-]+)$/);
      if (insightsMatch && request.method === 'POST') {
        return handleInsights(request, env, insightsMatch[1], corsHeaders);
      }

      const convergeMatch = path.match(/^\/api\/converge\/([a-zA-Z0-9_-]+)$/);
      if (convergeMatch && request.method === 'POST') {
        return handleConverge(request, env, convergeMatch[1], corsHeaders);
      }

      const feedbackMatch = path.match(/^\/api\/feedback\/([a-zA-Z0-9_-]+)$/);
      if (!feedbackMatch) {
        return json({ error: 'Not found' }, 404, corsHeaders);
      }

      const docId = feedbackMatch[1];

      if (request.method === 'GET') {
        return handleGet(env, docId, corsHeaders);
      }

      if (request.method === 'POST') {
        return handlePost(request, env, docId, corsHeaders);
      }

      if (request.method === 'DELETE') {
        return handleDelete(request, env, docId, corsHeaders);
      }

      return json({ error: 'Method not allowed' }, 405, corsHeaders);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return json({ error: message }, 500, corsHeaders);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleGet(env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const items = await getFeedback(env, docId);
  return json({ docId, items, count: items.length }, 200, headers);
}

async function handlePost(request: Request, env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const rateCheck = await checkRateLimit(env, ip, docId);
  if (!rateCheck.allowed) {
    return json({ error: rateCheck.reason }, 429, headers);
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return json({ error: 'Invalid JSON body' }, 400, headers);
  }

  const parsed = FeedbackItemSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'Validation failed', details: parsed.error.issues }, 400, headers);
  }

  const item: FeedbackStored = {
    ...parsed.data,
    id: crypto.randomUUID(),
    docId,
    createdAt: new Date().toISOString(),
    resolved: false,
  };

  await addFeedback(env, docId, item);
  await incrementRateLimit(env, ip, docId);

  return json({ id: item.id, createdAt: item.createdAt }, 201, headers);
}

async function handleDelete(request: Request, env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const isAuthor = await isAuthorOfDoc(env, authHeader, docId);

  if (!isAuthor) {
    return json({ error: 'Unauthorized — only the document author can delete feedback' }, 403, headers);
  }

  await deleteFeedback(env, docId);
  return json({ deleted: true, docId }, 200, headers);
}

async function handleRegister(request: Request, env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization header required' }, 401, headers);
  }

  const key = authHeader.slice(7);
  await registerAuthorKey(env, key, docId);

  return json({ registered: true, docId }, 200, headers);
}

async function handleAuthorFiles(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization required' }, 401, headers);
  }

  const key = authHeader.slice(7);
  const docs = await getAuthorDocs(env, key);
  const files = docs.map((docId) => ({ docId, name: docId.slice(0, 8) }));
  return json({ files }, 200, headers);
}

async function handleSegments(request: Request, env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const isAuthor = await isAuthorOfDoc(env, authHeader, docId);
  if (!isAuthor) return json({ error: 'Unauthorized' }, 403, headers);

  const body = await request.json().catch(() => null) as { items?: FeedbackStored[] } | null;
  if (!body?.items) return json({ error: 'Items required' }, 400, headers);

  const segments = clusterSegments(body.items);
  return json({ segments }, 200, headers);
}

async function handleInsights(request: Request, env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const isAuthor = await isAuthorOfDoc(env, authHeader, docId);
  if (!isAuthor) return json({ error: 'Unauthorized' }, 403, headers);

  const body = await request.json().catch(() => null) as {
    segment?: { title: string; items: FeedbackStored[] };
    references?: string[];
    anthropicKey?: string;
  } | null;
  if (!body?.segment) return json({ error: 'Segment required' }, 400, headers);

  const anthropicKey = body.anthropicKey || env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return json({ error: 'API key required. Add your Anthropic API key in Settings.' }, 400, headers);
  }

  const points = await generateInsights(anthropicKey, body.segment, body.references || []);
  return json({ points }, 200, headers);
}

async function handleConverge(request: Request, env: Env, docId: string, headers: Record<string, string>): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const isAuthor = await isAuthorOfDoc(env, authHeader, docId);
  if (!isAuthor) return json({ error: 'Unauthorized' }, 403, headers);

  const body = await request.json().catch(() => null) as {
    segment?: { title: string; items: FeedbackStored[] };
    insight?: { points?: { text: string; source?: string }[] };
    references?: string[];
    anthropicKey?: string;
  } | null;
  if (!body?.segment) return json({ error: 'Segment required' }, 400, headers);

  const anthropicKey = body.anthropicKey || env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return json({ error: 'API key required. Add your Anthropic API key in Settings.' }, 400, headers);
  }

  const suggestion = await generateConvergence(anthropicKey, body.segment, body.insight, body.references || []);
  return json({ suggestion }, 200, headers);
}

interface Segment {
  title: string;
  items: FeedbackStored[];
  hasDebate: boolean;
}

function clusterSegments(items: FeedbackStored[]): Segment[] {
  const groups: Record<string, Segment> = {};

  for (const item of items) {
    const key = item.anchor?.selectedText?.slice(0, 40) || item.anchor?.selector || 'page-level';
    if (!groups[key]) {
      groups[key] = { title: key, items: [], hasDebate: false };
    }
    groups[key].items.push(item);
  }

  for (const seg of Object.values(groups)) {
    if (seg.items.length >= 2) {
      const authors = new Set(seg.items.map((i) => i.author?.displayName));
      seg.hasDebate = authors.size >= 2;
    }
  }

  return Object.values(groups);
}

async function generateInsights(
  apiKey: string,
  segment: { title: string; items: FeedbackStored[] },
  references: string[]
): Promise<{ text: string; source?: string }[]> {
  const feedbackSummary = segment.items
    .map((item) => `${item.author?.displayName || 'Anonymous'}: "${item.content?.text || ''}"`)
    .join('\n');

  const refContext = references.length > 0
    ? `\n\nReference URLs provided by the author (consider these as authoritative sources):\n${references.join('\n')}`
    : '';

  const prompt = `You are a neutral research assistant facilitating a document review discussion.

The reviewers are discussing this segment: "${segment.title}"

Their comments:
${feedbackSummary}
${refContext}

Provide 2-4 factual, evidence-backed insights that help both sides understand the full picture. Each insight should:
1. Be grounded in verifiable facts, data, or expert opinions
2. Cite a source (URL, paper, or expert name)
3. Be neutral — don't take sides

Respond as JSON array: [{"text": "insight text", "source": "source reference"}]`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    return [{ text: 'Failed to generate insights', source: undefined }];
  }

  const data = await response.json() as { content: { text: string }[] };
  const text = data.content?.[0]?.text || '[]';

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* fall through */ }

  return [{ text, source: undefined }];
}

async function generateConvergence(
  apiKey: string,
  segment: { title: string; items: FeedbackStored[] },
  insight: { points?: { text: string; source?: string }[] } | undefined,
  references: string[]
): Promise<string> {
  const feedbackSummary = segment.items
    .map((item) => `${item.author?.displayName || 'Anonymous'}: "${item.content?.text || ''}"`)
    .join('\n');

  const insightContext = insight?.points
    ? `\n\nAI-gathered evidence:\n${insight.points.map((p) => `- ${p.text} (${p.source || 'no source'})`).join('\n')}`
    : '';

  const refContext = references.length > 0
    ? `\nAuthor references: ${references.join(', ')}`
    : '';

  const prompt = `You are synthesizing reviewer feedback on this document segment: "${segment.title}"

Reviewer comments:
${feedbackSummary}
${insightContext}
${refContext}

Based on all feedback and evidence, provide a brief (2-3 sentence) recommendation for how this segment should be revised. Be specific and actionable. If reviewers agree, state the consensus. If they disagree, recommend the approach best supported by evidence.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) return 'Failed to generate convergence suggestion';

  const data = await response.json() as { content: { text: string }[] };
  return data.content?.[0]?.text || 'No suggestion generated';
}

function json(data: unknown, status: number, extraHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
