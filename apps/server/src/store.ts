// Authoritative task state. Single-node, in-memory, with optional JSON persistence
// so a restart during the demo doesn't lose your queue. All mutation goes through
// here and emits an event; the WebSocket layer just forwards those events.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Proposal, Takeover, Task, TaskStep, TaskStatus, TaskResult, Verdict } from '@relay/shared';
import { applyStep, isTerminal, makeStep } from '@relay/shared';

export type TaskEvent = { type: 'created' | 'updated'; task: Task };

/** Why a decision was refused — each maps to an HTTP status in index.ts. */
export type DecideError = 'not_found' | 'not_waiting' | 'stale';

export class TaskStore {
  private tasks = new Map<string, Task>();
  readonly events = new EventEmitter();

  constructor(private persistPath?: string) {
    this.events.setMaxListeners(100);
    if (persistPath && existsSync(persistPath)) {
      try {
        const data = JSON.parse(readFileSync(persistPath, 'utf8')) as Task[];
        for (const t of data) this.tasks.set(t.id, t);
      } catch {
        /* start empty on a corrupt file rather than crash the demo */
      }
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    writeFileSync(this.persistPath, JSON.stringify(this.list(), null, 2));
  }

  /** Newest first — matches how the Command Center stacks cards. */
  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  add(task: Task): Task {
    this.tasks.set(task.id, task);
    this.persist();
    this.events.emit('event', { type: 'created', task } satisfies TaskEvent);
    return task;
  }

  private commit(task: Task): Task {
    this.tasks.set(task.id, task);
    this.persist();
    this.events.emit('event', { type: 'updated', task } satisfies TaskEvent);
    return task;
  }

  /**
   * Steps can always be appended (late log lines are harmless), but a task that
   * already finished keeps its final status — so a worker that didn't notice you
   * discarded the draft can't flip it back to running or done.
   */
  appendStep(
    id: string,
    step: TaskStep,
    patch?: Partial<Pick<Task, 'status' | 'result' | 'error'>>,
  ): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const settled = isTerminal(task.status);
    return this.commit(applyStep(task, step, settled ? undefined : patch));
  }

  setStatus(id: string, status: TaskStatus, note?: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (isTerminal(task.status)) return task;
    const step = makeStep('note', note ?? `Status → ${status}`);
    return this.commit(applyStep(task, step, { status }));
  }

  complete(id: string, result: TaskResult): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (isTerminal(task.status)) return task;
    // Finishing an approved task *is* the commit: stamp it so it can never run twice.
    const p = task.proposal;
    const proposal = p?.decision?.verdict === 'approve' && !p.committedAt ? { ...p, committedAt: Date.now() } : undefined;
    const step = makeStep('result', result.summary, { artifacts: result.artifacts });
    return this.commit(applyStep(task, step, { status: 'done', result, proposal }));
  }

  fail(id: string, error: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (isTerminal(task.status)) return task;
    const step = makeStep('note', `Failed: ${error}`);
    return this.commit(applyStep(task, step, { status: 'failed', error }));
  }

  /** The agent needs you to sign in on the box: park the task until you've handed it back. */
  awaitTakeover(id: string, takeover: Takeover): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (isTerminal(task.status)) return task;
    const step = makeStep('note', `Needs you — ${takeover.reason}`, { takeover });
    return this.commit(applyStep(task, step, { status: 'needs_input', takeover }));
  }

  /** You finished the sign-in: put the task back in the queue so the agent carries on. */
  resumeFromTakeover(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'needs_input') return task;
    const step = makeStep('note', 'You signed in — carrying on.');
    return this.commit(applyStep(task, step, { status: 'queued' }));
  }

  /** The worker has a draft ready: park the task until you decide. */
  propose(id: string, proposal: Proposal): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (isTerminal(task.status)) return task;
    const step = makeStep('note', `Ready for your OK — ${proposal.summary}`, { proposalId: proposal.id });
    return this.commit(applyStep(task, step, { status: 'awaiting_approval', proposal }));
  }

  /**
   * Your answer to a proposal. `proposalId` must match the one on screen, so a
   * card that went stale (the agent revised the draft meanwhile) can't approve
   * something you haven't read.
   *  approve → back in the queue, at the front, as a commit job
   *  revise  → back in the queue as a redo with your feedback
   *  reject  → back in the queue so a worker deletes the draft; then canceled
   */
  decide(
    id: string,
    proposalId: string,
    verdict: Verdict,
    feedback?: string,
  ): { task: Task } | { error: DecideError } {
    const task = this.tasks.get(id);
    if (!task) return { error: 'not_found' };
    if (task.status !== 'awaiting_approval' || !task.proposal) return { error: 'not_waiting' };
    if (task.proposal.id !== proposalId) return { error: 'stale' };

    const proposal: Proposal = { ...task.proposal, decision: { verdict, at: Date.now(), feedback } };
    const next =
      verdict === 'approve'
        ? applyStep(task, makeStep('note', `Approved by you — "${proposal.verb}" is next.`), {
            status: 'queued',
            priority: 10,
            proposal,
          })
        : verdict === 'revise'
          ? applyStep(task, makeStep('note', `Revise: ${feedback ?? ''}`.trim()), {
              status: 'queued',
              priority: 8,
              proposal,
            })
          : applyStep(task, makeStep('note', 'Discarding the draft — nothing will be sent.'), {
              status: 'queued',
              priority: 9,
              proposal,
            });
    return { task: this.commit(next) };
  }

  /**
   * Hand the next eligible task to a worker. Highest priority wins; ties break
   * oldest-first (FIFO within a priority band). Atomically flips it to `claimed`
   * so two workers can't grab the same task.
   */
  claimNext(): Task | undefined {
    const candidate = this.list()
      .filter((t) => t.status === 'queued')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
    if (!candidate) return undefined;
    return this.setStatus(candidate.id, 'claimed', 'Claimed by worker.');
  }
}
