import type { FeedbackStored } from './schema';
import { docTotalKey } from './rate-limit';

export interface Env {
  FEEDBACK: KVNamespace;
  RATE_LIMITS: KVNamespace;
  AUTHORS: KVNamespace;
  ANTHROPIC_API_KEY?: string;
}

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

function feedbackKey(docId: string): string {
  return `feedback:${docId}`;
}

export async function getFeedback(env: Env, docId: string): Promise<FeedbackStored[]> {
  const raw = await env.FEEDBACK.get(feedbackKey(docId));
  if (!raw) return [];
  return JSON.parse(raw) as FeedbackStored[];
}

export async function addFeedback(env: Env, docId: string, item: FeedbackStored): Promise<void> {
  const existing = await getFeedback(env, docId);
  existing.push(item);
  await env.FEEDBACK.put(feedbackKey(docId), JSON.stringify(existing), {
    expirationTtl: NINETY_DAYS_SECONDS,
  });
}

export async function deleteFeedback(env: Env, docId: string): Promise<void> {
  await env.FEEDBACK.delete(feedbackKey(docId));
  // Also reset the lifetime comment counter so clearing feedback un-freezes a doc
  // that had hit the per-doc total cap. The counter lives in the RATE_LIMITS
  // namespace; reuse the key-builder from rate-limit.ts to keep the format in sync.
  await env.RATE_LIMITS.delete(docTotalKey(docId));
}

export async function getDocCount(env: Env, docId: string): Promise<number> {
  const items = await getFeedback(env, docId);
  return items.length;
}

// --- Doc HTML content storage ---

export async function storeDocContent(env: Env, docId: string, html: string): Promise<void> {
  await env.FEEDBACK.put(`content:${docId}`, html, {
    expirationTtl: NINETY_DAYS_SECONDS,
  });
}

export async function getDocContent(env: Env, docId: string): Promise<string | null> {
  return env.FEEDBACK.get(`content:${docId}`);
}

// --- Doc URL storage ---

export async function storeDocUrl(env: Env, docId: string, url: string): Promise<void> {
  await env.FEEDBACK.put(`url:${docId}`, url, {
    expirationTtl: NINETY_DAYS_SECONDS,
  });
}

export async function getDocUrl(env: Env, docId: string): Promise<string | null> {
  return env.FEEDBACK.get(`url:${docId}`);
}

// --- Insights persistence ---

export interface StoredInsight {
  points: { text: string; source?: string }[];
  generatedAt: string;
}

export async function storeInsight(
  env: Env,
  docId: string,
  segmentIdx: number,
  insight: StoredInsight
): Promise<void> {
  await env.FEEDBACK.put(`insights:${docId}:${segmentIdx}`, JSON.stringify(insight), {
    expirationTtl: NINETY_DAYS_SECONDS,
  });
}

export async function getInsights(
  env: Env,
  docId: string
): Promise<Record<string, StoredInsight>> {
  // KV list with prefix to find all insight keys for this doc
  const list = await env.FEEDBACK.list({ prefix: `insights:${docId}:` });
  const results: Record<string, StoredInsight> = {};

  for (const key of list.keys) {
    const raw = await env.FEEDBACK.get(key.name);
    if (raw) {
      const segIdx = key.name.replace(`insights:${docId}:`, '');
      results[segIdx] = JSON.parse(raw) as StoredInsight;
    }
  }

  return results;
}
