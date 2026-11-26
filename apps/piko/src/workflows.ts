// A Piko task: one job, from the user's request to its result, as a durable Temporal workflow.
// Temporal records every step, so a task survives crashes and restarts and can wait days for an answer.
//
// Rules for this file: it must be deterministic. No I/O and no Node APIs; Temporal replaces Date and timers
// with replay-safe versions. At runtime it imports only @temporalio/workflow. Everything that touches the
// world (Claude, LINE, disk) is an activity.
//
// Changing this file changes running tasks: Temporal replays a task's history against the current code, and
// a different order of timers, activities or children fails it. The worker checks every running task at
// startup and retires the ones that no longer replay (src/worker.ts), so nothing gets stuck, but a retired task
// loses its place. Reminders wait for months: change pikoReminder only behind patched().
import {
  ActivityFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type {
  CalendarEvent,
  Connected,
  Decision,
  Card,
  Outgoing,
  Place,
  PlanItem,
  ReminderInput,
  ReplyToken,
  Step,
  TaskInput,
  TaskState,
  TaskView,
  ToolCall,
  ToolResult,
  UserMessage,
} from './types.js';

const MAX_TURNS = 40;
/** Say "still working" through the reply token before it expires (it lasts about a minute). */
const ACK_AFTER_MS = 45_000;
const WAIT_FOR_USER = '3 days';
/** A takeover link lasts 10 minutes and its session 20 more (src/takeover.ts). */
const TAKEOVER_WAIT = '30 minutes';

const { begin, think, runTool, runBoxTool, recordResult, finish, googleStatus, endTakeover } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { initialInterval: '2 seconds', backoffCoefficient: 2, maximumInterval: '1 minute', maximumAttempts: 6 },
});
const { deliver } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 8 },
});

export const userMessage = defineSignal<[UserMessage]>('userMessage');
export const decision = defineSignal<[Decision]>('decision');
/** Sent by the gateway when the user finishes signing in to an account. */
export const connected = defineSignal<[Connected]>('connected');
/** Sent by the gateway when the user taps 完成 on the takeover screen. */
export const handedBack = defineSignal<[{ requestId: string }]>('handedBack');
export const view = defineQuery<TaskView>('view');

export async function pikoTask(input: TaskInput): Promise<TaskState> {
  let state: TaskState = 'WORKING';
  let plan: PlanItem[] = [];
  let waitingFor: string | undefined;
  let waitingSince: number | undefined;
  let reply: ReplyToken | undefined = input.reply; // the freshest unused reply token
  let deliveries = 0;
  const inbox: UserMessage[] = [];
  const decisions = new Map<string, Decision>();
  // Cards wait here and go out with Piko's next message, so one free reply carries everything.
  const pending: Outgoing[] = [];

  setHandler(userMessage, (message) => {
    inbox.push(message);
    if (message.reply) reply = message.reply;
  });
  setHandler(decision, (d) => {
    decisions.set(d.requestId, d);
    if (d.reply) reply = d.reply;
  });
  const connections = new Map<string, Connected>();
  setHandler(connected, (c) => {
    connections.set(c.service, c);
  });
  const returned = new Set<string>();
  setHandler(handedBack, ({ requestId }) => {
    returned.add(requestId);
  });
  setHandler(view, () => ({ state, plan, waitingFor, waitingSince }));

  async function send(...out: Outgoing[]): Promise<void> {
    const token = reply;
    reply = undefined; // claimed now, so the ack loop can't spend the same token concurrently
    const all = [...pending.splice(0), ...out];
    await deliver({ taskId: input.taskId, userId: input.userId, seq: deliveries++, reply: token, out: all });
  }

  /**
   * Runs beside the task. Whenever the user's latest reply token is about to expire unused while Piko is still
   * working, it spends the token on a short 「收到了…」, so nobody waits in silence. It never pays for a push.
   */
  async function ackLoop(): Promise<void> {
    while (state !== 'DONE') {
      const token = reply;
      if (!token) {
        await condition(() => reply !== undefined || state === 'DONE');
        continue;
      }
      const left = token.receivedAt + ACK_AFTER_MS - Date.now();
      if (left > 0) await condition(() => reply !== token || state === 'DONE', left);
      if (reply === token && state === 'WORKING') await send({ kind: 'still_working' });
      else if (reply === token) await condition(() => reply !== token || state === 'DONE');
    }
  }

  function takeInbox(): string[] {
    return inbox.splice(0).map((m) => m.text);
  }

  /** Waits for the user: until `done()` is true, they write something, or `timeout` passes. */
  async function waitForUser(what: string, done: () => boolean, timeout: string): Promise<boolean> {
    state = 'NEEDS_INPUT';
    waitingFor = what;
    waitingSince = Date.now();
    // A cancel throws here and leaves waitingFor set, for the note the task leaves behind.
    const answered = await condition(() => done() || inbox.length > 0, timeout);
    state = 'WORKING';
    waitingFor = undefined;
    waitingSince = undefined;
    return answered;
  }

  /** Tools that run on the user's computer (kept in sync with onBox in src/box/hands.ts). */
  function onBox(call: ToolCall): boolean {
    return call.toolset === 'computer' || ['bash', 'str_replace_based_edit_tool', 'share_file', 'show_screen'].includes(call.name);
  }

  async function handle(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'ask_user': {
        const { question, options } = call.input as { question: string; options: string[] };
        await send({ kind: 'question', question, options });
        const answered = await waitForUser(question, () => false, WAIT_FOR_USER);
        return answered ? { content: takeInbox().join('\n') } : { content: 'The user did not answer within 3 days.', isError: true };
      }
      case 'request_approval': {
        const { title, detail } = call.input as { title: string; detail: string };
        await send({ kind: 'approval', taskId: input.taskId, requestId: call.id, title, detail });
        await waitForUser(title, () => decisions.has(call.id), WAIT_FOR_USER);
        const d = decisions.get(call.id);
        if (d) return { content: d.approved ? 'The user approved. Go ahead.' : 'The user declined. Do not do it.' };
        if (inbox.length > 0) return { content: `The user wrote instead of tapping a button: ${takeInbox().join('\n')}` };
        return { content: 'No answer within 3 days. Treat it as declined.', isError: true };
      }
      case 'add_to_calendar':
        pending.push({ kind: 'calendar', event: call.input as CalendarEvent });
        return { content: 'The calendar card goes out with your reply. The user taps 「加到 Google 日曆」 once to save it.' };
      case 'show_places':
        pending.push({ kind: 'places', places: (call.input as { places: Place[] }).places });
        return { content: 'The place cards go out with your reply, each with 導航 and 打電話 buttons. Keep your text short.' };
      case 'show_card':
        pending.push({ kind: 'card', card: call.input as Card });
        return { content: 'The card goes out with your reply.' };
      case 'set_reminder': {
        const { text, at } = call.input as { text: string; at: string };
        const due = Date.parse(`${at}:00+08:00`);
        if (due <= Date.now()) return { content: `${at} Taiwan time has already passed. Pick a future time.`, isError: true };
        if (due - Date.now() > 366 * 24 * 3600 * 1000) return { content: 'Reminders can be at most a year ahead.', isError: true };
        // A child workflow that outlives this task: a durable timer, then one LINE message.
        await startChild(pikoReminder, {
          workflowId: `${workflowInfo().workflowId}-reminder-${call.id}`,
          args: [{ userId: input.userId, text, at }],
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
        return { content: `Reminder set for ${at} Taiwan time.` };
      }
      case 'connect_google': {
        const status = await googleStatus({ userId: input.userId });
        if (status.connected) return { content: `Google is already connected (${status.email ?? 'account'}).` };
        if (!status.ready) {
          return { content: 'Google sign-in is not set up on this Piko yet. Use add_to_calendar instead.', isError: true };
        }
        const reason = (call.input as { reason: string }).reason;
        await send({ kind: 'connect', service: 'google', userId: input.userId, taskId: input.taskId, reason });
        await waitForUser('連結 Google 帳號', () => connections.has('google'), '1 day');
        const done = connections.get('google');
        if (done) return { content: `Connected: Google account ${done.email ?? ''}. You can use google_calendar_add and google_calendar_list now.` };
        if (inbox.length > 0) return { content: `The user wrote instead of connecting: ${takeInbox().join('\n')}` };
        return { content: 'The user did not connect within a day.', isError: true };
      }
      case 'request_takeover': {
        const reason = (call.input as { reason: string }).reason;
        await send({ kind: 'takeover', taskId: input.taskId, userId: input.userId, requestId: call.id, reason });
        try {
          await waitForUser(reason, () => returned.has(call.id), TAKEOVER_WAIT);
        } finally {
          // Whatever ended the wait (done, a message, the time limit, the task being closed), the screen is
          // taken back before Piko does anything else.
          await CancellationScope.nonCancellable(() =>
            endTakeover({ taskId: input.taskId, userId: input.userId, requestId: call.id, why: 'task moved on' }),
          );
        }
        const after = 'The computer is yours again. Take a screenshot to see where things stand before going on.';
        if (returned.has(call.id)) return { content: `The user tapped 完成 and handed the computer back. ${after}` };
        if (inbox.length > 0) return { content: `The user wrote instead: ${takeInbox().join('\n')}\n${after}` };
        return { content: `The user did not finish within 30 minutes. ${after} Then ask whether they still want to go on.`, isError: true };
      }
      case 'send_update':
        await send({ kind: 'text', text: (call.input as { text: string }).text });
        return { content: 'Sent.' };
      case 'update_plan':
        plan = (call.input as { items: PlanItem[] }).items;
        return { content: 'Plan saved.' };
      default:
        return runTool({ userId: input.userId, call });
    }
  }

  let answer = '（沒有完成）';
  const acks = ackLoop().catch(() => undefined);
  try {
    await begin(input);
    let paused = false;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // After a pause the API resumes the saved turn as is, so new messages wait for the next real turn.
      const userTexts: string[] = paused ? [] : takeInbox();
      const step: Step = await think({ taskId: input.taskId, turn, userTexts });
      paused = step.kind === 'paused';
      if (step.kind === 'final' || step.kind === 'refused') {
        answer = step.text;
        await send({ kind: 'final', taskId: input.taskId, text: step.text });
        break;
      }
      if (step.kind === 'tools') {
        // Computer actions in one turn depend on each other: after one fails, the rest are not run.
        let computerFailed = false;
        for (const call of step.calls) {
          if (onBox(call)) {
            if (call.toolset === 'computer' && computerFailed) {
              const skipped = { content: 'Not executed: an earlier computer action in this turn failed.', isError: true, toolset: 'computer' };
              await recordResult({ taskId: input.taskId, toolUseId: call.id, result: skipped });
              continue;
            }
            const { isError, out } = await runBoxTool({ taskId: input.taskId, userId: input.userId, call });
            if (isError && call.toolset === 'computer') computerFailed = true;
            if (out) pending.push(out);
            continue;
          }
          await recordResult({ taskId: input.taskId, toolUseId: call.id, result: await handle(call) });
        }
      }
      if (turn === MAX_TURNS - 1) await send({ kind: 'text', text: '這件事比較複雜，我先停在這裡。可以再跟我說一次您最需要的是什麼嗎？' });
    }
  } catch (err) {
    if (isCancellation(err)) {
      // The gateway closed a wait that went stale because the user wrote about something new. Leave a note of
      // the open question for the task that starts next, and say nothing: that task does the talking.
      const open = waitingFor;
      state = 'DONE';
      await CancellationScope.nonCancellable(() =>
        finish({ taskId: input.taskId, userId: input.userId, question: input.text, answer: open ? `（我問了：「${open}」，對方還沒回答）` : answer }),
      );
      throw err;
    }
    if (!(err instanceof ActivityFailure)) throw err;
    await send({ kind: 'text', text: '抱歉，我這邊出了點問題，請稍後再試一次 🙏' });
  }
  state = 'DONE';
  await acks;
  await finish({ taskId: input.taskId, userId: input.userId, question: input.text, answer });
  return state;
}

/** Waits (durably, across any restart) until the time comes, then sends the reminder as a LINE push. */
export async function pikoReminder(reminder: ReminderInput): Promise<void> {
  const wait = Date.parse(`${reminder.at}:00+08:00`) - Date.now();
  if (wait > 0) await sleep(wait);
  await deliver({ taskId: workflowInfo().workflowId, userId: reminder.userId, seq: 0, out: [{ kind: 'reminder', text: reminder.text }] });
}
