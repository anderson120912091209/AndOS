// Connecting a user's Google account the official way (OAuth 2.0), and the Calendar calls Piko makes with it.
//
//   Piko's card → /connect/google?s=<signed state>   (opened in the phone's real browser: Google refuses to
//                                                     sign people in inside LINE's in-app browser)
//   → Google's own sign-in and consent page            (the password never touches Piko)
//   → /oauth/google/callback?code=…&state=…            (we trade the one-time code for tokens, using our secret)
//   → tokens saved for that LINE user only, and the waiting task is told it can go on.
//
// Dev storage: one 0600 file per user under .data/. Encrypt these at rest before real users.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { addMinutes } from '../time.js';
import type { CalendarEvent, ToolResult } from '../types.js';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];

export interface ConnectState {
  userId: string;
  taskId?: string;
  exp: number;
  nonce: string;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  email?: string;
}

function mac(data: string): string {
  return createHmac('sha256', config.secret).update(data).digest('base64url');
}

/** A signed, expiring ticket that ties the Google sign-in to one LINE user (and the task that asked). */
export function makeState(userId: string, taskId?: string): string {
  const payload: ConnectState = { userId, taskId, exp: Date.now() + 30 * 60_000, nonce: randomBytes(12).toString('base64url') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function readState(state: string): ConnectState | undefined {
  const [body, signature] = state.split('.');
  if (!body || !signature) return undefined;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConnectState;
  return payload.exp > Date.now() ? payload : undefined;
}

/** The PKCE verifier is derived from the state's nonce, so nothing needs storing between the two requests. */
function verifier(nonce: string): string {
  return mac(`pkce:${nonce}`);
}

const redirectUri = () => `${config.publicUrl}/oauth/google/callback`;

/** What Piko's 「用 Google 登入」 button opens. */
export function connectLink(userId: string, taskId?: string): string {
  return `${config.publicUrl}/connect/google?s=${encodeURIComponent(makeState(userId, taskId))}&openExternalBrowser=1`;
}

export function consentUrl(state: string, payload: ConnectState): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: createHash('sha256').update(verifier(payload.nonce)).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function tokenFile(userId: string): string {
  const dir = join(config.dataDir, 'connections', userId.replace(/[^A-Za-z0-9_-]/g, '_'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'google.json');
}

function load(userId: string): Tokens | undefined {
  const file = tokenFile(userId);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Tokens) : undefined;
}

function save(userId: string, tokens: Tokens): void {
  writeFileSync(tokenFile(userId), JSON.stringify(tokens), { mode: 0o600 });
}

export function googleAccount(userId: string): { email?: string } | undefined {
  const tokens = load(userId);
  return tokens ? { email: tokens.email } : undefined;
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google said ${String(json.error)}: ${String(json.error_description ?? '')}`);
  return json;
}

/** Trades the one-time code for tokens and keeps them for this user. Returns the Google account's email. */
export async function finishConnect(code: string, payload: ConnectState): Promise<string | undefined> {
  const json = await tokenRequest({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code_verifier: verifier(payload.nonce),
  });
  // The id_token came straight from Google's token endpoint over TLS, so its payload can be read as is.
  const claims = String(json.id_token ?? '').split('.')[1];
  const email = claims ? (JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { email?: string }).email : undefined;
  save(payload.userId, {
    access_token: String(json.access_token),
    refresh_token: (json.refresh_token as string | undefined) ?? load(payload.userId)?.refresh_token,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    email,
  });
  return email;
}

async function accessToken(userId: string): Promise<string | undefined> {
  const tokens = load(userId);
  if (!tokens) return undefined;
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
  if (!tokens.refresh_token) return undefined;
  const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  const next = { ...tokens, access_token: String(json.access_token), expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  save(userId, next);
  return next.access_token;
}

const NOT_CONNECTED: ToolResult = {
  content: 'Google is not connected for this user (or access was removed). Offer connect_google, or use add_to_calendar instead.',
  isError: true,
};

async function calendarApi(userId: string, path: string, init?: RequestInit): Promise<Response | undefined> {
  const token = await accessToken(userId);
  if (!token) return undefined;
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init?.headers },
  });
  if (res.status === 401) {
    rmSync(tokenFile(userId)); // revoked from the user's Google account: forget it
    return undefined;
  }
  return res;
}

/** `2026-10-26T16:00` → Calendar API date-time in Taiwan time. */
function at(local: string) {
  return { dateTime: `${local}:00`, timeZone: 'Asia/Taipei' };
}

export async function addEvent(userId: string, event: CalendarEvent): Promise<ToolResult> {
  const end = event.end ?? addMinutes(event.start, 60);
  const res = await calendarApi(userId, '/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify({ summary: event.title, location: event.location, description: event.notes, start: at(event.start), end: at(end) }),
  });
  if (!res) return NOT_CONNECTED;
  if (!res.ok) return { content: `Google Calendar refused (${res.status}): ${await res.text()}`, isError: true };
  const created = (await res.json()) as { htmlLink?: string };
  return { content: `Added to the user's Google Calendar: ${event.title}, ${event.start} to ${end}. Link: ${created.htmlLink ?? ''}` };
}

export async function listEvents(userId: string, from: string, to: string): Promise<ToolResult> {
  const params = new URLSearchParams({
    timeMin: `${from}:00+08:00`,
    timeMax: `${to}:00+08:00`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '25',
  });
  const res = await calendarApi(userId, `/calendars/primary/events?${params}`);
  if (!res) return NOT_CONNECTED;
  if (!res.ok) return { content: `Google Calendar refused (${res.status}): ${await res.text()}`, isError: true };
  const { items = [] } = (await res.json()) as {
    items?: { summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
  };
  if (items.length === 0) return { content: 'No events in that time range.' };
  return {
    content: items
      .map((e) => `- ${e.start?.dateTime ?? e.start?.date} → ${e.end?.dateTime ?? e.end?.date}: ${e.summary ?? '(no title)'}${e.location ? ` @ ${e.location}` : ''}`)
      .join('\n'),
  };
}
