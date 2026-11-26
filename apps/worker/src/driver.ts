// The agent seam.
//
// A driver does the *work* of one task inside the worker and streams what it's
// doing through `ctx.emit`. It never takes an irreversible step itself: when the
// work reaches one (sending an email, putting something on your calendar) it
// returns a Proposal, and the task waits in the notch for your OK. The side
// effect runs later as its own job (commit.ts), with the arguments you saw.
//
// That boundary is enforced by types, not discipline: a driver only gets
// `Drafts` — create and discard — never a connector that can send.
//
// SimulatedDriver (simulated.ts) needs nothing external; ClaudeDriver
// (claude.ts) is the real agent. The rest of Relay doesn't care which.

import { makeId, summarize, type Proposal, type Task, type TaskResult } from '@relay/shared';
import type { McpCredential, Receipt } from './connectors.js';
import type { MailReader } from './google.js';
import type { BrowserSession } from './browser.js';
import type { Workstation } from './workstation.js';
import type { EmailDraft, EventDraft } from './mime.js';

export interface EmitStep {
  type: 'think' | 'act' | 'observe' | 'tool' | 'note';
  text: string;
  data?: Record<string, unknown>;
  /** promote the task's status alongside this step */
  status?: 'running' | 'needs_input';
}

/** The reversible half of a connector — all a driver is allowed to touch. */
export interface Drafts {
  createEmail(email: EmailDraft): Promise<Receipt>;
  discardEmail(draftId: string): Promise<void>;
}

export interface DriverContext {
  emit: (step: EmitStep) => Promise<void>;
  signal: AbortSignal;
  /** scale factor for simulated delays; 0 = instant (tests) */
  speed: number;
  drafts: Drafts;
  /** Read access to accounts you connected — for this job only. Reading never needs your OK. */
  reads?: {
    mail?: MailReader;
    /** each limited to its read-only tools; these run on Anthropic's side, not in the worker */
    mcp: McpCredential[];
    /** who you're signed in as, by service — so the agent knows whose mailbox it's in */
    accounts: Record<string, string>;
  };
  /** The browser on the box, when the worker is pointed at one. Lets the agent work any site. */
  box?: BrowserSession;
  /** The box as the agent's own computer — a shell, files and the screen — when the box has boxd. */
  computer?: Workstation;
}

/**
 * The agent needs you to drive the browser yourself for a moment — a sign-in, a 2FA code,
 * anything private. The server turns this into a takeover session (a viewer + Done button);
 * the task waits as `needs_input` until you're done, then the agent carries on.
 */
export interface TakeoverRequest {
  reason: string;
  /** the account/site this is for (gmail, whatsapp, …) — picks the icon in the notch */
  service: string;
  /** where to send the box browser first, if known */
  url?: string;
  /** the page target the agent was on, so the box shows you exactly where it was */
  targetId?: string;
}

/** How a run ends: finished, stopped at something to approve, or waiting for you to take over. */
export type Outcome =
  | { type: 'done'; result: TaskResult }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'takeover'; takeover: TakeoverRequest };

export interface AgentDriver {
  readonly name: string;
  run(task: Task, ctx: DriverContext): Promise<Outcome>;
  /** Redo a proposal with your note ("make it shorter", "send it to Sam instead"). */
  revise(task: Task, previous: Proposal, feedback: string, ctx: DriverContext): Promise<Outcome>;
}

export function emailProposal(email: EmailDraft, draftId: string): Proposal {
  const preview = { kind: 'email' as const, ...email };
  return {
    id: makeId('prop'),
    createdAt: Date.now(),
    verb: 'Send',
    summary: summarize(preview),
    preview,
    commit: { action: 'email.send', args: { draftId } },
  };
}

export function eventProposal(event: EventDraft): Proposal {
  const preview = { kind: 'event' as const, ...event };
  return {
    id: makeId('prop'),
    createdAt: Date.now(),
    verb: 'Add to Calendar',
    summary: summarize(preview),
    preview,
    commit: { action: 'calendar.create', args: { ...event } },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}
