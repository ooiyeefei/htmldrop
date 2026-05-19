import type { FeedbackStored } from './schema';

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
}

export async function getDocCount(env: Env, docId: string): Promise<number> {
  const items = await getFeedback(env, docId);
  return items.length;
}
