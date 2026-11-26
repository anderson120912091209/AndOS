// Types shared by the workflow (deterministic code) and the activities (everything that touches the world).
// The workflow imports this file for types only, so nothing here may have runtime behavior.

export type TaskState = 'WORKING' | 'NEEDS_INPUT' | 'DONE';

/** A LINE reply token: free to use, once, within about a minute of `receivedAt`. */
export interface ReplyToken {
  token: string;
  receivedAt: number;
}

export interface TaskInput {
  taskId: string;
  userId: string;
  text: string;
  reply?: ReplyToken;
}

export interface UserMessage {
  text: string;
  reply?: ReplyToken;
}

export interface Connected {
  service: 'google';
  email?: string;
}

export interface Decision {
  requestId: string;
  approved: boolean;
  reply?: ReplyToken;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set for members of an Anthropic toolset (`computer`); its results must echo it back. */
  toolset?: string;
}

export type ResultPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } };

export interface ToolResult {
  content: string | ResultPart[];
  isError?: boolean;
  toolset?: string;
}

/** What one model turn decided. Kept small on purpose: the full response stays in the task's log on disk. */
export type Step =
  | { kind: 'final'; text: string }
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'paused' }
  | { kind: 'refused'; text: string };

export interface PlanItem {
  title: string;
  status: 'todo' | 'doing' | 'done';
}

export interface TaskView {
  state: TaskState;
  plan: PlanItem[];
  waitingFor?: string;
  /** When the task started waiting for the user (ms). The gateway closes waits that went stale. */
  waitingSince?: number;
}

/**
 * What the harness wants to tell the user, independent of the channel. The deliver activity renders it for
 * LINE (text, quick replies, a Flex card); another channel could render the same thing differently.
 */
export type Outgoing =
  | { kind: 'text'; text: string }
  | { kind: 'still_working' }
  | { kind: 'question'; question: string; options: string[] }
  | { kind: 'approval'; taskId: string; requestId: string; title: string; detail: string }
  | { kind: 'calendar'; event: CalendarEvent }
  | { kind: 'places'; places: Place[] }
  | { kind: 'card'; card: Card }
  | { kind: 'connect'; service: 'google'; userId: string; taskId: string; reason: string }
  | { kind: 'image'; url: string; previewUrl: string; caption?: string }
  | { kind: 'file'; url: string; name: string; caption?: string }
  | { kind: 'reminder'; text: string }
  | { kind: 'takeover'; taskId: string; userId: string; requestId: string; reason: string; link?: string }
  | { kind: 'final'; taskId: string; text: string };

/**
 * One screen takeover (src/takeover.ts). Only hashes of the ticket and the session are kept, so the file alone
 * opens nothing.
 */
export interface Grant {
  /** grantId(taskId, requestId): names the record and prefixes its ticket and session. */
  id: string;
  requestId: string;
  taskId: string;
  userId: string;
  reason: string;
  ticketHash: string;
  ticketExpiresAt: number;
  openedAt?: number;
  sessionHash?: string;
  sessionExpiresAt?: number;
  closedAt?: number;
}

/** Times are Taiwan local time written as `2026-10-26T16:00` (Taiwan has no daylight saving). */
export interface CalendarEvent {
  title: string;
  start: string;
  end?: string;
  location?: string;
  notes?: string;
}

export interface ReminderInput {
  userId: string;
  text: string;
  /** Taiwan local time, `2026-10-26T15:30`. */
  at: string;
}

/** A place Piko recommends: shown as a card with 「導航」 and 「打電話」 buttons. */
export interface Place {
  name: string;
  address?: string;
  phone?: string;
  note?: string;
  url?: string;
}

export interface CardButton {
  label: string;
  /** link: open a web page · call: dial a number · map: open Google Maps · reply: send this text as the user. */
  kind: 'link' | 'call' | 'map' | 'reply';
  value: string;
}

/** A general card: a title, a few lines, and up to four buttons. */
export interface Card {
  title: string;
  lines?: { label?: string; text: string }[];
  buttons?: CardButton[];
  image_url?: string;
}
