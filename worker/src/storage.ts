import type { FeedbackStored } from './schema';
import { docTotalKey } from './rate-limit';

export interface Env {
  FEEDBACK: KVNamespace;
  RATE_LIMITS: KVNamespace;
  AUTHORS: KVNamespace;
  ANTHROPIC_API_KEY?: string;
  // Optional shared secret guarding POST /admin/migrate-owners. When unset, the
  // migration endpoint always returns 403.
  ADMIN_SECRET?: string;
}

// --- Ownership + access-capability records (v1.6.0 password-as-capability) ---
// Stored in the AUTHORS namespace alongside the rawKey->{docIds} records, using
// distinct key prefixes so KV.list can tell them apart during migration.

export interface AccessRecord {
  scheme: 'v2-capability';
  salt: string; // base64 PBKDF2 salt (also in the public v2: envelope; not secret)
  tokenHash: string; // lowercase hex SHA-256 of the base64 access token
}

// owner:<docId> -> lowercase hex SHA-256(authorKey). Set-once at registration.
export async function getOwner(env: Env, docId: string): Promise<string | null> {
  return env.AUTHORS.get(`owner:${docId}`);
}

export async function setOwner(env: Env, docId: string, keyHash: string): Promise<void> {
  await env.AUTHORS.put(`owner:${docId}`, keyHash);
}

// owner-conflict:<docId> -> JSON { candidates: string[]; at: string }. Written by
// migrateOwners when a docId is claimed by >1 distinct legacy key. Its presence
// HARD-BLOCKS register + owner-action claims until an admin resolves it, so an
// ambiguous doc cannot be silently land-grabbed after migration.
export async function getOwnerConflict(env: Env, docId: string): Promise<string | null> {
  return env.AUTHORS.get(`owner-conflict:${docId}`);
}

export async function setOwnerConflict(env: Env, docId: string, value: string): Promise<void> {
  await env.AUTHORS.put(`owner-conflict:${docId}`, value);
}

export async function deleteOwnerConflict(env: Env, docId: string): Promise<void> {
  await env.AUTHORS.delete(`owner-conflict:${docId}`);
}

// access:<docId> -> AccessRecord (present only for private/password-gated docs).
export async function getAccessRecord(env: Env, docId: string): Promise<AccessRecord | null> {
  const raw = await env.AUTHORS.get(`access:${docId}`);
  if (!raw) return null;
  return JSON.parse(raw) as AccessRecord;
}

export async function setAccessRecord(env: Env, docId: string, record: AccessRecord): Promise<void> {
  await env.AUTHORS.put(`access:${docId}`, JSON.stringify(record));
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
