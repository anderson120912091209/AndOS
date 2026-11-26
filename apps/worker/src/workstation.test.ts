import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createTask } from '@relay/shared';
import { BoxdClient, BoxdError, boxdFinder } from './boxd.js';
import { Workstation } from './workstation.js';
import { ClaudeDriver, type MessagesApi } from './claude.js';
import type { DriverContext, EmitStep } from './driver.js';

type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;

/** A pretend boxd: records each request and answers like the real one. */
function fakeBox(answer: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const seen: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ path, body, auth: new Headers(init?.headers).get('authorization') });
    const { status = 200, json } = answer(path, body);
    return Response.json(json, { status });
  }) as typeof fetch;
  const client = new BoxdClient(async () => ({ url: 'http://box:7070', token: 'h4nds' }), 'task_1', http);
  return { client, seen };
}

const use = (name: string, input: unknown, toolset?: string): ToolUse =>
  ({ type: 'tool_use', id: `tu_${name}`, name, input, ...(toolset ? { toolset_name: toolset } : {}) }) as ToolUse;

describe('Workstation', () => {
  it('runs bash in the job’s own shell and hands the output back', async () => {
    const { client, seen } = fakeBox(() => ({ json: { output: 'hello\n[exit code 0]', exit_code: 0, timed_out: false } }));
    const steps: EmitStep[] = [];
    const ws = new Workstation(client, async (s) => void steps.push(s));
    const out = await ws.handle(use('bash', { command: 'echo hello\necho more' }));
    expect(out).toEqual({ type: 'tool_result', tool_use_id: 'tu_bash', content: 'hello\n[exit code 0]' });
    expect(seen[0]).toMatchObject({ path: '/exec', body: { session: 'task_1', command: 'echo hello\necho more' }, auth: 'Bearer h4nds' });
    expect(steps).toEqual([{ type: 'tool', text: 'Running echo hello', data: { tool: 'box.bash' } }]);
  });

  it('edits files through the box, and returns the box’s refusal as an error the model can fix', async () => {
    const { client, seen } = fakeBox((path) =>
      path === '/files/view' ? { status: 403, json: { error: '/etc/passwd is outside the workspace (/home/agent)' } } : { json: { text: 'Created notes.md (1 lines).' } },
    );
    const ws = new Workstation(client, async () => undefined);
    expect(await ws.handle(use('str_replace_based_edit_tool', { command: 'create', path: 'notes.md', file_text: '# hi' }))).toMatchObject({ content: 'Created notes.md (1 lines).' });
    expect(seen[0]).toMatchObject({ path: '/files/create', body: { path: 'notes.md', file_text: '# hi' } });
    expect(await ws.handle(use('str_replace_based_edit_tool', { command: 'view', path: '/etc/passwd' }))).toMatchObject({
      is_error: true,
      content: expect.stringContaining('outside the workspace'),
    });
    expect(await ws.handle(use('read_page', {}))).toBeUndefined(); // not the box's: someone else handles it
  });

  it('works the screen as Anthropic’s computer toolset, toolset_name and all', async () => {
    const { client, seen } = fakeBox((path) =>
      path === '/screenshot' ? { json: { data: 'iVBORw0KGgo=', media_type: 'image/png' } } : path === '/input' ? { json: { ok: true } } : { json: {} },
    );
    const ws = new Workstation(client, async () => undefined);
    expect(ws.tools().map((t) => ('name' in t ? t.name : t.type))).toEqual(['bash', 'str_replace_based_edit_tool', 'computer_toolset_20260801']);

    const shot = await ws.handle(use('screenshot', {}, 'computer'));
    expect(shot).toMatchObject({ tool_use_id: 'tu_screenshot', toolset_name: 'computer' });
    expect(JSON.stringify(shot)).toContain('"type":"image"');

    const click = await ws.handle(use('left_click', { coordinate: [640, 60] }, 'computer'));
    expect(click).toMatchObject({ toolset_name: 'computer' });
    expect(click).not.toHaveProperty('is_error', true);
    expect(seen.at(-1)).toMatchObject({ path: '/input', body: { session: 'task_1', action: 'left_click', input: { coordinate: [640, 60] } } });
  });

  it('passes a busy screen back to the model instead of failing the task', async () => {
    const { client } = fakeBox(() => ({ status: 409, json: { error: 'Another task is using the screen right now — try again in a moment.' } }));
    const ws = new Workstation(client, async () => undefined);
    const out = await ws.handle(use('left_click', { coordinate: [1, 1] }, 'computer'));
    expect(out).toMatchObject({ is_error: true, toolset_name: 'computer' });
    expect(JSON.stringify(out)).toContain('Another task is using the screen');
  });
});

describe('boxdFinder', () => {
  it('wakes the box through the server and prefers RELAY_BOXD_URL from inside a container', async () => {
    const asked: string[] = [];
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${init?.method} ${String(input)}`);
      return Response.json({ computer: true, boxd: { host: 'http://127.0.0.1:17070', network: 'http://relay-browser:7070', token: 't' } });
    }) as typeof fetch;
    expect(await boxdFinder('http://srv', {}, {}, http)()).toEqual({ url: 'http://127.0.0.1:17070', token: 't' });
    expect(await boxdFinder('http://srv', {}, { RELAY_BOXD_URL: 'http://relay-browser:7070/' }, http)()).toEqual({ url: 'http://relay-browser:7070', token: 't' });
    expect(asked[0]).toBe('POST http://srv/api/worker/box/ensure');
  });

  it('says why when the box has no hands yet', async () => {
    const http = (async () => Response.json({ computer: false, note: 'restart it to get them' })) as unknown as typeof fetch;
    await expect(boxdFinder('http://srv', {}, {}, http)()).rejects.toThrow(BoxdError);
    await expect(boxdFinder('http://srv', {}, {}, http)()).rejects.toThrow(/restart it/);
  });
});

describe('ClaudeDriver with a computer', () => {
  it('offers the computer, runs a command on it, and keeps old screenshots from piling up', async () => {
    const calls: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
    const turns = [
      { content: [{ type: 'tool_use', id: 'b1', name: 'bash', input: { command: 'python3 -c "print(2**20)"' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: '2^20 is 1048576.' }], stop_reason: 'end_turn' },
    ];
    const api: MessagesApi = {
      async create(params) {
        calls.push(structuredClone(params));
        return { id: 'm', type: 'message', role: 'assistant', model: params.model, stop_sequence: null, usage: {}, ...turns.shift() } as unknown as Anthropic.Beta.Messages.BetaMessage;
      },
    };
    const { client } = fakeBox(() => ({ json: { output: '1048576', exit_code: 0, timed_out: false } }));
    const c: DriverContext = {
      emit: async () => undefined,
      signal: new AbortController().signal,
      speed: 0,
      drafts: { createEmail: async () => ({ id: 'd' }), discardEmail: async () => undefined },
      computer: new Workstation(client, async () => undefined),
    };
    const out = await new ClaudeDriver(api).run(createTask({ kind: 'agent', title: 'x', utterance: 'what is 2^20' }), c);

    // a one-line prose ending: the headline is the whole answer (shared answer.ts)
    expect(out).toEqual({ type: 'done', result: { summary: '2^20 is 1048576.', answer: { tone: 'answer', headline: '2^20 is 1048576.' }, place: 'chin' } });
    const first = calls[0]!;
    expect(first.tools?.map((t) => ('name' in t ? t.name : t.type))).toEqual(
      expect.arrayContaining(['bash', 'str_replace_based_edit_tool', 'computer_toolset_20260801']),
    );
    expect(String(first.system)).toContain('You have your own computer');
    expect(first.betas).toContain('context-management-2025-06-27');
    expect(first.context_management?.edits?.[0]).toMatchObject({ type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 8 } });
    expect(calls[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: '1048576' }] });
  });
});
