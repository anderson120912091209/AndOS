// OAuth for connections: the MCP way (discover → register → PKCE), and Google with your key.
//
// MCP servers publish where to sign in (RFC 9728 protected-resource metadata → RFC 8414
// authorization-server metadata) and let a client register itself (RFC 7591), so connecting
// one is a single click — no app to create anywhere. Every flow uses PKCE (S256) and a
// loopback redirect to this server (RFC 8252), and MCP flows name the server they're for
// (RFC 8707 `resource`).

import { createHash, randomBytes } from 'node:crypto';

export type Fetch = typeof fetch;

export interface AuthServer {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  revocation_endpoint?: string;
}

export interface Discovery {
  /** the MCP server's canonical resource URL */
  resource: string;
  issuer: string;
  server: AuthServer;
  scope?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

async function getJson<T>(http: Fetch, url: string): Promise<T | undefined> {
  try {
    const res = await http(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Find where an MCP server wants you to sign in. */
export async function discover(resourceUrl: string, http: Fetch = fetch): Promise<Discovery> {
  const u = new URL(resourceUrl);
  type Prm = { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] };
  let prm =
    (await getJson<Prm>(http, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)) ??
    (await getJson<Prm>(http, `${u.origin}/.well-known/oauth-protected-resource`));
  if (!prm?.authorization_servers?.length) {
    // Ask the server itself: a 401 names its metadata document.
    const res = await http(resourceUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    const hint = /resource_metadata="([^"]+)"/.exec(res?.headers.get('www-authenticate') ?? '')?.[1];
    if (hint) prm = await getJson<Prm>(http, hint);
  }
  const issuer = prm?.authorization_servers?.[0];
  if (!issuer) throw new Error(`${u.host} doesn't say where to sign in`);
  const i = new URL(issuer);
  const path = i.pathname === '/' ? '' : i.pathname;
  const server =
    (await getJson<AuthServer>(http, `${i.origin}/.well-known/oauth-authorization-server${path}`)) ??
    (await getJson<AuthServer>(http, `${i.origin}/.well-known/openid-configuration${path}`));
  if (!server?.authorization_endpoint || !server.token_endpoint) throw new Error(`${i.host} has no sign-in endpoints`);
  const scopes = prm?.scopes_supported ?? server.scopes_supported;
  return { resource: prm?.resource ?? resourceUrl, issuer, server, scope: scopes?.length ? scopes.join(' ') : undefined };
}

export interface Registration {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** Register Relay as a client of an authorization server (RFC 7591). */
export async function register(server: AuthServer, redirectUri: string, scope: string | undefined, http: Fetch = fetch): Promise<Registration> {
  if (!server.registration_endpoint) throw new Error("this service doesn't let apps register themselves");
  const res = await http(server.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Relay',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`registration failed (${res.status}) ${(await res.text().catch(() => '')).slice(0, 160)}`);
  const body = (await res.json()) as { client_id: string; client_secret?: string };
  return { clientId: body.client_id, clientSecret: body.client_secret, redirectUri };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(18).toString('base64url');
}

export function authorizeUrl(
  endpoint: string,
  p: { clientId: string; redirectUri: string; challenge: string; state: string; scope?: string; resource?: string; extra?: Record<string, string> },
): string {
  const url = new URL(endpoint);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', p.state);
  if (p.scope) q.set('scope', p.scope);
  if (p.resource) q.set('resource', p.resource);
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  return url.toString();
}

async function tokenRequest(http: Fetch, endpoint: string, form: Record<string, string | undefined>): Promise<TokenSet> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
  const res = await http(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`sign-in was refused (${res.status}) ${detail.slice(0, 160)}`);
  }
  const tokens = (await res.json()) as TokenSet;
  if (!tokens.access_token) throw new Error('sign-in returned no token');
  return tokens;
}

export function exchangeCode(
  http: Fetch,
  endpoint: string,
  p: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret?: string; resource?: string },
): Promise<TokenSet> {
  return tokenRequest(http, endpoint, {
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    resource: p.resource,
  });
}

export function refreshTokens(
  http: Fetch,
  endpoint: string,
  p: { refreshToken: string; clientId: string; clientSecret?: string; resource?: string },
): Promise<TokenSet> {
  return tokenRequest(http, endpoint, {
    grant_type: 'refresh_token',
    refresh_token: p.refreshToken,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    resource: p.resource,
  });
}

// --- Google ---------------------------------------------------------------------

export const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  /** offline → a refresh token; consent → Google re-issues it even if you connected before */
  extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
};

/** The email address in an id_token we just received from Google's token endpoint. */
export function emailFromIdToken(idToken?: string): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string };
    return claims.email;
  } catch {
    return undefined;
  }
}
