// The agent on your own ChatGPT plan: Codex's harness, Relay's hands.
//
// Codex's official app server — the protocol its own desktop app and IDE extensions speak, JSON-RPC
// over stdio — signed in with your ChatGPT login. Relay gives the thread its tools as dynamic tools,
// the same Toolbox as the Claude Code engine, and Codex calls each one back over the same pipe
// (item/tool/call), where the same approval line stands in front of it.
//
// Codex's own hands are switched off: no shell, no image viewer, no computer or browser use, no
// apps or plugins. The one tool Codex won't let go of, apply_patch, meets a read-only sandbox in an
// empty scratch folder, with every approval refused.
//
// It runs with its own Codex home (~/.relay/codex), so nothing from your own Codex setup — your MCP
// servers, plugins, hooks, history — comes along, and its login never touches yours. Sign it in once:
//   CODEX_HOME=~/.relay/codex codex login
// then start the worker with RELAY_DRIVER=codex. RELAY_CODEX_BIN points at a specific binary.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { answerFromText, answerResult, type Proposal, type Task } from '@relay/shared';
import { COMPUTER, SYSTEM, oneLine, revisePrompt, runPrompt } from './claude.js';
import type { AgentDriver, DriverContext, Outcome } from './driver.js';
import { Toolbox } from './toolbox.js';

const MODEL = process.env.RELAY_CODEX_MODEL || null; // null: the plan's default model
const BIN = process.env.RELAY_CODEX_BIN ?? 'codex';
export const CODEX_HOME = process.env.RELAY_CODEX_HOME ?? path.join(os.homedir(), '.relay', 'codex');
/** The engine's working directory: an empty scratch folder, never anything of yours. */
const HOME = process.env.RELAY_ENGINE_HOME ?? path.join(os.homedir(), '.relay', 'engine');

/** Codex's own tools that would act on this Mac, off; its plan tool, which the notch shows, on. */
export const CODEX_ARGS = [
  'app-server',
  ...['shell_tool', 'unified_exec', 'view_image', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'apps', 'plugins', 'hooks', 'memories'].flatMap(
    (f) => ['--disable', f],
  ),
  '-c',
  'tools.update_plan.enabled=true',
];

/** One line of JSON each way: what the driver needs from the app server's stdio. */
export interface Pipe {
  send(line: string): void;
  onLine(handle: (line: string) => void): void;
  /** the server went away; `why` is its last words on stderr */
  onExit(handle: (why: string) => void): void;
  close(): void;
}

/** The engine's environment: its own Codex home, and no API key, so it runs on the ChatGPT login. */
export function codexEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const { OPENAI_API_KEY: _key, CODEX_API_KEY: _codexKey, ...rest } = env;
  return { ...rest, CODEX_HOME };
}

function launch(): Pipe {
  mkdirSync(CODEX_HOME, { recursive: true });
  const proc = spawn(BIN, CODEX_ARGS, { cwd: HOME, env: codexEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let closed = false;
  proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const lines = readline.createInterface({ input: proc.stdout });
  // Its log lines, colour codes off; warnings such as "setting X is ignored" aren't why it stopped.
  const lastWords = () =>
    stderr
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((l) => /\bERROR\b|error|fatal|panic/i.test(l) && !/ignoring \d+ unrecognized|is ignored/.test(l))
      .pop() ?? '';
  return {
    send: (line) => proc.stdin.write(`${line}\n`),
    onLine: (handle) => lines.on('line', handle),
    onExit: (handle) => {
      proc.on('error', (err) => handle(`${BIN} couldn't start (${err.message}). Install Codex, or set RELAY_CODEX_BIN.`));
      proc.on('exit', () => closed || handle(lastWords()));
    },
    close: () => {
      closed = true; // our own ending, not a crash
      proc.kill();
    },
  };
}

type Message = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };

/** JSON-RPC over the pipe, the app server's dialect: one message per line, no "jsonrpc" field. */
class Rpc {
  private next = 1;
  private waiting = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private pipe: Pipe,
    private onRequest: (method: string, params: unknown) => Promise<unknown>,
    private onNotice: (method: string, params: unknown) => void,
  ) {
    pipe.onLine((line) => void this.receive(line));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    this.pipe.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  notify(method: string): void {
    this.pipe.send(JSON.stringify({ method }));
  }

  /** The server is gone: nothing still waiting will ever be answered. */
  fail(why: Error): void {
    for (const w of this.waiting.values()) w.reject(why);
    this.waiting.clear();
  }

  private async receive(line: string): Promise<void> {
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error) w?.reject(new Error(m.error.message ?? 'Codex refused the request'));
      else w?.resolve(m.result);
    } else if (m.id !== undefined && m.method) {
      try {
        this.pipe.send(JSON.stringify({ id: m.id, result: await this.onRequest(m.method, m.params) }));
      } catch (err) {
        this.pipe.send(JSON.stringify({ id: m.id, error: { code: -32000, message: (err as Error).message } }));
      }
    } else if (m.method) {
      this.onNotice(m.method, m.params);
    }
  }
}

/** What the engine adds to Codex's own instructions. */
function instructions(ctx: DriverContext): string {
  return `${SYSTEM}${ctx.computer ? COMPUTER : ''}

You're running inside Relay as the user's assistant. Your working directory is an empty scratch folder on the user's Mac with a read-only sandbox: don't use it. You act only through Relay's tools${ctx.computer ? ' — your own computer (the box: its shell, files and screen), ' : ' — '}the browser and the accounts the user connected. For a long job, keep the plan up to date. Always end by calling finish, or one of the tools that hand the next step to the user.`;
}

type OutputItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };

/** An MCP tool result as Codex's dynamic-tool output: text stays text, screenshots become data URLs. */
function asItems(result: CallToolResult): OutputItem[] {
  return result.content.flatMap((c): OutputItem[] =>
    c.type === 'text' ? [{ type: 'inputText', text: c.text }] : c.type === 'image' ? [{ type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` }] : [],
  );
}

type Turn = { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error: { message: string } | null };
type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
type Limits = { primary: Window | null; secondary: Window | null; rateLimitReachedType: string | null };

function planLimit(limits: Limits): string {
  const full = [limits.primary, limits.secondary].find((w) => w && w.usedPercent >= 100);
  const at = full?.resetsAt ? new Date(full.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'soon';
  const window = full?.windowDurationMins && full.windowDurationMins > 600 ? 'weekly' : '5-hour';
  return `Your ChatGPT plan's ${window} Codex limit is used up — it resets ${at}. Nothing was sent.`;
}

export class CodexDriver implements AgentDriver {
  readonly name = `codex (${MODEL ?? 'default model'}, your ChatGPT plan)`;

  /** `open` starts the app server — injectable so tests run without it. */
  constructor(private open: () => Pipe = launch) {}

  run(task: Task, ctx: DriverContext): Promise<Outcome> {
    return this.session(runPrompt(task, ctx), ctx);
  }

  revise(task: Task, previous: Proposal, feedback: string, ctx: DriverContext): Promise<Outcome> {
    return this.session(revisePrompt(task, previous, feedback, ctx), ctx);
  }

  private async session(prompt: string, ctx: DriverContext): Promise<Outcome> {
    mkdirSync(HOME, { recursive: true });
    const pipe = this.open();
    let threadId = '';
    let turnId = '';
    let said = ''; // the last thing Codex wrote: the answer, if it never calls finish
    let trouble = '';
    let limits: Limits | undefined;
    let settle!: (turn: Turn) => void;
    let lose!: (err: Error) => void;
    const ended = new Promise<Turn>((resolve, reject) => ((settle = resolve), (lose = reject)));
    ended.catch(() => undefined); // a crash before the turn starts is reported by the request it broke

    let stopping = false;
    const stop = () => {
      if (stopping || !turnId) return;
      stopping = true;
      void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      // If Codex doesn't confirm the interrupt, don't wait on it.
      setTimeout(() => settle({ id: turnId, status: 'interrupted', error: null }), 3000).unref();
    };
    const box = new Toolbox(ctx, stop);

    const rpc = new Rpc(
      pipe,
      async (method, params) => {
        switch (method) {
          case 'item/tool/call': {
            const p = params as { tool: string; arguments: unknown };
            const result = await box.call(p.tool, (p.arguments ?? {}) as Record<string, unknown>);
            return { contentItems: asItems(result), success: !result.isError };
          }
          // Codex's own actions, which Relay never allows: its shell is off, and its sandbox is read-only.
          case 'item/commandExecution/requestApproval':
          case 'item/fileChange/requestApproval':
            return { decision: 'decline' };
          case 'execCommandApproval':
          case 'applyPatchApproval':
            return { decision: { denied: { rejection: 'Relay runs nothing on this Mac. Use the box.' } } };
          default:
            throw new Error(`Relay doesn't support ${method}`);
        }
      },
      (method, params) => {
        if (method === 'turn/completed') {
          const t = (params as { turn: Turn }).turn;
          if (t.id === turnId) settle(t);
        } else if (method === 'error') {
          const e = params as { error: { message: string }; willRetry: boolean };
          if (!e.willRetry) trouble = e.error.message;
        } else if (method === 'account/rateLimits/updated') {
          limits = (params as { rateLimits: Limits }).rateLimits;
        } else {
          void narrate(method, params, ctx).catch(() => undefined);
          if (method === 'item/completed') {
            const item = (params as { item: { type: string; text?: string } }).item;
            if (item.type === 'agentMessage' && item.text) said = item.text;
          }
        }
      },
    );
    pipe.onExit((why) => {
      const err = new Error(why ? `Codex stopped: ${oneLine(why, 300)}` : 'Codex stopped unexpectedly.');
      lose(err);
      rpc.fail(err);
    });
    const cancel = () => stop();
    ctx.signal.addEventListener('abort', cancel, { once: true });

    try {
      await rpc.request('initialize', { clientInfo: { name: 'relay', title: 'Relay', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify('initialized');
      const auth = await rpc.request<{ authMethod: string | null }>('getAuthStatus', { includeToken: false, refreshToken: false });
      if (auth.authMethod !== 'chatgpt') {
        throw new Error(`Codex isn't signed in to your ChatGPT plan for Relay — run \`CODEX_HOME=${CODEX_HOME} codex login\` once, then try again.`);
      }
      const started = await rpc.request<{ thread: { id: string }; model: string }>('thread/start', {
        model: MODEL,
        cwd: HOME,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: instructions(ctx),
        serviceName: 'relay',
        dynamicTools: box.tools().map((t) => ({ type: 'function', name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })),
      });
      threadId = started.thread.id;
      await ctx.emit({
        type: 'note',
        text: `Working on it with Codex (${started.model}), on your ChatGPT plan.`,
        status: 'running',
        data: { engine: 'codex', thread: threadId },
      });
      const { turn } = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      turnId = turn.id;
      if (ctx.signal.aborted) stop();
      const end = await ended;

      if (box.fatal) throw box.fatal;
      if (box.outcome) return box.outcome;
      if (ctx.signal.aborted) throw new Error('aborted');
      if (end.status === 'completed' && said.trim()) {
        // It answered in prose instead of calling finish: keep every word, shaped as well as we can.
        return { type: 'done', result: answerResult(answerFromText(said)) };
      }
      if (limits?.rateLimitReachedType || [limits?.primary, limits?.secondary].some((w) => w && w.usedPercent >= 100)) {
        throw new Error(planLimit(limits!));
      }
      const why = end.error?.message || trouble;
      throw new Error(why ? `Codex stopped: ${oneLine(why, 300)}` : `Codex stopped (${end.status}) without an answer.`);
    } finally {
      ctx.signal.removeEventListener('abort', cancel);
      pipe.close();
    }
  }
}

/** What the notch shows while Codex works. Relay's own tools narrate themselves as they run. */
async function narrate(method: string, params: unknown, ctx: DriverContext): Promise<void> {
  if (method === 'turn/plan/updated') {
    const plan = (params as { plan: { step: string; status: string }[] }).plan;
    const now = plan.find((s) => s.status === 'inProgress');
    if (now) await ctx.emit({ type: 'note', text: now.step, data: { tool: 'engine.plan', plan } });
    return;
  }
  if (method !== 'item/started' && method !== 'item/completed') return;
  const item = (params as { item: Record<string, unknown> & { type: string } }).item;
  if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
    await ctx.emit({ type: 'think', text: oneLine(item.text) });
  } else if (method === 'item/started' && item.type === 'webSearch') {
    await ctx.emit({ type: 'tool', text: `Searching the web: ${String(item.query ?? '')}`, data: { tool: 'web_search' } });
  } else if (method === 'item/started' && item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
    await ctx.emit({ type: 'note', text: 'A helper is on it.', data: { tool: 'engine.agent' } });
  } else if (method === 'item/completed' && item.type === 'contextCompaction') {
    await ctx.emit({ type: 'note', text: 'Condensed its notes so far, to keep going.' });
  }
}
