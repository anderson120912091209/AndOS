// Piko's hands: everything the model does on the user's computer. Anthropic's trained tools (the computer
// toolset, bash, the text editor) run through boxd; share_file and show_screen hand results to the user.
// Each task is its own boxd session: its own shell, and one task at a time drives the screen.
import { setTimeout as delay } from 'node:timers/promises';
import { saveMedia, shareable } from '../media.js';
import type { Outgoing, ToolCall, ToolResult } from '../types.js';
import { type Box, BoxError, boxd, ensureBox } from './manager.js';

/** The computer toolset's member tools, as the model calls them. */
export const COMPUTER_MEMBERS = new Set([
  'screenshot', 'zoom', 'cursor_position', 'wait',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'mouse_move', 'left_mouse_down', 'left_mouse_up',
  'type', 'key', 'hold_key', 'scroll',
]);

/** Tools the box answers; the workflow sends these to the runTool activity. */
export function onBox(call: ToolCall): boolean {
  return call.toolset === 'computer' || ['bash', 'str_replace_based_edit_tool', 'share_file', 'show_screen'].includes(call.name);
}

const ok = (content: string, toolset?: string): ToolResult => ({ content, toolset });
const failed = (content: string, toolset?: string): ToolResult => ({ content, isError: true, toolset });

function image(data: string, toolset?: string): ToolResult {
  return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }], toolset };
}

async function computer(box: Box, session: string, call: ToolCall): Promise<ToolResult> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case 'screenshot':
      return image((await boxd<{ data: string }>(box, '/screenshot', { session })).data, 'computer');
    case 'zoom':
      return image((await boxd<{ data: string }>(box, '/screenshot', { session, region: input.region })).data, 'computer');
    case 'cursor_position': {
      const { x, y } = await boxd<{ x: number; y: number }>(box, '/cursor', { session });
      return ok(`X=${x}, Y=${y}`, 'computer');
    }
    case 'wait':
      await delay(Math.min(Number(input.duration) || 1, 300) * 1000);
      return ok('OK', 'computer');
    default:
      await boxd(box, '/input', { session, action: call.name, input });
      return ok('OK', 'computer');
  }
}

async function bash(box: Box, session: string, input: { command?: string; restart?: boolean }): Promise<ToolResult> {
  if (input.restart) return ok((await boxd<{ output: string }>(box, '/exec', { session, restart: true })).output);
  if (!input.command) return failed('command is required');
  const run = await boxd<{ output: string; exit_code: number }>(box, '/exec', { session, command: input.command, timeout_ms: 180_000 });
  return run.exit_code === 0 ? ok(run.output || '(no output)') : failed(run.output || `exit code ${run.exit_code}`);
}

async function editor(box: Box, input: Record<string, unknown> & { command?: string }): Promise<ToolResult> {
  if (!['view', 'create', 'str_replace', 'insert'].includes(String(input.command))) {
    return failed(`Unsupported command ${String(input.command)}. Use view, create, str_replace or insert.`);
  }
  return ok((await boxd<{ text: string }>(box, `/files/${String(input.command)}`, input)).text);
}

/** A screenshot made smaller with the box's ImageMagick, for LINE's 1 MB preview limit. */
async function preview(box: Box, session: string, path: string): Promise<Buffer> {
  const small = `/tmp/piko-preview-${Date.now()}.jpg`;
  await boxd(box, '/exec', { session, command: `convert ${JSON.stringify(path)} -resize 800x800 -quality 80 ${small}` });
  const read = await boxd<{ data: string }>(box, '/files/read', { session, path: small });
  return Buffer.from(read.data, 'base64');
}

async function share(box: Box, session: string, input: { path?: string; caption?: string }): Promise<{ result: ToolResult; out?: Outgoing }> {
  if (!input.path) return { result: failed('path is required') };
  const file = await boxd<{ name: string; size: number; data: string }>(box, '/files/read', { session, path: input.path });
  if (!shareable(file.name)) {
    return { result: failed(`${file.name} can't be sent. Share images, videos, PDF, Word, Excel, PowerPoint, CSV or text.`) };
  }
  const bytes = Buffer.from(file.data, 'base64');
  const url = saveMedia(bytes, file.name);
  const caption = input.caption;
  if (/\.(png|jpe?g)$/i.test(file.name)) {
    const previewUrl = bytes.length <= 1_000_000 ? url : saveMedia(await preview(box, session, input.path), 'preview.jpg');
    return { result: ok(`Sent the picture ${file.name}; it goes out with your reply.`), out: { kind: 'image', url, previewUrl, caption } };
  }
  return { result: ok(`Sent ${file.name} as a link; it goes out with your reply.`), out: { kind: 'file', url, name: file.name, caption } };
}

async function showScreen(box: Box, session: string, input: { caption?: string }): Promise<{ result: ToolResult; out?: Outgoing }> {
  const shot = await boxd<{ data: string }>(box, '/screenshot', { session });
  const url = saveMedia(Buffer.from(shot.data, 'base64'), 'screen.png');
  return { result: ok('Sent the current screen; it goes out with your reply.'), out: { kind: 'image', url, previewUrl: url, caption: input.caption } };
}

/** Runs one box tool for the user's task. `out` is something to show the user, queued with the next reply. */
export async function runOnBox(userId: string, taskId: string, call: ToolCall): Promise<{ result: ToolResult; out?: Outgoing }> {
  try {
    const box = await ensureBox(userId);
    const input = (call.input ?? {}) as Record<string, unknown>;
    if (call.toolset === 'computer' || COMPUTER_MEMBERS.has(call.name)) return { result: await computer(box, taskId, call) };
    switch (call.name) {
      case 'bash':
        return { result: await bash(box, taskId, input) };
      case 'str_replace_based_edit_tool':
        return { result: await editor(box, input) };
      case 'share_file':
        return await share(box, taskId, input as { path?: string; caption?: string });
      case 'show_screen':
        return await showScreen(box, taskId, input as { caption?: string });
      default:
        return { result: failed(`There is no box tool named ${call.name}.`) };
    }
  } catch (err) {
    const message = err instanceof BoxError ? err.message : err instanceof Error ? err.message : String(err);
    return { result: failed(`Error: ${message}`, call.toolset) };
  }
}
