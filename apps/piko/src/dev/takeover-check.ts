// End-to-end check of screen takeover, including the ways it must refuse: `pnpm check:takeover` (add --liff to
// check the LINE identity gate too). Plays LINE and the phone around a real worker, gateway and box, with the
// fake model, which asks for a takeover when told 「幫我登入」.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureTemporal, startNode, waitForHealth } from './procs.js';

const LIFF = process.argv.includes('--liff');
// --browser: also run a takeover the way a phone does, in headless Chrome (needs Google Chrome; not with --liff).
const BROWSER = process.argv.includes('--browser') && !LIFF;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// A new user (and so a new box) every run: nothing from an earlier run can stand in for this one.
const USER = `Utakeovercheck${Date.now()}`;
const SECRET = 'dev-secret';
const GATEWAY = 8795;
const LINE = 8796;
const ORIGIN = `http://127.0.0.1:${GATEWAY}`;
const DATA = '.data/piko-check';
const IMAGE = process.env.PIKO_BOX_IMAGE ?? 'piko-box:next';

let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures++;
}

// LINE's API, as far as this check needs it: every message Piko sends lands in `sent`.
const sent: unknown[] = [];
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/oauth2/v2.1/verify') {
      const form = new URLSearchParams(raw);
      const user = /^dev-id-token:(U\w+)$/.exec(form.get('id_token') ?? '')?.[1];
      if (!user) return void res.writeHead(400).end('{}');
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ sub: user, aud: form.get('client_id'), exp: Math.floor(Date.now() / 1000) + 600 }));
    }
    const body = (raw ? JSON.parse(raw) : {}) as { messages?: unknown[] };
    sent.push(...(body.messages ?? []));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
}).listen(LINE, '127.0.0.1');

function say(text: string): Promise<Response> {
  const body = JSON.stringify({
    destination: 'Udevbot',
    events: [
      {
        type: 'message',
        mode: 'active',
        timestamp: Date.now(),
        webhookEventId: randomUUID(),
        replyToken: randomUUID(),
        source: { type: 'user', userId: USER },
        message: { id: String(Date.now()), type: 'text', text },
      },
    ],
  });
  return fetch(`${ORIGIN}/webhooks/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', SECRET).update(body).digest('base64') },
    body,
  });
}

/** A refusal counts only if it is the expected one: right status, and the reason the page would show. */
async function refused(res: Promise<Response>, status: number, reason: string): Promise<boolean> {
  const r = await res;
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return r.status === status && (body.error ?? '').includes(reason);
}

function open(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${ORIGIN}/takeover/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** A raw WebSocket handshake through the gateway; resolves with the status line and the first bytes after it. */
function screen(headers: Record<string, string>): Promise<{ status: string; first: Buffer }> {
  return new Promise((resolve) => {
    const socket = connect(GATEWAY, '127.0.0.1');
    let data = Buffer.alloc(0);
    const done = () => {
      socket.destroy();
      const end = data.indexOf('\r\n\r\n');
      resolve({ status: data.subarray(0, data.indexOf('\r\n')).toString(), first: end >= 0 ? data.subarray(end + 4) : Buffer.alloc(0) });
    };
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf('\r\n\r\n');
      if (end >= 0 && (!data.toString().startsWith('HTTP/1.1 101') || data.length > end + 4 + 12)) done();
    });
    socket.on('error', done);
    setTimeout(done, 5000);
    const lines = [
      'GET /takeover/ws HTTP/1.1',
      `Host: 127.0.0.1:${GATEWAY}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
}

function box(...args: string[]): string {
  return boxAs('root', ...args);
}

function boxAs(user: string, ...args: string[]): string {
  try {
    return execFileSync('docker', ['exec', '-u', user, `piko-box-${boxId}`, ...args], { encoding: 'utf8' }).trim();
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '').trim();
  }
}

/** The HTTP status `user` gets for `url` from inside the box ('000' when the connection is refused). */
function reach(user: string, url: string): string {
  return boxAs(user, 'curl', '-s', '-m', '4', '-o', '/dev/null', '-w', '%{http_code}', url) || '000';
}

function linkIn(messages: unknown[]): string | undefined {
  return /"uri":"([^"]*(?:\/takeover\?t=|liff\.line\.me\/)[^"]*)"/.exec(JSON.stringify(messages))?.[1];
}

async function until<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  for (let waited = 0; waited < ms; waited += 250) {
    const value = get();
    if (value !== undefined) return value;
    await delay(250);
  }
  return undefined;
}

const boxId = createHash('sha256').update(USER).digest('hex').slice(0, 12);

/** Headless Chrome over its DevTools protocol, sized and touch-enabled like a phone. */
async function phone(url: string) {
  const port = 9333;
  const profile = mkdtempSync(join(tmpdir(), 'piko-phone-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    await delay(200);
    target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>)
      .then((list) => list.find((t) => t.type === 'page'))
      .catch(() => undefined);
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let next = 0;
  const waiting = new Map<number, (value: { result?: Record<string, unknown> }) => void>();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown> }>((resolve) => {
      waiting.set(++next, resolve);
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const run = async <T>(expression: string): Promise<T> =>
    ((await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result as { value: T } | undefined)?.value as T;
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  const shot = async (file: string) => {
    const { result } = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync('.context', { recursive: true });
    writeFileSync(file, Buffer.from(String(result?.data ?? ''), 'base64'));
  };
  const close = async () => {
    ws.close();
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { run, shot, close };
}

/** A whole takeover the way a phone does it: open, see the screen, type into the box's page, hand back. */
async function asAPhone(): Promise<void> {
  const { ensureBox, boxd } = await import('../box/manager.js');
  const computer = await ensureBox(USER);
  const act = (action: string, input: Record<string, unknown>) => boxd(computer, '/input', { session: 'check', action, input });
  // The box's browser shows a text box, the way a sign-in page would.
  await act('key', { text: 'ctrl+l' });
  // The page copies what reaches its input into its title, so the check can tell the page from the address bar.
  await act('type', { text: 'data:text/html,<title>sign in</title><input autofocus oninput="document.title=this.value" style="font-size:64px;width:90%" placeholder="password">' });
  await act('key', { text: 'Return' });
  await delay(2000);

  sent.length = 0;
  await say('幫我登入另一個網站');
  const url = await until(() => linkIn(sent), 20_000);
  if (!url) return check(false, 'phone: Piko sent a second takeover button');
  const browser = await phone(url);
  try {
    let shown = false;
    for (let i = 0; i < 60 && !shown; i++) {
      await delay(250);
      shown = await browser.run<boolean>("!document.getElementById('controls').hidden && !!document.querySelector('#screen canvas')");
    }
    check(shown, 'phone: the page opens, connects, and shows the box’s screen');
    const [w = 0, h = 0] = box('sh', '-c', 'DISPLAY=:99 xdotool getdisplaygeometry').split(' ').map(Number);
    check(w < h && w >= 640 && w <= 1200, `phone: the takeover screen is phone-shaped (${w}x${h}), so sites show their mobile layout`);
    check((await browser.run<string>('location.search')) === '', 'phone: the ticket is gone from the address bar');
    await delay(1500);
    await browser.shot('.context/takeover-phone-screen.png');
    await browser.run<boolean>("(() => { const t = document.getElementById('text'); t.value = 'hello piko 123'; document.getElementById('typer').requestSubmit(); return true; })()");
    await delay(1500);
    const xdo = (...args: string[]) => execFileSync('docker', ['exec', '-u', 'relay', '-e', 'DISPLAY=:99', `piko-box-${boxId}`, ...args], { encoding: 'utf8' });
    check(xdo('xdotool', 'getactivewindow', 'getwindowname').startsWith('hello piko 123'), 'phone: what was typed on the phone reached the sign-in page’s field (not the address bar)');
    xdo('xdotool', 'key', 'ctrl+a', 'ctrl+c');
    await delay(300);
    check(xdo('xsel', '-ob').trim() === 'hello piko 123', 'phone: and it is exactly what was typed');
    writeFileSync('.context/takeover-box-screen.png', execFileSync('docker', ['exec', '-u', 'relay', '-e', 'DISPLAY=:99', `piko-box-${boxId}`, 'import', '-window', 'root', 'png:-']));
    await browser.run<boolean>("(() => { document.getElementById('done').click(); return true; })()");
    let thanked = false;
    for (let i = 0; i < 40 && !thanked; i++) {
      await delay(250);
      thanked = await browser.run<boolean>("!document.getElementById('message').hidden && document.getElementById('message-title').textContent.includes('完成')");
    }
    check(thanked, 'phone: 完成 hands the computer back');
    await browser.shot('.context/takeover-phone-done.png');
    const resumed = await until(() => (JSON.stringify(sent).includes('畫面交回來了') ? true : undefined), 20_000);
    check(Boolean(resumed), 'phone: Piko carries on');
    await until(() => (box('pgrep', '-u', 'agent', '-c') !== '0' ? true : undefined), 10_000);
    check(xdo('sh', '-c', 'xsel -ob || true').trim() === '', 'phone: the clipboard used during the takeover is cleared afterwards');
    check(box('sh', '-c', 'DISPLAY=:99 xdotool getdisplaygeometry') === '1280 800', 'phone: afterwards the agent has its 1280x800 desktop back');
  } finally {
    await browser.close();
  }
}

function cleanUp(): void {
  execFileSync('docker', ['rm', '-f', `piko-box-${boxId}`], { stdio: 'ignore' });
  execFileSync('docker', ['volume', 'rm', '-f', `piko-profile-${boxId}`, `piko-home-${boxId}`], { stdio: 'ignore' });
}

await ensureTemporal();
const env = {
  ...process.env,
  LINE_CHANNEL_SECRET: SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: 'dev-token',
  LINE_API_BASE: `http://127.0.0.1:${LINE}`,
  PORT: String(GATEWAY),
  PUBLIC_URL: '',
  NGROK_DOMAIN: '',
  PIKO_DATA_DIR: DATA,
  PIKO_TASK_QUEUE: 'piko-check',
  PIKO_MODEL: 'fake',
  PIKO_BOX_IMAGE: IMAGE,
  LIFF_ID: LIFF ? 'dev-liff' : '',
  LINE_LOGIN_CHANNEL_ID: LIFF ? 'dev-login' : '',
};
// The box comes first (in real use the agent opened the sign-in page on it before asking).
process.env.PIKO_BOX_IMAGE = IMAGE;
const { ensureBox } = await import('../box/manager.js');
await ensureBox(USER);
startNode('worker', 'src/worker.ts', env);
startNode('gateway', 'src/gateway.ts', env);
await waitForHealth(`${ORIGIN}/healthz`);
await delay(2500); // the worker bundles its workflow code

// The box itself: internet yes; this machine's services, other boxes and private networks no — for the
// browser's user too, since the agent drives the browser.
for (const user of ['relay', 'agent', 'root']) {
  check(reach(user, 'http://host.docker.internal:7233/') === '000', `${user} can't reach this machine (Temporal)`);
  check(reach(user, `http://host.docker.internal:${GATEWAY}/healthz`) === '000', `${user} can't reach this machine (Piko's gateway)`);
  check(reach(user, 'http://169.254.169.254/') === '000', `${user} can't reach a cloud metadata service`);
}
check(['200', '301', '302'].includes(reach('relay', 'https://www.google.com/')), 'the browser’s user still reaches the internet');
check(
  ['9222', '9223'].every((port) => reach('root', `http://127.0.0.1:${port}/json/version`) === '000') &&
    box('pgrep', '-f', 'remote-debugging') === '' &&
    box('pgrep', '-c', 'chromium') !== '0',
  'Chromium runs, with no DevTools port',
);
// Seccomp, and Chromium's own sandbox working inside it.
check(/^Seccomp:\s+2$/m.test(box('cat', '/proc/1/status')), 'the box runs under a seccomp filter (not unconfined)');
await until(() => (box('pgrep', '-f', '--', '--type=zygote') !== '' ? true : undefined), 15_000);
check(
  box('pgrep', '-f', '--', '--type=zygote') !== '' && !box('cat', '/home/relay/log/chromium.log').includes('No usable sandbox'),
  'Chromium’s own sandbox is on (zygote running, no sandbox errors)',
);
// Through boxd, the way the agent's own commands run (docker exec would start outside boxd's filter).
const { boxd: boxdCall, ensureBox: ensure } = await import('../box/manager.js');
const probe = await boxdCall<{ output: string; exit_code: number }>(await ensure(USER), '/exec', {
  session: 'check',
  command: 'unshare -Ur true; echo "unshare=$?"; python3 -c "import os; os.unshare(0x10000000)" 2>&1 | tail -1; echo "plain=$(echo works)"',
});
check(
  /unshare=[1-9]/.test(probe.output) && /PermissionError|Operation not permitted/.test(probe.output) && probe.output.includes('plain=works'),
  'the agent’s commands can’t create user namespaces (and still run)',
);
check(box('pgrep', '-u', 'screen', '-x', 'Xvfb') !== '', 'the X server runs as its own user');
check(/Permission denied/.test(boxAs('screen', 'sh', '-c', 'ls /home/relay/profile 2>&1')), 'the X server’s user can’t read the browser profile');

await say('幫我登入測試網站');
const link = await until(() => linkIn(sent), 20_000);
check(link !== undefined && (LIFF ? link.startsWith('https://liff.line.me/dev-liff?') : link.startsWith(`${ORIGIN}/takeover?`)), `Piko sent a takeover button (${LIFF ? 'LIFF' : 'direct'} link)`);
if (!link) {
  console.log('\nNo takeover button, so nothing else can be checked.');
  cleanUp();
  process.exit(1);
}
const ticket = new URL(link).searchParams.get('t') ?? '';
const [grant = '', ticketSecret = '?'] = ticket.split('.');
check(!readFileSync(join(DATA, 'takeover', `${grant}.json`), 'utf8').includes(ticketSecret), 'only the ticket’s hash is stored');

const pageRes = await fetch(`${ORIGIN}/takeover?t=${encodeURIComponent(ticket)}`);
check(pageRes.status === 200 && (pageRes.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), 'page served with a strict Content-Security-Policy');
check(pageRes.headers.get('referrer-policy') === 'no-referrer' && pageRes.headers.get('cache-control') === 'no-store', 'page is never cached and leaks no referrer');
check((await fetch(`${ORIGIN}/takeover/novnc/core/../../../package.json`)).status === 404, 'static files can’t escape their folder');

check(await refused(open({ ticket }, { origin: 'https://evil.example' }), 403, '請從 LINE 裡的按鈕打開'), 'refused: a request from another site');
check(await refused(open({ ticket: `${grant}.${'A'.repeat(43)}` }), 403, '這個連結無效'), 'refused: a forged ticket');
if (LIFF) {
  check(await refused(open({ ticket }), 403, '只有本人'), 'refused: no LINE identity');
  check(await refused(open({ ticket, idToken: 'dev-id-token:Usomeoneelse' }), 403, '只有本人'), 'refused: another LINE user (a forwarded link)');
}
check(box('pgrep', '-u', 'agent', '-c') !== '0', 'before opening, the agent is still on the box');
const screenBefore = box('pgrep', '-u', 'screen', '-x', 'Xvfb');

const opened = await open({ ticket, ...(LIFF ? { idToken: `dev-id-token:${USER}` } : {}) });
const setCookie = opened.headers.get('set-cookie') ?? '';
check(opened.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), 'the owner opens it and gets an HttpOnly, SameSite=Strict session cookie');
const cookie = setCookie.split(';')[0] ?? '';
check(await refused(open({ ticket, ...(LIFF ? { idToken: `dev-id-token:${USER}` } : {}) }), 410, '已經用過了'), 'refused: the same ticket a second time, even by the owner');
check(box('pgrep', '-u', 'agent', '-c') === '0', 'while the person has the screen, no agent process exists on the box');
check(box('pgrep', '-f', 'x11vnc -display :99 -rfbport 5900') !== '', 'the typing screen is open');
const screenDuring = box('pgrep', '-u', 'screen', '-x', 'Xvfb');
check(screenDuring !== '' && screenDuring !== screenBefore, 'the person gets a brand-new X server, not one the agent talked to');

check((await screen({ origin: ORIGIN })).status.includes('401'), 'screen refused without the session cookie');
check((await screen({ origin: 'https://evil.example', cookie })).status.includes('403'), 'screen refused from another site, even with the cookie');
const live = await screen({ origin: ORIGIN, cookie });
check(live.status.includes('101') && live.first.includes(Buffer.from('RFB 00')), 'screen connects through to the box’s VNC (RFB banner received)');

const done = await fetch(`${ORIGIN}/takeover/done`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie }, body: '{}' });
check(done.status === 200, 'handing back works');
check((await screen({ origin: ORIGIN, cookie })).status.includes('401'), 'after handing back, the cookie opens nothing');
const finished = await until(() => (JSON.stringify(sent).includes('畫面交回來了') ? true : undefined), 20_000);
check(Boolean(finished), 'Piko carries on with the task');
await until(() => (box('pgrep', '-u', 'agent', '-c') !== '0' ? true : undefined), 10_000);
check(box('pgrep', '-u', 'agent', '-c') !== '0', 'the agent is back on the box');
check(box('pgrep', '-f', 'x11vnc -display :99 -rfbport 5900') === '', 'the typing screen is closed again');

if (BROWSER) await asAPhone();

const auditLog = readFileSync(join(DATA, 'audit.jsonl'), 'utf8');
const secrets = [ticketSecret, cookie.split('.')[1] ?? ''].filter(Boolean);
check(auditLog.includes('takeover.opened') && secrets.every((s) => !auditLog.includes(s)), 'the audit log records the takeover and no secrets');

cleanUp();
console.log(failures === 0 ? '\nAll takeover checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
