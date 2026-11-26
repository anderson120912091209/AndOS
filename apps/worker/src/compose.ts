// Rule-based drafting for the simulated driver: turns "email Alex saying I'll be
// late" or 「明天下午三點跟Alex開會」 into a believable email or event, so the
// whole approve-in-the-notch loop works with no model and no account. The real
// agent (claude.ts) writes its own drafts; nothing here runs when it's selected.

import { displayName } from '@relay/shared';
import type { EmailDraft, EventDraft } from './mime.js';

const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HAN = /\p{Script=Han}/u;
const NAME = String.raw`[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?`;
const ZH_STOP = String.raw`(?=說|说|講|讲|告訴|告诉|關於|关于|問|问|確認|确认|道歉|，|,|。|\s|$)`;

function recipientName(u: string): string | undefined {
  const en = new RegExp(String.raw`\b(?:to|email|e-mail|message|ping|text)\s+(${NAME})`, 'u').exec(u);
  if (en?.[1]) return en[1];
  const zh = new RegExp(String.raw`(?:給|给|跟|向)\s*([\p{Script=Han}A-Za-z]{1,8}?)${ZH_STOP}`, 'u').exec(u);
  return zh?.[1];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '.').replace(/[^\w.]/g, '') || 'someone';
}

/** The part of the request that *is* the message: "…saying I'll be late" → "I'll be late". */
function messageClause(u: string): string | undefined {
  const en =
    /\b(?:saying|say|telling\s+(?:him|her|them)|tell\s+(?:him|her|them)|let\s+(?:him|her|them)\s+know|letting\s+(?:him|her|them)\s+know|that)\s+(?:that\s+)?(.+)$/i.exec(
      u,
    );
  if (en?.[1]) return en[1];
  const zh = /(?:說|说|講|讲|告訴[他她]們?|告诉[他她]们?)\s*(.+)$/u.exec(u);
  return zh?.[1];
}

function topic(u: string): string | undefined {
  return /\babout\s+(.+?)(?:[,.]|\s+and\s+|$)/i.exec(u)?.[1] ?? /(?:關於|关于)(.+?)(?:的事|，|,|。|$)/u.exec(u)?.[1];
}

function asSentence(text: string, zh: boolean): string {
  const t = text.trim().replace(/[\s,，]+$/, '');
  if (zh) return /[。！？!?]$/.test(t) ? t : `${t}。`;
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

export function composeEmail(utterance: string, opts: { signature?: string } = {}): EmailDraft {
  const zh = HAN.test(utterance);
  const addresses = utterance.match(ADDRESS) ?? [];
  const name = recipientName(utterance) ?? (addresses[0] ? displayName(addresses[0]) : undefined);
  const to = addresses.length ? addresses : name ? [`${slug(name)}@example.com`] : [];

  const about = topic(utterance);
  const message =
    messageClause(utterance) ??
    (about ? (zh ? `想跟你聊聊${about}的事` : `I wanted to reach out about ${about}`) : undefined) ??
    (zh ? '想跟你確認一下近況' : 'Just following up');

  // The subject is the message's first clause: "the launch moved to Friday and thanks…" → "The launch moved to Friday".
  const clause = message.split(/\s+(?:and|but|so|because)\s+|[,;:.!?—]|，|。|；|！|？/)[0]!.trim();
  const subject = about
    ? asSentence(about, zh).replace(/[.。]$/, '')
    : zh
      ? clause.slice(0, 16)
      : clause.split(/\s+/).slice(0, 8).join(' ').replace(/^\w/, (c) => c.toUpperCase());

  const greeting = zh ? `${name ?? ''}你好，` : `Hi ${name?.split(' ')[0] ?? 'there'},`;
  const closing = zh ? '祝好' : 'Best,';
  const body = [greeting, '', asSentence(message, zh), '', closing, ...(opts.signature ? [opts.signature] : [])].join('\n');
  return { to, subject, body };
}

/** Simulated revision: honest about being canned, but visibly applies the note. */
export function reviseEmail(email: EmailDraft, feedback: string): EmailDraft {
  const f = feedback.toLowerCase();
  const recipients = feedback.match(ADDRESS);
  let body = email.body;
  if (/short|brief|concise|簡短|简短|短一點|短一点/.test(f)) {
    const lines = body.split('\n').filter((l) => l.trim());
    body = [lines[0], '', lines[1], '', lines.at(-1)].filter((l) => l !== undefined).join('\n');
  } else if (/formal|polite|正式|禮貌|礼貌/.test(f)) {
    body = body.replace(/^Hi /, 'Dear ').replace(/^Best,$/m, 'Kind regards,').replace(/你好，/, '您好：');
  } else if (!recipients) {
    body = body.replace(/\n\n(Best,|祝好)/, `\n\n${asSentence(feedback, HAN.test(feedback))}\n\n$1`);
  }
  return { ...email, to: recipients ?? email.to, body };
}

// --- events -------------------------------------------------------------------

const ZH_DIGITS: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function zhNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (ZH_DIGITS[s[1]!] ?? 0);
  if (s.endsWith('十')) return (ZH_DIGITS[s[0]!] ?? 1) * 10;
  if (s.includes('十')) return (ZH_DIGITS[s[0]!] ?? 1) * 10 + (ZH_DIGITS[s.at(-1)!] ?? 0);
  return ZH_DIGITS[s] ?? NaN;
}

const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];

/** Minutes east of UTC that `timeZone` observes at `at`. */
export function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - at.getTime()) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Wall-clock time in `timeZone` → ISO 8601 with that zone's offset (DST-aware). */
export function zonedIso(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): string {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const off = offsetMinutes(new Date(wall - offsetMinutes(new Date(wall), timeZone) * 60_000), timeZone);
  const n = new Date(wall); // normalizes day overflow (Oct 32 → Nov 1)
  const sign = off >= 0 ? '+' : '-';
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}T${pad(n.getUTCHours())}:${pad(
    n.getUTCMinutes(),
  )}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function dayOffset(u: string, todayWeekday: number): number {
  const l = u.toLowerCase();
  if (/day after tomorrow|後天|后天/.test(l)) return 2;
  if (/\btomorrow\b|明天/.test(l)) return 1;
  if (/\btoday\b|\btonight\b|今天|今晚/.test(l)) return 0;
  const en = WEEKDAYS_EN.findIndex((w) => new RegExp(String.raw`\b${w}\b`).test(l));
  const zh = /(?:下)?(?:週|周|星期|禮拜|礼拜)([日一二三四五六天])/u.exec(u);
  const target = en >= 0 ? en : zh ? (zh[1] === '天' ? 0 : WEEKDAYS_ZH.indexOf(zh[1]!)) : -1;
  if (target < 0) return 1; // unspecified → tomorrow
  if (/\bnext\b|下(?:週|周|星期|禮拜|礼拜)/.test(l)) {
    // "next Friday" / 下週五: that day in next Monday-to-Sunday week.
    const toNextMonday = (8 - todayWeekday) % 7 || 7;
    return toNextMonday + ((target + 6) % 7);
  }
  return (target - todayWeekday + 7) % 7 || 7; // the coming one
}

function timeOfDay(u: string): { hh: number; mm: number } {
  if (/\bnoon\b|中午/.test(u) && !/\d|[一二三四五六七八九十]點/.test(u)) return { hh: 12, mm: 0 };
  const en = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(u) ?? /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(u);
  if (en) {
    let hh = Number(en[1]);
    const mm = Number(en[2] ?? 0);
    const mer = en[3]?.toLowerCase().replace(/\./g, '');
    if (mer === 'pm' && hh < 12) hh += 12;
    if (mer === 'am' && hh === 12) hh = 0;
    if (!mer && hh >= 1 && hh <= 7) hh += 12; // "at 3" means 3 pm
    return { hh, mm };
  }
  const zh = /(上午|早上|中午|下午|晚上)?\s*([0-9一二兩两三四五六七八九十]{1,3})\s*[點点](半|([0-9一二三四五六七八九十]{1,3})分?)?/u.exec(u);
  if (zh) {
    let hh = zhNumber(zh[2]!);
    const mm = zh[3] === '半' ? 30 : zh[4] ? zhNumber(zh[4]) : 0;
    if ((zh[1] === '下午' || zh[1] === '晚上') && hh < 12) hh += 12;
    if (!zh[1] && hh >= 1 && hh <= 7) hh += 12;
    if (Number.isFinite(hh)) return { hh, mm };
  }
  return { hh: 10, mm: 0 };
}

function durationMinutes(u: string): number {
  const mins = /(\d+)\s*(?:min|minutes|分鐘|分钟)/i.exec(u);
  if (mins) return Number(mins[1]);
  if (/half an hour|半小時|半小时/.test(u)) return 30;
  const hours = /(\d+|an|one|two|一|兩|两|二)\s*(?:個|个)?\s*(?:hours?|小時|小时)/i.exec(u);
  if (hours) return ({ an: 1, one: 1, two: 2 }[hours[1]!.toLowerCase()] ?? zhNumber(hours[1]!)) * 60 || 60;
  return 30;
}

export function composeEvent(utterance: string, now = new Date(), timeZone = 'UTC'): EventDraft {
  const what =
    /\b(meeting|call|coffee|lunch|dinner|sync|catch[- ]up|interview|demo|1:1)\b/i.exec(utterance)?.[1] ??
    /(開會|开会|吃飯|吃饭|喝咖啡|見面|见面|通話|通话|面試|面试)/u.exec(utterance)?.[1];
  const withWhom =
    new RegExp(String.raw`\bwith\s+(${NAME})`, 'u').exec(utterance)?.[1] ??
    new RegExp(String.raw`(?:跟|和|與|与)\s*([\p{Script=Han}A-Za-z]{1,8}?)(?=開會|开会|吃|喝|見|见|通|面|，|,|\s|$)`, 'u').exec(utterance)?.[1];
  const zh = HAN.test(utterance);
  const title = what
    ? zh
      ? `${withWhom ? `跟${withWhom}` : ''}${what}`
      : `${what.charAt(0).toUpperCase()}${what.slice(1)}${withWhom ? ` with ${withWhom}` : ''}`
    : withWhom
      ? zh
        ? `跟${withWhom}見面`
        : `Meeting with ${withWhom}`
      : zh
        ? '會議'
        : 'Meeting';

  const today = new Date(now.getTime() + offsetMinutes(now, timeZone) * 60_000); // wall clock as UTC fields
  const add = dayOffset(utterance, today.getUTCDay());
  const { hh, mm } = timeOfDay(utterance);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const d = today.getUTCDate() + add;
  const start = zonedIso(y, m, d, hh, mm, timeZone);
  const minutes = durationMinutes(utterance);
  const end = zonedIso(y, m, d, hh, mm + minutes, timeZone);

  const addresses = utterance.match(ADDRESS) ?? [];
  const attendees = addresses.length ? addresses : withWhom ? [`${slug(withWhom)}@example.com`] : undefined;
  const location =
    /\b(?:at|in)\s+(?!\d)(?!noon\b)([A-Z][\p{L}'&-]+(?:\s+[A-Z][\p{L}'&-]+)*)/u.exec(utterance)?.[1] ??
    /在([\p{Script=Han}A-Za-z]{2,12}?)(?=見|见|開|开|吃|喝|碰|，|,|$)/u.exec(utterance)?.[1];
  return { title, start, end, ...(location ? { location } : {}), ...(attendees ? { attendees } : {}) };
}
