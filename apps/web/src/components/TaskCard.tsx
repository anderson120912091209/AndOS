import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { Task, TaskResult } from '@relay/shared';
import { isTerminal } from '@relay/shared';
import { KIND_META, STATUS_META, relativeTime, elapsed } from '../lib/format.js';
import { StepTimeline } from './StepTimeline.js';
import { ProposalBlock } from './ProposalBlock.js';
import { cancelTask } from '../lib/api.js';

function StatusChip({ task }: { task: Task }) {
  const meta = STATUS_META[task.status];
  const live = task.status === 'running' || task.status === 'claimed';
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em]">
      <span className={`relative h-1.5 w-1.5 rounded-full ${meta.dot}`}>
        {live && <span className={`absolute inset-0 animate-ping rounded-full ${meta.dot} opacity-60`} />}
      </span>
      <span className={meta.color}>{meta.label}</span>
    </span>
  );
}

function ResultBlock({ result }: { result: TaskResult }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-4 rounded-xl border border-[rgba(139,232,168,0.22)] bg-[rgba(139,232,168,0.05)] p-4"
    >
      <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-good/80">Result</div>
      <p className="mt-1.5 text-[14px] leading-relaxed text-bone/90">{result.summary}</p>
      {result.artifacts && result.artifacts.length > 0 && (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {result.artifacts.map((a, i) => (
            <div key={i} className="contents">
              <dt className="font-mono text-[11px] uppercase tracking-wider text-faint">{a.label}</dt>
              <dd className="text-[13px] text-bone/80">{a.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </motion.div>
  );
}

/** A compact insert block for dictation output, with one-tap copy. */
function InsertBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-start gap-3 rounded-xl border-l-2 border-sand/50 bg-[rgba(231,201,139,0.05)] py-2.5 pl-3 pr-2">
      <p className="flex-1 text-[15px] leading-relaxed text-bone/90">{text}</p>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="shrink-0 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-faint transition-colors hover:bg-[rgba(236,232,225,0.06)] hover:text-bone"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

export function TaskCard({ task }: { task: Task }) {
  const kind = KIND_META[task.kind];
  const running = !isTerminal(task.status);
  const isAgent = task.kind === 'agent';
  const lastTs = task.steps[task.steps.length - 1]?.ts ?? task.updatedAt;

  // live ticking elapsed for running agent tasks
  const [, force] = useState(0);
  useEffect(() => {
    if (!running || !isAgent) return;
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [running, isAgent]);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 14, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative overflow-hidden rounded-2xl p-5 shadow-[0_1px_0_0_rgba(236,232,225,0.05)_inset,0_20px_50px_-30px_rgba(0,0,0,0.9)] hairline"
    >
      {task.status === 'running' && (
        <div className="working-shimmer absolute inset-x-0 top-0 h-px animate-shimmer" />
      )}

      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`${kind.color} text-[13px]`}>{kind.glyph}</span>
          <h3 className="truncate font-display text-[17px] font-semibold tracking-tight text-bone">
            {task.title}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusChip task={task} />
          <span className="tabular font-mono text-[10.5px] text-faint">{relativeTime(task.updatedAt)}</span>
        </div>
      </header>

      <p className="mt-1.5 flex items-start gap-1.5 text-[13px] text-dim">
        <span className="select-none text-faint">“</span>
        <span className="italic">{task.utterance}</span>
      </p>

      {task.kind === 'dictation' && task.result && <InsertBlock text={task.result.summary} />}

      {task.kind === 'command' && (
        <div className="mt-3 font-mono text-[12.5px] text-sky/90">
          {task.result?.summary ?? '…'}
        </div>
      )}

      {isAgent && (
        <>
          <StepTimeline steps={task.steps} startTs={task.createdAt} />
          {task.proposal && !task.result && <ProposalBlock task={task} proposal={task.proposal} />}
          {task.result && <ResultBlock result={task.result} />}
          {task.error && (
            <div className="mt-3 rounded-lg border border-bad/30 bg-[rgba(255,155,138,0.06)] px-3 py-2 font-mono text-[12px] text-bad/90">
              {task.error}
            </div>
          )}
          <footer className="mt-4 flex items-center justify-between border-t border-[rgba(236,232,225,0.07)] pt-3">
            <span className="tabular font-mono text-[10.5px] uppercase tracking-wider text-faint">
              {task.steps.length} steps · {elapsed(task.createdAt, running ? Date.now() : lastTs)}
            </span>
            {running && (
              <button
                onClick={() => void cancelTask(task.id)}
                className="rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-faint transition-colors hover:bg-[rgba(255,155,138,0.1)] hover:text-bad"
              >
                cancel
              </button>
            )}
          </footer>
        </>
      )}
    </motion.article>
  );
}
