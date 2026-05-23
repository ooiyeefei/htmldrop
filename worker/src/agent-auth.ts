import type { Env } from './storage';
import { registerAuthorKey } from './auth';

export interface AgentAuthConfig {
  issuer: string;
  resource: string;
  trustedProviders: TrustedProvider[];
}

interface TrustedProvider {
  iss: string;
  jwks_uri: string;
  name: string;
}

const TRUSTED_PROVIDERS: TrustedProvider[] = [
  { iss: 'https://api.anthropic.com', jwks_uri: 'https://api.anthropic.com/.well-known/jwks.json', name: 'Anthropic' },
  { iss: 'https://api.openai.com', jwks_uri: 'https://api.openai.com/.well-known/jwks.json', name: 'OpenAI' },
  { iss: 'https://api.cursor.com', jwks_uri: 'https://api.cursor.com/.well-known/jwks.json', name: 'Cursor' },
];

interface IdJagPayload {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  jti: string;
  iat: number;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  agent_platform?: string;
  agent_context_id?: string;
}

interface JWK {
  kty: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export function getProtectedResourceMetadata(resource: string, authServer: string): object {
  return {
    resource,
    resource_name: 'htmldrop',
    resource_logo_uri: 'https://htmldrop-feedback.htmldrop.workers.dev/favicon.ico',
    authorization_servers: [authServer],
    scopes_supported: ['feedback.read', 'feedback.write', 'doc.write', 'converge'],
    bearer_methods_supported: ['header'],
  };
}

export function getAuthServerMetadata(resource: string, authServer: string): object {
  return {
    resource,
    authorization_servers: [authServer],
    scopes_supported: ['feedback.read', 'feedback.write', 'doc.write', 'converge'],
    bearer_methods_supported: ['header'],
    agent_auth: {
      skill: 'https://workos.com/auth.md',
      register_uri: `${authServer}/agent/auth`,
      claim_uri: `${authServer}/agent/auth/claim`,
      revocation_uri: `${authServer}/agent/auth/revoke`,
      identity_types_supported: ['anonymous', 'identity_assertion'],
      anonymous: {
        credential_types_supported: ['api_key'],
      },
      identity_assertion: {
        assertion_types_supported: [
          'urn:ietf:params:oauth:token-type:id-jag',
          'verified_email',
        ],
        credential_types_supported: ['api_key'],
      },
      events_supported: [
        'https://schemas.workos.com/events/agent/auth/identity/assertion/revoked',
      ],
    },
  };
}

export async function handleAgentAuth(
  request: Request,
  env: Env,
  authServer: string,
): Promise<Response> {
  const body = await request.json().catch(() => null) as {
    type?: string;
    assertion_type?: string;
    assertion?: string;
    requested_credential_type?: string;
  } | null;

  if (!body) {
    return agentAuthError('invalid_request', 'JSON body required', 400);
  }

  if (body.type === 'anonymous') {
    return handleAnonymousRegistration(env);
  }

  if (body.type !== 'identity_assertion') {
    return agentAuthError('invalid_request', 'Unsupported type. Use "identity_assertion" or "anonymous".', 400);
  }

  if (body.assertion_type !== 'urn:ietf:params:oauth:token-type:id-jag') {
    return agentAuthError('invalid_request', 'Only urn:ietf:params:oauth:token-type:id-jag is supported.', 400);
  }

  if (!body.assertion) {
    return agentAuthError('invalid_request', 'assertion field required.', 400);
  }

  const payload = await verifyIdJag(body.assertion, authServer, env);
  if ('error' in payload) {
    return agentAuthError(payload.error, payload.message, 401);
  }

  const credential = await issueCredential(env, payload);

  return new Response(JSON.stringify({
    registration_id: `reg_${crypto.randomUUID().slice(0, 8)}`,
    registration_type: 'agent-provider',
    credential_type: body.requested_credential_type || 'api_key',
    credential,
    credential_expires: null,
    scopes: ['feedback.read', 'feedback.write', 'doc.write', 'converge'],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function handleAgentRevoke(
  request: Request,
  env: Env,
): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('logout+jwt') && !contentType.includes('application/json')) {
    return agentAuthError('invalid_request', 'Expected Content-Type: application/logout+jwt', 400);
  }

  const token = await request.text();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return agentAuthError('invalid_request', 'Malformed logout token', 400);
  }

  const payloadStr = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
  const payload = JSON.parse(payloadStr) as { sub?: string; iss?: string };

  if (payload.sub) {
    const userKey = `user:${payload.iss}:${payload.sub}`;
    const existingCred = await env.AUTHORS.get(userKey);
    if (existingCred) {
      await env.AUTHORS.delete(existingCred);
      await env.AUTHORS.delete(userKey);
    }
  }

  return new Response(null, { status: 204 });
}

async function handleAnonymousRegistration(env: Env): Promise<Response> {
  const key = generateHexKey();
  await env.AUTHORS.put(key, JSON.stringify({ docIds: [], createdAt: new Date().toISOString() }));

  return new Response(JSON.stringify({
    registration_id: `reg_${crypto.randomUUID().slice(0, 8)}`,
    registration_type: 'anonymous',
    credential_type: 'api_key',
    credential: key,
    credential_expires: null,
    scopes: ['feedback.read', 'feedback.write'],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function verifyIdJag(
  token: string,
  expectedAud: string,
  env: Env,
): Promise<IdJagPayload | { error: string; message: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { error: 'invalid_signature', message: 'Malformed JWT' };
  }

  const headerStr = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'));
  const header = JSON.parse(headerStr) as { typ?: string; alg?: string; kid?: string };

  if (header.typ !== 'oauth-id-jag+jwt') {
    return { error: 'invalid_signature', message: 'Token typ must be oauth-id-jag+jwt' };
  }

  const payloadStr = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
  const payload = JSON.parse(payloadStr) as IdJagPayload;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    return { error: 'expired', message: 'Token has expired' };
  }

  // Check audience
  if (payload.aud !== expectedAud) {
    return { error: 'invalid_audience', message: `Expected aud: ${expectedAud}, got: ${payload.aud}` };
  }

  // Find trusted provider
  const provider = TRUSTED_PROVIDERS.find(p => p.iss === payload.iss);
  if (!provider) {
    return { error: 'invalid_issuer', message: `Issuer ${payload.iss} is not in the trusted providers list` };
  }

  // Check verified contact
  if (!payload.email_verified) {
    return { error: 'missing_verified_email', message: 'ID-JAG must include email_verified: true' };
  }

  // Check replay (jti)
  const replayKey = `replay:${payload.jti}`;
  const existing = await env.RATE_LIMITS.get(replayKey);
  if (existing) {
    return { error: 'replay_detected', message: 'This token has already been used' };
  }
  await env.RATE_LIMITS.put(replayKey, '1', { expirationTtl: 600 });

  // Verify signature against provider JWKS
  const verified = await verifyJwtSignature(token, provider.jwks_uri, header.alg || 'ES256', header.kid);
  if (!verified) {
    return { error: 'invalid_signature', message: 'JWT signature verification failed' };
  }

  return payload;
}

async function verifyJwtSignature(
  token: string,
  jwksUri: string,
  alg: string,
  kid?: string,
): Promise<boolean> {
  try {
    const res = await fetch(jwksUri);
    if (!res.ok) return false;
    const jwks = await res.json() as { keys: JWK[] };

    let key: JWK | undefined;
    if (kid) {
      key = jwks.keys.find(k => k.kid === kid);
    }
    if (!key) {
      key = jwks.keys.find(k => k.alg === alg || k.use === 'sig');
    }
    if (!key) return false;

    const cryptoKey = await importJwk(key, alg);
    if (!cryptoKey) return false;

    const parts = token.split('.');
    const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const signature = base64UrlDecode(parts[2]);

    const algorithm = getVerifyAlgorithm(alg) as unknown as Parameters<typeof crypto.subtle.verify>[0];
    return crypto.subtle.verify(algorithm, cryptoKey, signature, signingInput);
  } catch {
    return false;
  }
}

async function importJwk(jwk: JWK, alg: string): Promise<CryptoKey | null> {
  try {
    const algorithm = getImportAlgorithm(alg) as unknown as Parameters<typeof crypto.subtle.importKey>[2];
    return crypto.subtle.importKey('jwk', jwk as unknown as JsonWebKey, algorithm, false, ['verify']);
  } catch {
    return null;
  }
}

function getImportAlgorithm(alg: string): object {
  switch (alg) {
    case 'RS256': return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    case 'RS384': return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' };
    case 'RS512': return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' };
    case 'ES256': return { name: 'ECDSA', namedCurve: 'P-256' };
    case 'ES384': return { name: 'ECDSA', namedCurve: 'P-384' };
    default: return { name: 'ECDSA', namedCurve: 'P-256' };
  }
}

function getVerifyAlgorithm(alg: string): object {
  switch (alg) {
    case 'RS256': return { name: 'RSASSA-PKCS1-v1_5' };
    case 'RS384': return { name: 'RSASSA-PKCS1-v1_5' };
    case 'RS512': return { name: 'RSASSA-PKCS1-v1_5' };
    case 'ES256': return { name: 'ECDSA', hash: 'SHA-256' };
    case 'ES384': return { name: 'ECDSA', hash: 'SHA-384' };
    default: return { name: 'ECDSA', hash: 'SHA-256' };
  }
}

function base64UrlDecode(str: string): Uint8Array {
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function issueCredential(env: Env, payload: IdJagPayload): Promise<string> {
  const userKey = `user:${payload.iss}:${payload.sub}`;
  const existing = await env.AUTHORS.get(userKey);

  if (existing) {
    return existing;
  }

  const credential = generateHexKey();
  await env.AUTHORS.put(credential, JSON.stringify({
    docIds: [],
    createdAt: new Date().toISOString(),
    identity: { iss: payload.iss, sub: payload.sub, email: payload.email, name: payload.name },
  }));
  await env.AUTHORS.put(userKey, credential);

  return credential;
}

function generateHexKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function agentAuthError(error: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
