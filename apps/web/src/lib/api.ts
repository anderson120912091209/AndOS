import type { RoutedIntent, ScreenContext, Task, Verdict } from '@relay/shared';

// Same-origin in production; Vite proxies /api to the server in dev.
const base = '';

export interface SubmitResponse {
  intent: RoutedIntent;
  task: Task;
}

export async function submitUtterance(utterance: string, context: ScreenContext = {}): Promise<SubmitResponse> {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ utterance, context }),
  });
  if (!res.ok) throw new Error(`submit failed: ${res.status}`);
  return (await res.json()) as SubmitResponse;
}

export async function cancelTask(id: string): Promise<void> {
  await fetch(`${base}/api/tasks/${id}/cancel`, { method: 'POST' });
}

/** Answer a proposal. Naming the proposal id means a stale card can't approve a newer draft. */
export async function decide(id: string, proposalId: string, verdict: Verdict, feedback?: string): Promise<void> {
  const res = await fetch(`${base}/api/tasks/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposalId, verdict, feedback }),
  });
  if (!res.ok) throw new Error(`decision failed: ${res.status}`);
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${base}/api/tasks`);
  const data = (await res.json()) as { tasks: Task[] };
  return data.tasks;
}
