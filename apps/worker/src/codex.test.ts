import { describe, expect, it } from 'vitest';
import { createTask } from '@relay/shared';
import { CODEX_ARGS, CodexDriver, codexEnv, type Pipe } from './codex.js';
import type { DriverContext, EmitStep } from './driver.js';
import type { EmailDraft } from './mime.js';
import type { Workstation } from './workstation.js';

type Json = Record<string, unknown>;

interface Server {
  /** ask the driver something, the way Codex calls a dynamic tool or asks for an approval */
  request: (method: string, params: Json) => Promise<Json>;
  notify: (method: string, params: Json) => void;
  /** end the turn the way Codex does */
  complete: (status: 'completed' | 'failed', error?: string) => void;
}

/** A scripted app server: answers the handshake, then plays one turn against the driver's real Toolbox. */
function codex(play: (s: Server) => Promise<void>, auth: string | null = 'chatgpt') {
  const sent: Json[] = [];
  let deliver: (line: string) => void = () => undefined;
  const answers = new Map<number, (m: Json) => void>();
  let next = 1000;
  const later = (m: Json) => queueMicrotask(() => deliver(JSON.stringify(m)));
  const reply = (id: unknown, result: unknown) => later({ id, result });
  const server: Server = {
    request: (method, params) =>
      new Promise((resolve) => {
        const id = next++;
        answers.set(id, (m) => resolve((m.result ?? { error: m.error }) as Json));
        later({ id, method, params });
      }),
    notify: (method, params) => later({ method, params }),
    complete: (status, error) => later({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu1', status, error: error ? { message: error } : null } } }),
  };
  const pipe: Pipe = {
    send: (line) => {
      const m = JSON.parse(line) as Json;
      sent.push(m);
      if (m.method === 'initialize') reply(m.id, { userAgent: 'codex' });
      else if (m.method === 'getAuthStatus') reply(m.id, { authMethod: auth, authToken: null, requiresOpenaiAuth: true });
      else if (m.method === 'thread/start') reply(m.id, { thread: { id: 'th1' }, model: 'gpt-codex' });
      else if (m.method === 'turn/start') {
        reply(m.id, { turn: { id: 'tu1' } });
        queueMicrotask(() => void play(server));
      } else if (m.method === 'turn/interrupt') {
        reply(m.id, {});
        server.complete('failed'); // an interrupted turn ends; its status doesn't matter once the run has ended
      } else if (m.id !== undefined && m.method === undefined) answers.get(m.id as number)?.(m);
    },
    onLine: (handle) => (deliver = handle),
    onExit: () => undefined,
    close: () => undefined,
  };
  return { driver: new CodexDriver(() => pipe), sent };
}

const task = (utterance: string) => createTask({ kind: 'agent', title: utterance, utterance, context: { timeZone: 'Asia/Taipei' } });

function ctx(computer = false) {
  const steps: EmitStep[] = [];
  const drafts = new Map<string, EmailDraft>();
  const c: DriverContext = {
    emit: async (s) => void steps.push(s),
    signal: new AbortController().signal,
    speed: 0,
    drafts: {
      createEmail: async (email) => {
        const id = `d${drafts.size + 1}`;
        drafts.set(id, email);
        return { id };
      },
      discardEmail: async () => undefined,
    },
    ...(computer
      ? {
          computer: {
            tools: () => [],
            handle: async (call: { id: string; name: string }) => ({
              type: 'tool_result',
              tool_use_id: call.id,
              content:
                call.name === 'screenshot'
                  ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } }]
                  : [{ type: 'text', text: `ran ${call.name}` }],
            }),
          } as unknown as Workstation,
        }
      : {}),
  };
  return { c, steps, drafts };
}

describe('the Codex engine', () => {
  it("runs with its own Codex home, no API key, and none of Codex's own hands", () => {
    const env = codexEnv({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'k' });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toMatch(/\.relay\/codex$/);
    for (const off of ['shell_tool', 'unified_exec', 'computer_use', 'browser_use', 'apps', 'plugins', 'hooks']) {
      expect(CODEX_ARGS.join(' ')).toContain(`--disable ${off}`);
    }
    expect(CODEX_ARGS.join(' ')).toContain('--disable view_image');
  });

  it("calls Relay's tools back over the pipe, then ends on finish", async () => {
    const { driver, sent } = codex(async (s) => {
      expect(await s.request('item/tool/call', { tool: 'bash', arguments: { command: 'nproc' } })).toEqual({
        contentItems: [{ type: 'inputText', text: 'ran bash' }],
        success: true,
      });
      expect(await s.request('item/tool/call', { tool: 'computer', arguments: { action: 'screenshot' } })).toEqual({
        contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,UE5H' }],
        success: true,
      });
      await s.request('item/tool/call', { tool: 'finish', arguments: { tone: 'answer', headline: '18 cores', basis: '', note: '', followups: [] } });
    });
    const { c, steps } = ctx(true);
    const out = await driver.run(task('how many cores'), c);

    expect(out).toMatchObject({ type: 'done', result: { summary: '18 cores' } });
    const start = sent.find((m) => m.method === 'thread/start')!.params as Json & { dynamicTools: { name: string }[] };
    expect(start).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', serviceName: 'relay' });
    expect(start.dynamicTools.map((t) => t.name)).toEqual(expect.arrayContaining(['finish', 'draft_email', 'bash', 'computer']));
    expect(sent.some((m) => m.method === 'turn/interrupt')).toBe(true); // finish stopped the turn
    expect(steps[0]).toMatchObject({ type: 'note', status: 'running', data: { engine: 'codex', thread: 'th1' } });
  });

  it('drafts freely, stops at send_email with the card, and refuses its own shell', async () => {
    const { driver } = codex(async (s) => {
      expect(await s.request('item/commandExecution/requestApproval', { command: 'cat ~/.ssh/id_rsa' })).toEqual({ decision: 'decline' });
      await s.request('item/tool/call', { tool: 'draft_email', arguments: { to: ['sam@example.com'], subject: 'Late', body: 'Ten minutes late.' } });
      await s.request('item/tool/call', { tool: 'send_email', arguments: { draft_id: 'd1' } });
    });
    const out = await driver.run(task('email sam'), ctx().c);
    expect(out).toMatchObject({ type: 'proposal', proposal: { verb: 'Send', commit: { action: 'email.send', args: { draftId: 'd1' } } } });
  });

  it('keeps a prose answer, and says plainly when the plan is out of room or Codex is signed out', async () => {
    const prose = codex(async (s) => {
      s.notify('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'All done: 3 files.' } });
      s.complete('completed');
    });
    expect(await prose.driver.run(task('x'), ctx().c)).toMatchObject({ type: 'done', result: { summary: 'All done: 3 files.' } });

    const limited = codex(async (s) => {
      s.notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_792_945_352 }, secondary: null, rateLimitReachedType: 'primary' } });
      s.complete('failed', 'usage limit reached');
    });
    await expect(limited.driver.run(task('x'), ctx().c)).rejects.toThrow(/5-hour Codex limit is used up/);

    const signedOut = codex(async () => undefined, null);
    await expect(signedOut.driver.run(task('x'), ctx().c)).rejects.toThrow(/codex login/);
  });
});
