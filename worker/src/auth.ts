import type { Env } from './storage';

export async function validateAuthorKey(env: Env, authHeader: string | null): Promise<{ valid: boolean; docId?: string }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false };
  }

  const key = authHeader.slice(7);
  const record = await env.AUTHORS.get(key);
  if (!record) {
    return { valid: false };
  }

  const data = JSON.parse(record) as { docIds: string[]; createdAt: string };
  return { valid: true, docId: data.docIds?.[0] };
}

export async function registerAuthorKey(env: Env, key: string, docId: string): Promise<void> {
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
}

export async function getAuthorDocs(env: Env, key: string): Promise<string[]> {
  const record = await env.AUTHORS.get(key);
  if (!record) return [];
  const data = JSON.parse(record) as { docIds: string[]; createdAt: string };
  return data.docIds || [];
}

export async function isAuthorOfDoc(env: Env, authHeader: string | null, docId: string): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const key = authHeader.slice(7);
  const record = await env.AUTHORS.get(key);
  if (!record) return false;

  const data = JSON.parse(record) as { docIds: string[]; createdAt: string };
  return data.docIds.includes(docId);
}
