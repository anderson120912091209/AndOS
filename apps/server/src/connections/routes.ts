// The Connections API. Only Relay itself on this Mac may use it.
//
//   GET    /api/connections              what's connected (no secrets)
//   POST   /api/connections/:id/connect  → { authUrl } to open for sign-in, or { takeover } for a
//                                         site you sign in to on Relay's computer (the Box window)
//   GET    /api/connections/callback     the sign-in comes back here, then on to the app
//   DELETE /api/connections/:id          disconnect (for a box site: sign Relay's computer out of it)
//   GET    /api/connections/credentials  fresh tokens for one agent job (worker only)
//
// The whole server is fenced (../fence.ts); these routes keep a tighter fence of their own as
// defence in depth: loopback callers only, a localhost Host header (no DNS rebinding), and no
// web page origins except Relay's own — a page you happen to have open can't read your tokens
// or start a sign-in. A worker anywhere else — another machine, or a container on this one
// (host.docker.internal) — may fetch credentials (only) with the shared RELAY_TOKEN; over a
// network, run that through a private network or tunnel — the tokens travel with the reply.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  catalogEntry,
  type CatalogEntry,
  type ConnectionAuth,
  type ConnectionCredential,
  type ConnectionId,
  type ConnectionStatus,
} from '@relay/shared';
import { BoxError, type Box } from '../box/routes.js';
import type { SiteSession } from '../box/sites.js';
import { readOnlyTools, listTools } from './mcp.js';
import {
  authorizeUrl,
  discover,
  emailFromIdToken,
  exchangeCode,
  type Fetch,
  GOOGLE,
  pkce,
  randomState,
  register,
} from './oauth.js';
import { secretStoreFromEnv } from './secrets.js';
import { Vault } from './vault.js';

interface Pending {
  id: ConnectionId;
  kind: 'mcp' | 'google' | 'key';
  verifier: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
  url?: string;
  scopes?: string[];
  returnTo: 'mac' | 'web';
  created: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SANDBOX_HOSTS = new Set(['host.docker.internal', 'host.lima.internal']);
const FLOW_TTL = 10 * 60_000;

export interface ConnectionsOptions {
  vault?: Vault;
  http?: Fetch;
  port?: number;
  /** web pages allowed to manage connections (the Command Center) */
  origins?: string[];
  /** a worker on another machine sends `Authorization: Bearer <this>` (default: RELAY_TOKEN) */
  workerToken?: string;
  /**
   * The developer / bring-your-own connectors: Gmail over Google's API with your own key
   * (instead of Gmail on Relay's computer) and Fathom over MCP. Off unless asked for —
   * RELAY_DEV_CONNECTORS=1. Anything already connected through them stays listed regardless.
   */
  devConnectors?: boolean;
  /** Relay's computer, for sites you sign in to there (box/routes.ts). Without it they can't connect. */
  box?: Pick<Box, 'takeover' | 'takeovers' | 'sites'>;
  /** The server already provides the model (ANTHROPIC_API_KEY), so there's no Claude key to add. */
  builtinModel?: boolean;
}

export async function registerConnections(app: FastifyInstance, opts: ConnectionsOptions = {}): Promise<void> {
  const http = opts.http ?? fetch;
  const vault = opts.vault ?? new Vault(secretStoreFromEnv(), http);
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const redirectUri = `http://127.0.0.1:${port}/api/connections/callback`;
  const origins = new Set(opts.origins ?? ['http://localhost:5173', 'http://127.0.0.1:5173', `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const pending = new Map<string, Pending>();
  const workerToken = opts.workerToken ?? process.env.RELAY_TOKEN;
  const devConnectors = opts.devConnectors ?? process.env.RELAY_DEV_CONNECTORS === '1';
  const builtinModel = opts.builtinModel ?? !!process.env.ANTHROPIC_API_KEY;
  const box = opts.box;
  /** How this build connects an entry — a developer build swaps in `devAuth` where there is one. */
  const authOf = (entry: CatalogEntry): ConnectionAuth => (devConnectors && entry.devAuth) || entry.auth;
  /** Box sign-ins in flight: takeover id → the connection it signs in to. */
  const boxSignIns = new Map<string, ConnectionId>();
  box?.takeovers.onFinished((t) => {
    const id = boxSignIns.get(t.id);
    if (!id) return;
    boxSignIns.delete(t.id);
    if (t.state === 'done') box.sites.finishedSignIn(id);
  });
  /** The box's sign-ins right now — nothing when it's off (its rows just offer to sign in). */
  const boxSessions = async (): Promise<Map<ConnectionId, SiteSession> | undefined> =>
    box ? box.sites.sessions().catch(() => undefined) : undefined;
  /** What the Connections window lists. Anything you've connected stays, so you can disconnect it. */
  const listed = (s: { id: ConnectionId; state: string }) => {
    if (s.state === 'connected' || s.state === 'broken') return true;
    if (s.id === 'claude') return !builtinModel;
    return !catalogEntry(s.id)?.devOnly || devConnectors;
  };

  /** A worker elsewhere proves itself with the shared token — never a browser (no Origin). */
  const remoteWorker = (req: FastifyRequest): boolean => {
    if (!workerToken || req.headers.origin !== undefined) return false;
    const sent = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const want = Buffer.from(workerToken);
    return sent.length === want.length && timingSafeEqual(sent, want);
  };

  /** Relay on this Mac, and nothing else. `workerOnly` also refuses browsers outright. */
  const allowed = (req: FastifyRequest, workerOnly = false): boolean => {
    if (workerOnly && remoteWorker(req)) return true;
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const origin = req.headers.origin;
    // Every container on this Mac reaches it by these names, arriving as loopback — the box's
    // browser and any shell in it included. So the name proves nothing: a sandboxed worker gets
    // in only with the shared RELAY_TOKEN (checked above, worker routes only).
    if (SANDBOX_HOSTS.has(host)) return false;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false;
    if (origin === undefined) return true;
    return !workerOnly && origins.has(origin);
  };
  const deny = (reply: FastifyReply) => reply.code(403).send({ error: 'Relay connections are only available to Relay on this Mac.' });

  app.get('/api/connections', async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    const [statuses, sessions, googleKey] = await Promise.all([vault.statuses(), boxSessions(), vault.googleKey()]);
    const present = (s: ConnectionStatus): ConnectionStatus => {
      if (s.state !== 'available') return s; // signed in through an API or a key, or not ready yet
      const auth = authOf(catalogEntry(s.id)!);
      if (auth.type === 'google') return googleKey ? s : { ...s, needsKey: true };
      if (auth.type !== 'box') return s;
      const site = sessions?.get(s.id);
      return site?.signedIn ? { ...s, state: 'connected', account: site.account, via: 'box' } : { ...s, via: 'box' };
    };
    return { connections: statuses.map(present).filter(listed) };
  });

  app.post<{ Params: { id: string }; Body: { returnTo?: 'mac' | 'web'; clientId?: string; clientSecret?: string } | undefined }>(
    '/api/connections/:id/connect',
    async (req, reply) => {
      if (!allowed(req)) return deny(reply);
      const entry = catalogEntry(req.params.id);
      if (!entry) return reply.code(404).send({ error: 'unknown connection' });
      const auth = authOf(entry);
      if (auth.type === 'soon') return reply.code(409).send({ error: auth.note });

      // A site on Relay's computer: open it there and hand you the screen (the Box window).
      if (auth.type === 'box') {
        if (!box) return reply.code(409).send({ error: 'Relay’s computer isn’t set up on this Mac.' });
        try {
          const t = await box.takeover({ reason: `Sign in to ${entry.name}`, url: auth.url, service: entry.name });
          boxSignIns.set(t.id, entry.id);
          return { takeover: { id: t.id, reason: t.reason, service: t.service, url: t.url, viewerUrl: t.viewerUrl } };
        } catch (err) {
          return reply.code(err instanceof BoxError ? err.status : 409).send({ error: (err as Error).message });
        }
      }

      for (const [state, flow] of pending) if (Date.now() - flow.created > FLOW_TTL) pending.delete(state);
      const returnTo = req.body?.returnTo === 'web' ? 'web' : 'mac';
      const { verifier, challenge } = pkce();
      const state = randomState();

      try {
        if (auth.type === 'mcp') {
          const found = await discover(auth.url, http);
          let reg = await vault.registration(found.issuer);
          if (!reg || reg.redirectUri !== redirectUri) {
            reg = await register(found.server, redirectUri, found.scope, http);
            await vault.saveRegistration(found.issuer, reg);
          }
          pending.set(state, {
            id: entry.id, kind: 'mcp', verifier, tokenEndpoint: found.server.token_endpoint, clientId: reg.clientId,
            clientSecret: reg.clientSecret, resource: found.resource, url: auth.url, returnTo, created: Date.now(),
          });
          const authUrl = authorizeUrl(found.server.authorization_endpoint, {
            clientId: reg.clientId, redirectUri, challenge, state, scope: found.scope, resource: found.resource,
          });
          return { authUrl };
        }

        // A pasted key (Claude): the "sign-in" is a small page on this server, shown in the same
        // sheet, so it feels like every other connection.
        if (auth.type === 'key') {
          pending.set(state, {
            id: entry.id, kind: 'key', verifier: '', tokenEndpoint: '', clientId: '', returnTo, created: Date.now(),
          });
          return { authUrl: `http://127.0.0.1:${port}/api/connections/key?state=${encodeURIComponent(state)}` };
        }

        // Google: your own key, pasted once.
        const clientId = req.body?.clientId?.trim();
        const clientSecret = req.body?.clientSecret?.trim();
        if (clientId || clientSecret) {
          if (!clientId?.endsWith('.apps.googleusercontent.com') || !clientSecret) {
            return reply.code(400).send({ error: 'That doesn’t look like a Google client ID and secret.' });
          }
          await vault.saveGoogleKey({ clientId, clientSecret });
        }
        const key = await vault.googleKey();
        if (!key) return reply.code(409).send({ error: 'needs-key' });
        pending.set(state, {
          id: entry.id, kind: 'google', verifier, tokenEndpoint: GOOGLE.token, clientId: key.clientId,
          clientSecret: key.clientSecret, scopes: auth.scopes, returnTo, created: Date.now(),
        });
        const authUrl = authorizeUrl(GOOGLE.authorize, {
          clientId: key.clientId, redirectUri, challenge, state, scope: auth.scopes.join(' '), extra: GOOGLE.extra,
        });
        return { authUrl };
      } catch (err) {
        req.log.warn({ err }, `connect ${entry.id} failed`);
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/api/connections/callback',
    async (req, reply) => {
      if (!allowed(req)) return deny(reply);
      const flow = req.query.state ? pending.get(req.query.state) : undefined;
      if (!flow) return finish(reply, 'web', undefined, 'This sign-in expired — start again from Relay.');
      pending.delete(req.query.state!);
      if (req.query.error || !req.query.code) {
        const why = req.query.error === 'access_denied' ? 'cancelled' : (req.query.error_description ?? req.query.error ?? 'Sign-in failed');
        return finish(reply, flow.returnTo, flow.id, why);
      }
      try {
        const t = await exchangeCode(http, flow.tokenEndpoint, {
          code: req.query.code, verifier: flow.verifier, redirectUri, clientId: flow.clientId,
          clientSecret: flow.clientSecret, resource: flow.resource,
        });
        const base = {
          connectedAt: Date.now(),
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
          clientId: flow.clientId,
          clientSecret: flow.clientSecret,
          tokenEndpoint: flow.tokenEndpoint,
        };
        if (flow.kind === 'mcp') {
          const tools = await listTools(flow.url!, t.access_token, http).catch(() => []);
          await vault.save(flow.id, { ...base, kind: 'mcp', url: flow.url!, resource: flow.resource!, tools: readOnlyTools(flow.url!, tools) });
        } else {
          await vault.save(flow.id, { ...base, kind: 'google', scopes: t.scope?.split(' ') ?? flow.scopes ?? [], account: emailFromIdToken(t.id_token) });
        }
        req.log.info(`connected ${flow.id}`);
        return finish(reply, flow.returnTo, flow.id);
      } catch (err) {
        req.log.warn({ err }, `finishing ${flow.id} sign-in failed`);
        return finish(reply, flow.returnTo, flow.id, (err as Error).message);
      }
    },
  );

  // The key page and what it posts back. Same fence as everything else: only this Mac, and
  // only from this page (its origin is the server itself).
  app.get<{ Querystring: { state?: string } }>('/api/connections/key', async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    const flow = req.query.state ? pending.get(req.query.state) : undefined;
    const entry = flow ? catalogEntry(flow.id) : undefined;
    if (!flow || flow.kind !== 'key' || entry?.auth.type !== 'key') {
      return finish(reply, 'web', undefined, 'This link expired — start again from Relay.');
    }
    return reply.type('text/html; charset=utf-8').send(keyPage(entry.name, entry.auth.getKeyUrl, entry.auth.prefix, req.query.state!));
  });

  app.post<{ Body: { state?: string; apiKey?: string } | undefined }>('/api/connections/key', async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    const state = req.body?.state ?? '';
    const flow = pending.get(state);
    const entry = flow ? catalogEntry(flow.id) : undefined;
    if (!flow || flow.kind !== 'key' || entry?.auth.type !== 'key') {
      return reply.code(410).send({ error: 'This page expired — close it and press Connect again.' });
    }
    const apiKey = req.body?.apiKey?.trim() ?? '';
    if (!apiKey.startsWith(entry.auth.prefix) || apiKey.length < 24 || /\s/.test(apiKey)) {
      return reply.code(400).send({ error: `That doesn’t look like an Anthropic key — they start with ${entry.auth.prefix}` });
    }
    pending.delete(state);
    await vault.save(flow.id, { kind: 'key', apiKey, connectedAt: Date.now() });
    req.log.info(`connected ${flow.id}`);
    const next = flow.returnTo === 'mac' ? `relay://connected?id=${flow.id}` : `/api/connections/done?id=${flow.id}`;
    return { next };
  });

  app.get<{ Querystring: { id?: string } }>('/api/connections/done', async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    const entry = req.query.id ? catalogEntry(req.query.id) : undefined;
    return finish(reply, 'web', entry?.id);
  });

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    const entry = catalogEntry(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'unknown connection' });
    const rec = await vault.record(entry.id);
    if (!rec && entry.auth.type === 'box') {
      // Signed in on Relay's computer: sign it out there.
      if (!box) return reply.code(409).send({ error: 'Relay’s computer isn’t set up on this Mac.' });
      try {
        await box.sites.signOut(entry.id);
      } catch {
        return reply.code(409).send({ error: 'Relay’s computer is off — start it to sign out.' });
      }
      return { ok: true };
    }
    // Google lets us take the grant back too, so disconnecting really disconnects.
    if (rec?.kind === 'google' && rec.refreshToken) {
      await http(`${GOOGLE.revoke}?token=${encodeURIComponent(rec.refreshToken)}`, { method: 'POST' }).catch(() => undefined);
    }
    await vault.remove(entry.id);
    return { ok: true };
  });

  app.get('/api/connections/credentials', async (req, reply) => {
    if (!allowed(req, true)) return deny(reply);
    const [credentials, sessions] = await Promise.all([vault.credentials(), boxSessions()]);
    // Sites the box is signed in to carry no token — the agent works them in the box's browser.
    const onBox: ConnectionCredential[] = [];
    for (const [id, site] of sessions ?? []) {
      const entry = catalogEntry(id);
      if (!site.signedIn || entry?.auth.type !== 'box' || credentials.some((c) => c.id === id)) continue;
      onBox.push({ id, kind: 'box', name: entry.name, url: entry.auth.url, ...(site.account ? { account: site.account } : {}) });
    }
    return { credentials: [...credentials, ...onBox] };
  });
}

/** Back to the Mac app (which closes the sign-in sheet), or a page saying it worked. */
function finish(reply: FastifyReply, returnTo: 'mac' | 'web', id?: ConnectionId, error?: string) {
  if (returnTo === 'mac') {
    const q = new URLSearchParams();
    if (id) q.set('id', id);
    if (error) q.set('error', error);
    return reply.redirect(`relay://connected?${q.toString()}`, 302);
  }
  const name = id ? (catalogEntry(id)?.name ?? id) : 'Relay';
  const title = error ? 'Couldn’t connect' : `${name} is connected`;
  const detail = error ? escapeHtml(error) : 'You can close this tab and go back to what you were doing.';
  return reply
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:15px -apple-system,system-ui">` +
        `<div style="text-align:center"><div style="font-size:22px;font-weight:600;margin-bottom:8px">${escapeHtml(title)}</div>` +
        `<div style="opacity:.55">${detail}</div></div></body>`,
    );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The paste-your-key page: black, one field, one button — the same feel as Relay's windows. */
function keyPage(name: string, getKeyUrl: string, prefix: string, state: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connect ${escapeHtml(name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #fff;
         font: 14px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: min(420px, calc(100vw - 48px)); }
  .badge { width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; font-size: 19px;
           background: rgba(217,119,87,.18); color: #e08a68; margin-bottom: 18px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; letter-spacing: -.01em; }
  p { margin: 0; color: rgba(255,255,255,.55); }
  a { color: #fff; text-decoration: underline; text-decoration-color: rgba(255,255,255,.3); text-underline-offset: 2px; }
  label { display: block; margin: 22px 0 7px; font-size: 12.5px; font-weight: 500; color: rgba(255,255,255,.55); }
  input { width: 100%; height: 38px; padding: 0 12px; border-radius: 9px; border: 1px solid rgba(255,255,255,.1);
          background: rgba(255,255,255,.05); color: #fff; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; outline: none;
          transition: border-color .15s, background .15s; }
  input:focus { border-color: rgba(255,255,255,.35); background: rgba(255,255,255,.07); }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
  .note { flex: 1; font-size: 12px; color: rgba(255,255,255,.4); }
  .note.warn { color: #ffbc5c; }
  button { height: 32px; padding: 0 16px; border: 0; border-radius: 8px; background: #fff; color: #000;
           font: 600 13px -apple-system, system-ui; cursor: pointer; transition: opacity .15s; }
  button:disabled { opacity: .35; cursor: default; }
  .done { display: none; text-align: center; }
  .done .check { font-size: 34px; color: #73db8c; }
</style></head>
<body><main>
  <form id="f" autocomplete="off">
    <div class="badge">✳︎</div>
    <h1>Connect ${escapeHtml(name)}</h1>
    <p>Relay’s AI runs on your Anthropic account. Paste an API key — it stays in your Mac’s Keychain.
       <a href="${escapeHtml(getKeyUrl)}" target="_blank" rel="noopener">Get a key</a></p>
    <label for="k">API key</label>
    <input id="k" name="apiKey" type="password" placeholder="${escapeHtml(prefix)}…" spellcheck="false" autofocus>
    <div class="row"><span class="note" id="n">Only Relay on this Mac can read it.</span><button id="b" disabled>Connect</button></div>
  </form>
  <div class="done" id="d"><div class="check">✓</div><h1>${escapeHtml(name)} is connected</h1><p>Back to Relay…</p></div>
</main>
<script>
  const k = document.getElementById('k'), b = document.getElementById('b'), n = document.getElementById('n');
  const ok = () => k.value.trim().startsWith(${JSON.stringify(prefix)}) && k.value.trim().length >= 24;
  k.addEventListener('input', () => { b.disabled = !ok(); n.className = 'note'; n.textContent = 'Only Relay on this Mac can read it.'; });
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!ok()) return;
    b.disabled = true; b.textContent = 'Connecting…';
    try {
      const r = await fetch('/api/connections/key', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: ${JSON.stringify(state)}, apiKey: k.value.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'That didn’t work');
      document.getElementById('f').style.display = 'none';
      document.getElementById('d').style.display = 'block';
      setTimeout(() => { location.href = d.next; }, 450);
    } catch (err) {
      n.className = 'note warn'; n.textContent = err.message; b.disabled = false; b.textContent = 'Connect';
    }
  });
</script></body></html>`;
}
