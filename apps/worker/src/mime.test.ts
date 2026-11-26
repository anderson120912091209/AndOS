import { describe, expect, it } from 'vitest';
import { encodeHeader, toIcs, toRfc822 } from './mime.js';

const decodeWords = (h: string) =>
  [...h.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1]!, 'base64').toString('utf8')).join('');

describe('encodeHeader', () => {
  it('leaves ASCII readable', () => {
    expect(encodeHeader('Running late')).toBe('Running late');
  });

  it('encodes Chinese as RFC 2047 words of at most 75 chars that decode back exactly', () => {
    const subject = '明天的會議改到下午三點，請大家準時參加並準備好季度報告與預算檢討資料';
    const encoded = encodeHeader(subject);
    for (const word of encoded.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(encoded)).toBe(subject);
  });
});

describe('toRfc822', () => {
  it('writes headers and a UTF-8 base64 body that round-trips', () => {
    const raw = toRfc822({ to: ['a@x.io', 'b@x.io'], cc: ['c@x.io'], subject: '你好', body: 'Hi\n第二行' }, { date: new Date(0) });
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toContain('To: a@x.io, b@x.io');
    expect(head).toContain('Cc: c@x.io');
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hi\r\n第二行');
  });
});

describe('toIcs', () => {
  it('converts the start to UTC, defaults to 30 minutes, and escapes text', () => {
    const ics = toIcs(
      { title: 'Coffee, then demo; bring laptop', start: '2026-10-26T15:00:00+08:00', attendees: ['alex@acme.com'] },
      { uid: 'u1', now: new Date('2026-10-25T00:00:00Z') },
    );
    expect(ics).toContain('DTSTART:20261026T070000Z');
    expect(ics).toContain('DTEND:20261026T073000Z');
    expect(ics).toContain(String.raw`SUMMARY:Coffee\, then demo\; bring laptop`);
    expect(ics).toContain('ATTENDEE;RSVP=TRUE:mailto:alex@acme.com');
  });

  it('folds long lines without splitting a character', () => {
    const ics = toIcs({ title: '季度規劃'.repeat(20), start: '2026-10-26T15:00:00+08:00' }, { uid: 'u2' });
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(`SUMMARY:${'季度規劃'.repeat(20)}`);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});
