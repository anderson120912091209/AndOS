// Who may talk to the Relay server.
//
// This server can show your drafts, approve a send, and — once accounts are connected —
// run the agent against your mail. So it only answers your own Mac:
//
//   1. this machine only — a worker on another machine, or a container on this one (it reaches
//      us as host.docker.internal), must show RELAY_TOKEN
//   2. a localhost Host header — a web page on evil.example that re-points its DNS at
//      127.0.0.1 ("DNS rebinding") still sends Host: evil.example, and is refused
//   3. no other web pages — browsers attach an Origin to every cross-site request, and only
//      Relay's own pages (the Command Center) are on the list
//   4. worker routes are for programs: a browser can't claim, complete or propose tasks
//
// The Mac app, the worker and curl send no Origin at all, so they pass.

import { timingSafeEqual } from 'node:crypto';

export interface FenceConfig {
  /** web pages allowed to use the API — the Command Center */
  origins: ReadonlySet<string>;
  /** shared secret for workers on other machines; unset = this Mac only */
  token?: string;
}

export interface RequestFacts {
  path: string;
  remoteAddress?: string;
  host?: string;
  origin?: string;
  authorization?: string;
}

export type FenceVerdict = { ok: true } | { ok: false; reason: string };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** This Mac's own apps only — the Mac app, the dev worker, curl, the Command Center. */
const MAC_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;
/** The names a *container* uses to reach the Mac it runs on. A container is not this Mac: it
 *  arrives over loopback, but a prompt-injected box (its Chromium + our read_page tool) could
 *  pull credentials or approve its own send. So it must show RELAY_TOKEN, like a remote worker. */
const SANDBOX_HOSTS = new Set(['host.docker.internal', 'host.lima.internal']);

/** Compare without leaking, through response time, how much of a guess was right. */
function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkRequest(req: RequestFacts, config: FenceConfig): FenceVerdict {
  const hasToken = Boolean(config.token) && sameSecret(req.authorization, `Bearer ${config.token}`);
  const host = (req.host ?? '').replace(/:\d+$/, '');
  // A container reaches us over loopback but is not this Mac — hold it to the worker token.
  if (SANDBOX_HOSTS.has(host) && !hasToken) return { ok: false, reason: 'sandbox host needs RELAY_TOKEN' };
  if (!LOOPBACK.has(req.remoteAddress ?? '') && !hasToken) return { ok: false, reason: 'not from this Mac' };
  if (!MAC_HOST.test(host) && !hasToken) return { ok: false, reason: `unexpected Host "${host}"` };
  if (req.origin !== undefined) {
    if (req.path.startsWith('/api/worker/')) return { ok: false, reason: 'worker routes take no web origin' };
    if (!config.origins.has(req.origin)) return { ok: false, reason: `origin ${req.origin} not allowed` };
  }
  return { ok: true };
}

export function fenceFromEnv(port: number, env: NodeJS.ProcessEnv = process.env): FenceConfig {
  const pages = [5173, port].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
  const extra = (env.RELAY_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return { origins: new Set([...pages, ...extra]), token: env.RELAY_TOKEN || undefined };
}
