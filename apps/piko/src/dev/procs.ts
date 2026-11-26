// Starts the pieces of a dev session as child processes and stops them together.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_ROOT } from '../config.js';

const children: ChildProcess[] = [];
let stopping = false;
process.on('exit', () => {
  stopping = true;
  for (const child of children) child.kill();
});
process.on('SIGINT', () => process.exit(0));

export function isStopping(): boolean {
  return stopping;
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Starts Temporal's dev server unless one is already running. Its database file keeps tasks across restarts. */
export async function ensureTemporal(): Promise<void> {
  if (await portOpen(7233)) return;
  const dataDir = join(APP_ROOT, '.data');
  mkdirSync(dataDir, { recursive: true });
  const server = spawn('temporal', ['server', 'start-dev', '--ip', '127.0.0.1', '--db-filename', join(dataDir, 'temporal.db'), '--log-level', 'error'], {
    stdio: 'ignore',
  });
  server.on('error', () => {
    console.error('✗ the Temporal CLI is missing (brew install temporal)');
    process.exit(1);
  });
  children.push(server);
  for (let i = 0; i < 60; i++) {
    if (await portOpen(7233)) {
      console.log('✓ Temporal dev server running (UI: http://localhost:8233)');
      return;
    }
    await delay(500);
  }
  console.error('✗ the Temporal dev server did not start');
  process.exit(1);
}

/** Runs one of our TypeScript entry points (worker, gateway) with its output prefixed by `label`. */
export function startNode(label: string, entry: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', entry], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const print = (stream: NodeJS.WriteStream) => (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) stream.write(`  [${label}] ${line}\n`);
  };
  child.stdout.on('data', print(process.stdout));
  child.stderr.on('data', print(process.stderr));
  child.on('exit', (code, signal) => {
    if (stopping || signal === 'SIGINT') return;
    console.error(`✗ ${label} stopped (exit ${code ?? signal})`);
  });
  children.push(child);
  return child;
}

export async function waitForHealth(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await delay(150);
  }
  throw new Error(`${url} never answered`);
}
