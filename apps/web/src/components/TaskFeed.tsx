import { AnimatePresence } from 'framer-motion';
import type { Task } from '@relay/shared';
import { TaskCard } from './TaskCard.js';

export function TaskFeed({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="font-display text-[28px] font-semibold tracking-tight text-bone/70">
          Nothing in flight.
        </div>
        <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-dim">
          Press <kbd className="rounded bg-[rgba(236,232,225,0.08)] px-1.5 py-0.5 font-mono text-[11px] text-bone/80">Space</kbd>{' '}
          to start, Space again to stop — or just type below. Say what you see, and Relay decides whether to{' '}
          <span className="text-sand">write it down</span> or{' '}
          <span className="text-signal">dispatch an agent</span> to go do it.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 pb-48 pt-2">
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
