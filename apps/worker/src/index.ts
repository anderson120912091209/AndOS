// Relay worker: claims tasks from the server and works them, streaming every
// step back. Runs as its own process so it can live on a different machine or
// VM than the HUD — the "it goes off, does the work, and comes back" story.
//
// One queue, four kinds of job (see jobFor in @relay/shared):
//   run     — a new request: the driver works until it's done or needs your OK
//   commit  — you approved a proposal: perform exactly that side effect
//   revise  — you asked for a change: the driver redoes the draft
//   discard — you said no: delete the draft, send nothing

import { jobFor, type ConnectionCredential, type Proposal, type Task, type TaskResult } from '@relay/shared';
import { type DriverContext, type EmitStep, type Outcome } from './driver.js';
import { driverFor } from './choose.js';
import { accessFor, connectorsFromEnv, type JobAccess } from './connectors.js';
import { browserFromEnv } from './browser.js';
import { discardDraft, executeCommit, stampVia } from './commit.js';
import { BoxdClient, boxdFinder } from './boxd.js';
import { Workstation } from './workstation.js';

const SERVER = process.env.RELAY_SERVER ?? 'http://localhost:8787';
const POLL_MS = Number(process.env.RELAY_POLL_MS ?? 700);
const SPEED = Number(process.env.RELAY_SPEED ?? 1); // delay multiplier; 0 = instant
const CONCURRENCY = Number(process.env.RELAY_CONCURRENCY ?? 2);
// A worker on another machine proves itself with the server's RELAY_TOKEN (server/src/fence.ts).
const AUTH: Record<string, string> = process.env.RELAY_TOKEN ? { authorization: `Bearer ${process.env.RELAY_TOKEN}` } : {};

const defaults = connectorsFromEnv(); // what a job gets when you haven't connected an account
const findBoxd = boxdFinder(SERVER, AUTH);

async function post<T>(path: string, body: unknown): Promise<T | undefined> {
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined; // server restarting / not up yet — caller backs off
  }
}

async function claim(): Promise<Task | null> {
  const out = await post<{ task: Task | null }>('/api/worker/claim', {});
  return out?.task ?? null;
}

/**
 * Your connected accounts, as short-lived tokens for the job about to run. Asked for fresh
 * every job and held only in memory — never written to a task, a log, or disk.
 */
async function credentials(): Promise<ConnectionCredential[]> {
  try {
    const res = await fetch(`${SERVER}/api/connections/credentials`, { headers: AUTH });
    if (!res.ok) return [];
    return ((await res.json()) as { credentials?: ConnectionCredential[] }).credentials ?? [];
  } catch {
    return []; // server without Connections, or restarting: work with what's local
  }
}

/**
 * The box as this job's own computer — a shell, files and the screen — when the box has boxd. A box
 * that's asleep counts: the job's first computer tool wakes it (boxdFinder → /api/worker/box/ensure).
 */
async function computerFor(task: Task, emit: DriverContext['emit']): Promise<Workstation | undefined> {
  try {
    const res = await fetch(`${SERVER}/api/worker/box`, { headers: AUTH });
    if (!res.ok) return undefined;
    const box = (await res.json()) as { state?: string; computer?: boolean };
    if (!box.computer && box.state !== 'off' && box.state !== 'starting') return undefined;
  } catch {
    return undefined; // a server without the box: the agent works without a computer
  }
  return new Workstation(new BoxdClient(findBoxd, task.id), emit);
}

async function finish(task: Task, outcome: Outcome, access: JobAccess, emit: DriverContext['emit'], box?: DriverContext['box']): Promise<void> {
  if (outcome.type === 'proposal') {
    await post(`/api/worker/${task.id}/propose`, stampVia(outcome.proposal, access.connectors.email.name));
    console.log(`[worker] ? ${task.id} — waiting for your OK: ${outcome.proposal.summary}`);
  } else if (outcome.type === 'takeover') {
    // The agent needs the user to drive the box browser (sign-in, 2FA). Detach our CDP debugger
    // FIRST — an attached session with Runtime.enable makes Google refuse the sign-in as a bot —
    // then have the server open the takeover and park the task as needs_input.
    box?.close();
    const out = await post<{ task: Task }>(`/api/worker/${task.id}/takeover`, outcome.takeover);
    if (out) {
      console.log(`[worker] ⏸ ${task.id} — needs you: ${outcome.takeover.reason}`);
    } else {
      await post(`/api/worker/${task.id}/fail`, { error: "Couldn't hand you the browser — is Relay's computer running?" });
      console.log(`[worker] ✗ ${task.id} — takeover couldn't start`);
    }
  } else {
    await post(`/api/worker/${task.id}/done`, outcome.result satisfies TaskResult);
    console.log(`[worker] ✓ ${task.id}`);
  }
}

async function commit(task: Task, proposal: Proposal, access: JobAccess, emit: DriverContext['emit']): Promise<void> {
  await emit({ type: 'act', text: `${proposal.verb}: ${proposal.summary}`, data: { action: proposal.commit.action }, status: 'running' });
  const result = await executeCommit(proposal, access);
  await post(`/api/worker/${task.id}/done`, result);
  console.log(`[worker] ✓ ${task.id} — ${result.summary}`);
}

async function runTask(task: Task): Promise<void> {
  const job = jobFor(task);
  const controller = new AbortController();
  const emit = async (step: EmitStep) => {
    const out = await post<{ task: Task }>(`/api/worker/${task.id}/step`, step);
    if (out?.task.status === 'canceled') controller.abort(); // you canceled it mid-run
  };
  const box = browserFromEnv(); // this job's CDP handle, closed in `finally` so none leaks
  try {
    const creds = await credentials();
    const access = accessFor(creds);
    const driver = driverFor(creds); // your Claude key, if connected, decides — per job
    console.log(`[worker] ▶ ${task.id} (${job.type}, ${job.type === 'run' || job.type === 'revise' ? driver.name : 'no model'}) — ${task.title}`);
    const ctx: DriverContext = {
      emit,
      signal: controller.signal,
      speed: SPEED,
      drafts: {
        createEmail: (email) => access.connectors.email.createDraft(email),
        discardEmail: (id) => access.connectors.email.discard(id),
      },
      reads: {
        mail: access.mail,
        mcp: access.mcp,
        accounts: Object.fromEntries(creds.map((c) => [c.id, c.kind === 'google' || c.kind === 'box' ? c.account ?? '' : ''])),
      },
      box,
      computer: job.type === 'run' || job.type === 'revise' ? await computerFor(task, emit) : undefined,
    };

    switch (job.type) {
      case 'commit':
        await commit(task, job.proposal, access, emit);
        break;
      case 'discard':
        await discardDraft(job.proposal, access);
        await post(`/api/worker/${task.id}/canceled`, { note: 'Discarded — nothing was sent.' });
        console.log(`[worker] ✗ ${task.id} — discarded`);
        break;
      case 'revise': {
        const outcome = await driver.revise(task, job.proposal, job.feedback, ctx);
        await finish(task, outcome, access, emit, ctx.box);
        // The old draft is superseded; don't leave it lying around in Drafts.
        await discardDraft(job.proposal, access).catch(() => undefined);
        break;
      }
      case 'run':
        await finish(task, await driver.run(task, ctx), access, emit, ctx.box);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await post(`/api/worker/${task.id}/fail`, { error: message });
    console.log(`[worker] ✗ ${task.id} — ${message}`);
  } finally {
    box?.close(); // never leave a CDP debugger attached between jobs
  }
}

async function main(): Promise<void> {
  console.log(
    `[worker] driver: ${
      process.env.RELAY_DRIVER === 'claude-code' || process.env.RELAY_DRIVER === 'codex'
        ? `${process.env.RELAY_DRIVER}, on your own plan, for every job`
        : `per job (Claude key from Connections → env → ${process.env.RELAY_DRIVER ?? 'not connected'})`
    } · default email=${defaults.email.name} calendar=${defaults.calendar.name} · server=${SERVER} concurrency=${CONCURRENCY}`,
  );
  const inflight = new Set<Promise<void>>();

  // Simple pull loop with bounded concurrency: keep claiming while we have slots
  // and there's work; otherwise idle one poll interval.
  for (;;) {
    while (inflight.size < CONCURRENCY) {
      const task = await claim();
      if (!task) break;
      const p = runTask(task).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
