// One command to run the whole stack in dev: server + worker + web (Vite).
// Each child's output is prefixed and colorized. Ctrl-C tears everything down.
import { spawn } from 'node:child_process';

const procs = [
  { name: 'server', color: '\x1b[38;5;156m', cmd: 'pnpm', args: ['-s', 'tsx', 'watch', 'apps/server/src/index.ts'] },
  { name: 'worker', color: '\x1b[38;5;180m', cmd: 'pnpm', args: ['-s', 'tsx', 'watch', 'apps/worker/src/index.ts'], env: { RELAY_SPEED: '1', RELAY_BROWSER_CDP: process.env.RELAY_BROWSER_CDP ?? 'http://127.0.0.1:19222' } },
  { name: 'web   ', color: '\x1b[38;5;153m', cmd: 'pnpm', args: ['-C', 'apps/web', 'dev'] },
];

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${p.color}[${p.name}]\x1b[0m `;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) process.stdout.write(tag + l + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
});

console.log('\nRelay dev stack starting → web http://localhost:5173  (api :8787)\n');

const shutdown = () => {
  for (const c of children) c.kill('SIGINT');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
