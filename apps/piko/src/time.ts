// Taiwan time helpers. Piko's tools take times as Taiwan local time, `2026-10-26T16:00`; Taiwan has no daylight
// saving, so UTC+8 is always right.

const OFFSET_MS = 8 * 60 * 60 * 1000;

/** Milliseconds since the epoch for a Taiwan local time. */
export function taiwanMs(local: string): number {
  return Date.parse(`${local}:00+08:00`);
}

/** Back from milliseconds to `2026-10-26T16:00` in Taiwan time. */
export function taiwanLocal(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 16);
}

export function addMinutes(local: string, minutes: number): string {
  return taiwanLocal(taiwanMs(local) + minutes * 60_000);
}

/** How 長輩 read a date and time: 10月26日（週一）下午4:00. */
export function spoken(local: string): string {
  const date = new Date(taiwanMs(local))
    .toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'short' })
    .replace(/(週.)$/, '（$1）');
  return `${date}${clock(local)}`;
}

/** Just the time of day: 下午4:00. */
export function clock(local: string): string {
  return new Date(taiwanMs(local)).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: 'numeric', minute: '2-digit' });
}

/** Google Calendar's "add event" link, prefilled; it opens the app or the website. */
export function googleCalendarLink(event: { title: string; start: string; end?: string; location?: string; notes?: string }): string {
  const compact = (local: string) => `${local.replace(/[-:]/g, '')}00`;
  const end = event.end ?? addMinutes(event.start, 60);
  const params = new URLSearchParams({ action: 'TEMPLATE', text: event.title, dates: `${compact(event.start)}/${compact(end)}`, ctz: 'Asia/Taipei' });
  if (event.location) params.set('location', event.location);
  if (event.notes) params.set('details', event.notes);
  return `https://calendar.google.com/calendar/render?${params}`;
}
