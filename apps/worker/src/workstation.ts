// The box as the agent's own computer.
//
// Three of Anthropic's trained tools, carried out by boxd inside the box:
//   bash                          — one persistent shell per job, in /home/agent
//   str_replace_based_edit_tool   — view / create / str_replace / insert, confined to /home/agent
//   computer_toolset_20260801     — screenshot, zoom, click, type, key, scroll… on the box's screen
//
// They're the model's own tools, so the agent uses them the way it was trained to, on any task:
// write and run a script, convert a file, fill in a form on the screen, check its own work in a
// screenshot. The brain stays here in the worker; the box only executes.

import type Anthropic from '@anthropic-ai/sdk';
import { BetaAbstractComputerToolset20260801, ToolError, type BetaToolsetCallContext } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import { BoxdError, type BoxdClient } from './boxd.js';
import type { EmitStep } from './driver.js';

type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export const BASH_TOOL: Anthropic.Beta.BetaToolUnion = { type: 'bash_20250124', name: 'bash' };
export const EDITOR_TOOL: Anthropic.Beta.BetaToolUnion = {
  type: 'text_editor_20250728',
  name: 'str_replace_based_edit_tool',
  max_characters: 16_000,
};

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * The last check before an action reaches the box's screen: true lets it run; false declines it, and
 * the model is told so — it can then try another way, or hand the step to you with request_takeover.
 * Called for every screen action (the SDK insists on one for key, type and hold_key). `member` is the
 * toolset member ("type", "key", "left_click", …) and `input` is exactly what the model sent with it.
 */
export function allowOnScreen(member: string, input: Record<string, unknown>): boolean {
  // TODO(human): decide which screen actions the bot must never take on its own.
  return true;
}

/** The box's screen as Anthropic's computer toolset: every member goes to boxd, one request each. */
export class BoxScreen extends BetaAbstractComputerToolset20260801 {
  constructor(private boxd: BoxdClient) {
    super({ confirm: (ctx) => allowOnScreen(ctx.member, (ctx.input ?? {}) as Record<string, unknown>) });
  }

  // One dispatch for every member: boxd already speaks each member's own input shape.
  protected override async execute(ctx: BetaToolsetCallContext, name: string, input: unknown) {
    try {
      switch (name) {
        case 'screenshot': {
          const shot = await this.boxd.screenshot();
          return { data: shot.data, mediaType: shot.media_type };
        }
        case 'zoom': {
          const shot = await this.boxd.screenshot((input as { region?: number[] }).region);
          return { data: shot.data, mediaType: shot.media_type };
        }
        case 'cursor_position':
          return await this.boxd.cursor();
        case 'wait': {
          const seconds = Math.max(0, Math.min(10, Number((input as { duration?: unknown }).duration) || 1));
          await sleep(seconds * 1000, ctx.signal);
          return;
        }
        default:
          await this.boxd.input(name, input);
          return;
      }
    } catch (err) {
      // The box's explanation ("[1300, 10] is off the 1280×800 screen", "the screen is busy") goes
      // back to the model as an error result it can act on.
      if (err instanceof BoxdError) throw new ToolError(err.message);
      throw err;
    }
  }
}

/**
 * The one line the notch shows while the bot works the screen, or undefined to show nothing. Looking
 * and pointing stay quiet (a bot checks the screen constantly); what it types is never shown, since
 * the notch is on your screen for anyone nearby to read.
 */
export function narrateScreen(member: string, input: Record<string, unknown>): string | undefined {
  switch (member) {
    case 'left_click':
    case 'double_click':
    case 'triple_click':
    case 'right_click':
    case 'middle_click':
      return 'Clicking';
    case 'left_click_drag':
      return 'Dragging';
    case 'type':
      return 'Typing';
    case 'key':
    case 'hold_key':
      return typeof input.text === 'string' ? `Pressing ${input.text.replace(/\s+/g, ' ').slice(0, 24)}` : 'Pressing a key';
    case 'scroll':
      return typeof input.scroll_direction === 'string' ? `Scrolling ${input.scroll_direction}` : 'Scrolling';
    default:
      return undefined; // screenshot, zoom, cursor_position, mouse_move, mouse down/up, wait
  }
}

const firstLine = (s: string, max = 80) => {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One job's computer: the tools to offer the model, and the results of calling them. */
export class Workstation {
  readonly screen: BoxScreen;

  constructor(
    readonly boxd: BoxdClient,
    private emit: (step: EmitStep) => Promise<void>,
  ) {
    this.screen = new BoxScreen(boxd);
  }

  tools(): Anthropic.Beta.BetaToolUnion[] {
    return [BASH_TOOL, EDITOR_TOOL, this.screen.toJSON()];
  }

  /** The tool_result for a call that belongs to the box, or undefined when it's another tool's. */
  async handle(call: ToolUse): Promise<ToolResult | undefined> {
    if (call.toolset_name === 'computer') {
      const line = narrateScreen(call.name, (call.input ?? {}) as Record<string, unknown>);
      if (line) await this.emit({ type: 'act', text: line, data: { tool: `computer.${call.name}` } });
      return this.screen.toolResult(call);
    }
    if (call.name !== 'bash' && call.name !== 'str_replace_based_edit_tool') return undefined;
    try {
      const content = call.name === 'bash' ? await this.bash(call.input) : await this.edit(call.input);
      return { type: 'tool_result', tool_use_id: call.id, content };
    } catch (err) {
      if (!(err instanceof BoxdError)) throw err;
      return { type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true };
    }
  }

  private async bash(input: unknown): Promise<string> {
    const i = (input ?? {}) as { command?: unknown; restart?: unknown };
    if (i.restart === true) return this.boxd.restart();
    if (typeof i.command !== 'string' || !i.command.trim()) throw new BoxdError(400, 'bash needs a command');
    await this.emit({ type: 'tool', text: `Running ${firstLine(i.command)}`, data: { tool: 'box.bash' } });
    return (await this.boxd.exec(i.command)).output;
  }

  private async edit(input: unknown): Promise<string> {
    const i = (input ?? {}) as Record<string, unknown>;
    const path = typeof i.path === 'string' ? i.path : '';
    const name = path.split('/').pop() || path;
    switch (i.command) {
      case 'view':
        return this.boxd.view(path, Array.isArray(i.view_range) ? (i.view_range as [number, number]) : undefined);
      case 'create':
        await this.emit({ type: 'act', text: `Writing ${name}`, data: { tool: 'box.write', path } });
        return this.boxd.create(path, String(i.file_text ?? ''));
      case 'str_replace':
        await this.emit({ type: 'act', text: `Editing ${name}`, data: { tool: 'box.edit', path } });
        return this.boxd.strReplace(path, String(i.old_str ?? ''), String(i.new_str ?? ''));
      case 'insert':
        await this.emit({ type: 'act', text: `Editing ${name}`, data: { tool: 'box.edit', path } });
        return this.boxd.insert(path, Number(i.insert_line), String(i.insert_text ?? ''));
      default:
        throw new BoxdError(400, `the editor can't “${String(i.command)}” — use view, create, str_replace or insert`);
    }
  }
}
