// The router: given what you said (and what was on screen), decide what Relay does.
//
// Three outcomes:
//   dictation — you're writing. Clean it and insert it. (default)
//   command   — a fast, local, single-shot action ("bold that", "undo").
//   agent     — a multi-step job worth dispatching to a background worker
//               ("research X and draft an email", "find a flight and book it").
//
// This is rule-based on purpose: it's instant, deterministic, and unit-testable,
// which matters when it runs on every utterance. `routeIntent` is the seam — swap
// in an LLM classifier later without touching callers. See RouteOptions.classify.

import { cleanTranscript } from './dictation.js';
import { detectSurface, layoutText, type Surface } from './layout.js';
import { pointerChip, resolvePointer, type Pointer } from './pointer.js';
import { agentFor, type AgentId } from './agents.js';
import type { ScreenContext, TaskKind } from './task.js';

export interface RoutedAction {
  verb: string;
  /** what the verb operates on, if we could extract it */
  target?: string;
  /** the screen thing it should act on ("this", "selection", a url) */
  on?: string;
}

export interface RoutedIntent {
  kind: TaskKind;
  /** short, Title-Cased label for the task list */
  title: string;
  /** the utterance cleaned for display/insertion */
  cleanedText: string;
  /** 0..1 — how sure the router is; dictation is the safe fallback */
  confidence: number;
  action?: RoutedAction;
  /** human-readable why, surfaced in the HUD so routing never feels like a black box */
  reason: string;
  /** agent requests: what "this" was when you spoke, so the notch can say what it understood */
  pointer?: Pointer;
  /** the same, in a few words for the notch: “Q3 numbers”, #design */
  pointerChip?: string;
  /** agent jobs: who takes it — the character in the notch (agents.ts) */
  agent?: AgentId;
}

// Wake words the HUD may leave on the front of an utterance.
const WAKE = /^(?:hey\s+)?relay[,.! ]+/i;

// Verbs that imply a background, multi-step job. Order doesn't matter; we match whole words.
const AGENT_VERBS = [
  'research', 'find', 'search', 'look up', 'gather', 'compile', 'summarize', 'summarise',
  'draft', 'write up', 'analyze', 'analyse', 'compare', 'monitor', 'watch', 'track',
  'book', 'order', 'buy', 'reserve', 'schedule', 'plan', 'organize', 'organise',
  'email', 'message', 'reply to', 'respond to', 'follow up', 'reach out',
  'fill out', 'apply', 'sign up', 'download', 'scrape', 'extract', 'collect',
  'refactor', 'deploy', 'build', 'fix', 'investigate', 'debug', 'generate', 'create',
];

// Verbs that imply a quick, local, single action on the current app/selection.
const COMMAND_PHRASES = [
  'undo', 'redo', 'delete that', 'scratch that', 'select all', 'copy that', 'paste',
  'bold that', 'italicize', 'italicise', 'capitalize', 'uppercase', 'lowercase',
  'insert date', 'insert time', 'new line', 'new paragraph', 'send it', 'send this',
];

// Signals that a verb is really a *background* job rather than a one-liner:
// references to external places, research breadth, or explicit "and then" chaining.
const AGENT_BREADTH = [
  'and then', 'then ', ' and ', 'all the', 'every ', 'across ', 'compile', 'list of',
  'then send', 'and send', 'and email', 'and draft', 'options', 'cheapest', 'best',
  'online', 'website', 'web', 'the internet', 'my calendar', 'my inbox', 'repo', 'codebase',
];

function matchesWholeWord(haystack: string, needle: string): boolean {
  // needle may contain spaces; build a word-boundary-ish match.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i').test(haystack);
}

function titleCase(s: string, max = 64): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  const sliced = trimmed.length > max ? trimmed.slice(0, max - 1).trimEnd() + '…' : trimmed;
  return sliced.replace(/\b([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Pull the leading verb and a rough target out of a command/agent utterance. */
function extractAction(text: string, verb: string, ctx: ScreenContext): RoutedAction {
  const idx = text.toLowerCase().indexOf(verb.toLowerCase());
  const rest = idx >= 0 ? text.slice(idx + verb.length).trim() : text.trim();
  const target = rest.replace(/^(the|a|an|this|that|my)\s+/i, '').trim() || undefined;
  // Resolve a deictic reference ("this", "that", "the selection") to screen context.
  let on: string | undefined;
  if (/\b(this|that|the selection|here|it)\b/i.test(text)) {
    on = ctx.selectionText ? 'selection' : ctx.url ?? ctx.appName ?? 'screen';
  } else if (ctx.url) {
    on = ctx.url;
  }
  return { verb: verb.toLowerCase(), target, on };
}

export interface RouteOptions {
  /** Optional async classifier seam (LLM). When provided and it returns a kind,
   *  it overrides the heuristic. Kept out of the hot path by default. */
  classify?: (text: string, ctx: ScreenContext) => TaskKind | undefined;
}

/**
 * Core router. Synchronous and pure given its inputs (the optional classify hook
 * is the only impurity, and it's opt-in). Dictation is the safe default: if we
 * aren't reasonably sure you issued a command, we write down what you said.
 */
export function routeIntent(utterance: string, ctx: ScreenContext = {}, opts: RouteOptions = {}): RoutedIntent {
  const raw = (utterance ?? '').replace(WAKE, '').trim();
  const lower = raw.toLowerCase();

  if (!raw) {
    return { kind: 'dictation', title: 'Empty', cleanedText: '', confidence: 1, reason: 'Nothing was said.' };
  }

  // Optional LLM override (seam). If it decides, trust it but still build the shape.
  const override = opts.classify?.(raw, ctx);

  // 1) Fast local commands — short and imperative.
  const commandHit = COMMAND_PHRASES.find((p) => matchesWholeWord(lower, p));
  if (override === 'command' || (!override && commandHit && raw.split(/\s+/).length <= 6)) {
    const verb = commandHit ?? lower.split(/\s+/)[0] ?? 'do';
    return {
      kind: 'command',
      title: titleCase(raw, 40),
      cleanedText: raw,
      confidence: 0.9,
      action: extractAction(raw, verb, ctx),
      reason: `Recognized "${verb}" as an immediate local command.`,
    };
  }

  // 2) Agent jobs — an action verb, especially with breadth or an external target.
  const agentVerb = AGENT_VERBS.find((v) => matchesWholeWord(lower, v));
  const hasBreadth = AGENT_BREADTH.some((b) => lower.includes(b.trim()));
  const longEnough = raw.split(/\s+/).length >= 3;
  const startsWithVerb = agentVerb ? lower.startsWith(agentVerb.toLowerCase()) : false;

  if (override === 'agent' || (!override && agentVerb && longEnough && (startsWithVerb || hasBreadth))) {
    const action = extractAction(raw, agentVerb ?? 'do', ctx);
    const confidence = Math.min(0.95, 0.6 + (startsWithVerb ? 0.2 : 0) + (hasBreadth ? 0.15 : 0));
    const pointer = resolvePointer(ctx);
    const why = agentVerb
      ? `"${agentVerb}" plus ${hasBreadth ? 'multi-step scope' : 'an imperative opener'}`
      : 'You asked the AI';
    return {
      kind: 'agent',
      title: titleCase(raw),
      cleanedText: raw,
      confidence,
      action,
      reason: `${why} — dispatching to a worker${pointer ? ` about ${pointerChip(pointer)}` : action.on ? ` on ${action.on}` : ''}.`,
      pointer,
      pointerChip: pointer ? pointerChip(pointer) : undefined,
      agent: agentFor(raw, pointer),
    };
  }

  // 3) Default: dictation. Clean it, lay it out for where you're typing, hand it back.
  const cleaned = cleanTranscript(raw, { punctuated: ctx.punctuated });
  const surface = detectSurface(ctx.target);
  const routing = agentVerb
    ? `Saw "${agentVerb}" but no multi-step scope — treating as dictation. Say "Relay, ${agentVerb} …" to dispatch.`
    : 'No command verb — writing down what you said.';
  return {
    kind: 'dictation',
    title: titleCase(cleaned || raw, 40),
    cleanedText: layoutText(cleaned, surface),
    confidence: override ? 0.9 : agentVerb ? 0.55 : 0.8,
    reason: surface === 'general' ? routing : `${routing} Laid out for ${SURFACE_NAMES[surface]}.`,
  };
}

const SURFACE_NAMES: Record<Surface, string> = {
  email: 'an email',
  chat: 'a chat',
  document: 'a document',
  field: 'a one-line field',
  general: 'general text',
};
