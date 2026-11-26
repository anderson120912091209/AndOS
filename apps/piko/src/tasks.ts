// Starting tasks, finding the one a message belongs to, and retiring tasks that can't go on. Shared by the
// gateway (every message) and the worker (at startup, see src/worker.ts).
//
// A task can't go on when its steps keep failing: most often its workflow code changed while it waited
// (Temporal replays a task's history against the current code), or a bug in that code. Such a task would
// swallow every message sent to it, so it is retired instead: terminated, a note of where it stopped is left
// for the user's next task, and whatever the user said that it never read is handed back.
import { type Client, defaultPayloadConverter, WorkflowExecutionAlreadyStartedError, type WorkflowHandle, WorkflowNotFoundError } from '@temporalio/client';
import { setTimeout as delay } from 'node:timers/promises';
import { agentctl } from './box/manager.js';
import { config } from './config.js';
import { grantsFor, loadResults, readLog, updateUser } from './store.js';
import { closeGrant } from './takeover.js';
import type { ReminderInput, ReplyToken, TaskInput, UserMessage } from './types.js';
import { pikoReminder, pikoTask, view } from './workflows.js';

/** A task that has waited this long for an answer is closed when the user writes; the message starts fresh. */
export const STALE_WAIT_MS = Number(process.env.PIKO_STALE_WAIT_MS ?? 30 * 60_000);

/** Tools that leave a task waiting for the user. */
const WAITS = new Set(['ask_user', 'request_approval', 'connect_google', 'request_takeover']);

type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;
type HistoryEvent = NonNullable<History['events']>[number];

export async function startTask(client: Client, args: { userId: string; text: string; reply?: ReplyToken; taskId?: string }): Promise<string> {
  const taskId = args.taskId ?? `piko-${args.userId}-${Date.now()}`;
  updateUser(args.userId, (user) => {
    user.activeTask = taskId;
  });
  try {
    await client.workflow.start(pikoTask, {
      taskQueue: config.taskQueue,
      workflowId: taskId,
      args: [{ taskId, userId: args.userId, text: args.text, reply: args.reply } satisfies TaskInput],
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err; // another worker got there first
  }
  console.log(`task started: ${taskId}`);
  return taskId;
}

function decode<T>(payloads: { payloads?: unknown[] | null } | null | undefined): T | undefined {
  const first = payloads?.payloads?.[0];
  return first ? defaultPayloadConverter.fromPayload<T>(first as Parameters<typeof defaultPayloadConverter.fromPayload>[0]) : undefined;
}

/**
 * Whether the task's steps are failing (not just slow or waiting for a worker). Cheap in the common case:
 * the history is only read once Temporal reports a step that has been tried more than once.
 */
export async function isStuck(client: Client, workflowId: string, attempt: number): Promise<boolean> {
  if (attempt < 2) return false;
  const { history } = await client.workflowService.getWorkflowExecutionHistoryReverse({
    namespace: client.options.namespace,
    execution: { workflowId },
    maximumPageSize: 50,
  });
  // Newest first: the latest step outcome decides. A timeout is a worker that went away, not a broken task.
  for (const event of history?.events ?? []) {
    if (event.workflowTaskCompletedEventAttributes || event.workflowTaskTimedOutEventAttributes) return false;
    if (event.workflowTaskFailedEventAttributes) return true;
  }
  return false;
}

/** Where a task stood, read from its log: waiting on the user (and for what), still working, or done. */
function standing(taskId: string): { kind: 'waiting'; question: string } | { kind: 'working' } | { kind: 'done'; text: string } {
  const last = readLog(taskId).filter((e) => e.role === 'assistant').at(-1);
  if (!last) return { kind: 'working' };
  const results = loadResults(taskId);
  const uses = last.content.flatMap((b) => (b.type === 'tool_use' ? [b] : []));
  if (uses.length === 0) {
    const text = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { kind: 'done', text };
  }
  const open = uses.find((u) => WAITS.has(u.name) && !results[u.id]);
  if (!open) return { kind: 'working' };
  const asked = open.input as { question?: string; title?: string; reason?: string };
  return { kind: 'waiting', question: asked.question ?? asked.title ?? asked.reason ?? '' };
}

export interface Retired {
  /** What the user should get an answer to now: their unread messages, plus the request itself if it was cut off mid-work. */
  redo: string[];
  userId?: string;
}

/**
 * Terminates a task that can't go on and hands back what it owed the user. Safe to call twice and from two
 * processes: a second call finds the task closed and hands back nothing.
 */
export async function retire(client: Client, workflowId: string, why: string): Promise<Retired> {
  const handle = client.workflow.getHandle(workflowId);
  try {
    await handle.terminate(why);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return { redo: [] }; // gone or already closed: someone else retired it
    throw err;
  }
  // Read the history after terminating, so no message can slip in between reading and closing.
  const events: HistoryEvent[] = (await handle.fetchHistory()).events ?? [];
  const started = events[0]?.workflowExecutionStartedEventAttributes;
  const lastStep = events.findLastIndex((e) => e.workflowTaskCompletedEventAttributes);
  const unread = events
    .slice(lastStep + 1)
    .flatMap((e) => (e.workflowExecutionSignaledEventAttributes?.signalName === 'userMessage' ? [e.workflowExecutionSignaledEventAttributes] : []))
    .flatMap((s) => decode<UserMessage>(s.input)?.text ?? []);

  if (started?.workflowType?.name === 'pikoReminder') {
    const reminder = decode<ReminderInput>(started.input);
    const delivered = events.some((e) => e.activityTaskCompletedEventAttributes);
    if (reminder && !delivered) {
      await client.workflow
        .start(pikoReminder, { taskQueue: config.taskQueue, workflowId: `${workflowId}-r`, args: [reminder] })
        .catch((err: unknown) => {
          if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
        });
    }
    return { redo: [] };
  }

  const input = decode<TaskInput>(started?.input);
  if (!input) return { redo: unread };
  // A takeover it left open would keep the agent off the box: close it and hand the box back.
  for (const grant of grantsFor(input.taskId).filter((g) => !g.closedAt)) {
    closeGrant(grant.id, 'task retired');
    await agentctl(input.userId, 'release').catch((err: unknown) => console.error('release after retire failed:', err));
  }
  const where = standing(input.taskId);
  const note =
    where.kind === 'waiting'
      ? `（我問了：「${where.question}」，對方還沒回答）`
      : where.kind === 'done'
        ? where.text
        : '（處理到一半被中斷了，已重新開始）';
  updateUser(input.userId, (user) => {
    if (user.activeTask === input.taskId) delete user.activeTask;
    user.recent = [...user.recent, { question: input.text.slice(0, 200), answer: note.slice(0, 400) }].slice(-5);
  });
  return { redo: where.kind === 'working' ? [input.text, ...unread] : unread, userId: input.userId };
}

export type Route = { kind: 'live'; handle: WorkflowHandle<typeof pikoTask> } | { kind: 'closed'; carry: string[] };

/**
 * Decides whether a new message belongs to the user's open task. It does unless the task is gone, broken
 * (retired here; its unread messages are carried into the new task), or has waited for an answer so long
 * that the message is probably about something else: then it is closed and leaves a note of its question,
 * so the next task can still treat the message as the answer if it is one.
 */
export async function route(client: Client, taskId: string): Promise<Route> {
  const handle = client.workflow.getHandle<typeof pikoTask>(taskId);
  let description: Awaited<ReturnType<typeof handle.describe>>;
  try {
    description = await handle.describe();
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return { kind: 'closed', carry: [] };
    throw err;
  }
  if (description.status.name !== 'RUNNING') return { kind: 'closed', carry: [] };
  if (await isStuck(client, taskId, description.raw.pendingWorkflowTask?.attempt ?? 0)) {
    const retired = await retire(client, taskId, 'Its steps kept failing; the user wrote again.');
    return { kind: 'closed', carry: retired.redo };
  }
  // No worker answering within a few seconds isn't a reason to drop the task: the message waits for it.
  const now = await client.connection.withDeadline(Date.now() + 5000, () => handle.query(view)).catch(() => undefined);
  if (now?.state === 'NEEDS_INPUT' && now.waitingSince !== undefined && Date.now() - now.waitingSince > STALE_WAIT_MS) {
    await handle.cancel();
    // Give it a moment to write its note, which the next task reads.
    await Promise.race([handle.result().catch(() => undefined), delay(10_000)]);
    return { kind: 'closed', carry: [] };
  }
  return { kind: 'live', handle };
}
