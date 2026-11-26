// Activities: every step of a task that touches the outside world (Claude, LINE, disk). Temporal records each
// one's result and retries failures, so each activity is written to be safe to run twice.
import Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure } from '@temporalio/activity';
import { googleReady } from './config.js';
import { addEvent, googleAccount, listEvents } from './connect/google.js';
import { runMemory } from './agent/memory.js';
import { respond } from './agent/model.js';
import { INPUTS, isAnthropicTool, isKnownTool } from './agent/tools.js';
import { onBox, runOnBox } from './box/hands.js';
import { agentctl } from './box/manager.js';
import { push, reply, retryKey } from './line/api.js';
import { render } from './line/render.js';
import {
  appendLog,
  type LogEntry,
  loadResults,
  markSent,
  memoryDir,
  readLog,
  readUser,
  saveResult,
  sentRecord,
  updateUser,
} from './store.js';
import { closeGrant, grantId, issueTicket, takeoverLink } from './takeover.js';
import type { CalendarEvent, Outgoing, ReplyToken, Step, TaskInput, ToolCall, ToolResult } from './types.js';

/** A reply token is good for about a minute; leave a margin for the request itself. */
const REPLY_WINDOW_MS = 50_000;

/** Turn 0: write the user's request into the task log, with the time and a little recent context. */
export async function begin(input: TaskInput): Promise<void> {
  if (readLog(input.taskId).length > 0) return; // retried after it already ran
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'full', timeStyle: 'short' });
  const recent = readUser(input.userId).recent.slice(-3);
  const google = googleAccount(input.userId);
  const context = [
    `（現在時間：${now}，台灣）`,
    google ? `（已連結 Google 帳號：${google.email ?? '已連結'}）` : googleReady() ? '（尚未連結 Google 帳號）' : '',
    recent.length > 0
      ? `（最近聊過：\n${recent.map((r) => `・對方：${r.question}\n・Piko：${r.answer}`).join('\n')}）`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  appendLog(input.taskId, { turn: 0, role: 'user', content: [{ type: 'text', text: `${context}\n\n${input.text}` }] });
  updateUser(input.userId, (user) => {
    user.activeTask = input.taskId;
  });
}

function toMessages(log: LogEntry[]): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const entry of log) {
    const previous = messages.at(-1);
    // A turn resumed after pause_turn continues the same assistant message.
    if (previous && previous.role === entry.role && Array.isArray(previous.content)) previous.content.push(...entry.content);
    else messages.push({ role: entry.role, content: [...entry.content] } as Anthropic.Beta.BetaMessageParam);
  }
  return messages;
}

/** Reads a saved assistant turn back as a small decision for the workflow, checking every tool input. */
function decide(taskId: string, entry: LogEntry): Step {
  if (entry.stop === 'pause_turn') return { kind: 'paused' };
  if (entry.stop === 'refusal') return { kind: 'refused', text: '抱歉，這件事我沒辦法幫忙。' };
  const uses = entry.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use');
  if (uses.length === 0) {
    // Cited answers arrive as several text blocks split at each citation; joined back as written.
    const text = entry.content
      .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { kind: 'final', text: text || '好的，完成了。' };
  }
  const calls: ToolCall[] = [];
  for (const use of uses) {
    const toolset = use.toolset_name ?? undefined;
    if (isAnthropicTool(use.name, toolset)) {
      if (entry.stop === 'max_tokens') saveResult(taskId, use.id, { content: 'Cut off; call it again.', isError: true, toolset });
      else calls.push({ id: use.id, name: use.name, input: use.input, toolset });
      continue;
    }
    const problem =
      entry.stop === 'max_tokens'
        ? 'The response was cut off before this tool input was complete; call the tool again.'
        : !isKnownTool(use.name)
          ? `There is no tool named ${use.name}.`
          : INPUTS[use.name].safeParse(use.input).success
            ? undefined
            : JSON.stringify({ INVALID_JSON: JSON.stringify(use.input) });
    if (problem) saveResult(taskId, use.id, { content: problem, isError: true });
    else calls.push({ id: use.id, name: use.name, input: INPUTS[use.name as keyof typeof INPUTS].parse(use.input) });
  }
  return { kind: 'tools', calls };
}

/**
 * One model turn. Sends the previous turn's tool results (plus anything the user said meanwhile), calls Claude,
 * saves the whole response to the log and returns only the decision. Never calls Claude twice for one turn.
 */
export async function think(args: { taskId: string; turn: number; userTexts: string[] }): Promise<Step> {
  const log = readLog(args.taskId);
  const saved = log.find((e) => e.turn === args.turn && e.role === 'assistant');
  if (saved) return decide(args.taskId, saved);

  const previous = log.filter((e) => e.role === 'assistant').at(-1);
  const hasUserEntry = log.some((e) => e.turn === args.turn && e.role === 'user');
  if (args.turn > 0 && !hasUserEntry && previous && previous.stop !== 'pause_turn') {
    const results = loadResults(args.taskId);
    const content: Anthropic.Beta.BetaContentBlockParam[] = previous.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use')
      .map((use): Anthropic.Beta.BetaToolResultBlockParam => {
        const result = results[use.id] ?? { content: 'No result was recorded for this call.', isError: true };
        const toolset = use.toolset_name ?? result.toolset;
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: result.content,
          is_error: result.isError ?? false,
          ...(toolset ? { toolset_name: toolset } : {}),
        };
      });
    for (const text of args.userTexts) content.push({ type: 'text', text });
    appendLog(args.taskId, { turn: args.turn, role: 'user', content });
  }

  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await respond(toMessages(readLog(args.taskId)));
  } catch (err) {
    // Requests Claude will never accept are not worth retrying; rate limits and 5xx are (Temporal backs off).
    if (err instanceof Anthropic.APIError && [400, 401, 403, 404, 413, 422].includes(err.status ?? 0)) {
      throw ApplicationFailure.nonRetryable(`Claude rejected the request (${err.status}): ${err.message}`);
    }
    throw err;
  }
  const entry: LogEntry = {
    turn: args.turn,
    role: 'assistant',
    content: message.content as Anthropic.Beta.BetaContentBlockParam[],
    stop: message.stop_reason,
  };
  appendLog(args.taskId, entry);
  return decide(args.taskId, entry);
}

/** Tools that run in the harness itself (not on Anthropic's servers and not in the workflow). */
/**
 * Runs a tool on the user's computer (src/box/). Its result can hold screenshots, so it is saved straight to
 * the task log's side file instead of travelling through Temporal; the workflow only learns whether it failed
 * and whether there is something to show the user.
 */
export async function runBoxTool(args: { taskId: string; userId: string; call: ToolCall }): Promise<{ isError: boolean; out?: Outgoing }> {
  const { result, out } = await runOnBox(args.userId, args.taskId, args.call);
  saveResult(args.taskId, args.call.id, result);
  return { isError: result.isError ?? false, out };
}

export async function runTool(args: { userId: string; call: ToolCall }): Promise<ToolResult> {
  switch (args.call.name) {
    case 'memory':
      return runMemory(memoryDir(args.userId), INPUTS.memory.parse(args.call.input));
    case 'google_calendar_add':
      return addEvent(args.userId, INPUTS.google_calendar_add.parse(args.call.input) as CalendarEvent);
    case 'google_calendar_list': {
      const { from, to } = INPUTS.google_calendar_list.parse(args.call.input);
      return listEvents(args.userId, from, to);
    }
    default:
      return { content: `There is no harness tool named ${args.call.name}.`, isError: true };
  }
}

/** Whether this Piko can connect Google at all, and whether this user already has. */
export async function googleStatus(args: { userId: string }): Promise<{ ready: boolean; email?: string; connected: boolean }> {
  const account = googleAccount(args.userId);
  return { ready: googleReady(), connected: Boolean(account), email: account?.email };
}

export async function recordResult(args: { taskId: string; toolUseId: string; result: ToolResult }): Promise<void> {
  saveResult(args.taskId, args.toolUseId, args.result);
}

/**
 * Sends one message to the user: free through the reply token while it is fresh, otherwise as a push.
 * `seq` numbers a task's deliveries, so a retry never sends the same thing twice.
 */
export async function deliver(args: {
  taskId: string;
  userId: string;
  seq: number;
  reply?: ReplyToken;
  out: Outgoing[];
}): Promise<{ usedReply: boolean }> {
  const done = sentRecord(args.taskId, args.seq);
  if (done) return done;
  // A takeover's ticket is minted here, at the last moment, so the secret never enters Temporal's history.
  const out = args.out.map((o): Outgoing => {
    if (o.kind !== 'takeover') return o;
    const ticket = issueTicket({ requestId: o.requestId, taskId: o.taskId, userId: o.userId, reason: o.reason });
    return { ...o, link: takeoverLink(ticket) };
  });
  // LINE takes at most five messages per call: the first five ride the reply token, any rest are pushed.
  const messages = out.flatMap(render);
  const batches = Array.from({ length: Math.ceil(messages.length / 5) }, (_, i) => messages.slice(i * 5, i * 5 + 5));
  let usedReply = false;
  for (const [i, batch] of batches.entries()) {
    if (i === 0 && args.reply && Date.now() - args.reply.receivedAt < REPLY_WINDOW_MS) usedReply = await reply(args.reply.token, batch);
    if (i > 0 || !usedReply) await push(args.userId, batch, retryKey(args.taskId, args.seq * 100 + i));
  }
  markSent(args.taskId, args.seq, usedReply);
  return { usedReply };
}

/** Closes the task: frees the user's conversation and keeps a short note of it for next time. */
export async function finish(args: { taskId: string; userId: string; question: string; answer: string }): Promise<void> {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  updateUser(args.userId, (user) => {
    if (user.activeTask === args.taskId) delete user.activeTask;
    if (user.recent.at(-1)?.answer === clip(args.answer, 400)) return; // retried after it already ran
    user.recent = [...user.recent, { question: clip(args.question, 200), answer: clip(args.answer, 400) }].slice(-5);
  });
}

/**
 * Ends a takeover, however the wait for it ended: its ticket and session stop working, then the agent gets its
 * box back (agentctl release also closes the typing screen and clears the clipboard the person used).
 */
export async function endTakeover(args: { taskId: string; userId: string; requestId: string; why: string }): Promise<void> {
  closeGrant(grantId(args.taskId, args.requestId), args.why);
  await agentctl(args.userId, 'release');
}
