// Run a Relay worker inside a container (a Linux VM under colima / Docker Desktop):
// the "the agent works in its own sandbox and comes back" setup, on your own Mac.
// The local outbox is mounted in, so drafts made in the box can be sent by any worker.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const outbox = resolve(root, '.data/outbox');
mkdirSync(outbox, { recursive: true });

const run = (args) => {
  const r = spawnSync('docker', args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(['build', '-f', 'apps/worker/Dockerfile', '-t', 'relay-worker', '.']);
const pass = ['RELAY_DRIVER', 'RELAY_MODEL', 'RELAY_CONNECTOR', 'RELAY_TOKEN', 'RELAY_BROWSER_CDP', 'RELAY_BOXD_URL', 'ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'RELAY_SPEED']
  .filter((k) => process.env[k])
  .flatMap((k) => ['-e', k]);
// Join the box's private network so the worker can reach the browser (the box owner creates it),
// and the box's hands (boxd) by name from in there.
const network = process.env.RELAY_BOX_NETWORK ? ['--network', process.env.RELAY_BOX_NETWORK] : [];
if (process.env.RELAY_BOX_NETWORK && !process.env.RELAY_BOXD_URL) pass.push('-e', 'RELAY_BOXD_URL=http://relay-browser:7070');
run(['run', '--rm', '--name', 'relay-worker', '--add-host', 'host.docker.internal:host-gateway', ...network, '-v', `${outbox}:/outbox`, ...pass, 'relay-worker']);
