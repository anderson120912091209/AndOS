// The only place Relay does something irreversible.
//
// A commit job exists because you pressed the button on a specific proposal;
// it runs that proposal's frozen arguments — no model in the loop — so what you
// approved is what happens. Discard jobs are the mirror image: you said no, so
// the draft is deleted and nothing goes out.

import { displayName, type Proposal, type TaskResult } from '@relay/shared';
import { emailFor, type JobAccess } from './connectors.js';
import type { EventDraft } from './mime.js';

function draftIdOf(p: Proposal): string {
  const id = p.commit.args.draftId;
  if (typeof id !== 'string' || !id) throw new Error('this proposal has no draft to send');
  return id;
}

function eventOf(p: Proposal): EventDraft {
  const a = p.commit.args;
  if (typeof a.title !== 'string' || typeof a.start !== 'string') throw new Error('this event is missing a title or start time');
  return a as unknown as EventDraft;
}

/**
 * Remember which mailbox holds the draft, so the send later goes to the same place —
 * even if another worker, with other connections, picks up the approved job.
 */
export function stampVia(p: Proposal, via: string): Proposal {
  return p.commit.action === 'email.send' ? { ...p, commit: { ...p.commit, args: { ...p.commit.args, via } } } : p;
}

export async function executeCommit(p: Proposal, access: JobAccess): Promise<TaskResult> {
  const { connectors } = access;
  switch (p.commit.action) {
    case 'email.send': {
      if (p.preview.kind === 'email' && p.preview.to.length === 0) {
        throw new Error('no recipient — say who it should go to and Relay will redo the draft');
      }
      const email = emailFor(p.commit.args.via, access);
      const receipt = await email.send(draftIdOf(p));
      const to = p.preview.kind === 'email' ? p.preview.to.map(displayName).join(', ') : 'recipient';
      // The local outbox only moves a file on this Mac — never tell the user that was "Sent".
      const local = email.name === 'outbox';
      return {
        summary: local
          ? `Not sent — the email to ${to} is saved in Relay’s local outbox. Sending from your Gmail isn’t connected yet.`
          : `Sent to ${to}.`,
        artifacts: [
          ...(p.preview.kind === 'email' ? [{ label: 'Subject', value: p.preview.subject }] : []),
          local ? { label: 'Saved in', value: 'Relay’s local outbox' } : { label: 'Sent via', value: email.name },
          ...(receipt.where ? [{ label: 'Where', value: receipt.where }] : []),
        ],
      };
    }
    case 'calendar.create': {
      const event = eventOf(p);
      const receipt = await connectors.calendar.createEvent(event);
      const local = connectors.calendar.name === 'outbox'; // an .ics file on this Mac, not your calendar
      return {
        summary: local
          ? `Not added — “${event.title}” is saved as a local file. Your real calendar isn’t connected yet.`
          : `Added “${event.title}” to your calendar.`,
        artifacts: [
          { label: 'When', value: event.start },
          local ? { label: 'Saved in', value: 'Relay’s local outbox' } : { label: 'Calendar', value: connectors.calendar.name },
          ...(receipt.where ? [{ label: 'Where', value: receipt.where }] : []),
        ],
      };
    }
  }
}

/** Clean up after a "no" (or a superseded draft). Events have no draft to delete. */
export async function discardDraft(p: Proposal, access: JobAccess): Promise<void> {
  if (p.commit.action === 'email.send') await emailFor(p.commit.args.via, access).discard(draftIdOf(p));
}
