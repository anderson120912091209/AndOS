// Email (RFC 5322) and calendar (RFC 5545) text, built by hand so a draft looks
// the same in the local outbox as in Gmail. Chinese and other non-ASCII text is
// first-class: headers use RFC 2047 encoded-words, bodies are UTF-8 base64, and
// iCalendar lines fold on byte boundaries without splitting a character.

export interface EmailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface EventDraft {
  title: string;
  /** ISO 8601 with offset, e.g. 2026-10-26T15:00:00+08:00 */
  start: string;
  end?: string;
  location?: string;
  attendees?: string[];
  notes?: string;
}

const CRLF = '\r\n';
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** Split text into chunks of at most `maxBytes` UTF-8 bytes, never mid-character. */
function utf8Chunks(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += n;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** RFC 2047: ASCII stays readable; anything else becomes folded =?UTF-8?B?…?= words. */
export function encodeHeader(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  // 75-char words: "=?UTF-8?B?" + base64 + "?=" leaves 63 chars = 45 bytes of text.
  return utf8Chunks(value, 45)
    .map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`)
    .join(`${CRLF} `);
}

export function toRfc822(email: EmailDraft, opts: { date?: Date; messageId?: string; from?: string } = {}): string {
  const headers = [
    ...(opts.from ? [`From: ${opts.from}`] : []),
    `To: ${email.to.join(', ')}`,
    ...(email.cc?.length ? [`Cc: ${email.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(email.subject)}`,
    `Date: ${(opts.date ?? new Date()).toUTCString()}`,
    ...(opts.messageId ? [`Message-ID: <${opts.messageId}>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(email.body.replace(/\r?\n/g, CRLF), 'utf8').toString('base64');
  const wrapped = body.match(/.{1,76}/g)?.join(CRLF) ?? '';
  return headers.join(CRLF) + CRLF + CRLF + wrapped + CRLF;
}

/** iCalendar TEXT escaping: backslash, semicolon, comma, newline. */
function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 2026-10-26T15:00:00+08:00 → 20261026T070000Z */
function icsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Lines longer than 75 bytes continue on the next line after a single space. */
function fold(line: string): string {
  return utf8Chunks(line, 74).join(`${CRLF} `);
}

/** One-event .ics — opens in Calendar.app; the same fields Google Calendar takes. */
export function toIcs(event: EventDraft, opts: { uid: string; now?: Date }): string {
  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : new Date(start.getTime() + 30 * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Relay//Agent//EN',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${icsUtc((opts.now ?? new Date()).toISOString())}`,
    `DTSTART:${icsUtc(start.toISOString())}`,
    `DTEND:${icsUtc(end.toISOString())}`,
    `SUMMARY:${icsText(event.title)}`,
    ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
    ...(event.notes ? [`DESCRIPTION:${icsText(event.notes)}`] : []),
    ...(event.attendees ?? []).map((a) => `ATTENDEE;RSVP=TRUE:mailto:${a}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join(CRLF) + CRLF;
}
