// Gmail + Google Calendar connectors, over plain REST.
//
// Two ways to sign in:
//   - per job: the server hands the worker a short-lived access token for your connected
//     Google account (Connections in the Mac app) — `StaticToken`. Preferred.
//   - env: a long-lived refresh token you mint once (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//     GOOGLE_REFRESH_TOKEN), traded for access tokens as needed — `GoogleAuth`.
// Either way the worker can live on a remote VM and still act as you, without ever
// seeing your password.

import type { CalendarConnector, Connectors, EmailConnector, Receipt } from './connectors.js';
import { type EmailDraft, type EventDraft, toRfc822 } from './mime.js';

type Fetch = typeof fetch;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary';

export interface TokenSource {
  token(): Promise<string>;
}

/** An access token handed over for one job. */
export class StaticToken implements TokenSource {
  constructor(private value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
}

export class GoogleAuth implements TokenSource {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private clientId: string,
    private clientSecret: string,
    private refreshToken: string,
    private http: Fetch = fetch,
  ) {}

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google sign-in failed (${res.status}) — the refresh token may be revoked`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh a minute early so a token never expires mid-request.
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }
}

async function call<T>(auth: TokenSource, http: Fetch, url: string, method: string, body?: unknown): Promise<T> {
  const res = await http(url, {
    method,
    headers: {
      authorization: `Bearer ${await auth.token()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google API ${method} ${new URL(url).pathname} → ${res.status} ${detail.slice(0, 200)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export class GmailEmail implements EmailConnector {
  readonly name = 'gmail';
  constructor(private auth: TokenSource, private http: Fetch = fetch) {}

  async createDraft(email: EmailDraft): Promise<Receipt> {
    const raw = Buffer.from(toRfc822(email), 'utf8').toString('base64url');
    const draft = await call<{ id: string }>(this.auth, this.http, `${GMAIL}/drafts`, 'POST', { message: { raw } });
    return { id: draft.id, where: 'https://mail.google.com/mail/u/0/#drafts' };
  }

  async send(draftId: string): Promise<Receipt> {
    const sent = await call<{ id: string }>(this.auth, this.http, `${GMAIL}/drafts/send`, 'POST', { id: draftId });
    return { id: sent.id, where: `https://mail.google.com/mail/u/0/#all/${sent.id}` };
  }

  async discard(draftId: string): Promise<void> {
    await call<void>(this.auth, this.http, `${GMAIL}/drafts/${encodeURIComponent(draftId)}`, 'DELETE');
  }
}

export class GoogleCalendar implements CalendarConnector {
  readonly name = 'google-calendar';
  constructor(private auth: TokenSource, private http: Fetch = fetch) {}

  async createEvent(event: EventDraft): Promise<Receipt> {
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : new Date(start.getTime() + 30 * 60_000);
    // sendUpdates=all: invitees get the invite. This only runs after you approved it.
    const created = await call<{ id: string; htmlLink?: string }>(
      this.auth,
      this.http,
      `${CALENDAR}/events?sendUpdates=all`,
      'POST',
      {
        summary: event.title,
        location: event.location,
        description: event.notes,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: event.attendees?.map((email) => ({ email })),
      },
    );
    return { id: created.id, where: created.htmlLink };
  }
}

// --- Reading mail ---------------------------------------------------------------
// Reads are what make "go through my inbox" possible. They run in the worker as ordinary
// tools the agent may use without asking (policy.ts) — they change nothing.

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface MailMessage extends Omit<MailSummary, 'snippet'> {
  body: string;
}

export interface MailReader {
  search(query: string, max?: number): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

const BODY_LIMIT = 8000;

function header(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** The readable text of a message: text/plain if present, else HTML with the tags stripped. */
function plainText(part: GmailPart | undefined): string {
  if (!part) return '';
  const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');
  const find = (p: GmailPart, type: string): GmailPart | undefined =>
    p.mimeType === type && p.body?.data ? p : p.parts?.map((c) => find(c, type)).find(Boolean);
  const text = find(part, 'text/plain');
  if (text) return decode(text.body?.data);
  const html = find(part, 'text/html');
  return decode(html?.body?.data)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class GmailReader implements MailReader {
  constructor(private auth: TokenSource, private http: Fetch = fetch) {}

  async search(query: string, max = 10): Promise<MailSummary[]> {
    const q = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 25)) });
    const list = await call<{ messages?: { id: string }[] }>(this.auth, this.http, `${GMAIL}/messages?${q}`, 'GET');
    const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';
    const messages = await Promise.all(
      (list.messages ?? []).map((m) => call<GmailMessage>(this.auth, this.http, `${GMAIL}/messages/${m.id}?${meta}`, 'GET')),
    );
    return messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      from: header(m, 'From'),
      to: header(m, 'To'),
      subject: header(m, 'Subject'),
      date: header(m, 'Date'),
      snippet: m.snippet ?? '',
      unread: m.labelIds?.includes('UNREAD') ?? false,
    }));
  }

  async read(id: string): Promise<MailMessage> {
    const m = await call<GmailMessage>(this.auth, this.http, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, 'GET');
    const body = plainText(m.payload);
    return {
      id: m.id,
      threadId: m.threadId,
      from: header(m, 'From'),
      to: header(m, 'To'),
      subject: header(m, 'Subject'),
      date: header(m, 'Date'),
      unread: m.labelIds?.includes('UNREAD') ?? false,
      body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}…` : body,
    };
  }
}

export function googleConnectorsFromEnv(env: NodeJS.ProcessEnv): Connectors | undefined {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = env;
  if (!id || !secret || !refresh) return undefined;
  const auth = new GoogleAuth(id, secret, refresh);
  return { email: new GmailEmail(auth), calendar: new GoogleCalendar(auth) };
}
