// Takeover: the user drives their own Piko computer for a few minutes from their phone, to sign in to a site
// or get past a check only a person should pass. Whoever holds that screen holds the user's signed-in browser,
// so every step is narrow:
//
//   1. The LINE button carries a ticket. It works once, for 10 minutes. `deliver` mints it right before the
//      message goes out, so it never sits in Temporal's history, and only its hash is stored.
//   2. With LIFF set up, the page also proves who is holding the phone: LINE signs an ID token, LINE's own
//      server checks it here, and its user must own the box. A forwarded link opens nothing.
//   3. Opening trades the ticket for a session cookie (HttpOnly, Secure, SameSite=Strict, 20 minutes, one
//      browser). The screen's WebSocket needs that cookie and our own Origin.
//   4. Before a session starts, the box holds the agent (apps/piko-box/agentctl): every process of Piko's is
//      killed, so nothing of Piko's can watch the screen or read keys while the person types. The task
//      releases the hold when it closes the takeover, whichever way that happens.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, liffReady } from './config.js';
import { audit, readGrant, writeGrant } from './store.js';
import type { Grant } from './types.js';

export const TICKET_TTL_MS = 10 * 60_000;
/** Long enough for a real sign-in with a code by SMS; within the box's own limit on a hold (TTL in agentctl). */
export const SESSION_TTL_MS = 20 * 60_000;

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function sameHash(secret: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const given = Buffer.from(hash(secret), 'hex');
  const want = Buffer.from(expected, 'hex');
  return given.length === want.length && timingSafeEqual(given, want);
}

/** A takeover's id: one per task and request, so two tasks can never share (or reopen) a record. */
export function grantId(taskId: string, requestId: string): string {
  return createHash('sha256').update(`${taskId}\n${requestId}`).digest('hex').slice(0, 32);
}

/** `<grant id>.<secret>`: the id finds the record, the secret proves the holder. */
function split(credential: string | undefined): { id: string; secret: string } | undefined {
  const match = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(credential ?? '');
  return match ? { id: match[1] as string, secret: match[2] as string } : undefined;
}

function mint(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Called by `deliver` as the takeover card goes out. A fresh ticket replaces an earlier unused one (a delivery
 * that failed and is retried), but never reopens a takeover that was already opened or closed.
 */
export function issueTicket(args: { requestId: string; taskId: string; userId: string; reason: string }): string | undefined {
  const id = grantId(args.taskId, args.requestId);
  const earlier = readGrant(id);
  if (earlier?.openedAt || earlier?.closedAt) return undefined;
  const secret = mint();
  writeGrant({ id, ...args, ticketHash: hash(secret), ticketExpiresAt: Date.now() + TICKET_TTL_MS });
  audit('takeover.ticket', { grant: id, userId: args.userId, taskId: args.taskId });
  return `${id}.${secret}`;
}

export function takeoverLink(ticket: string | undefined): string | undefined {
  if (!ticket) return undefined;
  const t = encodeURIComponent(ticket);
  if (liffReady()) return `https://liff.line.me/${config.liff.id}?t=${t}`;
  return `${config.publicUrl || `http://${config.host}:${config.port}`}/takeover?t=${t}`;
}

/** Asks LINE whether an ID token is genuine, unexpired and issued for our LIFF channel; returns its user. */
async function lineUser(idToken: string | undefined): Promise<string | undefined> {
  if (!idToken || idToken.length > 4096) return undefined;
  try {
    const res = await fetch(`${config.line.api}/oauth2/v2.1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: config.liff.channelId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const claims = (await res.json()) as { sub?: string; aud?: string; exp?: number };
    if (claims.aud !== config.liff.channelId || !claims.exp || claims.exp * 1000 < Date.now()) return undefined;
    return claims.sub;
  } catch {
    return undefined;
  }
}

export type Opening =
  | { ok: true; grant: Grant; resumed: boolean }
  | { ok: false; status: number; message: string };

const refuse = (status: number, message: string): Opening => ({ ok: false, status, message });

/**
 * Checks a request to open the screen. A valid session cookie resumes (the phone reloaded the page);
 * otherwise the ticket must be genuine, fresh and unused, and with LIFF the person must be the box's owner.
 * Nothing is marked yet: `startSession` does that once the box holds the agent.
 */
export async function checkOpen(args: { ticket?: string; cookie?: string; idToken?: string; ip: string }): Promise<Opening> {
  const resumed = session(args.cookie);
  if (resumed) return { ok: true, grant: resumed, resumed: true };

  const parts = split(args.ticket);
  const grant = parts ? readGrant(parts.id) : undefined;
  if (!parts || !grant || !sameHash(parts.secret, grant.ticketHash)) {
    audit('takeover.refused', { why: 'bad ticket', ip: args.ip });
    return refuse(403, '這個連結無效。請從 LINE 裡 Piko 傳的按鈕打開。');
  }
  const why = grant.closedAt ? 'closed' : grant.openedAt ? 'used' : grant.ticketExpiresAt < Date.now() ? 'expired' : undefined;
  if (why) {
    audit('takeover.refused', { why, grant: grant.id, ip: args.ip });
    return refuse(410, why === 'used' ? '這個連結已經用過了。' : '這個連結過期了。回到 LINE 跟 Piko 說一聲，它會再傳一個新的。');
  }
  if (liffReady()) {
    const user = await lineUser(args.idToken);
    if (user !== grant.userId) {
      audit('takeover.refused', { why: user ? 'another LINE user' : 'no LINE identity', grant: grant.id, ip: args.ip });
      return refuse(403, '這個畫面只有本人可以打開。');
    }
  } else if (config.production) {
    return refuse(503, '這個功能還沒設定好。');
  }
  return { ok: true, grant, resumed: false };
}

/** Marks the ticket used and returns the session cookie's value. Call only after the box holds the agent. */
export function startSession(grant: Grant, ip: string): { cookie: string; grant: Grant } {
  const secret = mint();
  const now = Date.now();
  const opened: Grant = { ...grant, openedAt: now, sessionHash: hash(secret), sessionExpiresAt: now + SESSION_TTL_MS };
  writeGrant(opened);
  audit('takeover.opened', { grant: grant.id, userId: grant.userId, ip, identity: liffReady() ? 'liff' : 'ticket only' });
  return { cookie: `${grant.id}.${secret}`, grant: opened };
}

/** The open takeover a session cookie belongs to, if it is still live. */
export function session(cookie: string | undefined): Grant | undefined {
  const parts = split(cookie);
  const grant = parts ? readGrant(parts.id) : undefined;
  if (!parts || !grant || grant.closedAt || !grant.sessionExpiresAt || grant.sessionExpiresAt < Date.now()) return undefined;
  return sameHash(parts.secret, grant.sessionHash) ? grant : undefined;
}

/** Ends a takeover for good: its ticket and session stop working. Safe to call again. */
export function closeGrant(id: string, why: string): Grant | undefined {
  const grant = readGrant(id);
  if (!grant || grant.closedAt) return grant;
  const closed = { ...grant, closedAt: Date.now() };
  writeGrant(closed);
  audit('takeover.closed', { grant: id, userId: grant.userId, why });
  return closed;
}
