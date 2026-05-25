import type { Env, AccessRecord } from './storage';
import { getOwner, setOwner, setAccessRecord } from './storage';

// --- Workers-runtime crypto helpers (WebCrypto only; no node:crypto) ---

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare of two fixed-length (64-char) lowercase hex strings.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function bearerKey(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

export async function validateAuthorKey(env: Env, authHeader: string | null): Promise<{ valid: boolean; docId?: string }> {
  const key = bearerKey(authHeader);
  if (!key) {
    return { valid: false };
  }

  const record = await env.AUTHORS.get(key);
  if (!record) {
    return { valid: false };
  }

  const data = JSON.parse(record) as { docIds: string[]; createdAt: string };
  return { valid: true, docId: data.docIds?.[0] };
}

export interface RegisterResult {
  ok: boolean;
  conflict?: boolean; // true => a different key already owns this docId (HTTP 409)
}

// Register an author key for a docId with set-once ownership.
// - If owner:<docId> exists and the presented key's hash differs -> conflict (writes nothing).
// - If absent -> set owner:<docId> = SHA-256(key) (set-once).
// - Always appends docId to the rawKey AUTHORS record (back-compat list).
// - If accessHash & salt are provided, writes access:<docId> (private-doc gate).
export async function registerAuthorKey(
  env: Env,
  key: string,
  docId: string,
  opts?: { accessHash?: string; salt?: string }
): Promise<RegisterResult> {
  const keyHash = await sha256Hex(key);
  const owner = await getOwner(env, docId);

  if (owner !== null) {
    if (!timingSafeEqualHex(keyHash, owner)) {
      return { ok: false, conflict: true };
    }
  } else {
    await setOwner(env, docId, keyHash);
  }

  // Back-compat: keep the rawKey -> {docIds} record so getAuthorDocs / legacy
  // isAuthorOfDoc continue to work.
  const existing = await env.AUTHORS.get(key);
  if (existing) {
    const data = JSON.parse(existing) as { docIds: string[]; createdAt: string };
    if (!data.docIds.includes(docId)) {
      data.docIds.push(docId);
    }
    await env.AUTHORS.put(key, JSON.stringify(data));
  } else {
    await env.AUTHORS.put(key, JSON.stringify({
      docIds: [docId],
      createdAt: new Date().toISOString(),
    }));
  }

  // Private-doc access capability (optional).
  if (opts?.accessHash && opts?.salt) {
    const record: AccessRecord = {
      scheme: 'v2-capability',
      salt: opts.salt,
      tokenHash: opts.accessHash,
    };
    await setAccessRecord(env, docId, record);
  }

  return { ok: true };
}

export async function getAuthorDocs(env: Env, key: string): Promise<string[]> {
  const record = await env.AUTHORS.get(key);
  if (!record) return [];
  const data = JSON.parse(record) as { docIds: string[]; createdAt: string };
  return data.docIds || [];
}

export async function isAuthorOfDoc(env: Env, authHeader: string | null, docId: string): Promise<boolean> {
  const key = bearerKey(authHeader);
  if (!key) return false;

  const record = await env.AUTHORS.get(key);
  if (!record) return false;

  const data = JSON.parse(record) as { docIds: string[]; createdAt: string };
  return data.docIds.includes(docId);
}

// Authorize an owner-only action (clear, converge, content overwrite, segments,
// insights POST). Authority is the set-once owner:<docId> record.
// - If owner:<docId> is present -> constant-time match SHA-256(bearerKey) == owner.
// - If absent (legacy doc, pre-migration) -> fall back to the AUTHORS list AND, on
//   success, lazily backfill owner:<docId> so it's locked thereafter. This blocks
//   the old hijack: an attacker key that merely has the docId in its AUTHORS list
//   fails once a real owner record exists.
export async function authorizeOwner(env: Env, authHeader: string | null, docId: string): Promise<boolean> {
  const key = bearerKey(authHeader);
  if (!key) return false;

  const owner = await getOwner(env, docId);
  if (owner !== null) {
    const keyHash = await sha256Hex(key);
    return timingSafeEqualHex(keyHash, owner);
  }

  // Legacy fallback: no owner record yet. Trust the AUTHORS list, then lock it.
  if (await isAuthorOfDoc(env, authHeader, docId)) {
    await setOwner(env, docId, await sha256Hex(key));
    return true;
  }
  return false;
}

// One-time, idempotent backfill of owner:<docId> records from the legacy AUTHORS
// rawKey -> {docIds} records. Skips owner:/access: keys. A docId claimed by more
// than one DISTINCT key (possible if the pre-set-once land-grab bug created
// duplicate author records) is AMBIGUOUS: it is NOT auto-assigned — it is
// reported in `collisions` for manual repair (e.g. the true owner clears +
// re-pushes). Only sets owner when currently absent.
export async function migrateOwners(env: Env): Promise<{ migrated: number; scanned: number; collisions: string[] }> {
  let scanned = 0;
  const claims = new Map<string, Set<string>>(); // docId -> distinct owner-key hashes

  let cursor: string | undefined;
  do {
    const list = await env.AUTHORS.list({ cursor });
    for (const entry of list.keys) {
      const name = entry.name;
      if (name.startsWith('owner:') || name.startsWith('access:')) continue;
      const raw = await env.AUTHORS.get(name);
      if (!raw) continue;
      let data: { docIds?: string[] };
      try {
        data = JSON.parse(raw) as { docIds?: string[] };
      } catch {
        continue; // not a JSON author record
      }
      if (!Array.isArray(data.docIds)) continue;
      scanned++;
      const keyHash = await sha256Hex(name);
      for (const docId of data.docIds) {
        let set = claims.get(docId);
        if (!set) { set = new Set<string>(); claims.set(docId, set); }
        set.add(keyHash);
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  let migrated = 0;
  const collisions: string[] = [];
  for (const [docId, keyHashes] of claims) {
    if (keyHashes.size > 1) {
      collisions.push(docId); // ambiguous ownership — skip; surface for manual repair
      continue;
    }
    const existing = await getOwner(env, docId);
    if (existing === null) {
      await setOwner(env, docId, [...keyHashes][0]);
      migrated++;
    }
  }

  return { migrated, scanned, collisions };
}
