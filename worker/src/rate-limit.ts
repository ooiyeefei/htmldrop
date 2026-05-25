import type { Env } from './storage';

const MAX_PER_IP_PER_DOC_PER_DAY = 20;
const MAX_PER_DOC_TOTAL = 200;
// Match the doc/feedback TTL (90 days) so the lifetime counter expires with the
// content it guards, instead of freezing a doc at the cap forever.
const TOTAL_TTL_SECONDS = 60 * 60 * 24 * 90;

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

function ipDocKey(ip: string, docId: string): string {
  return `rl:${ip}:${docId}:${todayKey()}`;
}

// Exported so storage.ts can delete the matching counter when feedback is cleared.
export function docTotalKey(docId: string): string {
  return `rl:total:${docId}`;
}

export async function checkRateLimit(
  env: Env,
  ip: string,
  docId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const [ipCount, totalCount] = await Promise.all([
    env.RATE_LIMITS.get(ipDocKey(ip, docId)).then((v) => Number(v || 0)),
    env.RATE_LIMITS.get(docTotalKey(docId)).then((v) => Number(v || 0)),
  ]);

  if (totalCount >= MAX_PER_DOC_TOTAL) {
    return { allowed: false, reason: `Document has reached the maximum of ${MAX_PER_DOC_TOTAL} comments` };
  }

  if (ipCount >= MAX_PER_IP_PER_DOC_PER_DAY) {
    return { allowed: false, reason: `Rate limit: ${MAX_PER_IP_PER_DOC_PER_DAY} comments per day per document` };
  }

  return { allowed: true };
}

export async function incrementRateLimit(env: Env, ip: string, docId: string): Promise<void> {
  const ipKey = ipDocKey(ip, docId);
  const totalKey = docTotalKey(docId);
  const oneDaySeconds = 86400;

  const [currentIp, currentTotal] = await Promise.all([
    env.RATE_LIMITS.get(ipKey).then((v) => Number(v || 0)),
    env.RATE_LIMITS.get(totalKey).then((v) => Number(v || 0)),
  ]);

  // NOTE: this is a SOFT limit. KV has no atomic increment, so concurrent bursts
  // can read the same value and modestly overshoot the cap. That trade-off is
  // accepted here (a Durable Object would be needed for a hard guarantee).
  await Promise.all([
    env.RATE_LIMITS.put(ipKey, String(currentIp + 1), { expirationTtl: oneDaySeconds }),
    env.RATE_LIMITS.put(totalKey, String(currentTotal + 1), { expirationTtl: TOTAL_TTL_SECONDS }),
  ]);
}
