import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
// @ts-expect-error — plain-JS module that runs inside the box
import { BoxdError, Desktop, LIMITS, Shell, Workspace, clip, createBoxd, describeRun, shellEnv } from './boxd.mjs';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'boxd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const shellIn = (cwd: string) => new Shell({ cwd, env: shellEnv(process.env, cwd) });

describe('the shell', () => {
  it('keeps cd and variables between commands, and folds stderr in', async () => {
    const sh = shellIn(dir);
    try {
      await sh.run('mkdir -p sub && cd sub && export GREETING=hi');
      const out = await sh.run('pwd; echo "$GREETING"; echo oops >&2; false');
      expect(out.output).toContain(`${path.basename(dir)}/sub`);
      expect(out.output).toContain('hi');
      expect(out.output).toContain('oops');
      expect(out.exitCode).toBe(1);
      expect(describeRun(out, 1000)).toMatch(/\[exit code 1\]$/);
    } finally {
      sh.kill();
    }
  });

  it("doesn't wait on stdin, and stops a command that runs too long", async () => {
    const sh = shellIn(dir);
    try {
      expect((await sh.run('cat; echo after', 5000)).output).toContain('after'); // cat reads /dev/null, not our marker
      const slow = await sh.run('echo started; sleep 30', 400);
      expect(slow.timedOut).toBe(true);
      expect(slow.output).toContain('started');
      expect(describeRun(slow, 400)).toContain('shell was restarted');
      expect((await sh.run('echo fresh')).output.trim()).toBe('fresh'); // a new shell picks up
    } finally {
      sh.kill();
    }
  });

  it('notices when a command exits the shell', async () => {
    const sh = shellIn(dir);
    try {
      const out = await sh.run('echo bye; exit 3');
      expect(out.exited).toBe(true);
      expect(out.output).toContain('bye');
      expect((await sh.run('echo again')).output.trim()).toBe('again');
    } finally {
      sh.kill();
    }
  });

  it('shows the model none of Relay’s secrets', () => {
    const env = shellEnv({ PATH: '/usr/bin', RELAY_BOXD_TOKEN: 'x', RELAY_BOX_TOKEN: 'y', ANTHROPIC_API_KEY: 'z' }, '/home/agent');
    expect(Object.keys(env).filter((k) => /RELAY|ANTHROPIC|TOKEN|KEY/.test(k))).toEqual([]);
    expect(env.HOME).toBe('/home/agent');
  });

  it('keeps the head and tail of long output', () => {
    const long = `${'a'.repeat(LIMITS.output)}END`;
    const out = clip(long);
    expect(out.length).toBeLessThan(long.length + 80);
    expect(out.endsWith('END')).toBe(true);
    expect(out).toContain('characters cut');
  });
});

describe('the workspace', () => {
  it('views files with line numbers, ranges, and folders two levels deep', async () => {
    const ws = new Workspace(dir);
    await ws.create('notes/todo.md', 'one\ntwo\nthree');
    expect(await ws.view('notes/todo.md')).toBe('     1\tone\n     2\ttwo\n     3\tthree');
    expect(await ws.view('notes/todo.md', [2, -1])).toBe('     2\ttwo\n     3\tthree');
    await expect(ws.view('notes/todo.md', [5, 6])).rejects.toThrow(/outside the file/);
    expect(await ws.view('.')).toContain('notes/todo.md');
  });

  it('replaces exactly one match and inserts after a line', async () => {
    const ws = new Workspace(dir);
    await ws.create('a.txt', 'x = 1\ny = 1\n');
    await expect(ws.strReplace('a.txt', '= 1', '= 2')).rejects.toThrow(/appears 2 times/);
    await expect(ws.strReplace('a.txt', 'z = 1', '')).rejects.toThrow(/wasn't found/);
    expect(await ws.strReplace('a.txt', 'y = 1', 'y = 2')).toContain('y = 2');
    await ws.insert('a.txt', 0, '# top');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('# top\nx = 1\ny = 2\n');
  });

  it('never reads or writes outside the workspace, even through a symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'boxd-outside-'));
    try {
      await writeFile(path.join(outside, 'secret'), 'cookies');
      await symlink(outside, path.join(dir, 'link'));
      const ws = new Workspace(dir);
      await expect(ws.view('../secret')).rejects.toThrow(/outside the workspace/);
      await expect(ws.view(path.join(outside, 'secret'))).rejects.toThrow(/outside the workspace/);
      await expect(ws.view('link/secret')).rejects.toThrow(/leads outside/);
      await expect(ws.readBytes('link/secret')).rejects.toThrow(/leads outside/); // delivery can't escape either
      await symlink(path.join(outside, 'secret'), path.join(dir, 'secret-link'));
      await expect(ws.readBytes('secret-link')).rejects.toThrow(/leads outside/); // a file symlink straight out
      await expect(ws.create('link/new.txt', 'x')).rejects.toThrow(/leads outside/);
      await mkdir(path.join(dir, 'ok'));
      expect(await ws.create('ok/new.txt', 'fine')).toMatch(/^Created/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reads a finished file as bytes for delivery, and refuses folders, misses and oversize', async () => {
    const ws = new Workspace(dir);
    await writeFile(path.join(dir, 'deck.pptx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    const got = await ws.readBytes('deck.pptx');
    expect(got).toEqual({ name: 'deck.pptx', size: 7, data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).toString('base64') });
    await mkdir(path.join(dir, 'folder'));
    await expect(ws.readBytes('folder')).rejects.toThrow(/folder/);
    await expect(ws.readBytes('nope.pdf')).rejects.toThrow(/doesn't exist/);
    await expect(ws.readBytes('../etc/hosts')).rejects.toThrow(/outside the workspace/);
    await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(LIMITS.deliver + 1));
    await expect(ws.readBytes('big.bin')).rejects.toThrow(/delivery limit/);
  });
});

describe('the screen', () => {
  const desktop = (now = () => 0) => {
    const calls: [string, string[]][] = [];
    const d = new Desktop({
      width: 1280,
      height: 800,
      display: ':99',
      now,
      run: async (cmd: string, args: string[]) => {
        calls.push([cmd, args]);
        return Buffer.from(cmd === 'import' ? 'PNG' : 'X=12\nY=34\n');
      },
    });
    return { d, calls };
  };

  it('turns the computer toolset into xdotool argument lists, never a shell string', async () => {
    const { d, calls } = desktop();
    await d.act('double_click', { coordinate: [100, 200], text: 'shift' });
    await d.act('scroll', { scroll_direction: 'down', scroll_amount: 3 });
    await d.act('key', { text: 'ctrl+s' });
    await d.act('type', { text: 'hello; rm -rf /' });
    expect(calls.map(([, a]) => a)).toEqual([
      ['mousemove', '--sync', '100', '200'],
      ['keydown', 'shift'],
      ['click', '--repeat', '2', '--delay', '80', '1'],
      ['keyup', 'shift'],
      ['click', '--repeat', '3', '--delay', '30', '5'],
      ['key', '--repeat', '1', '--delay', '40', '--', 'ctrl+s'],
      ['type', '--delay', '8', '--', 'hello; rm -rf /'],
    ]);
    expect(await d.cursor()).toEqual({ x: 12, y: 34 });
  });

  it('refuses points off the screen and actions it does not know', async () => {
    const { d } = desktop();
    await expect(d.act('left_click', { coordinate: [1280, 10] })).rejects.toThrow(/off the 1280×800 screen/);
    await expect(d.act('left_click', { coordinate: [-1, 10] })).rejects.toThrow(BoxdError);
    await expect(d.act('format_disk', {})).rejects.toThrow(/can't do/);
  });

  it('zooms by cropping a region and enlarging it to the screen size', async () => {
    const { d, calls } = desktop();
    const shot = await d.screenshot([100, 100, 420, 300]);
    expect(shot.media_type).toBe('image/png');
    expect(calls[0]![1]).toEqual(['-display', ':99', '-silent', '-window', 'root', '-crop', '320x200+100+100', '+repage', '-resize', '1280x800', 'png:-']);
  });

  it('lends the screen to one job at a time', () => {
    let t = 0;
    const { d } = desktop(() => t);
    d.claim('job-a');
    expect(() => d.claim('job-b')).toThrow(/Another task is using the screen/);
    t += LIMITS.leaseMs + 1;
    expect(() => d.claim('job-b')).not.toThrow();
  });
});

describe('the daemon', () => {
  const start = async () => {
    const server = createBoxd({
      token: 's3cret',
      workspace: new Workspace(dir),
      desktop: new Desktop({ width: 1280, height: 800, display: ':99', run: async () => Buffer.from('PNG') }),
      newShell: () => shellIn(dir),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown, headers: Record<string, string> = { authorization: 'Bearer s3cret' }) =>
      fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { server, base, post };
  };

  it('answers health openly, and everything else only with the token and no Origin', async () => {
    const { server, base, post } = await start();
    try {
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, screen: { width: 1280, height: 800 } });
      expect((await post('/exec', { session: 'j1', command: 'id' }, {})).status).toBe(401);
      expect((await post('/exec', { session: 'j1', command: 'id' }, { authorization: 'Bearer nope' })).status).toBe(401);
      expect((await post('/exec', { session: 'j1', command: 'id' }, { authorization: 'Bearer s3cret', origin: 'https://evil.example' })).status).toBe(403);
      expect((await post('/exec', { session: '../../x', command: 'id' })).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('runs a job’s commands in its own shell and edits files in the workspace', async () => {
    const { server, post } = await start();
    try {
      await post('/exec', { session: 'job-1', command: 'cd /tmp' });
      const one = await (await post('/exec', { session: 'job-1', command: 'pwd' })).json();
      const two = await (await post('/exec', { session: 'job-2', command: 'pwd' })).json();
      expect(one.output).toMatch(/\/tmp$/);
      expect(two.output.trim().endsWith(path.basename(dir))).toBe(true); // its own shell, still in the workspace
      const made = await (await post('/files/create', { path: 'report.md', file_text: '# Report' })).json();
      expect(made.text).toMatch(/^Created report.md/);
      const bad = await post('/files/view', { path: '/etc/passwd' });
      expect(bad.status).toBe(403);
      expect((await bad.json()).error).toMatch(/outside the workspace/);
    } finally {
      server.close();
    }
  });
});
