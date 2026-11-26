// Piko's computers: one Linux desktop per LINE user (Chromium, a shell, Python and office tools), in a
// Docker container built from apps/piko-box. Files and website sign-ins live on two volumes, so they survive
// the container being recreated. Piko talks to each box through boxd, the box's own small HTTP daemon.
//
// Today the containers run in Docker on this Mac; on a server the same image and calls apply.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_ROOT } from '../config.js';

const IMAGE = process.env.PIKO_BOX_IMAGE ?? 'piko-box:dev';
const NETWORK = 'piko-box';
/**
 * Docker's default seccomp profile plus exactly what Chromium's sandbox needs (user and PID namespaces,
 * chroot): see the comments inside it. The docker CLI reads it from this machine and sends it along.
 */
const SECCOMP = process.env.PIKO_BOX_SECCOMP ?? resolve(APP_ROOT, '../piko-box/seccomp-chromium.json');

export interface Box {
  /** boxd's address from this machine, e.g. http://127.0.0.1:55012 */
  url: string;
  token: string;
  /** the noVNC viewer, for takeover */
  viewerPort: number;
}

export class BoxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function docker(args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const context = process.env.PIKO_DOCKER_CONTEXT ? ['--context', process.env.PIKO_DOCKER_CONTEXT] : [];
  return new Promise((resolve) => {
    execFile('docker', [...context, ...args], { timeout: 180_000, env: env ?? process.env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** A short, stable id per user, so container and volume names don't carry LINE ids. */
function idFor(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

function boxName(userId: string): string {
  return `piko-box-${idFor(userId)}`;
}

async function publishedPort(name: string, port: number): Promise<number> {
  const out = await docker(['port', name, `${port}/tcp`]);
  const found = /:(\d+)\s*$/m.exec(out.stdout.trim().split('\n')[0] ?? '');
  if (!found) throw new BoxError(500, `box ${name} has no port ${port}`);
  return Number(found[1]);
}

/** Tokens live in the container's environment (`-e NAME` without a value), so a restarted worker finds them. */
async function envValue(name: string, key: string): Promise<string> {
  const out = await docker(['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', name]);
  const line = out.stdout.split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) throw new BoxError(500, `box ${name} has no ${key}`);
  return line.slice(key.length + 1);
}

const known = new Map<string, Box>();

async function start(userId: string): Promise<void> {
  const id = idFor(userId);
  const name = boxName(userId);
  const state = await docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (state.code === 0 && state.stdout.trim() === 'true') return;
  if (state.code === 0) {
    const started = await docker(['start', name]); // stopped: start it again, same tokens and volumes and options
    if (started.code !== 0) throw new BoxError(500, `couldn't start ${name}: ${started.stderr.trim()}`);
    return;
  }
  // Never fall back to no filter at all.
  if (!existsSync(SECCOMP)) throw new BoxError(500, `the box's seccomp profile is missing (${SECCOMP})`);
  // Boxes share a network but must never reach each other: inter-container traffic is off at the bridge.
  // (start.sh's fence also blocks private addresses, this is the second wall.)
  if ((await docker(['network', 'inspect', NETWORK])).code !== 0) {
    await docker(['network', 'create', '-o', 'com.docker.network.bridge.enable_icc=false', NETWORK]);
  }
  const ran = await docker(
    [
      'run', '-d', '--name', name,
      '--label', 'piko.box=1',
      '--network', NETWORK,
      // Loopback only, on ports Docker picks: boxd for Piko's worker, the viewer for takeover.
      '-p', '127.0.0.1::7070',
      '-p', '127.0.0.1::6080',
      '-v', `piko-profile-${id}:/home/relay/profile`,
      '-v', `piko-home-${id}:/home/agent`,
      '-e', 'RELAY_BOX_TOKEN',
      '-e', 'RELAY_BOX_VIEW_TOKEN',
      '-e', 'RELAY_BOXD_TOKEN',
      '--shm-size', '1g',
      '--memory', '2g',
      '--cpus', '2',
      '--pids-limit', '1024',
      // Chromium keeps its own sandbox under a seccomp profile that allows only what that sandbox needs;
      // NET_ADMIN is only for the fence start.sh puts up as root; nothing can gain privileges afterwards.
      '--security-opt', `seccomp=${SECCOMP}`,
      '--cap-add', 'NET_ADMIN',
      '--security-opt', 'no-new-privileges',
      '--restart', 'unless-stopped',
      IMAGE,
    ],
    {
      ...process.env,
      RELAY_BOX_TOKEN: randomBytes(24).toString('base64url'),
      RELAY_BOX_VIEW_TOKEN: randomBytes(24).toString('base64url'),
      RELAY_BOXD_TOKEN: randomBytes(24).toString('base64url'),
    },
  );
  if (ran.code !== 0) throw new BoxError(500, `couldn't create ${name}: ${ran.stderr.trim()}`);
}

/** The user's computer, started if needed. Resolves once boxd answers. */
export async function ensureBox(userId: string): Promise<Box> {
  const cached = known.get(userId);
  if (cached && (await healthy(cached))) return cached;
  await start(userId);
  const name = boxName(userId);
  const box: Box = {
    url: `http://127.0.0.1:${await publishedPort(name, 7070)}`,
    token: await envValue(name, 'RELAY_BOXD_TOKEN'),
    viewerPort: await publishedPort(name, 6080),
  };
  for (let i = 0; i < 120; i++) {
    if (await healthy(box)) {
      known.set(userId, box);
      return box;
    }
    // Still no boxd after a few seconds: it may have died, or a takeover holds the box (boxd is stopped then).
    if (i === 10 && (await agentctl(userId, 'up')) === 'held') {
      throw new BoxError(423, 'The user has the computer right now (a takeover is open). Wait until they hand it back.');
    }
    await delay(500);
  }
  throw new BoxError(503, 'The computer did not start in time.');
}

/**
 * Runs agentctl (apps/piko-box/agentctl) as root inside the user's box. `hold` stops every process of the agent's
 * before a person types, on a fresh screen (of `size`, `WxH`, when given: a phone's); `release` brings the
 * agent and its desktop back; `up` starts what is missing unless a takeover holds the box.
 */
export async function agentctl(userId: string, action: 'hold' | 'release' | 'up', size?: string): Promise<'held' | 'up'> {
  const out = await docker(['exec', '-u', 'root', boxName(userId), '/opt/relay/agentctl', action, ...(size ? [size] : [])]);
  if (out.code === 3) return 'held';
  // No box (never made, or removed): there is nothing to release, and nothing to hand over.
  if (/No such container|is not running/.test(out.stderr)) {
    if (action === 'release') return 'up';
    throw new BoxError(404, 'The computer is not running.');
  }
  if (out.code !== 0) throw new BoxError(500, `agentctl ${action} failed: ${(out.stderr || out.stdout).trim()}`);
  return out.stdout.trim() === 'held' ? 'held' : 'up';
}

/** Where the box's typing screen (VNC :5900 behind websockify) answers on this machine, and its token. */
export async function typingScreen(userId: string): Promise<{ port: number; token: string }> {
  const name = boxName(userId);
  return { port: await publishedPort(name, 6080), token: await envValue(name, 'RELAY_BOX_TOKEN') };
}

async function healthy(box: Box): Promise<boolean> {
  try {
    return (await fetch(`${box.url}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** One boxd call. Errors carry boxd's own message, which is written to be shown to the model. */
export async function boxd<T>(box: Box, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${box.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${box.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(330_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new BoxError(res.status, json.error ?? `boxd ${path} failed (${res.status})`);
  return json;
}
