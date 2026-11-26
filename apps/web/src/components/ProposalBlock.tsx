import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Proposal, Task, Verdict } from '@relay/shared';
import { decide } from '../lib/api.js';

/** The draft the agent stopped at, with the buttons that decide what happens to it. */
export function ProposalBlock({ task, proposal }: { task: Task; proposal: Proposal }) {
  const waiting = task.status === 'awaiting_approval';
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const p = proposal.preview;

  const send = async (verdict: Verdict, feedback?: string) => {
    setBusy(true);
    try {
      await decide(task.id, proposal.id, verdict, feedback);
      setRevising(false);
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const decided = proposal.decision?.verdict;
  const pending = decided === 'approve' ? `${proposal.verb}…` : decided === 'revise' ? 'Revising…' : decided === 'reject' ? 'Discarding…' : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-4 overflow-hidden rounded-xl border border-[rgba(231,201,139,0.28)] bg-[rgba(231,201,139,0.05)]"
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-sand/90">
          {p.kind === 'email' ? 'Email draft' : p.kind === 'event' ? 'Calendar event' : 'Draft'} · waiting for your OK
        </span>
      </div>

      {p.kind === 'email' && (
        <div className="px-4 pb-3 pt-2 text-[13px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">To</dt>
            <dd className={p.to.length ? 'text-bone/90' : 'text-bad/90'}>{p.to.join(', ') || 'no recipient yet'}</dd>
            {p.cc?.length ? (
              <>
                <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">Cc</dt>
                <dd className="text-bone/80">{p.cc.join(', ')}</dd>
              </>
            ) : null}
            <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">Subject</dt>
            <dd className="font-medium text-bone">{p.subject}</dd>
          </dl>
          <p className="mt-3 whitespace-pre-wrap border-t border-[rgba(236,232,225,0.07)] pt-3 leading-relaxed text-bone/85">{p.body}</p>
        </div>
      )}

      {p.kind === 'event' && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 pb-3 pt-2 text-[13px]">
          <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">What</dt>
          <dd className="font-medium text-bone">{p.title}</dd>
          <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">When</dt>
          <dd className="text-bone/90">
            {new Date(p.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {p.end && ` – ${new Date(p.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
          </dd>
          {p.location && (
            <>
              <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">Where</dt>
              <dd className="text-bone/90">{p.location}</dd>
            </>
          )}
          {p.attendees?.length ? (
            <>
              <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">Invite</dt>
              <dd className="text-bone/80">{p.attendees.join(', ')}</dd>
            </>
          ) : null}
        </dl>
      )}

      {p.kind === 'note' && <p className="whitespace-pre-wrap px-4 pb-3 pt-2 text-[13px] text-bone/85">{p.body}</p>}

      <footer className="flex items-center justify-end gap-2 border-t border-[rgba(236,232,225,0.07)] px-3 py-2.5">
        {pending ? (
          <span className="font-mono text-[11px] uppercase tracking-wider text-sand/80">{pending}</span>
        ) : waiting && revising ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) void send('revise', note.trim());
            }}
          >
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What should change? e.g. make it shorter"
              className="flex-1 rounded-md bg-[rgba(236,232,225,0.06)] px-2.5 py-1.5 text-[13px] text-bone placeholder:text-faint focus:outline-none"
            />
            <button disabled={busy} className="rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-sand hover:bg-[rgba(231,201,139,0.1)]">
              revise
            </button>
          </form>
        ) : waiting ? (
          <>
            <button
              disabled={busy}
              onClick={() => void send('reject')}
              className="rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-faint hover:bg-[rgba(255,155,138,0.1)] hover:text-bad"
            >
              discard
            </button>
            <button
              disabled={busy}
              onClick={() => setRevising(true)}
              className="rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-dim hover:bg-[rgba(236,232,225,0.06)] hover:text-bone"
            >
              revise
            </button>
            <button
              disabled={busy || (p.kind === 'email' && p.to.length === 0)}
              onClick={() => void send('approve')}
              className="rounded-md bg-sand px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink hover:bg-sand/90 disabled:opacity-40"
            >
              {proposal.verb}
            </button>
          </>
        ) : null}
      </footer>
    </motion.div>
  );
}
