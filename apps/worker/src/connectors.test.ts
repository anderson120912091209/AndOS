import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discardDraft, executeCommit, stampVia } from './commit.js';
import { OutboxCalendar, OutboxEmail, accessFor, emailFor, type Connectors, type JobAccess } from './connectors.js';
import { emailProposal, eventProposal } from './driver.js';
import { GmailEmail, GmailReader, GoogleAuth, StaticToken } from './google.js';

async function outbox(): Promise<{ root: string; connectors: Connectors; access: JobAccess }> {
  const root = await mkdtemp(join(tmpdir(), 'relay-outbox-'));
  const connectors = { email: new OutboxEmail(root), calendar: new OutboxCalendar(root) };
  return { root, connectors, access: { connectors, mcp: [] } };
}

const email = { to: ['alex@acme.com'], subject: 'Running late', body: 'Hi Alex' };

describe('commit (outbox)', () => {
  it('sends only the approved draft, by moving it from drafts/ to sent/', async () => {
    const { root, connectors, access } = await outbox();
    const draft = await connectors.email.createDraft(email);
    expect(await readdir(join(root, 'drafts'))).toEqual([`${draft.id}.eml`]);

    const result = await executeCommit(emailProposal(email, draft.id), access);
    // The outbox never claims "Sent": nothing left this Mac.
    expect(result.summary).toBe('Not sent — the email to Alex is saved in Relay’s local outbox. Sending from your Gmail isn’t connected yet.');
    expect(result.artifacts).toContainEqual({ label: 'Saved in', value: 'Relay’s local outbox' });
    expect(await readdir(join(root, 'drafts'))).toEqual([]);
    expect(await readFile(join(root, 'sent', `${draft.id}.eml`), 'utf8')).toContain('Subject: Running late');
  });

  it('refuses to send an email with no recipient', async () => {
    const { connectors, access } = await outbox();
    const draft = await connectors.email.createDraft({ ...email, to: [] });
    await expect(executeCommit(emailProposal({ ...email, to: [] }, draft.id), access)).rejects.toThrow(/no recipient/);
  });

  it('discards a rejected draft', async () => {
    const { root, connectors, access } = await outbox();
    const draft = await connectors.email.createDraft(email);
    await discardDraft(emailProposal(email, draft.id), access);
    expect(await readdir(join(root, 'drafts'))).toEqual([]);
  });

  it('writes an approved event as an .ics file', async () => {
    const { root, access } = await outbox();
    const result = await executeCommit(eventProposal({ title: 'Coffee', start: '2026-10-26T15:00:00+08:00' }), access);
    expect(result.summary).toBe('Not added — “Coffee” is saved as a local file. Your real calendar isn’t connected yet.');
    const [file] = await readdir(join(root, 'calendar'));
    expect(await readFile(join(root, 'calendar', file!), 'utf8')).toContain('DTSTART:20261026T070000Z');
  });
});

describe('Gmail connector', () => {
  it('refreshes the token once, creates a raw RFC 822 draft, and sends it by id', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const http = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const body =
        String(url).includes('oauth2') ? { access_token: 'tok', expires_in: 3600 } : String(url).endsWith('/drafts') ? { id: 'r-1' } : { id: 'm-1' };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const gmail = new GmailEmail(new GoogleAuth('id', 'secret', 'refresh', http), http);

    const draft = await gmail.createDraft({ ...email, subject: '晚到' });
    const sent = await gmail.send(draft.id);

    expect(requests.filter((r) => r.url.includes('oauth2'))).toHaveLength(1);
    const created = JSON.parse(String(requests[1]!.init!.body)) as { message: { raw: string } };
    expect(Buffer.from(created.message.raw, 'base64url').toString('utf8')).toContain('To: alex@acme.com');
    expect(requests[1]!.init!.headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(JSON.parse(String(requests[2]!.init!.body))).toEqual({ id: 'r-1' });
    expect(sent).toEqual({ id: 'm-1', where: 'https://mail.google.com/mail/u/0/#all/m-1' });
  });
});

describe('per-job access', () => {
  it('uses a connected Gmail for drafts, sends and reads — and drops MCP servers with no read tools', () => {
    const access = accessFor([
      { id: 'gmail', kind: 'google', token: 'tok', scopes: [], account: 'me@x.io' },
      { id: 'fathom', kind: 'mcp', name: 'Fathom', url: 'https://f', token: 't', tools: ['list_meetings'] },
      { id: 'linear', kind: 'mcp', name: 'Linear', url: 'https://l', token: 't', tools: [] },
    ]);
    expect(access.connectors.email.name).toBe('gmail');
    expect(access.mail).toBeDefined();
    expect(access.mcp.map((m) => m.id)).toEqual(['fathom']);
  });

  it('falls back to the local outbox when nothing is connected', () => {
    const access = accessFor([], {});
    expect(access.connectors.email.name).toBe('outbox');
    expect(access.mail).toBeUndefined();
  });

  it('sends a draft from the mailbox it was written in, or refuses', () => {
    const outboxAccess = accessFor([], {});
    expect(emailFor('outbox', outboxAccess).name).toBe('outbox');
    expect(emailFor(undefined, outboxAccess).name).toBe('outbox');
    expect(() => emailFor('gmail', outboxAccess)).toThrow(/isn't connected right now/);
  });

  it('stamps an email proposal with where its draft lives', () => {
    const p = stampVia(emailProposal(email, 'd1'), 'gmail');
    expect(p.commit.args).toEqual({ draftId: 'd1', via: 'gmail' });
    const ev = eventProposal({ title: 'x', start: '2026-10-26T15:00:00+08:00' });
    expect(stampVia(ev, 'gmail')).toBe(ev);
  });
});

describe('Gmail reader', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

  it('searches, then fetches just the headers it shows', async () => {
    const urls: string[] = [];
    const http = (async (url: string | URL) => {
      urls.push(String(url));
      const u = String(url);
      const body = u.includes('/messages?')
        ? { messages: [{ id: 'm1' }] }
        : { id: 'm1', threadId: 't1', snippet: 'hi', labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'Alex <a@x.io>' }, { name: 'Subject', value: '合約' }] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const found = await new GmailReader(new StaticToken('tok'), http).search('is:unread', 5);
    expect(found).toEqual([{ id: 'm1', threadId: 't1', from: 'Alex <a@x.io>', to: '', subject: '合約', date: '', snippet: 'hi', unread: true }]);
    expect(decodeURIComponent(urls[0]!)).toContain('q=is:unread&maxResults=5');
    expect(urls[1]).toContain('format=metadata');
  });

  it('reads the plain-text part of a multipart message, or strips HTML when that is all there is', async () => {
    const message = (payload: unknown) =>
      (async () => new Response(JSON.stringify({ id: 'm1', threadId: 't1', payload }), { status: 200 })) as unknown as typeof fetch;
    const multipart = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<b>x</b>') } }, { mimeType: 'text/plain', body: { data: b64('請在週五前簽名') } }] };
    expect((await new GmailReader(new StaticToken('t'), message(multipart)).read('m1')).body).toBe('請在週五前簽名');
    const htmlOnly = { mimeType: 'text/html', body: { data: b64('<p>Hello</p><style>p{}</style><p>Sign&nbsp;by Friday</p>') } };
    expect((await new GmailReader(new StaticToken('t'), message(htmlOnly)).read('m1')).body).toBe('Hello\nSign by Friday');
  });
});
