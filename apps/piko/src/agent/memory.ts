// The backend for Claude's memory tool (`memory_20250818`). Claude sees one directory, /memories; each user
// gets their own real directory behind it, and no path may escape it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import type { ToolResult } from '../types.js';
import type { INPUTS } from './tools.js';

type MemoryCommand = z.infer<(typeof INPUTS)['memory']>;

const MAX_FILE_BYTES = 100_000;

function locate(root: string, path: string): string {
  if (path !== '/memories' && !path.startsWith('/memories/')) throw new Error(`Paths must start with /memories (got ${path}).`);
  const target = resolve(root, `.${path.slice('/memories'.length)}`);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`${path} is outside /memories.`);
  return target;
}

function list(root: string, dir: string, depth: number): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const shown = `/memories/${relative(root, full)}`;
    if (entry.isDirectory()) return depth > 1 ? [`${shown}/`, ...list(root, full, depth - 1)] : [`${shown}/`];
    return [`${shown} (${statSync(full).size} bytes)`];
  });
}

export function runMemory(root: string, input: MemoryCommand): ToolResult {
  try {
    switch (input.command) {
      case 'view': {
        const target = locate(root, input.path);
        if (!existsSync(target)) return { content: `${input.path} does not exist.`, isError: true };
        if (statSync(target).isDirectory()) {
          const entries = list(root, target, 2);
          return { content: entries.length > 0 ? entries.join('\n') : `${input.path} is empty.` };
        }
        const lines = readFileSync(target, 'utf8').split('\n');
        const [start = 1, end = -1] = input.view_range ?? [];
        const last = end === -1 ? lines.length : end;
        return {
          content: lines
            .slice(start - 1, last)
            .map((line, i) => `${String(start + i).padStart(4)}\t${line}`)
            .join('\n'),
        };
      }
      case 'create': {
        if (Buffer.byteLength(input.file_text) > MAX_FILE_BYTES) return { content: 'File too large; keep memories short.', isError: true };
        const target = locate(root, input.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, input.file_text);
        return { content: `File created successfully at: ${input.path}` };
      }
      case 'str_replace': {
        const target = locate(root, input.path);
        if (!existsSync(target)) return { content: `${input.path} does not exist.`, isError: true };
        const text = readFileSync(target, 'utf8');
        const count = text.split(input.old_str).length - 1;
        if (count !== 1) return { content: `old_str must appear exactly once in ${input.path} (found ${count}).`, isError: true };
        writeFileSync(target, text.replace(input.old_str, () => input.new_str));
        return { content: `The memory file ${input.path} has been edited.` };
      }
      case 'insert': {
        const target = locate(root, input.path);
        if (!existsSync(target)) return { content: `${input.path} does not exist.`, isError: true };
        const lines = readFileSync(target, 'utf8').split('\n');
        if (input.insert_line > lines.length) return { content: `insert_line is past the end of ${input.path}.`, isError: true };
        lines.splice(input.insert_line, 0, input.insert_text);
        writeFileSync(target, lines.join('\n'));
        return { content: `Text inserted at line ${input.insert_line} of ${input.path}.` };
      }
      case 'delete': {
        const target = locate(root, input.path);
        if (target === resolve(root)) return { content: 'The /memories directory itself cannot be deleted.', isError: true };
        if (!existsSync(target)) return { content: `${input.path} does not exist.`, isError: true };
        rmSync(target, { recursive: true });
        return { content: `Deleted ${input.path}.` };
      }
      case 'rename': {
        const from = locate(root, input.old_path);
        const to = locate(root, input.new_path);
        if (!existsSync(from)) return { content: `${input.old_path} does not exist.`, isError: true };
        if (existsSync(to)) return { content: `${input.new_path} already exists.`, isError: true };
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        return { content: `Renamed ${input.old_path} to ${input.new_path}.` };
      }
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
