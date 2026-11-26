import { describe, expect, it } from 'vitest';
import { composeEmail, composeEvent, offsetMinutes, reviseEmail, zonedIso } from './compose.js';

// Sunday 25 Oct 2026, 13:00 in Taipei
const NOW = new Date('2026-10-25T05:00:00Z');

describe('composeEmail', () => {
  it('finds the recipient and the message in English', () => {
    const e = composeEmail("email Sarah Lee saying the contract is signed and we're ready to start");
    expect(e.to).toEqual(['sarah.lee@example.com']);
    expect(e.body).toMatch(/^Hi Sarah,\n\nThe contract is signed and we're ready to start\.\n\nBest,$/);
    expect(e.subject).toBe('The contract is signed');
  });

  it('cuts the subject at the first clause', () => {
    expect(composeEmail('email Alex saying the launch moved to Friday and thanks for covering the demo').subject).toBe(
      'The launch moved to Friday',
    );
  });

  it('keeps a spoken email address and works in Chinese', () => {
    const e = composeEmail('寫一封信給王經理 wang@corp.tw 說我明天會晚一點到');
    expect(e.to).toEqual(['wang@corp.tw']);
    expect(e.body).toBe('王經理你好，\n\n我明天會晚一點到。\n\n祝好');
  });

  it('applies "shorter" and "more formal" revisions', () => {
    const e = composeEmail('email Alex about the Q3 budget');
    expect(reviseEmail(e, 'more formal').body).toMatch(/^Dear Alex,[\s\S]*Kind regards,$/);
    expect(reviseEmail(e, 'send it to alex@acme.com instead').to).toEqual(['alex@acme.com']);
  });
});

describe('composeEvent', () => {
  it('reads who, when and how long in English', () => {
    const ev = composeEvent('coffee with Alex at Blue Bottle tomorrow at 3pm for an hour', NOW, 'Asia/Taipei');
    expect(ev).toMatchObject({
      title: 'Coffee with Alex',
      start: '2026-10-26T15:00:00+08:00',
      end: '2026-10-26T16:00:00+08:00',
      location: 'Blue Bottle',
      attendees: ['alex@example.com'],
    });
  });

  it('understands 下週五 and 晚上七點半', () => {
    const ev = composeEvent('下週五晚上七點半跟小美吃飯', NOW, 'Asia/Taipei');
    expect(ev.title).toBe('跟小美吃飯');
    expect(ev.start).toBe('2026-10-30T19:30:00+08:00');
  });

  it('respects daylight saving in the target zone', () => {
    // US clocks fall back on 1 Nov 2026; a 9am meeting on the 2nd is UTC-8, not UTC-7.
    expect(zonedIso(2026, 11, 2, 9, 0, 'America/Los_Angeles')).toBe('2026-11-02T09:00:00-08:00');
    expect(offsetMinutes(new Date('2026-10-25T12:00:00Z'), 'America/Los_Angeles')).toBe(-420);
  });
});
