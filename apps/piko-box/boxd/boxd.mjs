// boxd — the agent's hands inside Relay's computer.
//
// The agent's brain (the model loop, your model key, your account tokens) stays in the worker.
// The box only *does* things, and this daemon is how: run a shell command, read or edit a file,
// take a screenshot, move the mouse, press keys. The worker maps Anthropic's trained tools
// (bash, the text editor, the computer toolset) onto these endpoints, one structured request each.
//
// It runs as the unix user `agent`, so everything it starts can touch the workspace and the screen
// but not the browser's profile (owned by `relay`, mode 700). The box's start script also blocks
// `agent` from Chromium's DevTools ports, so a prompt-injected shell can't read your cookies.
//
// Every endpoint but /health needs `Authorization: Bearer <RELAY_BOXD_TOKEN>`. Requests that carry an
// Origin are refused, so no web page — not even one open in the box's own browser — can use it.
// Plain Node (18+), no dependencies: it runs on whatever Node the box's Debian ships.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = {
  /** characters of command output handed back to the model */
  output: 30_000,
  /** characters of a file shown by `view` */
  view: 16_000,
  /** a command's default and maximum running time */
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  /** a job's shell is put away after this long unused */
  idleMs: 15 * 60_000,
  /** the screen stays one job's for this long after its last action */
  leaseMs: 60_000,
  /** request bodies (file_text can be a whole file) */
  bodyBytes: 8 * 1024 * 1024,
  /** the largest finished file the box will hand back for delivery, before base64 */
  deliver: 25 * 1024 * 1024,
};

/** An error with the HTTP status it should be answered with. */
export class BoxdError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Keep the head and the tail of a long text; the middle is rarely what the model needs. */
export function clip(text, max = LIMITS.output) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters cut] …\n${text.slice(-tail)}`;
}

// --- The shell ------------------------------------------------------------------------------
//
// One bash per job, kept between calls so `cd`, variables and activated environments persist —
// the way Anthropic's bash tool expects. Each command runs with stdin from /dev/null (a stray
// `cat` can't swallow the next command) and stderr folded into stdout, then a random end marker
// carries its exit code back.

export class Shell {
  #proc;
  #buf = '';
  #version = 0;
  #wake;
  #queue = Promise.resolve();

  /** @param {{ cwd: string, env: NodeJS.ProcessEnv, bin?: string, maxBuffer?: number }} opts */
  constructor({ cwd, env, bin = '/bin/bash', maxBuffer = 4_000_000 }) {
    this.cwd = cwd;
    this.env = env;
    this.bin = bin;
    this.maxBuffer = maxBuffer;
    this.lastUsed = Date.now();
  }

  #spawn() {
    const proc = spawn(this.bin, ['--noprofile', '--norc'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // its own process group, so a timeout can stop everything it started
    });
    const take = (chunk) => {
      this.#buf += chunk;
      if (this.#buf.length > this.maxBuffer) this.#buf = this.#buf.slice(-this.maxBuffer);
      this.#bump();
    };
    proc.stdout.setEncoding('utf8').on('data', take);
    proc.stderr.setEncoding('utf8').on('data', take); // bash's own errors (syntax, missing commands)
    proc.stdin.on('error', () => {}); // the shell exited mid-write; #run notices it
    proc.on('exit', () => {
      if (this.#proc === proc) this.#proc = undefined;
      this.#bump();
    });
    this.#proc = proc;
    return proc;
  }

  #bump() {
    this.#version += 1;
    this.#wake?.();
  }

  /** Resolve once new output (or an exit) arrives after `seen`, or after `ms`. */
  #changed(seen, ms) {
    if (this.#version !== seen) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    });
  }

  /** Run one command. Calls for the same shell wait their turn. */
  run(command, timeoutMs = LIMITS.timeoutMs) {
    const job = this.#queue.then(() => this.#run(command, timeoutMs));
    this.#queue = job.catch(() => {});
    return job;
  }

  async #run(command, timeoutMs) {
    this.lastUsed = Date.now();
    const proc = this.#proc ?? this.#spawn();
    const mark = `__relay_done_${randomBytes(8).toString('hex')}__`;
    const end = new RegExp(`\\n?${mark} (\\d+)\\n`);
    this.#buf = ''; // output a background job printed since the last command isn't this command's
    proc.stdin.write(`{ ${command}\n} < /dev/null 2>&1\nprintf '\\n${mark} %s\\n' "$?"\n`);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const seen = this.#version;
      const m = end.exec(this.#buf);
      if (m) {
        const output = this.#buf.slice(0, m.index);
        this.#buf = this.#buf.slice(m.index + m[0].length);
        this.lastUsed = Date.now();
        return { output, exitCode: Number(m[1]) };
      }
      if (this.#proc !== proc) {
        const output = this.#buf;
        this.#buf = '';
        return { output, exitCode: proc.exitCode, exited: true };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        const output = this.#buf;
        this.kill();
        return { output, exitCode: null, timedOut: true };
      }
      await this.#changed(seen, Math.min(left, 1000));
    }
  }

  /** Stop the shell and everything it started. The next command gets a fresh one. */
  kill() {
    const proc = this.#proc;
    this.#proc = undefined;
    this.#buf = '';
    if (!proc) return;
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  }
}

/** The text the model reads back from one command. */
export function describeRun(result, timeoutMs) {
  let text = clip(result.output.replace(/\n$/, ''));
  if (result.timedOut) {
    text += `${text ? '\n' : ''}[stopped after ${Math.round(timeoutMs / 1000)}s — the command didn't finish (waiting for input, or unbalanced quotes?). The shell was restarted; cd and variables were reset.]`;
  } else if (result.exited) {
    text += `${text ? '\n' : ''}[the shell exited${result.exitCode == null ? '' : ` with code ${result.exitCode}`} — the next command starts a new one]`;
  } else if (result.exitCode !== 0) {
    text += `${text ? '\n' : ''}[exit code ${result.exitCode}]`;
  }
  return text || '(no output)';
}

// --- The workspace (Anthropic's text editor tool) --------------------------------------------
//
// Every path is resolved inside the workspace root — through symlinks — before anything is read
// or written. Relative paths are relative to the root.

const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export class Workspace {
  /** @param {string} root */
  constructor(root) {
    this.root = path.resolve(root);
  }

  /** The real path for `p`, or an error if it — or a symlink on the way — leads outside the root. */
  async resolve(p) {
    if (typeof p !== 'string' || !p.trim()) throw new BoxdError(400, 'path is required');
    const root = await fs.realpath(this.root);
    const abs = path.resolve(root, p.trim());
    if (!within(root, abs)) throw new BoxdError(403, `${p} is outside the workspace (${this.root})`);
    // Resolve symlinks on the deepest part that exists; the rest will be created inside it.
    const missing = [];
    let probe = abs;
    for (;;) {
      try {
        const real = path.join(await fs.realpath(probe), ...missing);
        if (!within(root, real)) throw new BoxdError(403, `${p} leads outside the workspace (${this.root})`);
        return real;
      } catch (err) {
        if (err instanceof BoxdError || err.code !== 'ENOENT') throw err;
        missing.unshift(path.basename(probe));
        probe = path.dirname(probe);
      }
    }
  }

  async view(p, range) {
    const file = await this.resolve(p);
    const stat = await fs.stat(file).catch(() => {
      throw new BoxdError(404, `${p} doesn't exist`);
    });
    if (stat.isDirectory()) return this.#list(file);
    const buf = await fs.readFile(file);
    if (buf.includes(0)) return `${p} is a binary file (${buf.length} bytes) — use bash to inspect or convert it.`;
    const lines = buf.toString('utf8').split('\n');
    let from = 1;
    let to = lines.length;
    if (range !== undefined && range !== null) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)) {
        throw new BoxdError(400, 'view_range must be [start, end] (end -1 = to the end)');
      }
      from = range[0];
      to = range[1] === -1 ? lines.length : range[1];
      if (from < 1 || from > lines.length || to < from) {
        throw new BoxdError(400, `view_range ${JSON.stringify(range)} is outside the file's ${lines.length} lines`);
      }
    }
    const shown = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`);
    return clip(shown.join('\n'), LIMITS.view);
  }

  /** Two levels deep, hidden files and dependency folders left out. */
  async #list(dir) {
    const out = [];
    const walk = async (d, depth) => {
      const entries = (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
        const full = path.join(d, e.name);
        out.push(`${path.relative(dir, full)}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && depth < 2 && out.length < 400) await walk(full, depth + 1);
      }
    };
    await walk(dir, 1);
    const shown = out.length ? out.slice(0, 400).join('\n') : '(empty)';
    return `${dir}:\n${shown}${out.length > 400 ? `\n… and ${out.length - 400} more` : ''}`;
  }

  async create(p, text) {
    if (typeof text !== 'string') throw new BoxdError(400, 'file_text is required');
    const file = await this.resolve(p);
    const existed = await fs.stat(file).then(() => true, () => false);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return `${existed ? 'Overwrote' : 'Created'} ${p} (${text.split('\n').length} lines).`;
  }

  /**
   * A finished file's raw bytes, for handing to the user (a .pptx the agent built, a chart, an MP4).
   * This is the delivery path, not the model's eyes: the bytes go to the server, never into the
   * agent's context. Capped so one file can't blow up the reply.
   */
  async readBytes(p) {
    const file = await this.resolve(p);
    const stat = await fs.stat(file).catch(() => {
      throw new BoxdError(404, `${p} doesn't exist`);
    });
    if (stat.isDirectory()) throw new BoxdError(400, `${p} is a folder — name a file, or zip it first`);
    if (stat.size > LIMITS.deliver) {
      throw new BoxdError(413, `${p} is ${(stat.size / 1_048_576).toFixed(1)} MB — over the ${LIMITS.deliver / 1_048_576} MB delivery limit`);
    }
    const buf = await fs.readFile(file);
    return { name: path.basename(file), size: buf.length, data: buf.toString('base64') };
  }

  async strReplace(p, oldStr, newStr) {
    if (typeof oldStr !== 'string' || !oldStr) throw new BoxdError(400, 'old_str is required');
    const file = await this.resolve(p);
    const text = await fs.readFile(file, 'utf8').catch(() => {
      throw new BoxdError(404, `${p} doesn't exist`);
    });
    const count = text.split(oldStr).length - 1;
    if (count === 0) throw new BoxdError(400, `old_str wasn't found in ${p} — view the file and copy the text exactly`);
    if (count > 1) throw new BoxdError(400, `old_str appears ${count} times in ${p} — include more surrounding text so it matches once`);
    const at = text.indexOf(oldStr);
    const next = text.slice(0, at) + (newStr ?? '') + text.slice(at + oldStr.length);
    await fs.writeFile(file, next);
    const line = text.slice(0, at).split('\n').length;
    return `Edited ${p}.\n${snippet(next, line, (newStr ?? '').split('\n').length)}`;
  }

  async insert(p, after, text) {
    if (!Number.isInteger(after) || after < 0) throw new BoxdError(400, 'insert_line must be a line number (0 = the top)');
    if (typeof text !== 'string') throw new BoxdError(400, 'insert_text is required');
    const file = await this.resolve(p);
    const lines = (await fs.readFile(file, 'utf8').catch(() => {
      throw new BoxdError(404, `${p} doesn't exist`);
    })).split('\n');
    if (after > lines.length) throw new BoxdError(400, `${p} has only ${lines.length} lines`);
    lines.splice(after, 0, ...text.split('\n'));
    await fs.writeFile(file, lines.join('\n'));
    return `Inserted after line ${after} of ${p}.\n${snippet(lines.join('\n'), after + 1, text.split('\n').length)}`;
  }
}

/** The edited lines with a little context, numbered like `view`. */
function snippet(text, line, count, context = 3) {
  const lines = text.split('\n');
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + count - 1 + context);
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');
}

// --- The screen ------------------------------------------------------------------------------
//
// Screenshots through ImageMagick's `import`, mouse and keyboard through xdotool — always as an
// argument list, never through a shell, so nothing the model writes is ever parsed as a command.

const BUTTON = { left_click: '1', middle_click: '2', right_click: '3', double_click: '1', triple_click: '1' };
const CLICKS = { left_click: 1, middle_click: 1, right_click: 1, double_click: 2, triple_click: 3 };
const WHEEL = { up: '4', down: '5', left: '6', right: '7' };

/** `[cmd, args]` runner; resolves stdout. Injectable so the mapping is testable without X. */
const runFile = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
      if (err) reject(new BoxdError(500, `${cmd} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });

export class Desktop {
  #owner;
  #lastUse = 0;

  /** @param {{ width: number, height: number, display: string, run?: typeof runFile, now?: () => number }} opts */
  constructor({ width, height, display, run = runFile, now = Date.now }) {
    this.width = width;
    this.height = height;
    this.display = display;
    this.run = run;
    this.now = now;
  }

  /** One job drives the screen at a time; another gets a clear "busy" until the lease runs out. */
  claim(session) {
    const t = this.now();
    if (this.#owner && this.#owner !== session && t - this.#lastUse < LIMITS.leaseMs) {
      throw new BoxdError(409, 'Another task is using the screen right now — try again in a moment.');
    }
    this.#owner = session;
    this.#lastUse = t;
  }

  #point(c, name = 'coordinate') {
    if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)) throw new BoxdError(400, `${name} must be [x, y]`);
    const [x, y] = c.map(Math.round);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new BoxdError(400, `${name} [${x}, ${y}] is off the ${this.width}×${this.height} screen`);
    }
    return [String(x), String(y)];
  }

  #keys(text, name = 'text') {
    const keys = typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean) : [];
    if (!keys.length) throw new BoxdError(400, `${name} must name a key, like "Return" or "ctrl+s"`);
    return keys;
  }

  /** Modifier keys to hold during a click or scroll ("shift", "ctrl+alt"), as xdotool keysyms. */
  #modifiers(text) {
    if (text === undefined || text === null || text === '') return [];
    return this.#keys(String(text).replace(/\+/g, ' '), 'text');
  }

  async #xdo(...args) {
    await this.run('xdotool', args, { env: { ...process.env, DISPLAY: this.display } });
  }

  async screenshot(region) {
    const args = ['-display', this.display, '-silent', '-window', 'root'];
    if (region !== undefined && region !== null) {
      if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) {
        throw new BoxdError(400, 'region must be [x0, y0, x1, y1]');
      }
      const [x0, y0] = this.#point(region.slice(0, 2), 'region start').map(Number);
      const [x1, y1] = region.slice(2).map(Math.round).map((v, i) => Math.min(v, i === 0 ? this.width : this.height));
      if (x1 <= x0 || y1 <= y0) throw new BoxdError(400, 'region must have x1 > x0 and y1 > y0');
      // A zoom: that region, enlarged to fill the screen's size so small text becomes readable.
      args.push('-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage', '-resize', `${this.width}x${this.height}`);
    }
    args.push('png:-');
    const png = await this.run('import', args);
    return { data: Buffer.from(png).toString('base64'), media_type: 'image/png' };
  }

  async cursor() {
    const out = String(await this.run('xdotool', ['getmouselocation', '--shell'], { env: { ...process.env, DISPLAY: this.display } }));
    const x = Number(/X=(\d+)/.exec(out)?.[1]);
    const y = Number(/Y=(\d+)/.exec(out)?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BoxdError(500, 'couldn’t read the mouse position');
    return { x, y };
  }

  /** One computer-toolset member, by name, with the model's input. */
  async act(name, input = {}) {
    switch (name) {
      case 'mouse_move':
        return this.#xdo('mousemove', '--sync', ...this.#point(input.coordinate));
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        if (input.coordinate) await this.#xdo('mousemove', '--sync', ...this.#point(input.coordinate));
        const mods = this.#modifiers(input.text);
        if (mods.length) await this.#xdo('keydown', ...mods);
        try {
          await this.#xdo('click', '--repeat', String(CLICKS[name]), '--delay', '80', BUTTON[name]);
        } finally {
          if (mods.length) await this.#xdo('keyup', ...mods);
        }
        return;
      }
      case 'left_mouse_down':
        return this.#xdo('mousedown', '1');
      case 'left_mouse_up':
        return this.#xdo('mouseup', '1');
      case 'left_click_drag': {
        const from = this.#point(input.start_coordinate, 'start_coordinate');
        const to = this.#point(input.coordinate);
        await this.#xdo('mousemove', '--sync', ...from);
        await this.#xdo('mousedown', '1');
        await this.#xdo('mousemove', '--sync', ...to);
        return this.#xdo('mouseup', '1');
      }
      case 'scroll': {
        const button = WHEEL[input.scroll_direction];
        if (!button) throw new BoxdError(400, 'scroll_direction must be up, down, left or right');
        const amount = Math.max(1, Math.min(30, Math.round(Number(input.scroll_amount) || 1)));
        if (input.coordinate) await this.#xdo('mousemove', '--sync', ...this.#point(input.coordinate));
        const mods = this.#modifiers(input.text);
        if (mods.length) await this.#xdo('keydown', ...mods);
        try {
          await this.#xdo('click', '--repeat', String(amount), '--delay', '30', button);
        } finally {
          if (mods.length) await this.#xdo('keyup', ...mods);
        }
        return;
      }
      case 'key': {
        const repeat = Math.max(1, Math.min(50, Math.round(Number(input.repeat) || 1)));
        return this.#xdo('key', '--repeat', String(repeat), '--delay', '40', '--', ...this.#keys(input.text));
      }
      case 'hold_key': {
        const keys = this.#keys(input.text);
        const seconds = Math.max(0, Math.min(10, Number(input.duration) || 0));
        await this.#xdo('keydown', '--', ...keys);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return this.#xdo('keyup', '--', ...keys);
      }
      case 'type': {
        if (typeof input.text !== 'string') throw new BoxdError(400, 'text is required');
        // Chunks keep xdotool from dropping characters on long strings.
        for (let i = 0; i < input.text.length; i += 64) {
          await this.#xdo('type', '--delay', '8', '--', input.text.slice(i, i + 64));
        }
        return;
      }
      default:
        throw new BoxdError(400, `the box can't do “${name}”`);
    }
  }
}

// --- HTTP -----------------------------------------------------------------------------------

const SESSION = /^[\w.:-]{1,80}$/;

const sameSecret = (given, expected) => {
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.bodyBytes) throw new BoxdError(413, 'request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new BoxdError(400, 'body must be JSON');
  }
}

/**
 * The daemon. `newShell(session)` makes a job's shell; shells nobody used for a while are put away.
 * @param {{ token: string, workspace: Workspace, desktop: Desktop, newShell: () => Shell, log?: (line: string) => void }} opts
 */
export function createBoxd({ token, workspace, desktop, newShell, log = () => {} }) {
  if (!token) throw new Error('boxd needs a token');
  const shells = new Map();
  const shellFor = (session) => {
    let shell = shells.get(session);
    if (!shell) shells.set(session, (shell = newShell()));
    return shell;
  };
  const reaper = setInterval(() => {
    for (const [session, shell] of shells) {
      if (Date.now() - shell.lastUsed > LIMITS.idleMs) {
        shell.kill();
        shells.delete(session);
      }
    }
  }, 60_000);
  reaper.unref();

  const session = (body) => {
    if (typeof body.session !== 'string' || !SESSION.test(body.session)) throw new BoxdError(400, 'session must be a short id');
    return body.session;
  };

  const routes = {
    'POST /exec': async (body) => {
      const s = session(body);
      if (body.restart === true) {
        shells.get(s)?.kill();
        return { output: 'The shell was restarted.' };
      }
      if (typeof body.command !== 'string' || !body.command.trim()) throw new BoxdError(400, 'command is required');
      const timeoutMs = Math.min(LIMITS.maxTimeoutMs, Math.max(1000, Number(body.timeout_ms) || LIMITS.timeoutMs));
      log(`exec ${s} ${body.command.replace(/\s+/g, ' ').slice(0, 160)}`);
      const result = await shellFor(s).run(body.command, timeoutMs);
      return { output: describeRun(result, timeoutMs), exit_code: result.exitCode, timed_out: !!result.timedOut };
    },
    'POST /files/view': async (b) => ({ text: await workspace.view(b.path, b.view_range) }),
    'POST /files/create': async (b) => ({ text: await workspace.create(b.path, b.file_text) }),
    'POST /files/read': async (b) => workspace.readBytes(b.path),
    'POST /files/str_replace': async (b) => ({ text: await workspace.strReplace(b.path, b.old_str, b.new_str) }),
    'POST /files/insert': async (b) => ({ text: await workspace.insert(b.path, b.insert_line, b.insert_text) }),
    'POST /screenshot': async (b) => {
      desktop.claim(session(b));
      return desktop.screenshot(b.region);
    },
    'POST /cursor': async (b) => {
      desktop.claim(session(b));
      return desktop.cursor();
    },
    'POST /input': async (b) => {
      desktop.claim(session(b));
      if (typeof b.action !== 'string') throw new BoxdError(400, 'action is required');
      await desktop.act(b.action, b.input ?? {});
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.origin) throw new BoxdError(403, 'forbidden');
      const route = `${req.method} ${new URL(req.url ?? '/', 'http://boxd').pathname}`;
      if (route === 'GET /health') return reply(200, { ok: true, screen: { width: desktop.width, height: desktop.height } });
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!auth || !sameSecret(auth, token)) throw new BoxdError(401, 'unauthorized');
      const handler = routes[route];
      if (!handler) throw new BoxdError(404, 'not found');
      reply(200, await handler(await readJson(req)));
    } catch (err) {
      const status = err instanceof BoxdError ? err.status : 500;
      if (status === 500) log(`error ${err?.stack ?? err}`);
      reply(status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.on('close', () => {
    clearInterval(reaper);
    for (const shell of shells.values()) shell.kill();
  });
  return server;
}

/** What a job's shell may see: enough to work, none of Relay's secrets. */
export function shellEnv(env, home) {
  return {
    HOME: home,
    USER: env.USER ?? 'agent',
    LOGNAME: env.USER ?? 'agent',
    SHELL: '/bin/bash',
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: env.LANG ?? 'C.UTF-8',
    DISPLAY: env.DISPLAY ?? ':99',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONUNBUFFERED: '1',
  };
}

// --- Run it ------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  // The box hands the token over in a file only `agent` can read, and boxd deletes it once read: it
  // then lives only in this process's memory — not in a file or an environment the shell can see.
  let token = env.RELAY_BOXD_TOKEN;
  if (!token && env.RELAY_BOXD_TOKEN_FILE) {
    token = (await fs.readFile(env.RELAY_BOXD_TOKEN_FILE, 'utf8')).trim();
    await fs.rm(env.RELAY_BOXD_TOKEN_FILE, { force: true });
  }
  delete env.RELAY_BOXD_TOKEN;
  delete env.RELAY_BOXD_TOKEN_FILE;
  if (!token) {
    console.error('[boxd] RELAY_BOXD_TOKEN or RELAY_BOXD_TOKEN_FILE is required');
    process.exit(1);
  }
  const home = env.RELAY_WORKSPACE ?? env.HOME ?? '/home/agent';
  const [width, height] = (env.SCREEN ?? '1280x800').split('x').map(Number);
  const childEnv = shellEnv(env, home);
  const server = createBoxd({
    token,
    workspace: new Workspace(home),
    desktop: new Desktop({ width, height, display: env.DISPLAY ?? ':99' }),
    newShell: () => new Shell({ cwd: home, env: childEnv }),
    log: (line) => console.log(`[boxd] ${line}`),
  });
  const port = Number(env.BOXD_PORT ?? 7070);
  server.listen(port, env.BOXD_HOST ?? '0.0.0.0', () => console.log(`[boxd] listening on ${port}, workspace ${home}`));
}
