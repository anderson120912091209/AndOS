// Where an agent's work actually lands: your mailbox, your calendar.
//
// A connector does exactly one kind of side effect each. Drafting is reversible
// (draft → send or discard), sending and creating events are not — which is why
// only `commit.ts` calls `send` / `createEvent`, and only for a proposal you
// approved.
//
// Which one a job uses, in order:
//   1. an account you connected in the Mac app — the server hands the worker a
//      short-lived token for this job only (GET /api/connections/credentials)
//   2. RELAY_CONNECTOR=google with a refresh token in the worker's env (google.ts)
//   3. outbox — real files on disk (.eml / .ics) under .data/outbox, so the whole
//      loop runs with zero accounts and you can open the result.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeId, type ConnectionCredential } from '@relay/shared';
import { type EmailDraft, type EventDraft, toIcs, toRfc822 } from './mime.js';
import { GmailEmail, GmailReader, GoogleCalendar, StaticToken, googleConnectorsFromEnv, type MailReader } from './google.js';

export interface Receipt {
  id: string;
  /** where you can see it: a file path or a web link */
  where?: string;
}

export interface EmailConnector {
  readonly name: string;
  createDraft(email: EmailDraft): Promise<Receipt>;
  send(draftId: string): Promise<Receipt>;
  discard(draftId: string): Promise<void>;
}

export interface CalendarConnector {
  readonly name: string;
  createEvent(event: EventDraft): Promise<Receipt>;
}

export interface Connectors {
  email: EmailConnector;
  calendar: CalendarConnector;
}

const DEFAULT_OUTBOX = fileURLToPath(new URL('../../../.data/outbox', import.meta.url));

/** Drafts are files in drafts/; sending moves one to sent/. Nothing leaves the machine. */
export class OutboxEmail implements EmailConnector {
  readonly name = 'outbox';
  constructor(private root = process.env.RELAY_OUTBOX ?? DEFAULT_OUTBOX) {}

  private path(dir: 'drafts' | 'sent', id: string): string {
    return join(this.root, dir, `${id}.eml`);
  }

  async createDraft(email: EmailDraft): Promise<Receipt> {
    const id = makeId('draft');
    await mkdir(join(this.root, 'drafts'), { recursive: true });
    await writeFile(this.path('drafts', id), toRfc822(email, { messageId: `${id}@relay.local` }));
    return { id, where: this.path('drafts', id) };
  }

  async send(draftId: string): Promise<Receipt> {
    await mkdir(join(this.root, 'sent'), { recursive: true });
    await rename(this.path('drafts', draftId), this.path('sent', draftId));
    return { id: draftId, where: this.path('sent', draftId) };
  }

  async discard(draftId: string): Promise<void> {
    await rm(this.path('drafts', draftId), { force: true });
  }
}

/** Events become .ics files — double-click one to add it to Calendar.app. */
export class OutboxCalendar implements CalendarConnector {
  readonly name = 'outbox';
  constructor(private root = process.env.RELAY_OUTBOX ?? DEFAULT_OUTBOX) {}

  async createEvent(event: EventDraft): Promise<Receipt> {
    const id = makeId('event');
    const dir = join(this.root, 'calendar');
    await mkdir(dir, { recursive: true });
    const where = join(dir, `${id}.ics`);
    await writeFile(where, toIcs(event, { uid: `${id}@relay.local` }));
    return { id, where };
  }
}

export type McpCredential = Extract<ConnectionCredential, { kind: 'mcp' }>;

/** Everything one job may use. Built per job from that job's credentials, then dropped. */
export interface JobAccess {
  /** where drafts go and approved actions land */
  connectors: Connectors;
  /** reading your mailbox — only when Gmail is connected */
  mail?: MailReader;
  /** connected MCP servers, each limited to its read-only tools */
  mcp: McpCredential[];
}

export function accessFor(credentials: ConnectionCredential[], env = process.env): JobAccess {
  // A server with no allowed tools adds nothing but risk, so it isn't attached at all.
  const mcp = credentials.filter((c): c is McpCredential => c.kind === 'mcp' && c.tools.length > 0);
  const google = credentials.find((c) => c.kind === 'google');
  if (google) {
    const auth = new StaticToken(google.token);
    return { connectors: { email: new GmailEmail(auth), calendar: new GoogleCalendar(auth) }, mail: new GmailReader(auth), mcp };
  }
  return { connectors: connectorsFromEnv(env), mcp };
}

/**
 * The mailbox a draft actually lives in. A draft made in Gmail can only be sent from
 * Gmail: if Gmail was disconnected in between, say so rather than send from elsewhere.
 */
export function emailFor(via: unknown, access: JobAccess): EmailConnector {
  const current = access.connectors.email;
  if (via === undefined || via === current.name) return current;
  if (via === 'outbox') return new OutboxEmail();
  throw new Error(`this draft is in ${String(via)}, which isn't connected right now — reconnect it and approve again`);
}

/** RELAY_CONNECTOR=google uses your Google account; anything else stays local. */
export function connectorsFromEnv(env = process.env): Connectors {
  if (env.RELAY_CONNECTOR === 'google') {
    const google = googleConnectorsFromEnv(env);
    if (google) return google;
    console.warn('[worker] RELAY_CONNECTOR=google but GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN are missing — using the local outbox.');
  }
  return { email: new OutboxEmail(), calendar: new OutboxCalendar() };
}
