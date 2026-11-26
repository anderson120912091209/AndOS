// A short conversation with the box's browser over the Chrome DevTools Protocol, using Node 22's
// WebSocket — no dependency. Browser-level only (cookies, tabs); the agent's own page work goes
// through the worker (apps/worker/src/browser.ts).

export type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Open the browser's DevTools socket, run `use`, close it. Every step gives up after `timeoutMs`. */
export async function withBrowser<T>(
  base: string,
  use: (send: Send) => Promise<T>,
  http: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<T> {
  const version = (await (await http(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).json()) as {
    webSocketDebuggerUrl?: string;
  };
  if (!version.webSocketDebuggerUrl) throw new Error('the box’s browser isn’t answering');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let next = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    const w = m.id === undefined ? undefined : waiting.get(m.id);
    if (!w) return; // an event, not an answer
    waiting.delete(m.id!);
    clearTimeout(w.timer);
    if (m.error) w.reject(new Error(m.error.message));
    else w.resolve(m.result ?? {});
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the box’s browser didn’t answer')), timeoutMs);
      ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true });
      ws.addEventListener('error', () => (clearTimeout(timer), reject(new Error('couldn’t reach the box’s browser'))), { once: true });
    });
    const send: Send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => (waiting.delete(id), reject(new Error(`${method} timed out`))), timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    return await use(send);
  } finally {
    for (const w of waiting.values()) clearTimeout(w.timer);
    ws.close();
  }
}
