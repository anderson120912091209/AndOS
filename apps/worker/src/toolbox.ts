// Relay's tools for an engine that brings its own harness — Claude Code, Codex — on your own plan.
//
// The engine runs the loop; this is everything it can touch, for one job: the API agent's own tools
// (finish, drafts, the browser, your mail) with their schemas unchanged, plus the box's shell, files
// and screen under the names and input shapes the models were trained on. It's served to the engine
// over MCP, and carried out here in the worker, by the same code the API agent uses.
//
// The approval line is the API agent's too (shared policy.ts): a call that needs you, or that hands
// you the next step, is never carried out — it becomes this job's Outcome (an answer, a card in the
// notch, the box handed to you) and the engine is stopped right there.

import type Anthropic from '@anthropic-ai/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { answerResult, approvalFor, makeId, normalizeAnswer } from '@relay/shared';
import { BadToolInput, askToConnect, executeTool, proposalFor, requestTakeover, toolsFor } from './claude.js';
import type { DriverContext, Outcome } from './driver.js';
import type { EmailDraft } from './mime.js';

/** Tools whose call ends the run: an answer, a button, the box handed to you. */
const ENDINGS = new Set(['finish', 'ask_to_connect', 'request_takeover']);

/** Every member of Anthropic's computer toolset, as the actions of one `computer` tool. */
const SCREEN_ACTIONS = [
  'screenshot', 'zoom', 'cursor_position', 'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click',
  'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'key', 'hold_key', 'type', 'wait',
];

const point = (description: string) => ({ type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description });

/**
 * The box's tools for an engine that takes them over MCP. Same names and input shapes as Anthropic's
 * bash, text editor and computer tools — the model's trained habits carry over — and the same
 * Workstation carries them out.
 */
const BOX_TOOLS: Tool[] = [
  {
    name: 'bash',
    description:
      'Run a command in your own shell on the box, your Linux computer (bash, starting in /home/agent). cd and variables carry over between calls. restart: true gives you a fresh shell.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, restart: { type: 'boolean' } } },
  },
  {
    name: 'str_replace_based_edit_tool',
    description:
      'View, create and edit files on the box, under /home/agent. view shows a file with line numbers, or a folder two levels deep; create writes a whole file; str_replace swaps text that appears exactly once; insert adds text after insert_line (0 = the top).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
        path: { type: 'string', description: 'e.g. /home/agent/report.md' },
        file_text: { type: 'string', description: 'create: the whole file' },
        old_str: { type: 'string', description: 'str_replace: text that appears exactly once' },
        new_str: { type: 'string', description: 'str_replace: what replaces it' },
        insert_line: { type: 'integer', description: 'insert: the line to insert after' },
        insert_text: { type: 'string', description: 'insert: the text' },
        view_range: { type: 'array', items: { type: 'integer' }, description: 'view: [first, last] line; last = -1 for the end' },
      },
      required: ['command', 'path'],
    },
  },
  {
    name: 'computer',
    description:
      "See and use the box's screen, 1280×800. Take a screenshot first, act, then take another to check it worked. zoom enlarges a region to read small text.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: SCREEN_ACTIONS },
        coordinate: point('[x, y] in screenshot pixels'),
        start_coordinate: point('left_click_drag: where the drag starts'),
        text: { type: 'string', description: 'type: the text. key / hold_key: a key or chord such as ctrl+s. A click or scroll: modifier keys to hold.' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer' },
        duration: { type: 'number', description: 'wait / hold_key: seconds' },
        repeat: { type: 'integer', description: 'key: how many presses' },
        region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4, description: 'zoom: [x1, y1, x2, y2]' },
      },
      required: ['action'],
    },
  },
];

const BOX_TOOL_NAMES = new Set(BOX_TOOLS.map((t) => t.name));

/** Relay's own tools for this job, as MCP tools: the API agent's schemas, unchanged, plus the box. */
export function engineTools(ctx: DriverContext): Tool[] {
  const own = toolsFor(ctx).tools.flatMap((t): Tool[] =>
    'input_schema' in t && t.input_schema ? [{ name: t.name, description: t.description ?? '', inputSchema: t.input_schema as Tool['inputSchema'] }] : [],
  );
  return [...own, ...(ctx.computer ? BOX_TOOLS : [])];
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** A tool_result from the Workstation, as MCP content: text stays text, screenshots stay images. */
function asMcp(result: Anthropic.Beta.Messages.BetaToolResultBlockParam): CallToolResult {
  const blocks = typeof result.content === 'string' || result.content === undefined ? [{ type: 'text' as const, text: result.content ?? '' }] : result.content;
  const content = blocks.flatMap((b): CallToolResult['content'] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    if (b.type === 'image' && b.source.type === 'base64') return [{ type: 'image', data: b.source.data, mimeType: b.source.media_type }];
    return [];
  });
  return { content, ...(result.is_error ? { isError: true } : {}) };
}

/** What the gate decides for one call before it runs. */
export type Verdict = { run: true } | { refuse: string } | { end: Outcome };

/** One job's tools, the approval line in front of them, and how the job ended if a call ended it. */
export class Toolbox {
  /** set by the call that ended the run */
  outcome?: Outcome;
  /** a failure in Relay's own tools: fails the task, as it would on the API agent */
  fatal?: unknown;
  private drafts = new Map<string, EmailDraft>();

  /** `stop` halts the engine: called once the run has ended, or a tool failed outright. */
  constructor(
    private ctx: DriverContext,
    private stop: () => void,
  ) {}

  tools(): Tool[] {
    return engineTools(this.ctx);
  }

  /** The approval line, by Relay's name for the tool. Ending the run records the outcome. */
  gate(name: string, input: unknown): Verdict {
    if (!ENDINGS.has(name) && approvalFor(name) !== 'ask') return { run: true };
    try {
      this.outcome = this.ending(name, input);
      return { end: this.outcome };
    } catch (err) {
      if (err instanceof BadToolInput) return { refuse: err.message }; // the model reads why, and tries another way
      throw err;
    }
  }

  /** Carry out one call. The gate runs here too, so an engine that skipped it still can't get past it. */
  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const verdict = this.gate(name, args);
      if ('refuse' in verdict) return text(verdict.refuse, true);
      if ('end' in verdict) {
        this.stop();
        return text('Handed to the user. Stop here.');
      }
      if (this.ctx.computer && BOX_TOOL_NAMES.has(name)) {
        const { action, ...rest } = args;
        const use = (name === 'computer'
          ? { type: 'tool_use', id: makeId('call'), name: String(action), input: rest, toolset_name: 'computer' }
          : { type: 'tool_use', id: makeId('call'), name, input: args }) as unknown as Anthropic.Beta.Messages.BetaToolUseBlock;
        const result = await this.ctx.computer.handle(use);
        if (result) return asMcp(result);
      }
      return text(await executeTool({ name, input: args }, this.drafts, this.ctx));
    } catch (err) {
      if (err instanceof BadToolInput) return text(err.message, true);
      this.fatal = err;
      this.stop();
      return text('Relay hit an error and stopped this task.', true);
    }
  }

  /** The tools as an MCP server whose schemas reach the model exactly as written (no zod round-trip). */
  server(name: string): McpServer {
    const server = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools() }));
    server.server.setRequestHandler(CallToolRequestSchema, async (req) => this.call(req.params.name, req.params.arguments ?? {}));
    return server;
  }

  private ending(name: string, input: unknown): Outcome {
    switch (name) {
      case 'finish':
        return { type: 'done', result: answerResult(normalizeAnswer(input)) };
      case 'ask_to_connect':
        return askToConnect(input);
      case 'request_takeover':
        return requestTakeover(input, this.ctx.box);
      default:
        return { type: 'proposal', proposal: proposalFor({ name, input }, this.drafts) };
    }
  }
}
