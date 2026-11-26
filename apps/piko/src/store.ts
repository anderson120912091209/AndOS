// Piko's on-disk state for development. Everything a task needs survives a crash of any process:
//
//   .data/piko/tasks/<taskId>/log.jsonl     the conversation with Claude, append-only (never edited)
//   .data/piko/tasks/<taskId>/results.json  tool results waiting to be sent with the next turn
//   .data/piko/tasks/<taskId>/sent.json     which deliveries already reached LINE (so retries don't repeat)
//   .data/piko/users/<userId>.json          the user's open task and their last few exchanges
//   .data/piko/memory/<userId>/             the files behind Claude's memory tool
//   .data/piko/takeover/<grant id>.json      one screen takeover: hashes of its ticket and session, never the secrets
//   .data/piko/audit.jsonl                   security events (takeovers opened, refused, closed), no secrets
//
// The log stays out of Temporal's history on purpose: model responses (thinking, search results) are large,
// and Temporal only needs the small decisions. Swap this module for Postgres before real users.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import type { Grant, ToolResult } from './types.js';

export interface LogEntry {
  turn: number;
  role: 'user' | 'assistant';
  content: Anthropic.Beta.BetaContentBlockParam[];
  stop?: string | null;
}

export interface Exchange {
  question: string;
  answer: string;
}

interface UserRecord {
  activeTask?: string;
  recent: Exchange[];
}

function dir(...parts: string[]): string {
  const path = join(config.dataDir, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

/** Ids come from LINE and from us; keep them to safe file-name characters anyway. */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function readLog(taskId: string): LogEntry[] {
  const path = join(dir('tasks', safe(taskId)), 'log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

export function appendLog(taskId: string, entry: LogEntry): void {
  appendFileSync(join(dir('tasks', safe(taskId)), 'log.jsonl'), `${JSON.stringify(entry)}\n`);
}

export function saveResult(taskId: string, toolUseId: string, result: ToolResult): void {
  const path = join(dir('tasks', safe(taskId)), 'results.json');
  const results = readJson<Record<string, ToolResult>>(path, {});
  results[toolUseId] = result;
  writeFileSync(path, JSON.stringify(results));
}

export function loadResults(taskId: string): Record<string, ToolResult> {
  return readJson(join(dir('tasks', safe(taskId)), 'results.json'), {});
}

/** How delivery number `seq` of a task went, if it already reached LINE. */
export function sentRecord(taskId: string, seq: number): { usedReply: boolean } | undefined {
  return readJson<Record<string, { usedReply: boolean }>>(join(dir('tasks', safe(taskId)), 'sent.json'), {})[seq];
}

export function markSent(taskId: string, seq: number, usedReply: boolean): void {
  const path = join(dir('tasks', safe(taskId)), 'sent.json');
  const sent = readJson<Record<string, { usedReply: boolean }>>(path, {});
  sent[seq] = { usedReply };
  writeFileSync(path, JSON.stringify(sent));
}

function userPath(userId: string): string {
  return join(dir('users'), `${safe(userId)}.json`);
}

export function readUser(userId: string): UserRecord {
  return readJson<UserRecord>(userPath(userId), { recent: [] });
}

export function updateUser(userId: string, change: (user: UserRecord) => void): void {
  const user = readUser(userId);
  change(user);
  writeFileSync(userPath(userId), JSON.stringify(user, null, 2));
}

export function memoryDir(userId: string): string {
  return dir('memory', safe(userId));
}

export function recordFeedback(taskId: string, value: string): void {
  appendFileSync(join(dir('feedback'), 'feedback.jsonl'), `${JSON.stringify({ taskId, value, at: Date.now() })}\n`);
}

function grantPath(id: string): string {
  return join(dir('takeover'), `${safe(id)}.json`);
}

export function readGrant(id: string): Grant | undefined {
  return readJson<Grant | undefined>(grantPath(id), undefined);
}

export function writeGrant(grant: Grant): void {
  writeFileSync(grantPath(grant.id), JSON.stringify(grant), { mode: 0o600 });
}

export function grantsFor(taskId: string): Grant[] {
  return readdirSync(dir('takeover'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson<Grant | undefined>(join(dir('takeover'), name), undefined))
    .filter((g): g is Grant => g?.taskId === taskId);
}

/** One line per security event. Callers pass ids and outcomes only: never tickets, cookies or tokens. */
export function audit(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  appendFileSync(join(dir(), 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
}
