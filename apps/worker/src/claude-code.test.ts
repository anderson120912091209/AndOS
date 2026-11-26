import { describe, expect, it } from 'vitest';
import type { CanUseTool, Options, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTask } from '@relay/shared';
import { ClaudeCodeDriver, engineEnv } from './claude-code.js';
import { engineTools } from './toolbox.js';
import type { DriverContext, EmitStep } from './driver.js';
import type { EmailDraft } from './mime.js';
import type { Workstation } from './workstation.js';

type Engine = {
  /** call one of Relay's tools the way the engine does: over MCP */
  tool: (name: string, args?: Record<string, unknown>) => Promise<{ content: { type: string; text?: string; data?: string }[]; isError?: boolean }>;
  /** ask the gate the way the engine does before every tool */
  gate: (name: string, input: Record<string, unknown>) => ReturnType<CanUseTool>;
  options: Options;
};

/** A scripted engine: plays one run against the driver's real gate and real MCP server. */
function scripted(play: (engine: Engine) => AsyncGenerator<Partial<SDKMessage> & { type: string }>) {
  const seen: Options[] = [];
  const start = (({ options }: { prompt: string; options: Options }) => {
    seen.push(options);
    async function* run() {
      const server = (options.mcpServers!.relay as { instance: McpServer }).instance;
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'engine', version: '0' });
      await client.connect(clientSide);
      const signal = new AbortController().signal;
      yield* play({
        tool: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as Awaited<ReturnType<Engine['tool']>>,
        gate: (name, input) => options.canUseTool!(name, input, { signal, toolUseID: 't1' } as Parameters<CanUseTool>[2]),
        options,
      });
    }
    return run();
  }) as unknown as typeof query;
  return { driver: new ClaudeCodeDriver(start), seen };
}

const task = (utterance: string) => createTask({ kind: 'agent', title: utterance, utterance, context: { timeZone: 'Asia/Taipei' } });

const init = { type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's1', claude_code_version: '2.1.310', apiKeySource: 'none' } as const;
const success = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 3 }) as const;

function ctx(computer = false) {
  const steps: EmitStep[] = [];
  const drafts = new Map<string, EmailDraft>();
  const ran: { name: string; input: unknown; toolset?: string }[] = [];
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
            handle: async (call: { id: string; name: string; input: unknown; toolset_name?: string }) => {
              ran.push({ name: call.name, input: call.input, ...(call.toolset_name ? { toolset: call.toolset_name } : {}) });
              const content =
                call.name === 'screenshot'
                  ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } }]
                  : [{ type: 'text', text: `ran ${call.name}` }];
              return { type: 'tool_result', tool_use_id: call.id, content };
            },
          } as unknown as Workstation,
        }
      : {}),
  };
  return { c, steps, drafts, ran };
}

describe('the Claude Code engine', () => {
  it('never hands the engine an API key, so it runs on the claude.ai login', () => {
    const env = engineEnv({ PATH: '/usr/bin', HOME: '/Users/me', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/me', CLAUDE_AGENT_SDK_CLIENT_APP: 'relay/0.1' });
  });

  it("offers Relay's own tools with their schemas unchanged, and the box only when there is one", () => {
    const names = (computer: boolean) => engineTools(ctx(computer).c).map((t) => t.name);
    expect(names(false)).toEqual(expect.arrayContaining(['finish', 'draft_email', 'send_email', 'create_calendar_event']));
    expect(names(false)).not.toContain('bash');
    expect(names(false)).not.toContain('web_search'); // the engine has its own WebSearch
    expect(names(true)).toEqual(expect.arrayContaining(['bash', 'str_replace_based_edit_tool', 'computer']));
    const finish = engineTools(ctx().c).find((t) => t.name === 'finish')!;
    expect(JSON.stringify(finish.inputSchema)).toContain('"anyOf"'); // the shaped-answer blocks survive
  });

  it('works in the box over MCP, then ends on finish with the shaped answer', async () => {
    const { driver, seen } = scripted(async function* ({ tool, gate }) {
      yield init;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Checking the box.' }] } } as never;
      expect(await gate('mcp__relay__bash', { command: 'nproc' })).toMatchObject({ behavior: 'allow' });
      expect((await tool('bash', { command: 'nproc' })).content[0]).toEqual({ type: 'text', text: 'ran bash' });
      const shot = await tool('computer', { action: 'screenshot' });
      expect(shot.content[0]).toMatchObject({ type: 'image', data: 'UE5H', mimeType: 'image/png' });
      expect(await gate('mcp__relay__finish', { tone: 'answer', headline: '18 cores', basis: '', note: '', followups: [] })).toMatchObject({
        behavior: 'deny',
        interrupt: true,
      });
      throw new Error('interrupted'); // what the SDK does once the gate interrupts
    });
    const { c, steps, ran } = ctx(true);
    const out = await driver.run(task('how many cores'), c);

    expect(out).toMatchObject({ type: 'done', result: { summary: '18 cores' } });
    expect(ran).toEqual([
      { name: 'bash', input: { command: 'nproc' } },
      { name: 'screenshot', input: {}, toolset: 'computer' },
    ]);
    expect(steps[0]).toMatchObject({ type: 'note', status: 'running', data: { engine: 'claude-code', session: 's1', auth: 'none' } });
    expect(steps).toContainEqual({ type: 'think', text: 'Checking the box.' });
    const o = seen[0]!;
    expect(o.tools).toEqual(['Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'WebSearch']);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('drafts freely, and stops at send_email with the card you approve', async () => {
    const { driver } = scripted(async function* ({ tool, gate }) {
      yield init;
      expect(await gate('mcp__relay__draft_email', {})).toMatchObject({ behavior: 'allow' });
      const saved = await tool('draft_email', { to: ['sam@example.com'], subject: 'Hi', body: 'Hello Sam' });
      expect(saved.content[0]!.text).toContain('nothing sent');
      await gate('mcp__relay__send_email', { draft_id: 'd1' });
      throw new Error('interrupted');
    });
    const { c, drafts } = ctx();
    const out = await driver.run(task('email sam hi'), c);
    expect(drafts.get('d1')).toMatchObject({ subject: 'Hi' });
    expect(out).toMatchObject({ type: 'proposal', proposal: { verb: 'Send', commit: { action: 'email.send', args: { draftId: 'd1' } } } });
  });

  it("refuses what Relay can't put in front of you, and lets the model try another way", async () => {
    const { driver } = scripted(async function* ({ gate }) {
      yield init;
      expect(await gate('mcp__relay__send_email', { draft_id: 'nope' })).toEqual({ behavior: 'deny', message: 'unknown draft_id — call draft_email first' });
      expect(await gate('mcp__other__delete_everything', {})).toMatchObject({ behavior: 'deny' });
      yield success('Could not send it: there was no draft.');
    });
    const out = await driver.run(task('send it'), ctx().c);
    expect(out).toMatchObject({ type: 'done', result: { summary: 'Could not send it: there was no draft.' } });
  });

  it('says plainly when your plan is out of room, or Claude Code is signed out', async () => {
    const limited = scripted(async function* () {
      yield init;
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_792_945_800 } } as never;
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limited'], num_turns: 1 } as never;
    });
    await expect(limited.driver.run(task('x'), ctx().c)).rejects.toThrow(/5-hour limit is used up/);

    const signedOut = scripted(async function* () {
      yield init;
      yield { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', num_turns: 1 } as never;
    });
    await expect(signedOut.driver.run(task('x'), ctx().c)).rejects.toThrow(/claude auth login/);
  });
});
