import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerConnections } from './routes.js';
import { readOnlyTools } from './mcp.js';
import { MemoryStore } from './secrets.js';
import { Vault } from './vault.js';
import { registerBox } from '../box/routes.js';
import { BoxSites, type BoxBrowser, type BoxCookie, type BoxPage } from '../box/sites.js';
import type { BoxDriver } from '../box/driver.js';

// A pretend Fathom (MCP + OAuth) and Google, answering the way the real ones do.
function fakeServices() {
  const calls: { url: string; method: string; body?: string }[] = [];
  let tokenCount = 0;
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
    calls.push({ url, method, body });

    if (url === 'https://api.fathom.ai/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: 'https://api.fathom.ai/mcp', authorization_servers: ['https://api.fathom.ai'], scopes_supported: ['mcp'] });
    }
    if (url === 'https://api.fathom.ai/.well-known/oauth-authorization-server') {
      return json({
        issuer: 'https://api.fathom.ai',
        authorization_endpoint: 'https://fathom.video/mcp/oauth/authorize',
        token_endpoint: 'https://api.fathom.ai/mcp/oauth/token',
        registration_endpoint: 'https://api.fathom.ai/mcp/oauth/register',
      });
    }
    if (url === 'https://api.fathom.ai/mcp/oauth/register') return json({ client_id: 'relay-client-1' }, { status: 201 });
    if (url === 'https://api.fathom.ai/mcp/oauth/token') {
      tokenCount++;
      return json({ access_token: `fathom-access-${tokenCount}`, refresh_token: `fathom-refresh-${tokenCount}`, expires_in: 3600 });
    }
    if (url === 'https://api.fathom.ai/mcp') {
      const msg = JSON.parse(body ?? '{}') as { id?: number; method: string };
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fathom' } }
          : { tools: [{ name: 'search_calls' }, { name: 'get_transcript' }] };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`, {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const idToken = ['x', Buffer.from(JSON.stringify({ email: 'anderson@example.com' })).toString('base64url'), 'sig'].join('.');
      return json({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600, scope: 'openid email gmail.readonly', id_token: idToken });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return new Response(null, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { http, calls };
}

async function setup(now = () => Date.now(), workerToken?: string) {
  const { http, calls } = fakeServices();
  const vault = new Vault(new MemoryStore(), http, now);
  const app = Fastify();
  await registerConnections(app, { vault, http, port: 8787, workerToken, devConnectors: true, builtinModel: false });
  return { app, calls, vault };
}

const local = { host: '127.0.0.1:8787' };

describe('Connections API', () => {
  it('connects Fathom in one click: discover, register, sign in, learn its tools', async () => {
    const { app, calls } = await setup();

    const before = (await app.inject({ url: '/api/connections', headers: local })).json().connections;
    expect(before.find((c: { id: string }) => c.id === 'fathom').state).toBe('available');
    expect(before.find((c: { id: string }) => c.id === 'slack')).toMatchObject({ state: 'available', via: 'box' }); // signed in on Relay’s computer

    const start = await app.inject({ method: 'POST', url: '/api/connections/fathom/connect', headers: local, payload: {} });
    expect(start.statusCode).toBe(200);
    const auth = new URL(start.json().authUrl);
    expect(auth.origin + auth.pathname).toBe('https://fathom.video/mcp/oauth/authorize');
    expect(auth.searchParams.get('client_id')).toBe('relay-client-1');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/api/connections/callback');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('resource')).toBe('https://api.fathom.ai/mcp');
    expect(auth.searchParams.get('scope')).toBe('mcp');

    const back = await app.inject({ url: `/api/connections/callback?code=c0de&state=${auth.searchParams.get('state')}`, headers: local });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('relay://connected?id=fathom');
    const exchange = calls.find((c) => c.url.endsWith('/mcp/oauth/token'));
    expect(exchange?.body).toContain('code_verifier=');
    expect(exchange?.body).toContain('resource=https%3A%2F%2Fapi.fathom.ai%2Fmcp');

    const after = (await app.inject({ url: '/api/connections', headers: local })).json().connections;
    expect(after.find((c: { id: string }) => c.id === 'fathom')).toMatchObject({ state: 'connected', tools: ['search_calls', 'get_transcript'] });

    const creds = (await app.inject({ url: '/api/connections/credentials', headers: local })).json().credentials;
    expect(creds).toEqual([
      { id: 'fathom', kind: 'mcp', name: 'Fathom', url: 'https://api.fathom.ai/mcp', token: 'fathom-access-1', tools: ['search_calls', 'get_transcript'] },
    ]);
  });

  it('registers once and reuses it next time', async () => {
    const { app, calls } = await setup();
    await app.inject({ method: 'POST', url: '/api/connections/fathom/connect', headers: local, payload: {} });
    await app.inject({ method: 'POST', url: '/api/connections/fathom/connect', headers: local, payload: {} });
    expect(calls.filter((c) => c.url.endsWith('/oauth/register'))).toHaveLength(1);
  });

  it('refreshes a token that is about to expire and keeps the rotated refresh token', async () => {
    let clock = 1_000_000;
    const { app, vault } = await setup(() => clock);
    const start = await app.inject({ method: 'POST', url: '/api/connections/fathom/connect', headers: local, payload: {} });
    const state = new URL(start.json().authUrl).searchParams.get('state');
    await app.inject({ url: `/api/connections/callback?code=c&state=${state}`, headers: local });
    // The vault stamped expiry with the real clock in the route; move ours far past it.
    clock = Date.now() + 2 * 3600_000;
    expect(await vault.token('fathom')).toBe('fathom-access-2');
    const rec = await vault.record('fathom');
    expect(rec?.kind === 'mcp' ? rec.refreshToken : undefined).toBe('fathom-refresh-2');
  });

  it('connects Gmail with your own Google key', async () => {
    const { app, calls } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/connections/gmail/connect', headers: local, payload: {} })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/api/connections/gmail/connect', headers: local, payload: { clientId: 'nope', clientSecret: 's' } })).statusCode,
    ).toBe(400);

    const start = await app.inject({
      method: 'POST', url: '/api/connections/gmail/connect', headers: local,
      payload: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' },
    });
    const auth = new URL(start.json().authUrl);
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('scope')).toContain('gmail.readonly');

    const back = await app.inject({ url: `/api/connections/callback?code=g&state=${auth.searchParams.get('state')}`, headers: local });
    expect(back.headers.location).toBe('relay://connected?id=gmail');
    const gmail = (await app.inject({ url: '/api/connections', headers: local })).json().connections.find((c: { id: string }) => c.id === 'gmail');
    expect(gmail).toMatchObject({ state: 'connected', account: 'anderson@example.com' });
    expect(calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')?.body).toContain('client_secret=GOCSPX-secret');

    await app.inject({ method: 'DELETE', url: '/api/connections/gmail', headers: local });
    expect(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true);
    const gone = (await app.inject({ url: '/api/connections', headers: local })).json().connections.find((c: { id: string }) => c.id === 'gmail');
    expect(gone.state).toBe('available');
  });

  it('tells the app when you cancel, and when a link has expired', async () => {
    const { app } = await setup();
    const start = await app.inject({ method: 'POST', url: '/api/connections/fathom/connect', headers: local, payload: {} });
    const state = new URL(start.json().authUrl).searchParams.get('state');
    const cancelled = await app.inject({ url: `/api/connections/callback?error=access_denied&state=${state}`, headers: local });
    expect(cancelled.headers.location).toBe('relay://connected?id=fathom&error=cancelled');
    const stale = await app.inject({ url: '/api/connections/callback?code=x&state=nope', headers: local });
    expect(stale.body).toContain('expired');
  });

  it('connects Claude with a pasted key, on a page of its own', async () => {
    const { app } = await setup();
    const start = await app.inject({ method: 'POST', url: '/api/connections/claude/connect', headers: local, payload: {} });
    const page = new URL(start.json().authUrl);
    expect(page.origin + page.pathname).toBe('http://127.0.0.1:8787/api/connections/key');
    const html = await app.inject({ url: page.pathname + page.search, headers: local });
    expect(html.body).toContain('Connect Claude');
    const state = page.searchParams.get('state');

    const here = { ...local, origin: 'http://127.0.0.1:8787' };
    const bad = await app.inject({ method: 'POST', url: '/api/connections/key', headers: here, payload: { state, apiKey: 'not-a-key' } });
    expect(bad.statusCode).toBe(400);
    const fromElsewhere = await app.inject({
      method: 'POST', url: '/api/connections/key', headers: { ...local, origin: 'https://evil.example' }, payload: { state, apiKey: 'sk-ant-attacker-key-000000000' },
    });
    expect(fromElsewhere.statusCode).toBe(403);

    const good = await app.inject({ method: 'POST', url: '/api/connections/key', headers: here, payload: { state, apiKey: 'sk-ant-api03-abcdefghijklmnop-WXYZ' } });
    expect(good.json()).toEqual({ next: 'relay://connected?id=claude' });
    const claude = (await app.inject({ url: '/api/connections', headers: local })).json().connections.find((c: { id: string }) => c.id === 'claude');
    expect(claude).toMatchObject({ state: 'connected', account: 'API key …WXYZ' });
    const creds = (await app.inject({ url: '/api/connections/credentials', headers: local })).json().credentials;
    expect(creds).toContainEqual({ id: 'claude', kind: 'anthropic', apiKey: 'sk-ant-api03-abcdefghijklmnop-WXYZ' });

    // The page can't be replayed.
    const again = await app.inject({ method: 'POST', url: '/api/connections/key', headers: here, payload: { state, apiKey: 'sk-ant-api03-abcdefghijklmnop-WXYZ' } });
    expect(again.statusCode).toBe(410);
  });

  it('lists only what fits the build: no Claude row when the model is built in, dev connectors on request', async () => {
    const { http } = fakeServices();
    const shipped = Fastify();
    await registerConnections(shipped, { vault: new Vault(new MemoryStore(), http), http, port: 8787, devConnectors: false, builtinModel: true });
    const rows = (await shipped.inject({ url: '/api/connections', headers: local })).json().connections;
    expect(rows.map((c: { id: string }) => c.id)).toEqual(['gmail', 'slack', 'notion', 'linear']);
    expect(rows.every((c: { via?: string; needsKey?: boolean }) => c.via === 'box' && !c.needsKey)).toBe(true); // no Google Cloud steps

    // Something you connected while developing stays listed, so you can still disconnect it.
    const vault = new Vault(new MemoryStore(), http);
    await vault.save('fathom', { kind: 'mcp', url: 'https://api.fathom.ai/mcp', resource: 'https://api.fathom.ai/mcp', tools: [], connectedAt: 1, accessToken: 't', clientId: 'c', tokenEndpoint: 'https://x' });
    const later = Fastify();
    await registerConnections(later, { vault, http, port: 8787, devConnectors: false, builtinModel: true });
    const listed = (await later.inject({ url: '/api/connections', headers: local })).json().connections.map((c: { id: string }) => c.id);
    expect(listed).toContain('fathom');
  });

  it('gives the worker an empty list when nothing is connected', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/connections/credentials', headers: local });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credentials: [] });
  });

  it('refuses web pages, DNS rebinding and other machines', async () => {
    const { app } = await setup();
    const evilPage = await app.inject({ url: '/api/connections/credentials', headers: { ...local, origin: 'https://evil.example' } });
    expect(evilPage.statusCode).toBe(403);
    const commandCenter = await app.inject({ url: '/api/connections/credentials', headers: { ...local, origin: 'http://localhost:5173' } });
    expect(commandCenter.statusCode).toBe(403); // tokens are for the worker only
    expect((await app.inject({ url: '/api/connections', headers: { ...local, origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/connections', headers: { ...local, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/connections', headers: { host: 'evil.example:8787' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/connections', headers: local, remoteAddress: '192.168.0.42' })).statusCode).toBe(403);
  });

  it('lets a worker on another machine fetch credentials with the shared token — and only that', async () => {
    const { app } = await setup(Date.now, 'relay-shared-token-1234');
    const remote = { remoteAddress: '10.0.0.5' };
    const bearer = (t: string) => ({ host: '10.0.0.1:8787', authorization: `Bearer ${t}` });
    expect((await app.inject({ url: '/api/connections/credentials', headers: bearer('relay-shared-token-1234'), ...remote })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/connections/credentials', headers: bearer('relay-shared-token-0000'), ...remote })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/api/connections/credentials', headers: { ...bearer('relay-shared-token-1234'), origin: 'https://evil.example' }, ...remote })).statusCode,
    ).toBe(403);
    // The token opens the worker's door only — not the Connections UI.
    expect((await app.inject({ url: '/api/connections', headers: bearer('relay-shared-token-1234'), ...remote })).statusCode).toBe(403);
  });

  it('lets a sandboxed worker in only with the shared token — by name alone it could be any container', async () => {
    const { app } = await setup(Date.now, 'relay-shared-token-1234');
    const token = { authorization: 'Bearer relay-shared-token-1234' };
    for (const host of ['host.docker.internal:8787', 'host.lima.internal:8787']) {
      expect((await app.inject({ url: '/api/connections/credentials', headers: { host } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/connections/credentials', headers: { host, ...token } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/connections/credentials', headers: { host, ...token, origin: 'http://localhost:5173' } })).statusCode).toBe(403);
      // the token is for the worker's door, not the Connections window
      expect((await app.inject({ url: '/api/connections', headers: { host, ...token } })).statusCode).toBe(403);
    }
  });
});

// Relay's computer, faked: a browser whose cookies and tabs the test sets, and a box that's up.
interface FakeBrowser extends BoxBrowser {
  jar: BoxCookie[];
  tabs: BoxPage[];
  up: boolean;
}

function fakeBox() {
  const browser: FakeBrowser = {
    jar: [],
    tabs: [],
    up: true,
    async cookies() {
      if (!browser.up) throw new Error('down');
      return browser.jar;
    },
    async expire(gone) {
      browser.jar = browser.jar.filter((c) => !gone.includes(c));
    },
    async pages() {
      return browser.tabs;
    },
  };
  const opened: { url?: string }[] = [];
  const driver: BoxDriver = {
    status: async () => ({ state: 'ready' }),
    start: async () => undefined,
    viewerUrl: async () => 'http://127.0.0.1:16080/relay.html?token=t',
    focus: async (t) => void opened.push(t),
  };
  const cookie = (name: string, domain: string): BoxCookie => ({ name, domain, path: '/', secure: true, httpOnly: true });
  return { browser, driver, opened, cookie };
}

describe('Read-only tools', () => {
  it('never offers a tool whose name acts on the world, whatever its label says', () => {
    const tools = ['search_calls', 'getThread', 'send_email', 'deleteDraft', 'create-event', 'list_bookmarks', 'mark_read']
      .map((name) => ({ name, readOnly: true }));
    expect(readOnlyTools('https://mcp.example.com', tools)).toEqual(['search_calls', 'getThread', 'list_bookmarks']);
  });
});

describe('Sites on Relay’s computer', () => {
  it('signs in on the box: Connect opens the site there, the row follows the browser’s own sign-in', async () => {
    const { http } = fakeServices();
    const { browser, driver, opened, cookie } = fakeBox();
    const app = Fastify();
    const box = await registerBox(app, { driver, sites: new BoxSites(browser) });
    await registerConnections(app, { vault: new Vault(new MemoryStore(), http), http, port: 8787, box, devConnectors: false, builtinModel: true });
    const row = async (id: string) =>
      (await app.inject({ url: '/api/connections', headers: local })).json().connections.find((c: { id: string }) => c.id === id);

    expect(await row('gmail')).toMatchObject({ state: 'available', via: 'box' });
    const res = await app.inject({ method: 'POST', url: '/api/connections/gmail/connect', headers: local, payload: { returnTo: 'mac' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().takeover).toMatchObject({ reason: 'Sign in to Gmail', service: 'Gmail', url: 'https://mail.google.com/' });
    expect(res.json().takeover.viewerUrl).toContain('token=');
    expect(opened.at(-1)).toEqual({ targetId: undefined, url: 'https://mail.google.com/' });

    // You sign in in the Box window; Google sets its session cookie and the inbox names you.
    browser.jar.push(cookie('SID', '.google.com'), cookie('NID', '.google.com'), cookie('d', '.slack.com'));
    browser.tabs.push({ url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (3) - me@example.com - Gmail' });
    expect(await row('gmail')).toMatchObject({ state: 'connected', account: 'me@example.com', via: 'box' });
    expect(await row('slack')).toMatchObject({ state: 'connected', via: 'box' });

    // The worker learns which sites it can use there — no tokens, just where.
    const creds = (await app.inject({ url: '/api/connections/credentials', headers: local })).json().credentials;
    expect(creds).toContainEqual({ id: 'gmail', kind: 'box', name: 'Gmail', url: 'https://mail.google.com/', account: 'me@example.com' });

    // Disconnect signs the box out of Google only.
    await app.inject({ method: 'DELETE', url: '/api/connections/gmail', headers: local });
    expect(browser.jar.map((c) => c.name)).toEqual(['d']);
    expect(await row('gmail')).toMatchObject({ state: 'available' });
  });

  it('takes your word for a site it can’t check, once you press Done', async () => {
    const { http } = fakeServices();
    const { browser, driver } = fakeBox();
    const app = Fastify();
    const box = await registerBox(app, { driver, sites: new BoxSites(browser) });
    await registerConnections(app, { vault: new Vault(new MemoryStore(), http), http, port: 8787, box, devConnectors: false, builtinModel: true });
    const linear = async () =>
      (await app.inject({ url: '/api/connections', headers: local })).json().connections.find((c: { id: string }) => c.id === 'linear');

    const { takeover } = (await app.inject({ method: 'POST', url: '/api/connections/linear/connect', headers: local, payload: {} })).json();
    await app.inject({ method: 'POST', url: `/api/box/takeover/${takeover.id}/cancel` });
    expect(await linear()).toMatchObject({ state: 'available' });

    const again = (await app.inject({ method: 'POST', url: '/api/connections/linear/connect', headers: local, payload: {} })).json().takeover;
    await app.inject({ method: 'POST', url: `/api/box/takeover/${again.id}/done` });
    expect(await linear()).toMatchObject({ state: 'connected', via: 'box' });

    // Off, or held while you use it: the sign-in lives on in the box's profile, so the row stays.
    browser.up = false;
    expect(await linear()).toMatchObject({ state: 'connected', via: 'box' });
  });

  it('a developer build swaps Gmail on the box for your own Google key', async () => {
    const { app } = await setup();
    const gmail = (await app.inject({ url: '/api/connections', headers: local })).json().connections.find((c: { id: string }) => c.id === 'gmail');
    expect(gmail).toMatchObject({ state: 'available', needsKey: true });
    expect(gmail.via).toBeUndefined();
  });

  it('says the box isn’t set up instead of pretending', async () => {
    const { http } = fakeServices();
    const app = Fastify();
    await registerConnections(app, { vault: new Vault(new MemoryStore(), http), http, port: 8787, devConnectors: false, builtinModel: true });
    const res = await app.inject({ method: 'POST', url: '/api/connections/gmail/connect', headers: local, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Relay’s computer/);
  });
});
