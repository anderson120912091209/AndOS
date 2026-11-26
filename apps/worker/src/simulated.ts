// A believable agent that needs nothing external.
//
// It picks an archetype from the utterance (calendar / email / booking / research
// / code / generic) and narrates think → act → tool → observe steps the way a
// real agent would. Email and calendar requests do real, reversible work — a
// draft lands in the outbox — and then stop at a Proposal for your OK, exactly
// like the real driver (claude.ts). The other archetypes finish with a result.

import { answerResult, displayName, type Proposal, type Task } from '@relay/shared';
import { composeEmail, composeEvent, reviseEmail } from './compose.js';
import { type AgentDriver, type DriverContext, type Outcome, emailProposal, eventProposal, sleep } from './driver.js';

interface PlannedStep {
  type: 'think' | 'act' | 'observe' | 'tool';
  text: string;
  data?: Record<string, unknown>;
  /** pause after this step, in "work units" (scaled by ctx.speed) */
  cost?: number;
}

interface Archetype {
  match: (u: string) => boolean;
  steps: (task: Task) => PlannedStep[];
  finish: (task: Task, ctx: DriverContext) => Promise<Outcome>;
}

const lc = (s: string) => s.toLowerCase();
/** "Alex Chen <alex@acme.com>" → "Alex Chen"; a bare address → its name part. */
const senderName = (from: string) => from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || displayName(from.replace(/[<>]/g, ''));
const signature = () => process.env.RELAY_SIGNATURE;
const zoneOf = (task: Task) => task.context.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

// "schedule…" is always calendar; "meeting/lunch…" only when it isn't an email *about* one.
const CALENDAR = /\b(schedule|calendar|invite|appointment|set up a (?:meeting|call)|book a (?:meeting|call|room))\b|行事曆|日曆|日历|約(?:個|个)?時間|约(?:個|个)?时间|排(?:個|个)?(?:會議|会议)/;
const GATHERING = /\b(meeting|lunch|coffee|dinner|call|sync|catch[- ]up)\b|開會|开会|會議|会议|吃飯|吃饭|喝咖啡|見面|见面/;
const EMAIL = /\b(email|e-mail|mail|message|reply|respond|follow up|reach out|draft|letter|write to)\b|封信|寫信|写信|寄信|回信|信給|信给|郵件|邮件|回覆|回复/;
const isCalendar = (u: string) => CALENDAR.test(u) || (GATHERING.test(u) && !EMAIL.test(u));
// "Go through my email and tell me…" is a request to *read* the inbox, not to write.
const INBOX_READ = /\b(go through|check|read|scan|look (?:at|through)|summari[sz]e|triage)\b.{0,24}\b(my |the )?(e-?mails?|inbox|mail)\b|(?:看|讀|读|整理|檢查|检查).{0,6}(?:信箱|郵件|邮件|email)/;

async function draftEmail(email: ReturnType<typeof composeEmail>, ctx: DriverContext): Promise<Outcome> {
  const draft = await ctx.drafts.createEmail(email);
  await ctx.emit({ type: 'observe', text: 'Draft saved — nothing is sent until you approve it in the notch.', data: { draftId: draft.id } });
  return { type: 'proposal', proposal: emailProposal(email, draft.id) };
}

const ARCHETYPES: Archetype[] = [
  {
    // Reading mail: with Gmail connected, actually look; without it, say so — never fake a draft.
    match: (u) => INBOX_READ.test(u),
    steps: () => [{ type: 'think', text: 'This needs to read your inbox.', cost: 1 }],
    finish: async (_task, ctx) => {
      const mail = ctx.reads?.mail;
      if (!mail) {
        return {
          type: 'done',
          result: answerResult({ tone: 'answer', headline: "I can't read your inbox yet — connect Gmail in Relay, then ask again.", note: 'Nothing was drafted or sent.' }),
        };
      }
      const recent = await mail.search('in:inbox newer_than:2d', 8);
      await ctx.emit({ type: 'observe', text: `Read ${recent.length} recent messages.`, data: { tool: 'gmail.search' } });
      const unread = recent.filter((m) => m.unread).length;
      if (!recent.length) return { type: 'done', result: answerResult({ tone: 'answer', headline: 'Nothing new in your inbox in the last two days.' }) };
      return {
        type: 'done',
        result: answerResult({
          tone: 'answer',
          headline: `${recent.length} messages in the last two days${unread ? `, ${unread} unread` : ''}`,
          basis: 'Read your inbox',
          block: {
            kind: 'list',
            items: recent.slice(0, 5).map((m) => ({
              title: senderName(m.from),
              sub: m.subject || '(no subject)',
              ...(m.unread ? { tag: 'unread', tone: 'amber' as const } : {}),
            })),
            ...(recent.length > 5 ? { more: `+${recent.length - 5}` } : {}),
          },
          note: 'This simulated agent only lists them — turn on the Claude agent to have them read and turned into a to-do list.',
        }),
      };
    },
  },
  {
    match: isCalendar,
    steps: () => [
      { type: 'think', text: 'Pull out who, when and how long; resolve "tomorrow" in your time zone.', cost: 1 },
      { type: 'tool', text: 'Checking your calendar around that time.', data: { tool: 'calendar.freebusy' }, cost: 2 },
      { type: 'observe', text: 'That slot is free.', cost: 1 },
    ],
    finish: async (task) => ({ type: 'proposal', proposal: eventProposal(composeEvent(task.utterance, new Date(), zoneOf(task))) }),
  },
  {
    match: (u) => EMAIL.test(u),
    steps: (task) => [
      { type: 'think', text: 'Who is it for, what is the one ask — then match your usual tone.', cost: 1 },
      { type: 'tool', text: 'Reading context from the focused window.', data: { tool: 'screen.read', on: task.context.appName ?? 'frontmost app' }, cost: 1 },
      { type: 'act', text: 'Opening a draft in the mail sandbox.', data: { tool: 'email.draft' }, cost: 1 },
      { type: 'think', text: 'Keeping it short and warm, one clear ask.', cost: 1 },
    ],
    finish: (task, ctx) => draftEmail(composeEmail(task.utterance, { signature: signature() }), ctx),
  },
  {
    // travel / booking — prepares everything, stops before payment
    match: (u) => /\b(flight|book|hotel|reserve|ticket|trip|travel)\b/.test(u),
    steps: () => [
      { type: 'think', text: 'Breaking this into: search options → compare on price/time → prepare a booking, stop before payment.', cost: 1 },
      { type: 'act', text: 'Launching Chromium in the sandbox.', data: { tool: 'browser.launch' }, cost: 1 },
      { type: 'tool', text: 'Searching flights across aggregators.', data: { tool: 'browser.navigate', url: 'https://www.google.com/travel/flights' }, cost: 2 },
      { type: 'observe', text: 'Found 11 itineraries; 3 are non-stop.', data: { screenshotRef: 'sbx://shot/flights-1.png' }, cost: 1 },
      { type: 'think', text: 'Filtering to non-stop, carry-on included, arrive before 6pm.', cost: 1 },
      { type: 'act', text: 'Selected the 09:40 non-stop ($412, carry-on included).', cost: 1 },
      { type: 'observe', text: 'Reached the passenger-details step — holding here, no payment made.', cost: 1 },
    ],
    finish: async () => ({
      type: 'done',
      result: answerResult({
        tone: 'needs_you',
        headline: 'Stopped before payment — book the 09:40?',
        basis: '11 itineraries, 3 non-stop',
        block: {
          kind: 'choice',
          options: [
            { label: '09:40 non-stop · $412', note: 'carry-on included' },
            { label: '13:15 non-stop · $388', note: 'no carry-on' },
            { label: '07:05 non-stop · $451', note: 'refundable' },
          ],
          recommended: 0,
        },
      }),
    }),
  },
  {
    match: (u) => /\b(research|compare|summ(ar|ar)ise|summary|analy|find out|look up|gather|list of)\b/.test(u),
    steps: () => [
      { type: 'think', text: 'Plan: gather 5–8 sources, extract claims, de-duplicate, synthesize a short comparison.', cost: 1 },
      { type: 'act', text: 'Opening a research sandbox with a headless browser.', data: { tool: 'browser.launch' }, cost: 1 },
      { type: 'tool', text: 'Querying sources.', data: { tool: 'search', queries: 3 }, cost: 2 },
      { type: 'observe', text: 'Collected 7 sources; 2 were low-signal and dropped.', cost: 1 },
      { type: 'tool', text: 'Extracting structured facts from each page.', data: { tool: 'extract', pages: 5 }, cost: 2 },
      { type: 'think', text: 'Reconciling conflicting numbers; preferring primary/official sources.', cost: 1 },
      { type: 'act', text: 'Drafting a 5-row comparison with a recommendation.', cost: 1 },
    ],
    finish: async () => ({
      type: 'done',
      result: answerResult({
        tone: 'answer',
        headline: 'Option B — best balance of price and support',
        basis: '5 primary sources',
        block: {
          kind: 'compare',
          columns: ['Option A', 'Option B', 'Option C'],
          rows: [
            { label: 'Price', values: ['$', '$$', '$$$'] },
            { label: 'Support', values: ['Email', '24/7 SLA', '24/7 SLA'] },
            { label: 'Setup', values: ['1 day', '2 days', '1–2 weeks'] },
          ],
          pick: 1,
        },
        followups: ['Write it up as a report', 'Add a fourth option'],
      }),
    }),
  },
  {
    match: (u) => /\b(refactor|deploy|build|fix|bug|repo|codebase|test|pull request|pr)\b/.test(u),
    steps: () => [
      { type: 'think', text: 'Reproduce → locate → minimal fix → run tests → open a PR. No force-push.', cost: 1 },
      { type: 'act', text: 'Cloning the repo into an ephemeral sandbox.', data: { tool: 'git.clone' }, cost: 1 },
      { type: 'tool', text: 'Running the failing test to reproduce.', data: { tool: 'shell', cmd: 'pnpm test' }, cost: 2 },
      { type: 'observe', text: 'Reproduced: 1 failing test, null deref in the parser.', cost: 1 },
      { type: 'act', text: 'Applied a 4-line guard and a regression test.', cost: 1 },
      { type: 'tool', text: 'Re-running the suite.', data: { tool: 'shell', cmd: 'pnpm test' }, cost: 2 },
      { type: 'observe', text: 'All green (42 passed). Opened a draft PR.', cost: 1 },
    ],
    finish: async () => ({
      type: 'done',
      result: answerResult({
        tone: 'done',
        headline: 'Fixed the parser crash — draft PR is up',
        basis: 'Reproduced, fixed, re-ran the suite',
        block: {
          kind: 'facts',
          rows: [
            { label: 'PR', value: 'draft: "fix: guard null node in parser"' },
            { label: 'Tests', value: '42 passed (was 41/1 failing)' },
            { label: 'Diff', value: '+18 / -3 across 2 files' },
          ],
        },
        followups: ['Mark it ready for review'],
      }),
    }),
  },
];

const GENERIC: Archetype = {
  match: () => true,
  steps: (task) => [
    { type: 'think', text: `Interpreting the request and choosing tools: "${task.title}".`, cost: 1 },
    { type: 'act', text: 'Spun up an isolated sandbox for this task.', data: { tool: 'sandbox.create' }, cost: 1 },
    { type: 'tool', text: 'Executed the primary action.', cost: 2 },
    { type: 'observe', text: 'Verified the outcome against the goal.', cost: 1 },
  ],
  finish: async (task) => ({ type: 'done', result: answerResult({ tone: 'done', headline: `Completed: ${task.title}.` }) }),
};

export class SimulatedDriver implements AgentDriver {
  readonly name = 'simulated';

  async run(task: Task, ctx: DriverContext): Promise<Outcome> {
    const archetype = ARCHETYPES.find((a) => a.match(lc(task.utterance))) ?? GENERIC;

    await ctx.emit({ type: 'note', text: `Provisioning sandbox (isolated macOS/Linux VM) for "${task.title}".`, status: 'running' });
    await sleep(240 * ctx.speed, ctx.signal);

    for (const step of archetype.steps(task)) {
      if (ctx.signal.aborted) throw new Error('aborted');
      await ctx.emit({ type: step.type, text: step.text, data: step.data });
      await sleep((step.cost ?? 1) * 260 * ctx.speed, ctx.signal);
    }
    return archetype.finish(task, ctx);
  }

  async revise(task: Task, previous: Proposal, feedback: string, ctx: DriverContext): Promise<Outcome> {
    await ctx.emit({ type: 'think', text: `Revising with your note: "${feedback}".`, status: 'running' });
    await sleep(400 * ctx.speed, ctx.signal);
    const p = previous.preview;
    if (p.kind === 'email') {
      return draftEmail(reviseEmail({ to: p.to, cc: p.cc, subject: p.subject, body: p.body }, feedback), ctx);
    }
    if (p.kind === 'event') {
      // Your note goes first so its day/time/place win over the original request's.
      const event = composeEvent(`${feedback} ${task.utterance}`, new Date(), zoneOf(task));
      return { type: 'proposal', proposal: eventProposal(event) };
    }
    return this.run(task, ctx);
  }
}
