import type { TaskKind, TaskStatus, TaskStep } from '@relay/shared';

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function elapsed(fromTs: number, toTs: number): string {
  const ms = Math.max(0, toTs - fromTs);
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export const STATUS_META: Record<TaskStatus, { label: string; color: string; dot: string }> = {
  queued: { label: 'Queued', color: 'text-dim', dot: 'bg-dim' },
  claimed: { label: 'Claimed', color: 'text-sky', dot: 'bg-sky' },
  running: { label: 'Working', color: 'text-signal', dot: 'bg-signal' },
  needs_input: { label: 'Needs you', color: 'text-sand', dot: 'bg-sand' },
  awaiting_approval: { label: 'Needs your OK', color: 'text-sand', dot: 'bg-sand' },
  done: { label: 'Done', color: 'text-good', dot: 'bg-good' },
  failed: { label: 'Failed', color: 'text-bad', dot: 'bg-bad' },
  canceled: { label: 'Canceled', color: 'text-faint', dot: 'bg-faint' },
};

export const KIND_META: Record<TaskKind, { label: string; color: string; glyph: string }> = {
  dictation: { label: 'Dictation', color: 'text-sand', glyph: '✎' },
  command: { label: 'Command', color: 'text-sky', glyph: '⌘' },
  agent: { label: 'Agent task', color: 'text-signal', glyph: '◆' },
};

export const STEP_GLYPH: Record<TaskStep['type'], string> = {
  think: '∴',
  act: '→',
  observe: '◎',
  tool: '⚙',
  note: '·',
  result: '✓',
};
