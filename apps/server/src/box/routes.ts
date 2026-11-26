// The box API — Relay's computer, and handing it to you when a site needs a person.
//
//   GET  /api/box                      is it up, where to watch it, where a worker finds CDP
//   POST /api/box/start                start it (it also starts itself when asked to take over)
//   POST /api/box/takeover             {reason, url?, service?, taskId?, targetId?} → {id, viewerUrl}
//   GET  /api/box/takeover/:id         one takeover
//   POST /api/box/takeover/:id/done    you're finished — the task waiting on it carries on
//   POST /api/box/takeover/:id/cancel  you'd rather not — the task is told so
//
// The whole server is fenced to this Mac (../fence.ts); the viewer URL carries the box's
// token, so only callers inside that fence ever see it. A worker asks for a takeover through
// its own route, which calls `takeover()` from what registerBox returns.

import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { makeId } from '@relay/shared';
import { BOX, type BoxDriver, LocalDockerBox } from './driver.js';
import { BoxSites } from './sites.js';

export interface Takeover {
  id: string;
  /** what the person is asked to do, shown as the Box window's title ("Sign in to Gmail") */
  reason: string;
  url?: string;
  /** the site or app, for the window's badge ("Gmail") */
  service?: string;
  taskId?: string;
  targetId?: string;
  state: 'open' | 'done' | 'cancelled';
  createdAt: number;
  finishedAt?: number;
}

export interface TakeoverRequest {
  reason?: string;
  url?: string;
  service?: string;
  taskId?: string;
  targetId?: string;
}

/** Why a takeover can't start: 400 when the request is wrong, 409 when the box can't right now. */
export class BoxError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

/** Open takeovers, and a 'finished' event when you hand the box back (or decline). */
export class Takeovers extends EventEmitter {
  private all = new Map<string, Takeover>();

  open(p: Omit<Takeover, 'id' | 'state' | 'createdAt' | 'finishedAt'>): Takeover {
    const t: Takeover = { id: makeId('takeover'), ...p, state: 'open', createdAt: Date.now() };
    this.all.set(t.id, t);
    return t;
  }

  get(id: string): Takeover | undefined {
    return this.all.get(id);
  }

  /** Is anyone using the box right now? The agent stays stopped until nobody is. */
  anyOpen(): boolean {
    for (const t of this.all.values()) if (t.state === 'open') return true;
    return false;
  }

  finish(id: string, state: 'done' | 'cancelled'): Takeover | undefined {
    const t = this.all.get(id);
    if (!t) return undefined;
    if (t.state !== 'open') return t; // already finished — finishing twice changes nothing
    const done = { ...t, state, finishedAt: Date.now() };
    this.all.set(id, done);
    this.emit('finished', done);
    return done;
  }

  onFinished(listener: (t: Takeover) => void): void {
    this.on('finished', listener);
  }
}

export interface BoxOptions {
  driver?: BoxDriver;
  takeovers?: Takeovers;
  sites?: BoxSites;
}

export type Box = Awaited<ReturnType<typeof registerBox>>;

/** The reason and service come from the agent; they're titles, so keep them title-sized. */
const clamp = (s: string | undefined, max: number): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export async function registerBox(app: FastifyInstance, opts: BoxOptions = {}) {
  const driver = opts.driver ?? new LocalDockerBox();
  const takeovers = opts.takeovers ?? new Takeovers();
  const sites = opts.sites ?? new BoxSites();

  const describe = async () => {
    const status = await driver.status();
    if (status.state !== 'ready') return status;
    return {
      ...status,
      // Watching, unless a takeover has the box — then the agent is gone and you may type.
      viewerUrl: await driver.viewerUrl({ control: takeovers.anyOpen() }),
      // where a worker finds the browser: on this Mac, or on the box's own network (resolve the
      // name to its IP before connecting — Chrome only accepts an IP or localhost as Host)
      cdp: { host: `http://127.0.0.1:${BOX.cdpPort}`, network: `http://${BOX.name}:9222` },
    };
  };

  /** Hand the box to the person: start it, bring the right tab forward, open a takeover. */
  const takeover = async (req: TakeoverRequest): Promise<Takeover & { viewerUrl: string }> => {
    const reason = clamp(req.reason, 120);
    if (!reason) throw new BoxError('say why the person is needed (reason)', 400);
    const url = req.url?.trim() || undefined;
    if (url && !/^https?:\/\//i.test(url)) throw new BoxError('url must be http(s)', 400);
    try {
      await driver.start();
      await driver.focus({ targetId: req.targetId, url });
    } catch (err) {
      throw new BoxError((err as Error).message, 409);
    }
    // Before you get the screen, the agent is gone — every takeover, with a task or without. Any
    // program on the box's screen could read what you type, so if it can't be stopped, no box.
    try {
      await driver.hold?.();
    } catch {
      throw new BoxError('Relay couldn’t pause the agent, so it won’t hand you the box — try again in a moment.', 409);
    }
    const t = takeovers.open({ reason, url, service: clamp(req.service, 40), taskId: req.taskId, targetId: req.targetId });
    return { ...t, viewerUrl: await driver.viewerUrl({ control: true }) };
  };

  app.get('/api/box', async () => describe());

  app.post('/api/box/start', async (_req, reply) => {
    try {
      await driver.start();
      return await describe();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  // For workers only (the fence keeps web pages off /api/worker/*): where the box's hands are and
  // the token that opens them. `ensure` wakes the box first — a worker asks that when a task
  // reaches for the computer, so a sleeping box doesn't stop the work.
  const IN_USE = 'You’re using Relay’s computer right now — the agent waits until you hand it back.';
  const forWorker = async () => {
    const status = await driver.status();
    const cdp = { host: `http://127.0.0.1:${BOX.cdpPort}`, network: `http://${BOX.name}:9222` };
    if (status.state !== 'ready') return { ...status, computer: false };
    if (takeovers.anyOpen()) return { state: status.state, computer: false, note: IN_USE };
    const boxd = await driver.boxd?.();
    return boxd
      ? { state: status.state, computer: true, boxd, cdp }
      : { state: status.state, computer: false, note: 'Relay’s computer is from before its shell and screen tools — restart it to get them.', cdp };
  };
  app.get('/api/worker/box', async () => forWorker());
  app.post('/api/worker/box/ensure', async (_req, reply) => {
    try {
      await driver.start();
      // Wake the agent's side unless a person has the box (a hold the server lost track of, after a
      // restart, wears off on its own after ten minutes).
      if (!takeovers.anyOpen() && (await driver.wake?.()) === false) {
        return { state: 'ready', computer: false, note: IN_USE };
      }
      return await forWorker();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });


  app.post<{ Body: TakeoverRequest | undefined }>('/api/box/takeover', async (req, reply) => {
    try {
      const t = await takeover(req.body ?? {});
      return { id: t.id, reason: t.reason, url: t.url, service: t.service, taskId: t.taskId, viewerUrl: t.viewerUrl };
    } catch (err) {
      return reply.code(err instanceof BoxError ? err.status : 409).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/box/takeover/:id', async (req, reply) => {
    const t = takeovers.get(req.params.id);
    return t ? { takeover: t } : reply.code(404).send({ error: 'not found' });
  });

  for (const [verb, state] of [['done', 'done'], ['cancel', 'cancelled']] as const) {
    app.post<{ Params: { id: string } }>(`/api/box/takeover/:id/${verb}`, async (req, reply) => {
      const t = takeovers.finish(req.params.id, state);
      if (!t) return reply.code(404).send({ error: 'not found' });
      // Once nobody is using the box, the agent comes back — before this answers, so whatever looks
      // at the box next (Connections checking your new sign-in) finds it up again.
      if (!takeovers.anyOpen()) {
        await driver.release?.().catch((err) => app.log.warn({ err }, 'couldn’t bring the agent back after a takeover'));
      }
      return { takeover: t };
    });
  }

  return { driver, takeovers, takeover, sites };
}
