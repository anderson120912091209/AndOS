// The agent on your own Claude subscription: Claude Code's harness, Relay's hands.
//
// The model loop here isn't Relay's. It's Claude Code's own — the official runtime the Agent SDK
// ships — signed in with your claude.ai login (Pro/Max), the way Conductor runs it. That harness is
// what long jobs need: no small step cap, automatic compaction, a task list, helper agents with their
// own context, sessions you can resume. Relay brings everything around it:
//
//   hands     only Relay's tools (toolbox.ts), served to the engine in-process over MCP: the box's
//             shell, files and screen, its browser, your mail, drafts. Claude Code's own tools that
//             would act on this Mac (Bash, Read, Write, Edit…) are never offered; if the model
//             reaches for Bash by name anyway, the call lands in the box (toolAliases).
//   approvals every tool call passes canUseTool first, against the same table as the API agent
//             (shared policy.ts). Anything that needs you ends the run as the usual notch card.
//   billing   no API key reaches the engine, so it runs on your plan's limits, never on API credit.
//
// Select it with RELAY_DRIVER=claude-code. The Mac the worker runs on must be signed in to Claude
// Code (`claude auth login`; `claude auth status` shows the plan).

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type CanUseTool, type Options, type SDKMessage, type SDKRateLimitInfo, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { answerFromText, answerResult, type Proposal, type Task } from '@relay/shared';
import { COMPUTER, SYSTEM, oneLine, revisePrompt, runPrompt } from './claude.js';
import type { AgentDriver, DriverContext, Outcome } from './driver.js';
import { Toolbox } from './toolbox.js';

const MODEL = process.env.RELAY_ENGINE_MODEL ?? 'opus';
/** A ceiling for a runaway loop, not a step budget: the engine compacts and keeps going. */
const MAX_TURNS = 400;
/** The engine's working directory: an empty scratch folder, never anything of yours. */
const HOME = process.env.RELAY_ENGINE_HOME ?? path.join(os.homedir(), '.relay', 'engine');

const SERVER = 'relay';
const PREFIX = `mcp__${SERVER}__`;

/**
 * Claude Code's own tools that stay on: its task list, its helper agents (each helper's own tool
 * calls go through the gate one by one), and web search, which runs on Anthropic's side. None of
 * them touches this Mac.
 */
const ENGINE_TOOLS = ['Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'WebSearch'];

/** What the engine adds to Claude Code's own instructions. */
function instructions(ctx: DriverContext): string {
  return `${SYSTEM}${ctx.computer ? COMPUTER : ''}

You're running inside Relay as the user's assistant, not as a coding CLI. The working directory above is an empty scratch folder on the user's Mac: you have no tools for it, or for the Mac at all. You act only through Relay's tools, which appear to you as ${PREFIX}<name>${ctx.computer ? ' — your own computer (the box: its shell, files and screen), ' : ' — '}the browser and the accounts the user connected. Above they're called by their short names (finish, draft_email, send_email…). For a long job, keep a task list, and hand self-contained parts to helper agents: they have the same tools. Always end with ${PREFIX}finish, or one of the tools that hand the next step to the user.`;
}

/** A tool's name as Relay's policy knows it. */
function relayName(engineName: string): string {
  if (engineName.startsWith(PREFIX)) return engineName.slice(PREFIX.length);
  return engineName === 'WebSearch' ? 'web_search' : engineName;
}

/** The engine's environment: without an API key it runs on the claude.ai login, never on API credit. */
export function engineEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, CLAUDECODE: _nested, ...rest } = env;
  return { ...rest, CLAUDE_AGENT_SDK_CLIENT_APP: 'relay/0.1' };
}

function planLimit(limit: SDKRateLimitInfo): string {
  const window = limit.rateLimitType === 'five_hour' ? '5-hour' : 'weekly';
  const at = limit.resetsAt ? new Date(limit.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'soon';
  return `Your Claude plan's ${window} limit is used up — it resets ${at}. Nothing was sent.`;
}

function failure(result: SDKResultMessage): string {
  const said = result.subtype === 'success' ? result.result : result.errors.join('; ');
  if (/\/login|not logged in|invalid api key|authenticat/i.test(said)) {
    return "Claude Code isn't signed in on this Mac — run `claude auth login` once, then try again.";
  }
  if (result.subtype === 'error_max_turns') return `stopped after ${result.num_turns} steps without finishing`;
  return said ? `Claude Code stopped: ${oneLine(said, 300)}` : `Claude Code stopped (${result.subtype}).`;
}

export class ClaudeCodeDriver implements AgentDriver {
  readonly name = `claude code (${MODEL}, your subscription)`;

  /** `start` is the Agent SDK's query — injectable so tests run without the engine. */
  constructor(private start: typeof query = query) {}

  run(task: Task, ctx: DriverContext): Promise<Outcome> {
    return this.session(runPrompt(task, ctx), ctx);
  }

  revise(task: Task, previous: Proposal, feedback: string, ctx: DriverContext): Promise<Outcome> {
    return this.session(revisePrompt(task, previous, feedback, ctx), ctx);
  }

  private async session(prompt: string, ctx: DriverContext): Promise<Outcome> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    ctx.signal.addEventListener('abort', stop, { once: true });
    const box = new Toolbox(ctx, stop);

    // Before every tool the engine runs, its helpers' included: the same line as the API agent.
    const gate: CanUseTool = async (engineName, input) => {
      const verdict = box.gate(relayName(engineName), input);
      if ('refuse' in verdict) return { behavior: 'deny', message: verdict.refuse };
      if ('end' in verdict) return { behavior: 'deny', message: 'Handed to the user. Stop here.', interrupt: true };
      return { behavior: 'allow', updatedInput: input };
    };

    mkdirSync(HOME, { recursive: true });
    const options: Options = {
      model: MODEL,
      effort: 'high',
      cwd: HOME,
      tools: ENGINE_TOOLS,
      mcpServers: { [SERVER]: { type: 'sdk', name: SERVER, instance: box.server(SERVER) } },
      strictMcpConfig: true,
      toolAliases: { Bash: `${PREFIX}bash` },
      settingSources: [], // never your own Claude Code settings, hooks, plugins or CLAUDE.md
      permissionMode: 'default',
      canUseTool: gate,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions(ctx) },
      env: engineEnv(),
      maxTurns: MAX_TURNS,
      abortController: abort,
    };

    let result: SDKResultMessage | undefined;
    let limit: SDKRateLimitInfo | undefined;
    try {
      for await (const m of this.start({ prompt, options })) {
        if (m.type === 'result') result = m;
        else if (m.type === 'rate_limit_event') limit = m.rate_limit_info;
        else await narrate(m, ctx);
      }
    } catch (err) {
      // Ending the run from the gate (or a cancel) closes the stream with an error: that's expected.
      if (!box.outcome && !box.fatal && !abort.signal.aborted) throw err;
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }

    if (box.fatal) throw box.fatal;
    if (box.outcome) return box.outcome;
    if (ctx.signal.aborted) throw new Error('aborted');
    if (limit?.status === 'rejected') throw new Error(planLimit(limit));
    if (!result) throw new Error('Claude Code stopped without an answer.');
    if (result.subtype === 'success' && !result.is_error) {
      // It answered in prose instead of calling finish: keep every word, shaped as well as we can.
      return { type: 'done', result: answerResult(answerFromText(result.result)) };
    }
    throw new Error(failure(result));
  }
}

/** What the notch shows while the engine works. Relay's own tools narrate themselves as they run. */
async function narrate(m: SDKMessage, ctx: DriverContext): Promise<void> {
  if (m.type === 'system' && m.subtype === 'init') {
    await ctx.emit({
      type: 'note',
      text: `Working on it with Claude Code (${m.model}), on your Claude plan.`,
      status: 'running',
      // The session can be opened in Claude Code itself: `claude --resume <session>` from the engine's folder.
      data: { engine: 'claude-code', session: m.session_id, version: m.claude_code_version, auth: m.apiKeySource },
    });
    return;
  }
  if (m.type === 'system' && m.subtype === 'compact_boundary') {
    await ctx.emit({ type: 'note', text: 'Condensed its notes so far, to keep going.' });
    return;
  }
  // A helper agent's own thinking stays out of the notch; its work in the box still shows as it runs.
  if (m.type !== 'assistant' || m.parent_tool_use_id) return;
  for (const b of m.message.content) {
    if (b.type === 'text' && b.text.trim()) {
      await ctx.emit({ type: 'think', text: oneLine(b.text) });
    } else if (b.type === 'tool_use') {
      const i = (b.input ?? {}) as Record<string, unknown>;
      const said = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
      if (b.name === 'WebSearch') await ctx.emit({ type: 'tool', text: `Searching the web: ${said('query')}`, data: { tool: 'web_search' } });
      else if (b.name === 'Agent') await ctx.emit({ type: 'note', text: `A helper is on it: ${said('description')}`, data: { tool: 'engine.agent' } });
      else if (b.name === 'TaskCreate') await ctx.emit({ type: 'note', text: `Plan: ${said('subject')}`, data: { tool: 'engine.plan', plan: { add: said('subject') } } });
      else if (b.name === 'TaskUpdate' && i.status === 'in_progress' && (said('activeForm') || said('subject'))) {
        await ctx.emit({ type: 'note', text: said('activeForm') || said('subject'), data: { tool: 'engine.plan', plan: { now: i.taskId } } });
      }
    }
  }
}
