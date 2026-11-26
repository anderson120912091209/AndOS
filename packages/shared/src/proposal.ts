// The "ready for your OK" moment of an agent task.
//
// An agent does everything reversible on its own — researches, drafts the email,
// fills in the event — and stops right before the one step that can't be taken
// back. That stopping point is a Proposal: a preview you can read in the notch,
// plus the exact side effect that runs if you approve.
//
// The commit's arguments are frozen when the proposal is made, and approving
// names the proposal id. So what you approve is exactly what gets sent: the
// model can't change the email after you said yes, and a stale card can't
// approve a newer draft.

import type { Task } from './task.js';

/** What the notch shows. Typed per kind so it renders natively, not as a blob. */
export type Artifact =
  | { kind: 'email'; to: string[]; cc?: string[]; subject: string; body: string }
  | {
      kind: 'event';
      title: string;
      /** ISO 8601, local time with offset */
      start: string;
      end?: string;
      location?: string;
      attendees?: string[];
      notes?: string;
    }
  | { kind: 'note'; title: string; body: string };

/** Side effects a worker knows how to perform once you approve. */
export type CommitAction = 'email.send' | 'calendar.create';

export interface Commit {
  action: CommitAction;
  /** frozen at proposal time — e.g. { draftId } for email.send */
  args: Record<string, unknown>;
}

export type Verdict = 'approve' | 'reject' | 'revise';

export interface Decision {
  verdict: Verdict;
  at: number;
  /** what to change, for `revise` ("make it shorter") — or why, for `reject` */
  feedback?: string;
}

export interface Proposal {
  id: string;
  createdAt: number;
  /** the primary button: "Send", "Add to Calendar" */
  verb: string;
  /** one line for the collapsed notch: "Email to Alex · Running late" */
  summary: string;
  preview: Artifact;
  commit: Commit;
  decision?: Decision;
  /** set by the worker once the commit has actually run */
  committedAt?: number;
}

/** What a worker should do with a task it just claimed. */
export type Job =
  | { type: 'run' } // fresh request: do the work, maybe end in a proposal
  | { type: 'commit'; proposal: Proposal } // you approved: perform the side effect
  | { type: 'revise'; proposal: Proposal; feedback: string } // redo the draft with your note
  | { type: 'discard'; proposal: Proposal }; // you said no: clean up the draft, send nothing

/**
 * Approved and revised tasks go back into the same queue as new ones; the
 * decision on their proposal says which kind of job they are. Pure, so the
 * worker and the tests agree on it.
 */
export function jobFor(task: Pick<Task, 'proposal'>): Job {
  const p = task.proposal;
  const d = p?.decision;
  if (p && d?.verdict === 'approve' && !p.committedAt) return { type: 'commit', proposal: p };
  if (p && d?.verdict === 'revise') return { type: 'revise', proposal: p, feedback: d.feedback ?? '' };
  if (p && d?.verdict === 'reject') return { type: 'discard', proposal: p };
  return { type: 'run' };
}

/** "Email to Alex · Running late" — the line the collapsed notch shows. */
export function summarize(a: Artifact): string {
  switch (a.kind) {
    case 'email': {
      const who = a.to[0] ? displayName(a.to[0]) : 'someone';
      const more = a.to.length > 1 ? ` +${a.to.length - 1}` : '';
      return `Email to ${who}${more} · ${a.subject}`;
    }
    case 'event':
      return `${a.title} · ${a.start.slice(0, 16).replace('T', ' ')}`;
    case 'note':
      return a.title;
  }
}

/** "alex.chen@acme.com" → "Alex Chen"; anything else passes through. */
export function displayName(address: string): string {
  const m = /^([^@\s]+)@/.exec(address.trim());
  if (!m?.[1]) return address.trim();
  return m[1]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}
