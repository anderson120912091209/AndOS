// What an agent hands back when it's done — shaped for the notch, not a blob of text.
//
// The notch is small, and free text doesn't fit it: the old card cut every answer at four
// lines (the part that mattered was usually further down) and printed its markdown raw. So
// the agent ends a run by calling `finish` with an Answer — the conclusion first, at most one
// structured block, and what you might say next — and the notch picks the container from the
// shape (placeFor): one line stays in the chin under the notch, a block opens a card, a
// document opens the reader. Nothing is shrunk or cut off; it moves to a container that fits.

import type { Task, TaskResult } from './task.js';

/** What kind of ending it is — sets the colour and the character's mood. */
export type AnswerTone = 'answer' | 'done' | 'needs_you';

/** A list tag's colour: amber = it's on you, red = urgent, green = good news. */
export type TagTone = 'neutral' | 'amber' | 'red' | 'green';

export interface ListItem {
  title: string;
  /** quieter, after the title — an email's subject */
  sub?: string;
  /** the one line that says why it's on the list */
  detail?: string;
  /** a short tag at the end: "週五前", "要回" */
  tag?: string;
  tone?: TagTone;
}

/** The one structured thing a card shows. Each kind renders natively in the notch. */
export type Block =
  | { kind: 'text'; body: string }
  /** emails to answer, search results, steps it took — the rest summed up in `more` */
  | { kind: 'list'; items: ListItem[]; more?: string }
  /** label → value: a booking, a receipt, someone's details */
  | { kind: 'facts'; rows: { label: string; value: string }[] }
  /** options side by side; `pick` is the column it recommends */
  | { kind: 'compare'; columns: string[]; rows: { label: string; values: string[] }[]; pick?: number }
  /** it needs you to pick one; tapping an option answers it */
  | { kind: 'choice'; options: { label: string; note?: string }[]; recommended?: number }
  /** long-form writing you asked for — opens in the reader */
  | { kind: 'doc'; title: string; markdown: string };

export interface Answer {
  tone: AnswerTone;
  /** the conclusion, first — the whole answer when it fits on one line */
  headline: string;
  /** what it went through, in a few words ("讀完 40 封未讀") */
  basis?: string;
  block?: Block;
  /** an assumption it made, or a caveat, in one line */
  note?: string;
  /** up to three things you might say next — each one a button that asks it */
  followups?: string[];
}

/** Where an answer lives: one line under the notch, a card, or the reader. */
export type Placement = 'chin' | 'card' | 'reader';

/** One line under the notch holds about this much — ~28 Chinese characters or ~56 Latin ones. */
const CHIN_WIDTH = 56;
/** A paragraph longer than this reads better in the reader than in a card. */
const LONG_TEXT = 560;

/** Where the notch shows an answer. Shape decides first; length only matters for bare text. */
export function placeFor(a: Answer): Placement {
  const b = a.block;
  if (b?.kind === 'doc' || (b?.kind === 'text' && displayWidth(b.body) > LONG_TEXT)) return 'reader';
  if (b || a.tone === 'needs_you') return 'card'; // a question needs room for its answers
  return displayWidth(a.headline) <= CHIN_WIDTH ? 'chin' : 'card';
}

/** How wide a string reads: CJK, full-width and emoji count double. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** The task result for an answer: the answer itself, where it goes, and plain text for everything else. */
export function answerResult(a: Answer): TaskResult {
  return { summary: answerText(a), answer: a, place: placeFor(a) };
}

// --- Taking it from the model ------------------------------------------------

const MAX = { headline: 120, basis: 60, note: 200, line: 160, followup: 40, followups: 3, items: 8, rows: 10, columns: 4, options: 5 };
const TONES: readonly AnswerTone[] = ['answer', 'done', 'needs_you'];
const TAG_TONES: readonly TagTone[] = ['neutral', 'amber', 'red', 'green'];

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
/** A trimmed one-liner, or undefined when there's nothing there. */
const line = (v: unknown, max = MAX.line): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s ? clip(s, max) : undefined;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const index = (v: unknown, length: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < length ? (v as number) : undefined);
const fields = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The model's `finish` call, cleaned up. Strict tool use guarantees the shape; this enforces what
 * a schema can't — lengths, counts, indexes in range — and drops empty optional fields (the
 * schema makes most of them required-but-may-be-empty, to stay inside strict mode's budget).
 */
export function normalizeAnswer(input: unknown): Answer {
  const i = (input ?? {}) as Record<string, unknown>;
  const block = normalizeBlock(i.block);
  const headline =
    line(i.headline, MAX.headline) ??
    (block?.kind === 'doc' ? block.title : undefined) ??
    'Done.';
  return fields({
    tone: TONES.includes(i.tone as AnswerTone) ? (i.tone as AnswerTone) : 'answer',
    headline,
    basis: line(i.basis, MAX.basis),
    block,
    note: line(i.note, MAX.note),
    followups: nonEmpty(
      list(i.followups)
        .map((f) => line(f, MAX.followup))
        .filter((f): f is string => !!f)
        .slice(0, MAX.followups),
    ),
  });
}

const nonEmpty = <T>(xs: T[]) => (xs.length ? xs : undefined);

function normalizeBlock(input: unknown): Block | undefined {
  const b = (input ?? {}) as Record<string, unknown>;
  switch (b.kind) {
    case 'text': {
      const body = typeof b.body === 'string' ? b.body.trim() : '';
      return body ? { kind: 'text', body } : undefined;
    }
    case 'list': {
      const all = list(b.items).flatMap((x): ListItem[] => {
        const o = (x ?? {}) as Record<string, unknown>;
        const title = line(o.title);
        if (!title) return [];
        const tone = TAG_TONES.includes(o.tone as TagTone) && o.tone !== 'neutral' ? (o.tone as TagTone) : undefined;
        return [fields({ title, sub: line(o.sub), detail: line(o.detail), tag: line(o.tag, 16), tone })];
      });
      if (!all.length) return undefined;
      const cut = all.length - MAX.items;
      const more = line(b.more) ?? (cut > 0 ? `+${cut}` : undefined);
      return fields({ kind: 'list' as const, items: all.slice(0, MAX.items), more });
    }
    case 'facts': {
      const rows = list(b.rows)
        .flatMap((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          const label = line(o.label, 24);
          const value = line(o.value);
          return label && value ? [{ label, value }] : [];
        })
        .slice(0, MAX.rows);
      return rows.length ? { kind: 'facts', rows } : undefined;
    }
    case 'compare': {
      const columns = list(b.columns)
        .map((c) => line(c, 24))
        .filter((c): c is string => !!c)
        .slice(0, MAX.columns);
      if (columns.length < 2) return undefined;
      const rows = list(b.rows)
        .flatMap((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          const label = line(o.label, 16);
          if (!label) return [];
          // exactly one value per column, so the grid always lines up
          const values = columns.map((_, n) => line(list(o.values)[n], 32) ?? '—');
          return [{ label, values }];
        })
        .slice(0, MAX.rows);
      if (!rows.length) return undefined;
      return fields({ kind: 'compare' as const, columns, rows, pick: index(b.pick, columns.length) });
    }
    case 'choice': {
      const options = list(b.options)
        .flatMap((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          const label = line(o.label, 60);
          return label ? [fields({ label, note: line(o.note, 60) })] : [];
        })
        .slice(0, MAX.options);
      if (!options.length) return undefined;
      return fields({ kind: 'choice' as const, options, recommended: index(b.recommended, options.length) });
    }
    case 'doc': {
      const markdown = typeof b.markdown === 'string' ? b.markdown.trim() : '';
      if (!markdown) return undefined;
      return { kind: 'doc', title: line(b.title, 80) ?? firstLine(markdown), markdown };
    }
    default:
      return undefined;
  }
}

/**
 * The model answered in prose instead of calling `finish`. Keep every word: the first sentence
 * becomes the headline, a short remainder a paragraph, anything longer a document for the reader.
 */
export function answerFromText(text: string): Answer {
  const lines = text.trim().split('\n');
  const at = lines.findIndex((l) => plain(l));
  if (at < 0) return { tone: 'answer', headline: 'Done.' };
  const head = plain(lines[at]!);
  const sentence = firstSentence(head);
  const rest = [head.slice(sentence.length).trim(), ...lines.slice(at + 1)].join('\n').trim();
  const headline = clip(sentence, MAX.headline);
  if (!rest) return sentence === headline ? { tone: 'answer', headline } : { tone: 'answer', headline, block: { kind: 'text', body: sentence } };
  // A few plain sentences stay a paragraph; anything with structure, or long, goes to the reader.
  const prose = displayWidth(rest) <= LONG_TEXT && !/^\s*(#|[-*+] |\d+[.)] |>|\|)/m.test(rest);
  return { tone: 'answer', headline, block: prose ? { kind: 'text', body: plain(rest) } : { kind: 'doc', title: headline, markdown: rest } };
}

/** Up to the first full stop — 。！？ end a sentence anywhere, . ! ? only before a space. */
const firstSentence = (s: string) => (/^.+?(?:[。！？]|[.!?](?=\s|$))/u.exec(s)?.[0] ?? s).trim();

/** The first sentence of some markdown, as plain text. */
const firstLine = (markdown: string) => firstSentence(plain(markdown.split('\n').find((l) => plain(l)) ?? ''));

/** Markdown's markers gone: **bold**, # headings, list bullets, `code`, [links](url). */
function plain(s: string): string {
  return s
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

// --- Giving it to anything that can't draw it --------------------------------

/**
 * An answer as plain text: the task's `summary` (the web feed, older notch builds), Copy, and
 * what a follow-up shows the agent about its earlier answer.
 */
export function answerText(a: Answer): string {
  const parts = [a.headline];
  if (a.basis) parts.push(`(${a.basis})`);
  const b = a.block;
  if (b) parts.push(blockText(b));
  if (a.note) parts.push(a.note);
  return parts.join('\n\n');
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'text':
      return b.body;
    case 'list':
      return [
        ...b.items.map((i) => {
          const head = [i.title, i.sub].filter(Boolean).join(' · ');
          return `• ${head}${i.detail ? ` — ${i.detail}` : ''}${i.tag ? ` [${i.tag}]` : ''}`;
        }),
        ...(b.more ? [b.more] : []),
      ].join('\n');
    case 'facts':
      return b.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
    case 'compare':
      return b.rows
        .map((r) => `${r.label}: ${r.values.map((v, n) => `${b.columns[n]} ${v}`).join(' · ')}`)
        .concat(b.pick !== undefined ? [`→ ${b.columns[b.pick]}`] : [])
        .join('\n');
    case 'choice':
      return b.options
        .map((o, n) => `${n + 1}. ${o.label}${o.note ? ` — ${o.note}` : ''}${n === b.recommended ? ' ←' : ''}`)
        .join('\n');
    case 'doc':
      return b.markdown;
  }
}

// --- Carrying on from an answer ------------------------------------------------

/** What came before, when a request continues an earlier answer (a follow-up button, a tapped option). */
export interface FollowUp {
  /** the earlier task */
  taskId: string;
  /** what you asked then */
  utterance: string;
  /** what the agent answered, as plain text */
  answer: string;
}

export function followUpFrom(task: Pick<Task, 'id' | 'utterance' | 'result'>): FollowUp {
  const r = task.result;
  return { taskId: task.id, utterance: task.utterance, answer: r?.answer ? answerText(r.answer) : r?.summary ?? '' };
}
