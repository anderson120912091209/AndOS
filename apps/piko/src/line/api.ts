// The few LINE Messaging API calls the harness makes.
import { createHash } from 'node:crypto';
import { config } from '../config.js';

export type LineMessage = Record<string, unknown>;

async function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${config.line.api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.line.token}`, ...headers },
    body: JSON.stringify(body),
  });
}

/** Free, but a token works once and only for about a minute. Returns false when LINE refuses it. */
export async function reply(token: string, messages: LineMessage[]): Promise<boolean> {
  const res = await call('/v2/bot/message/reply', { replyToken: token, messages });
  if (!res.ok) console.warn(`[line] reply refused (${res.status}): ${await res.text()}`);
  return res.ok;
}

/** Billed per recipient. Retries reuse one X-Line-Retry-Key, so LINE delivers at most once. */
export async function push(to: string, messages: LineMessage[], retryKey: string): Promise<void> {
  const res = await call('/v2/bot/message/push', { to, messages }, { 'x-line-retry-key': retryKey });
  if (res.ok || res.status === 409) return; // 409: LINE already accepted a push with this retry key
  throw new Error(`LINE push failed (${res.status}): ${await res.text()}`);
}

/** The "typing…" dots in a 1:1 chat. They vanish when the bot's next message arrives. */
export async function startLoading(chatId: string, seconds = 60): Promise<void> {
  await call('/v2/bot/chat/loading/start', { chatId, loadingSeconds: seconds }).catch(() => undefined);
}

/** A stable UUID per (task, delivery), so every retry of the same push carries the same retry key. */
export function retryKey(taskId: string, seq: number): string {
  const h = createHash('sha256').update(`${taskId}#${seq}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
