// Relay server: the single source of truth and the hub between the HUD (producers
// of utterances) and the workers (consumers that execute agent tasks).
//
//   POST /api/tasks            HUD  -> route an utterance, enqueue a task
//   GET  /api/tasks            UI   -> snapshot of the queue
//   GET  /api/tasks/:id        UI   -> one task with its step timeline
//   POST /api/tasks/:id/cancel UI   -> cancel
//   POST /api/tasks/:id/decision UI -> approve / revise / reject a proposal
//   GET  /ws                   UI   -> live stream of task events
//   POST /api/worker/claim     wkr  -> claim the next queued task
//   POST /api/worker/:id/step  wkr  -> append a streamed step
//   POST /api/worker/:id/propose wkr -> park the task on a draft for your OK
//   POST /api/worker/:id/done  wkr  -> finish with a result (or /fail, /canceled)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import { createTask, followUpFrom, routeIntent, makeStep } from '@relay/shared';
import type { Proposal, ScreenContext, Takeover, TaskResult, Verdict } from '@relay/shared';
import { TaskStore, type DecideError, type TaskEvent } from './store.js';
import { registerConnections } from './connections/routes.js';
import { registerBox, BoxError } from './box/routes.js';
import { checkRequest, fenceFromEnv } from './fence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const store = new TaskStore(process.env.RELAY_PERSIST ?? join(__dirname, '../../../.data/tasks.json'));

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// Only your own Mac and Relay's own pages may use this server (fence.ts) — it can approve
// sends and read your drafts. Runs before every route, the WebSocket included.
const fence = fenceFromEnv(PORT);
app.addHook('onRequest', async (req, reply) => {
  const verdict = checkRequest(
    {
      path: req.url,
      remoteAddress: req.socket.remoteAddress,
      host: req.headers.host,
      origin: req.headers.origin,
      authorization: req.headers.authorization,
    },
    fence,
  );
  if (!verdict.ok) {
    req.log.warn({ reason: verdict.reason, url: req.url }, 'refused');
    return reply.code(403).send({ error: 'forbidden' });
  }
});
await app.register(cors, { origin: [...fence.origins] });
await app.register(websocket);
// Relay's computer: a browser in a container the agent drives; you take over to sign in (box/).
// `box.takeovers.onFinished` fires when you hand it back, so the waiting task can carry on.
export const box = await registerBox(app);
// Your accounts: sites signed in on Relay's computer, plus developer connectors whose tokens
// stay in your Keychain (connections/routes.ts).
await registerConnections(app, { port: PORT, box });

// You handed the box back: 'done' → the task re-queues and the agent carries on with the now
// signed-in session; 'cancelled' → the task stops and says so.
box.takeovers.onFinished((t) => {
  if (!t.taskId) return;
  if (t.state === 'done') store.resumeFromTakeover(t.taskId);
  else store.setStatus(t.taskId, 'canceled', 'You handed the box back without finishing — nothing was done.');
});

app.get('/api/health', async () => ({ ok: true, tasks: store.list().length }));

// --- HUD / UI surface -------------------------------------------------------

interface CreateBody {
  utterance: string;
  context?: ScreenContext;
  /** pin the routing decision — the Mac app's Fn (dictation) / Fn+Ctrl (agent) modes */
  forceKind?: 'dictation' | 'command' | 'agent';
  /** carry on from an earlier answer (a follow-up button, a tapped option) — that task's id */
  followUpOf?: string;
}

app.post<{ Body: CreateBody }>('/api/tasks', async (req, reply) => {
  const { utterance, context = {}, forceKind, followUpOf } = req.body ?? ({} as CreateBody);
  if (!utterance?.trim()) return reply.code(400).send({ error: 'utterance is required' });
  const parent = followUpOf ? store.get(followUpOf) : undefined;
  if (followUpOf && !parent) return reply.code(404).send({ error: 'no such task to follow up on' });

  // forceKind overrides the heuristic via the router's classify seam. A follow-up is always the
  // agent's: it carries on from what the agent said.
  const kind = parent ? 'agent' : forceKind;
  const intent = routeIntent(utterance, context, kind ? { classify: () => kind } : undefined);

  // Dictation and local commands resolve immediately — there's nothing to dispatch.
  if (intent.kind === 'dictation' || intent.kind === 'command') {
    const task = store.add(createTask({ kind: intent.kind, title: intent.title, utterance, context }));
    const result: TaskResult = {
      summary:
        intent.kind === 'dictation'
          ? intent.cleanedText
          : `Ran local command: ${intent.action?.verb ?? intent.title}`,
      artifacts: intent.kind === 'dictation' ? [{ label: 'insert', value: intent.cleanedText }] : undefined,
    };
    store.appendStep(task.id, makeStep('think', intent.reason));
    store.complete(task.id, result);
    return reply.send({ intent, task: store.get(task.id) });
  }

  // Agent jobs get queued for a worker.
  // A follow-up stays with the agent that answered, so the same character carries the conversation.
  const task = store.add(
    createTask({
      kind: 'agent',
      title: intent.title,
      utterance,
      context,
      priority: 5,
      agent: parent?.agent ?? intent.agent,
      ...(parent ? { followUp: followUpFrom(parent) } : {}),
    }),
  );
  store.appendStep(task.id, makeStep('think', intent.reason, { action: intent.action, confidence: intent.confidence }));
  return reply.send({ intent, task: store.get(task.id) });
});

app.get('/api/tasks', async () => ({ tasks: store.list() }));

app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
  const task = store.get(req.params.id);
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
  const task = store.setStatus(req.params.id, 'canceled', 'Canceled by user.');
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

interface DecisionBody {
  /** the proposal you were looking at — a stale card gets a 409, not a send */
  proposalId: string;
  verdict: Verdict;
  feedback?: string;
}

const DECIDE_STATUS: Record<DecideError, number> = { not_found: 404, not_waiting: 409, stale: 409 };

app.post<{ Params: { id: string }; Body: DecisionBody }>('/api/tasks/:id/decision', async (req, reply) => {
  const { proposalId, verdict, feedback } = req.body ?? ({} as DecisionBody);
  if (!proposalId || !['approve', 'reject', 'revise'].includes(verdict)) {
    return reply.code(400).send({ error: 'proposalId and verdict (approve | reject | revise) are required' });
  }
  if (verdict === 'revise' && !feedback?.trim()) {
    return reply.code(400).send({ error: 'revise needs feedback — what should change?' });
  }
  const out = store.decide(req.params.id, proposalId, verdict, feedback?.trim());
  return 'error' in out ? reply.code(DECIDE_STATUS[out.error]).send({ error: out.error }) : out;
});

// --- Worker surface ---------------------------------------------------------

app.post('/api/worker/claim', async () => {
  const task = store.claimNext();
  return { task: task ?? null };
});

interface StepBody {
  type: 'think' | 'act' | 'observe' | 'tool' | 'note';
  text: string;
  data?: Record<string, unknown>;
  status?: 'running' | 'needs_input';
}

app.post<{ Params: { id: string }; Body: StepBody }>('/api/worker/:id/step', async (req, reply) => {
  const { type, text, data, status } = req.body;
  const task = store.appendStep(req.params.id, makeStep(type, text, data), status ? { status } : undefined);
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

app.post<{ Params: { id: string }; Body: Proposal }>('/api/worker/:id/propose', async (req, reply) => {
  const proposal = req.body;
  if (!proposal?.id || !proposal.preview || !proposal.commit) {
    return reply.code(400).send({ error: 'a proposal needs id, preview and commit' });
  }
  const task = store.propose(req.params.id, { ...proposal, decision: undefined, committedAt: undefined });
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

interface TakeoverBody {
  reason: string;
  service: string;
  url?: string;
  targetId?: string;
}

app.post<{ Params: { id: string }; Body: TakeoverBody }>('/api/worker/:id/takeover', async (req, reply) => {
  const { reason, service, url, targetId } = req.body ?? ({} as TakeoverBody);
  if (!reason) return reply.code(400).send({ error: 'reason is required' });
  try {
    const t = await box.takeover({ reason, url, service, targetId, taskId: req.params.id });
    const takeover: Takeover = { id: t.id, reason: t.reason, service, ...(t.url ? { url: t.url } : {}) };
    const task = store.awaitTakeover(req.params.id, takeover);
    return task ? { task, viewerUrl: t.viewerUrl } : reply.code(404).send({ error: 'not found' });
  } catch (err) {
    return reply.code(err instanceof BoxError ? err.status : 409).send({ error: (err as Error).message });
  }
});

app.post<{ Params: { id: string }; Body: TaskResult }>('/api/worker/:id/done', async (req, reply) => {
  const task = store.complete(req.params.id, req.body);
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

/** A job that ends by design without a result — e.g. your draft was discarded. */
app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/worker/:id/canceled', async (req, reply) => {
  const task = store.setStatus(req.params.id, 'canceled', req.body?.note ?? 'Canceled.');
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

app.post<{ Params: { id: string }; Body: { error: string } }>('/api/worker/:id/fail', async (req, reply) => {
  const task = store.fail(req.params.id, req.body?.error ?? 'unknown error');
  return task ? { task } : reply.code(404).send({ error: 'not found' });
});

// --- Live event stream ------------------------------------------------------

app.get('/ws', { websocket: true }, (socket) => {
  // Replay current state so a late-joining UI is immediately consistent.
  socket.send(JSON.stringify({ type: 'snapshot', tasks: store.list() }));
  const onEvent = (evt: TaskEvent) => {
    try {
      socket.send(JSON.stringify(evt));
    } catch {
      /* socket closing */
    }
  };
  store.events.on('event', onEvent);
  socket.on('close', () => store.events.off('event', onEvent));
});

// --- Static web (production build), optional in dev -------------------------

const webDist = join(__dirname, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fstatic, { root: webDist });
  app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
}

// Loopback only by default. RELAY_LISTEN=0.0.0.0 opens it to the network for workers on other
// machines — which the fence still turns away unless they send RELAY_TOKEN.
const LISTEN = process.env.RELAY_LISTEN ?? 'localhost';
if (LISTEN !== 'localhost' && LISTEN !== '127.0.0.1' && !fence.token) {
  app.log.warn(`RELAY_LISTEN=${LISTEN} without RELAY_TOKEN: other machines can connect but will be refused`);
}

app
  .listen({ port: PORT, host: LISTEN })
  .then(() => app.log.info(`Relay server on http://localhost:${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
