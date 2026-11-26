import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { BOX, type BoxDriver, type BoxStatus, LocalDockerBox, type DockerRun } from './driver.js';
import { registerBox, BoxError, Takeovers, type Takeover } from './routes.js';
import { BoxSites, onDomain, type BoxCookie } from './sites.js';

class FakeBox implements BoxDriver {
  state: BoxStatus['state'] = 'off';
  focused: { targetId?: string; url?: string }[] = [];
  async status() {
    return { state: this.state };
  }
  async start() {
    if (this.state === 'missing') throw new Error('not set up');
    this.state = 'ready';
  }
  async viewerUrl(opts: { control?: boolean } = {}) {
    return opts.control ? 'http://127.0.0.1:16080/relay.html?token=t0k3n' : 'http://127.0.0.1:16080/relay.html?token=v1ew&view=1';
  }
  async focus(target: { targetId?: string; url?: string }) {
    this.focused.push(target);
  }
  hands = true;
  async boxd() {
    return this.hands ? { host: 'http://127.0.0.1:17070', network: 'http://relay-browser:7070', token: 'h4nds' } : undefined;
  }
  /** what happened to the agent's side, in order */
  agent: string[] = [];
  holdFails = false;
  held = false;
  async hold() {
    if (this.holdFails) throw new Error('still running');
    this.agent.push(`hold after focus #${this.focused.length}`);
  }
  async release() {
    await new Promise((r) => setTimeout(r, 5)); // agentctl takes a moment
    this.agent.push('release');
  }
  async wake() {
    this.agent.push('wake');
    return !this.held;
  }
}

describe('box API', () => {
  it('starts the box for a takeover, shows the right tab, and tells the task when you are done', async () => {
    const box = new FakeBox();
    const app = Fastify();
    const { takeovers } = await registerBox(app, { driver: box });
    const finished: Takeover[] = [];
    takeovers.onFinished((t) => finished.push(t));

    const res = await app.inject({
      method: 'POST', url: '/api/box/takeover',
      payload: { reason: 'Sign in to Gmail', taskId: 'task_1', targetId: 'TAB1' },
    });
    expect(res.statusCode).toBe(200);
    const { id, viewerUrl } = res.json();
    expect(viewerUrl).toContain('token=');
    expect(box.state).toBe('ready');
    expect(box.focused).toEqual([{ targetId: 'TAB1', url: undefined }]);

    await app.inject({ method: 'POST', url: `/api/box/takeover/${id}/done` });
    await app.inject({ method: 'POST', url: `/api/box/takeover/${id}/done` }); // twice is harmless
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ id, taskId: 'task_1', state: 'done' });
  });

  it('opens a site to sign in to, and says no politely when it can’t', async () => {
    const box = new FakeBox();
    const app = Fastify();
    await registerBox(app, { driver: box });
    await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'Sign in', url: 'https://web.whatsapp.com' } });
    expect(box.focused.at(-1)).toEqual({ targetId: undefined, url: 'https://web.whatsapp.com' });

    expect((await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { url: 'https://x.com' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'x', url: 'file:///etc/passwd' } })).statusCode).toBe(400);
    box.state = 'missing';
    const missing = await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'x' } });
    expect(missing.statusCode).toBe(409);
  });

  it('stops the agent before you get the screen, and brings it back only when nobody is using it', async () => {
    const box = new FakeBox();
    const app = Fastify();
    const { takeovers } = await registerBox(app, { driver: box });
    const a = (await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'Sign in to Gmail', taskId: 'task_1' } })).json();
    // the Box window's own "Take Over" — no task, still a takeover
    const b = (await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'You’re using Relay’s computer', service: 'box' } })).json();
    expect(box.agent).toEqual(['hold after focus #1', 'hold after focus #2']); // the tab is ready first, then the agent goes
    expect(takeovers.anyOpen()).toBe(true);

    // while you have it, workers get no computer
    expect((await app.inject({ url: '/api/worker/box' })).json()).toMatchObject({ computer: false, note: expect.stringContaining('using Relay’s computer') });

    await app.inject({ method: 'POST', url: `/api/box/takeover/${a.id}/done` });
    expect(box.agent).not.toContain('release'); // the other takeover is still open
    await app.inject({ method: 'POST', url: `/api/box/takeover/${b.id}/cancel` });
    expect(box.agent.at(-1)).toBe('release'); // done before /cancel answered: the box is back
  });

  it('hands out a screen you can type into only while a takeover has the box', async () => {
    const box = new FakeBox();
    box.state = 'ready';
    const app = Fastify();
    await registerBox(app, { driver: box });
    expect((await app.inject({ url: '/api/box' })).json().viewerUrl).toContain('token=v1ew&view=1'); // watching
    const t = (await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'Sign in' } })).json();
    expect(t.viewerUrl).toContain('token=t0k3n'); // the takeover itself gets typing
    expect((await app.inject({ url: '/api/box' })).json().viewerUrl).toContain('token=t0k3n'); // so does the Box window that opens for it
    await app.inject({ method: 'POST', url: `/api/box/takeover/${t.id}/done` });
    expect((await app.inject({ url: '/api/box' })).json().viewerUrl).toContain('view=1'); // and then it's watching again
  });

  it('won’t hand you the box if the agent couldn’t be stopped', async () => {
    const box = new FakeBox();
    box.holdFails = true;
    const app = Fastify();
    const { takeovers } = await registerBox(app, { driver: box });
    const res = await app.inject({ method: 'POST', url: '/api/box/takeover', payload: { reason: 'Sign in' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/couldn’t pause the agent/);
    expect(takeovers.anyOpen()).toBe(false);
  });

  it('wakes the agent for a worker, unless a takeover the server lost track of still holds the box', async () => {
    const box = new FakeBox();
    const app = Fastify();
    await registerBox(app, { driver: box });
    expect((await app.inject({ method: 'POST', url: '/api/worker/box/ensure' })).json()).toMatchObject({ computer: true });
    expect(box.agent).toEqual(['wake']);
    box.held = true;
    expect((await app.inject({ method: 'POST', url: '/api/worker/box/ensure' })).json()).toMatchObject({ computer: false });
  });

  it('tells workers — and only workers — where the box’s hands are, waking the box when asked', async () => {
    const box = new FakeBox();
    const app = Fastify();
    await registerBox(app, { driver: box });
    expect((await app.inject({ url: '/api/worker/box' })).json()).toEqual({ state: 'off', computer: false });
    const woke = (await app.inject({ method: 'POST', url: '/api/worker/box/ensure' })).json();
    expect(box.state).toBe('ready');
    expect(woke).toMatchObject({ computer: true, boxd: { host: 'http://127.0.0.1:17070', token: 'h4nds' } });
    expect(JSON.stringify((await app.inject({ url: '/api/box' })).json())).not.toContain('h4nds'); // the Mac's view never carries it
    box.hands = false; // a box still on an image from before boxd
    expect((await app.inject({ url: '/api/worker/box' })).json()).toMatchObject({ computer: false, note: expect.stringContaining('restart') });
  });

  it('only hands out the viewer and CDP addresses once the box is up', async () => {
    const box = new FakeBox();
    const app = Fastify();
    await registerBox(app, { driver: box });
    expect((await app.inject({ url: '/api/box' })).json()).toEqual({ state: 'off' });
    box.state = 'ready';
    expect((await app.inject({ url: '/api/box' })).json()).toMatchObject({
      state: 'ready',
      cdp: { host: 'http://127.0.0.1:19222', network: 'http://relay-browser:9222' },
    });
  });
});

describe('LocalDockerBox', () => {
  it('runs the box on loopback only, with the token out of the process list', async () => {
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    let running = false;
    const docker: DockerRun = async (args, env) => {
      calls.push({ args, env });
      if (args[0] === 'info') return { code: 0, stdout: '29.0', stderr: '' };
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) return { code: running ? 0 : 1, stdout: running ? 'true' : '', stderr: '' };
      if (args[0] === 'image') return { code: 0, stdout: 'sha256:x', stderr: '' };
      if (args[0] === 'network' && args[1] === 'inspect') return { code: 1, stdout: '', stderr: 'no such network' };
      if (args[0] === 'run') running = true;
      return { code: 0, stdout: '', stderr: '' };
    };
    const http = (async () => new Response('ok', { status: running ? 200 : 503 })) as typeof fetch;
    await new LocalDockerBox(docker, http, async () => undefined).start();

    const run = calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).toContain(`127.0.0.1:${BOX.viewerPort}:6080`);
    expect(run.args).toContain(`127.0.0.1:${BOX.cdpPort}:9222`);
    expect(run.args).toContain(`127.0.0.1:${BOX.boxdPort}:7070`);
    expect(run.args).toContain(`${BOX.homeVolume}:/home/agent`);
    expect(run.args.join(' ')).not.toMatch(/0\.0\.0\.0|RELAY_BOX_TOKEN=|RELAY_BOXD_TOKEN=|--no-sandbox|--privileged/);
    expect(run.args.join(' ')).toContain('seccomp=unconfined'); // so Chromium's own sandbox can run
    expect(run.args.join(' ')).toContain('--cap-add NET_ADMIN'); // start.sh's firewall for the agent's shell, nothing broader
    expect(run.args.join(' ')).not.toMatch(/--cap-add (?!NET_ADMIN)/);
    expect(run.args.join(' ')).toContain('--security-opt no-new-privileges'); // nothing in the box can climb back to root
    expect(run.env?.RELAY_BOX_TOKEN).toMatch(/^[\w-]{30,}$/);
    expect(run.env?.RELAY_BOXD_TOKEN).toMatch(/^[\w-]{30,}$/);
    expect(run.env?.RELAY_BOXD_TOKEN).not.toBe(run.env?.RELAY_BOX_TOKEN); // the viewer's token can't open boxd
    expect(run.args.join(' ')).toContain('-e RELAY_BOX_VIEW_TOKEN');
    expect(run.env?.RELAY_BOX_VIEW_TOKEN).toMatch(/^[\w-]{30,}$/);
    expect(new Set([run.env?.RELAY_BOX_TOKEN, run.env?.RELAY_BOX_VIEW_TOKEN, run.env?.RELAY_BOXD_TOKEN]).size).toBe(3);
    expect(calls.some((c) => c.args.join(' ') === `network create ${BOX.network}`)).toBe(true);
  });

  it('gives watchers the view-only token, and typing only when asked for', async () => {
    const docker: DockerRun = async (args) =>
      args[0] === 'inspect' ? { code: 0, stdout: 'RELAY_BOX_TOKEN=typing\nRELAY_BOX_VIEW_TOKEN=watching\n', stderr: '' } : { code: 0, stdout: '', stderr: '' };
    const box = new LocalDockerBox(docker);
    expect(await box.viewerUrl()).toBe(`http://127.0.0.1:${BOX.viewerPort}/relay.html?token=watching&view=1`);
    expect(await box.viewerUrl({ control: true })).toBe(`http://127.0.0.1:${BOX.viewerPort}/relay.html?token=typing`);
    // a box from before the view-only screen: watching falls back to the app's own view-only mode
    const old = new LocalDockerBox(async (args) => ({ code: 0, stdout: args[0] === 'inspect' ? 'RELAY_BOX_TOKEN=typing\n' : '', stderr: '' }));
    expect(await old.viewerUrl()).toBe(`http://127.0.0.1:${BOX.viewerPort}/relay.html?token=typing&view=1`);
  });

  it('pauses and resumes the agent through agentctl, as root inside the box', async () => {
    const calls: string[][] = [];
    let code = 0;
    const docker: DockerRun = async (args) => {
      calls.push(args);
      return { code, stdout: '', stderr: '' };
    };
    const box = new LocalDockerBox(docker);
    await box.hold();
    expect(calls.at(-1)).toEqual(['exec', BOX.name, '/opt/relay/agentctl', 'hold']);
    code = 1;
    await expect(box.hold()).rejects.toThrow(/couldn’t pause the agent/);
    code = 127; // a box from before agentctl: there's no agent to stop
    await expect(box.hold()).resolves.toBeUndefined();
    code = 3;
    expect(await box.wake()).toBe(false); // still held by a takeover
    code = 0;
    expect(await box.wake()).toBe(true);
    await box.release();
    expect(calls.at(-1)).toEqual(['exec', BOX.name, '/opt/relay/agentctl', 'release']);
  });

  it('brings a tab already on that site forward instead of opening another', async () => {
    const asked: string[] = [];
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(`${init?.method ?? 'GET'} ${url.replace(`http://127.0.0.1:${BOX.cdpPort}`, '')}`);
      if (url.endsWith('/json/list')) {
        return Response.json([{ id: 'GOOG', type: 'page', url: 'https://accounts.google.com/v3/signin/identifier' }]);
      }
      return new Response('{}');
    }) as typeof fetch;
    const box = new LocalDockerBox(async () => ({ code: 0, stdout: '', stderr: '' }), http);
    await box.focus({ url: 'https://mail.google.com/' });
    expect(asked.at(-1)).toBe('GET /json/activate/GOOG');
    await box.focus({ url: 'https://app.slack.com/signin' });
    expect(asked.at(-1)).toBe(`PUT /json/new?https://app.slack.com/signin`);
  });

  it('says what’s missing instead of failing mysteriously', async () => {
    const noDocker: DockerRun = async () => ({ code: 1, stdout: '', stderr: 'Cannot connect' });
    expect(await new LocalDockerBox(noDocker).status()).toMatchObject({ state: 'unavailable' });
    const noImage: DockerRun = async (args) => ({ code: args[0] === 'info' ? 0 : 1, stdout: '', stderr: '' });
    expect(await new LocalDockerBox(noImage).status()).toMatchObject({ state: 'missing' });
  });
});

describe('Takeovers', () => {
  it('finishes once', () => {
    const t = new Takeovers();
    const a = t.open({ reason: 'r' });
    expect(t.finish(a.id, 'cancelled')?.state).toBe('cancelled');
    expect(t.finish(a.id, 'done')?.state).toBe('cancelled');
  });
});

describe('takeover() for a worker', () => {
  it('refuses what an agent shouldn’t ask for, and keeps titles title-sized', async () => {
    const box = await registerBox(Fastify(), { driver: new FakeBox() });
    await expect(box.takeover({ reason: 'x', url: 'javascript:alert(1)' })).rejects.toMatchObject({ status: 400 });
    await expect(box.takeover({ reason: '   ' })).rejects.toBeInstanceOf(BoxError);
    const t = await box.takeover({ reason: 'Sign in '.repeat(40), service: 'Gmail', taskId: 'task_9' });
    expect(t.reason.length).toBeLessThanOrEqual(120);
    expect(t.reason.endsWith('…')).toBe(true);
    expect(t).toMatchObject({ service: 'Gmail', taskId: 'task_9', state: 'open' });
  });
});

describe('BoxSites', () => {
  const cookie = (name: string, domain: string): BoxCookie => ({ name, domain, path: '/', secure: true, httpOnly: false });

  it('matches a site’s cookies by domain, subdomains included, and nothing that merely ends alike', () => {
    expect(onDomain('.google.com', ['google.com'])).toBe(true);
    expect(onDomain('accounts.google.com', ['google.com'])).toBe(true);
    expect(onDomain('.notgoogle.com', ['google.com'])).toBe(false);
    expect(onDomain('www.notion.so', ['notion.so', 'notion.com'])).toBe(true);
  });

  it('remembers who you are after the tab closes, and forgets on sign-out', async () => {
    let jar = [cookie('SID', '.google.com'), cookie('d', '.slack.com')];
    let tabs = [{ url: 'https://mail.google.com/mail/u/0/', title: 'Inbox - me@example.com - Gmail' }];
    const sites = new BoxSites({
      cookies: async () => jar,
      expire: async (gone) => void (jar = jar.filter((c) => !gone.includes(c))),
      pages: async () => tabs,
    });
    expect((await sites.sessions())?.get('gmail')).toEqual({ signedIn: true, account: 'me@example.com' });
    tabs = [];
    expect((await sites.sessions())?.get('gmail')).toEqual({ signedIn: true, account: 'me@example.com' });
    await sites.signOut('gmail');
    expect(jar.map((c) => c.name)).toEqual(['d']);
    expect((await sites.sessions())?.get('gmail')).toEqual({ signedIn: false });
  });

  it('keeps the last answer while the browser can’t be asked, and knows nothing before the first', async () => {
    let up = false;
    const sites = new BoxSites({
      cookies: async () => {
        if (!up) throw new Error('held');
        return [cookie('d', '.slack.com')];
      },
      expire: async () => undefined,
      pages: async () => [],
    });
    expect(await sites.sessions()).toBeUndefined();
    up = true;
    expect((await sites.sessions())?.get('slack')).toEqual({ signedIn: true, account: undefined });
    up = false; // a takeover holds the box
    expect((await sites.sessions())?.get('slack')).toEqual({ signedIn: true, account: undefined });
  });
});

