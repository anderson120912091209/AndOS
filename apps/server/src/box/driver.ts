// Relay's computer — the "box": a whole Linux desktop in a container on your Mac (apps/box),
// with a real Chromium and a workspace with a shell. The agent drives the browser over the
// Chrome DevTools Protocol and everything else through boxd, the box's hands (a shell, files,
// screenshots, mouse and keyboard). When a site needs you (a password, a 2FA code) you take over
// the same screen from the Box window.
//
// This driver runs it with the docker CLI. Everything is published on 127.0.0.1 only: the
// viewer and boxd (each behind its own random per-box token) and CDP for a worker running on
// the Mac. Workers in containers join the box's network and reach CDP at relay-browser:9222 —
// resolving that name to its IP first, because Chrome refuses DevTools requests whose Host
// isn't an IP or "localhost" — and boxd at relay-browser:7070.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const BOX = {
  image: 'relay-browser',
  name: 'relay-browser',
  network: 'relay-box',
  volume: 'relay-box-profile',
  /** the agent's workspace, /home/agent — its files survive a recreated box, like your sign-ins */
  homeVolume: 'relay-box-home',
  viewerPort: 16080,
  cdpPort: 19222,
  boxdPort: 17070,
} as const;

/** Where a worker reaches boxd, and the token it needs. */
export interface BoxdEndpoint {
  /** from this Mac */
  host: string;
  /** from a container on the box's network */
  network: string;
  token: string;
}

export interface BoxStatus {
  /** missing: not built yet · off: built, not running · starting · ready · unavailable: no Docker */
  state: 'missing' | 'off' | 'starting' | 'ready' | 'unavailable';
  note?: string;
}

export interface BoxDriver {
  status(): Promise<BoxStatus>;
  /** Start the box if it isn't running; resolves once its viewer answers. */
  start(): Promise<void>;
  /**
   * The viewer page for a person. View-only unless `control` — and the screen that takes typing only
   * runs during a takeover (agentctl), so a control URL is worth nothing outside one.
   */
  viewerUrl(opts?: { control?: boolean }): Promise<string>;
  /** Bring a tab to the front by its DevTools id, or open `url` in a new front tab. */
  focus(target: { targetId?: string; url?: string }): Promise<void>;
  /** The box's hands, for workers — undefined while the box runs an image from before boxd. */
  boxd?(): Promise<BoxdEndpoint | undefined>;
  /**
   * A person is about to use the box: stop everything of the agent's first. X11 lets any client on
   * the screen read every keystroke, so no agent process may exist while you type a password —
   * and the worker's CDP door closes too. Rejects if the agent couldn't be stopped.
   */
  hold?(): Promise<void>;
  /** You handed the box back: clear the clipboard you used, and bring the agent's side back. */
  release?(): Promise<void>;
  /** Start the agent's side if it's missing. False while a takeover still holds the box. */
  wake?(): Promise<boolean>;
}

export type DockerRun = (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;

const dockerCli: DockerRun = (args, env) =>
  new Promise((resolve) => {
    execFile('docker', args, { timeout: 120_000, env: env ?? process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LocalDockerBox implements BoxDriver {
  constructor(
    private docker: DockerRun = dockerCli,
    private http: typeof fetch = fetch,
    private wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private cdp(path: string): string {
    return `http://127.0.0.1:${BOX.cdpPort}${path}`;
  }

  private async viewerAnswers(): Promise<boolean> {
    try {
      const res = await this.http(`http://127.0.0.1:${BOX.viewerPort}/relay.html`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async status(): Promise<BoxStatus> {
    if ((await this.docker(['info', '--format', '{{.ServerVersion}}'])).code !== 0) {
      return { state: 'unavailable', note: 'Docker isn’t running — open Docker Desktop.' };
    }
    const running = await this.docker(['inspect', '-f', '{{.State.Running}}', BOX.name]);
    if (running.code === 0 && running.stdout.trim() === 'true') {
      return { state: (await this.viewerAnswers()) ? 'ready' : 'starting' };
    }
    const image = await this.docker(['image', 'inspect', '--format', '{{.Id}}', BOX.image]);
    return image.code === 0 ? { state: 'off' } : { state: 'missing', note: 'Relay’s computer isn’t set up yet — run pnpm box:build.' };
  }

  async start(): Promise<void> {
    const now = await this.status();
    if (now.state === 'ready') return;
    if (now.state === 'unavailable' || now.state === 'missing') throw new Error(now.note);
    if (now.state === 'off') {
      if ((await this.docker(['network', 'inspect', BOX.network])).code !== 0) {
        const made = await this.docker(['network', 'create', BOX.network]);
        if (made.code !== 0) throw new Error(`couldn’t create the box’s network: ${made.stderr.trim()}`);
      }
      await this.docker(['rm', '-f', BOX.name]); // a stopped leftover, if any
      // The tokens reach the container through the environment (`-e NAME` without a value),
      // so they never appear in a process listing.
      const token = randomBytes(24).toString('base64url');
      const viewToken = randomBytes(24).toString('base64url');
      const boxdToken = randomBytes(24).toString('base64url');
      const ran = await this.docker(
        [
          'run', '-d', '--name', BOX.name,
          '--network', BOX.network,
          '-p', `127.0.0.1:${BOX.viewerPort}:6080`,
          '-p', `127.0.0.1:${BOX.cdpPort}:9222`,
          '-p', `127.0.0.1:${BOX.boxdPort}:7070`,
          '-v', `${BOX.volume}:/home/relay/profile`,
          '-v', `${BOX.homeVolume}:/home/agent`,
          '-e', 'RELAY_BOX_TOKEN',
          '-e', 'RELAY_BOX_VIEW_TOKEN',
          '-e', 'RELAY_BOXD_TOKEN',
          '--shm-size', '1g',
          // Chromium isolates every page in its own user namespace, which Docker's default
          // syscall filter forbids. Keeping Chromium's sandbox matters more here — the box holds
          // your signed-in sessions — and Docker Desktop still runs the box inside a Linux VM.
          '--security-opt', 'seccomp=unconfined',
          // Only for start.sh's first lines, as root: the firewall that keeps the agent's shell
          // away from the browser's DevTools (your cookies), your Mac (Relay's server) and private
          // networks. Every process left running is relay or agent, which hold no capabilities.
          '--cap-add', 'NET_ADMIN',
          // …and no process can ever gain privileges after that — no setuid binary, no file
          // capability — so nothing the agent runs can climb back to root or that capability.
          '--security-opt', 'no-new-privileges',
          '--restart', 'unless-stopped',
          BOX.image,
        ],
        { ...process.env, RELAY_BOX_TOKEN: token, RELAY_BOX_VIEW_TOKEN: viewToken, RELAY_BOXD_TOKEN: boxdToken },
      );
      if (ran.code !== 0) throw new Error(`couldn’t start Relay’s computer: ${ran.stderr.trim()}`);
    }
    for (let i = 0; i < 80; i++) {
      if (await this.viewerAnswers()) return;
      await this.wait(250);
    }
    throw new Error('Relay’s computer didn’t come up');
  }

  /** The tokens live in the container's environment, so a restarted server finds them again. */
  private async envToken(name: 'RELAY_BOX_TOKEN' | 'RELAY_BOX_VIEW_TOKEN' | 'RELAY_BOXD_TOKEN'): Promise<string | undefined> {
    const env = await this.docker(['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', BOX.name]);
    return new RegExp(`^${name}=(.+)$`, 'm').exec(env.stdout)?.[1]?.trim() || undefined;
  }

  private async token(): Promise<string> {
    const token = await this.envToken('RELAY_BOX_TOKEN');
    if (!token) throw new Error('Relay’s computer isn’t running');
    return token;
  }

  /** apps/box/agentctl, run as root inside the box. A box from before agentctl has no agent to stop. */
  private async agentctl(command: 'hold' | 'release' | 'up'): Promise<number> {
    const out = await this.docker(['exec', BOX.name, '/opt/relay/agentctl', command]);
    if (out.code === 126 || out.code === 127) return 0;
    return out.code;
  }

  async hold(): Promise<void> {
    const code = await this.agentctl('hold');
    if (code !== 0) throw new Error('couldn’t pause the agent');
  }

  async release(): Promise<void> {
    await this.agentctl('release');
  }

  async wake(): Promise<boolean> {
    return (await this.agentctl('up')) !== 3;
  }

  async boxd(): Promise<BoxdEndpoint | undefined> {
    const token = await this.envToken('RELAY_BOXD_TOKEN');
    if (!token) return undefined; // a box from before boxd: it needs recreating to get its hands
    return { host: `http://127.0.0.1:${BOX.boxdPort}`, network: `http://${BOX.name}:7070`, token };
  }

  async viewerUrl(opts: { control?: boolean } = {}): Promise<string> {
    const page = `http://127.0.0.1:${BOX.viewerPort}/relay.html`;
    const view = opts.control ? undefined : await this.envToken('RELAY_BOX_VIEW_TOKEN');
    if (view) return `${page}?token=${encodeURIComponent(view)}&view=1`;
    // Typing — or a box from before the view-only screen, where watching is only client-side.
    return `${page}?token=${encodeURIComponent(await this.token())}${opts.control ? '' : '&view=1'}`;
  }

  async focus(target: { targetId?: string; url?: string }): Promise<void> {
    if (target.targetId) {
      const res = await this.http(this.cdp(`/json/activate/${encodeURIComponent(target.targetId)}`));
      if (!res.ok) throw new Error('that tab is gone');
      return;
    }
    if (target.url) {
      // A tab already on that site (say, Google's sign-in page Gmail sent you to) comes to the
      // front instead of a new one, so asking twice doesn't pile up tabs.
      const site = siteOf(target.url);
      const tabs = await this.http(this.cdp('/json/list'))
        .then((r) => (r.ok ? (r.json() as Promise<{ id: string; type: string; url: string }[]>) : []))
        .catch(() => []);
      const open = tabs.find((t) => t.type === 'page' && URL.canParse(t.url) && siteOf(t.url) === site);
      if (open && (await this.http(this.cdp(`/json/activate/${encodeURIComponent(open.id)}`))).ok) return;
      // Otherwise Chrome opens it in a new tab, in front.
      const res = await this.http(this.cdp(`/json/new?${encodeURI(target.url)}`), { method: 'PUT' });
      if (!res.ok) throw new Error(`couldn’t open ${new URL(target.url).host}`);
    }
  }
}

/** A URL's site, near enough: mail.google.com and accounts.google.com are both google.com. */
function siteOf(url: string): string {
  return new URL(url).hostname.split('.').slice(-2).join('.');
}
