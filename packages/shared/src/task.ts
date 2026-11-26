// Domain model for a unit of work Relay tracks end-to-end.
//
// A Task is created the moment you finish speaking. If the router decides your
// utterance was dictation, the task is trivial (clean + insert). If it was an
// agent request, the task is handed to a remote worker that streams its progress
// back as `steps` until it reaches a terminal status — or stops at a Proposal
// (proposal.ts) and waits for your OK before doing anything irreversible.

import type { Proposal } from './proposal.js';
import type { TypingTarget } from './layout.js';
import type { ConnectionId } from './connections.js';
import type { AgentId } from './agents.js';
import type { Answer, FollowUp, Placement } from './answer.js';

export type TaskKind = 'dictation' | 'command' | 'agent';

export type TaskStatus =
  | 'queued' // created, waiting for a worker to claim it
  | 'claimed' // a worker has taken ownership
  | 'running' // worker is actively executing steps
  | 'needs_input' // worker is blocked on a question for the user
  | 'awaiting_approval' // a draft is ready; nothing irreversible happens until you OK it
  | 'done' // finished successfully
  | 'failed' // finished with an error
  | 'canceled'; // user canceled before completion

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'canceled'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A single observable thing the worker did, streamed to the UI in real time. */
export interface TaskStep {
  id: string;
  ts: number;
  /** think = reasoning, act = took an action, observe = read result, tool = called a tool, note = status */
  type: 'think' | 'act' | 'observe' | 'tool' | 'note' | 'result';
  text: string;
  /** optional structured payload, e.g. a tool call's arguments or a screenshot ref */
  data?: Record<string, unknown>;
}

/** What was on screen / in focus when you spoke. Lets a task act "on this thing". */
export interface ScreenContext {
  appName?: string;
  windowTitle?: string;
  url?: string;
  /** currently selected/focused text, if any */
  selectionText?: string;
  /** opaque reference to a captured screenshot (path/id), never the bytes inline */
  screenshotRef?: string;
  capturedAt?: number;
  /** IANA zone of the person speaking ("Asia/Taipei"), so "tomorrow at 3" means their 3 o'clock */
  timeZone?: string;
  /** where the words will be typed — app, page host, focused field (never its contents) */
  target?: TypingTarget;
  /** the speech engine already punctuated + cased the transcript (Whisper, Apple Speech) */
  punctuated?: boolean;
}

export interface TaskResult {
  summary: string;
  /** optional artifacts: links, file paths, generated text */
  artifacts?: { label: string; value: string }[];
  /**
   * Something you have to set up before this can work — Claude, Gmail… Shown as one button
   * ("Set up Claude") that takes you straight there; once it's connected, the request runs again.
   */
  setup?: { connection: ConnectionId; label: string };
  /** The answer, shaped for the notch (answer.ts). When it's here, `summary` is its plain text. */
  answer?: Answer;
  /** where the notch shows the answer — placeFor(answer) */
  place?: Placement;
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  /** the raw thing the user said */
  utterance: string;
  status: TaskStatus;
  priority: number; // higher runs first
  createdAt: number;
  updatedAt: number;
  context: ScreenContext;
  steps: TaskStep[];
  result?: TaskResult;
  error?: string;
  /** set while a draft waits for you — and kept afterwards as the record of what you approved */
  proposal?: Proposal;
  /** set while the agent waits for you to sign in on the box browser (needs_input) */
  takeover?: Takeover;
  /** agent jobs: which of Relay's agents took it — the character the notch shows (agents.ts) */
  agent?: AgentId;
  /** set when this carries on from an earlier answer — what was asked then, and what it said */
  followUp?: FollowUp;
}

/** A moment where only you should act in the box browser — a sign-in, a 2FA code. */
export interface Takeover {
  /** the takeover session on the box — used to fetch the viewer and to tell the box you're done */
  id: string;
  reason: string;
  /** account/site, for the notch icon */
  service: string;
  url?: string;
  // Not the viewer URL: its token rotates when the box restarts, so the Mac fetches a fresh
  // one from GET /api/box when it opens the window (box owner's note).
}

let counter = 0;
/** Small, dependency-free unique id. Good enough for a single-node demo. */
export function makeId(prefix = 'task'): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export interface NewTaskInput {
  kind: TaskKind;
  title: string;
  utterance: string;
  context?: ScreenContext;
  priority?: number;
  agent?: AgentId;
  followUp?: FollowUp;
}

export function createTask(input: NewTaskInput): Task {
  const now = Date.now();
  return {
    id: makeId(),
    kind: input.kind,
    title: input.title,
    utterance: input.utterance,
    status: 'queued',
    priority: input.priority ?? (input.kind === 'agent' ? 5 : 1),
    createdAt: now,
    updatedAt: now,
    context: input.context ?? {},
    steps: [],
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.followUp ? { followUp: input.followUp } : {}),
  };
}

export function makeStep(type: TaskStep['type'], text: string, data?: Record<string, unknown>): TaskStep {
  return { id: makeId('step'), ts: Date.now(), type, text, data };
}

/**
 * Pure state transition: returns a new Task with a step appended and status/result
 * updated. Keeping this pure makes the store trivial and the behavior testable.
 */
export function applyStep(
  task: Task,
  step: TaskStep,
  patch?: Partial<Pick<Task, 'status' | 'result' | 'error' | 'proposal' | 'priority' | 'takeover'>>,
): Task {
  return {
    ...task,
    steps: [...task.steps, step],
    status: patch?.status ?? task.status,
    result: patch?.result ?? task.result,
    error: patch?.error ?? task.error,
    proposal: patch?.proposal ?? task.proposal,
    takeover: patch?.takeover ?? task.takeover,
    priority: patch?.priority ?? task.priority,
    updatedAt: step.ts,
  };
}
