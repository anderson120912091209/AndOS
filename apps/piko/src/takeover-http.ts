// The takeover screen over HTTP: the page and its scripts, opening a session, the screen's WebSocket, and
// handing the computer back. All of it faces the internet, so every request is checked before any work is
// done, and nothing secret (tickets, cookies, ID tokens, what the person types) is ever logged.
// The security model is in src/takeover.ts.
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { extname, join, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Client } from '@temporalio/client';
import { agentctl, typingScreen } from './box/manager.js';
import { APP_ROOT, config, liffReady } from './config.js';
import { audit, readGrant } from './store.js';
import { checkOpen, closeGrant, SESSION_TTL_MS, session, startSession } from './takeover.js';
import { handedBack } from './workflows.js';

const ORIGIN = config.publicUrl ? new URL(config.publicUrl).origin : `http://${config.host}:${config.port}`;
const SECURE = ORIGIN.startsWith('https:');
// __Host-: the browser only accepts it over https, for this exact host, with Path=/ — no subdomain can set it.
const COOKIE = SECURE ? '__Host-piko-takeover' : 'piko-takeover';
const WEB = join(APP_ROOT, 'web');
const NOVNC = realpathSync(join(APP_ROOT, 'node_modules/@novnc/novnc'));

/**
 * LIFF SDK 2.31.2, pinned: 2.20.0–2.31.0 have an XSS through crafted links (CVE-2026-112148). LINE's CDN
 * sends no CORS headers, so integrity checks can't apply; instead the policy allows only the paths the SDK
 * itself loads from it (its native-bridge extensions and alert UI), not the whole CDN.
 */
const LIFF_SDK = 'https://static.line-scdn.net/liff/edge/versions/2.31.2/sdk.js';
const LIFF_SCRIPTS = [LIFF_SDK, 'https://static.line-scdn.net/liff/edge/2/', 'https://static.line-scdn.net/lui/edge/versions/1.13.0/'];
const LIFF_CONNECT = ['https://api.line.me', 'https://access.line.me', 'https://liff.line.me', 'https://liffsdk.line-scdn.net'];

const CSP = [
  "default-src 'none'",
  `script-src 'self' ${liffReady() ? LIFF_SCRIPTS.join(' ') : ''}`,
  "style-src 'self'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${ORIGIN.replace(/^http/, 'ws')} ${liffReady() ? LIFF_CONNECT.join(' ') : ''}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function headers(type: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', // the ticket is in the page's URL until the page removes it
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(SECURE ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    ...extra,
  };
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, headers('application/json; charset=utf-8', extra)).end(JSON.stringify(body));
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) || req.socket.remoteAddress || '?';
}

function cookieOf(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return undefined;
}

/** Same-origin requests only: our page sends its Origin; another site's page can't forge it. */
function fromOurPage(req: IncomingMessage): boolean {
  return req.headers.origin === ORIGIN;
}

function readJson(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/** At most 30 attempts to open a screen per address per 10 minutes. Tickets can't be guessed; this is for floods. */
const attempts = new Map<string, number[]>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) attempts.clear();
  return recent.length > 30;
}

// The screen connections that are open, per takeover. One phone at a time: a new connection replaces the old.
const live = new Map<string, Duplex[]>();

function cut(id: string): void {
  for (const stream of live.get(id) ?? []) stream.destroy();
  live.delete(id);
}

// The worker can close a takeover too (the task moved on). Every few seconds, cut connections whose takeover
// is closed or whose session ran out; the box closing its typing screen is a second, independent cut.
setInterval(() => {
  for (const id of live.keys()) {
    const grant = readGrant(id);
    if (!grant || grant.closedAt || !grant.sessionExpiresAt || grant.sessionExpiresAt < Date.now()) cut(id);
  }
}, 3000).unref();

function page(res: ServerResponse): void {
  const liff = liffReady() ? config.liff.id.replace(/[^A-Za-z0-9-]/g, '') : '';
  const html = readFileSync(join(WEB, 'takeover.html'), 'utf8')
    .replace('{{LIFF_ID}}', liff)
    .replace('{{LIFF_SDK}}', liff ? `<script charset="utf-8" src="${LIFF_SDK}"></script>` : '');
  res.writeHead(200, headers('text/html; charset=utf-8', { 'content-security-policy': CSP })).end(html);
}

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** A file from a fixed folder, refusing anything that resolves outside it (../, symlinks) or isn't js/css. */
function asset(res: ServerResponse, root: string, relative: string): void {
  const type = TYPES[extname(relative)];
  let path: string;
  try {
    path = realpathSync(join(root, relative));
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (!type || !path.startsWith(root + sep) || !statSync(path).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { ...headers(type), 'cache-control': 'private, max-age=3600' });
  createReadStream(path).pipe(res);
}

/**
 * The takeover screen for the space the page has for it (CSS pixels): on a phone, the same shape, drawn at
 * 2x (agentctl), so websites lay out for a phone. Chromium's window is never narrower than 500 pixels, so
 * narrower phones get a 500-wide screen of their proportions (text a little smaller than native, still
 * large). Wider (a tablet or a computer) keeps the desktop.
 */
function phoneScreen(width: unknown, height: unknown): string | undefined {
  if (typeof width !== 'number' || typeof height !== 'number' || width >= 700) return undefined;
  const clamp = (n: number, low: number, high: number) => Math.round(Math.min(high, Math.max(low, n)));
  const w = clamp(width, 320, 600);
  const h = clamp(height, 300, 1000);
  const across = Math.max(w, 500);
  const down = Math.min(1000, Math.round((h * across) / w));
  return `${across * 2}x${down * 2}`;
}

/** Takeovers being opened right now (between the checks and the session being written). */
const inFlight = new Set<string>();

async function onOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req);
  if (!fromOurPage(req) || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '請從 LINE 裡的按鈕打開。' });
  if (tooMany(ip)) return json(res, 429, { error: '太多次了，請稍等幾分鐘再試。' });
  const body = await readJson(req);
  const text = (key: string) => (typeof body?.[key] === 'string' ? (body[key] as string) : undefined);
  const opening = await checkOpen({ ticket: text('ticket'), idToken: text('idToken'), cookie: cookieOf(req), ip });
  if (!opening.ok) return json(res, opening.status, { error: opening.message });

  let grant = opening.grant;
  let setCookie: Record<string, string> = {};
  if (!opening.resumed) {
    // A ticket opens once, even when two requests race with it (a double tap, or someone racing the owner).
    if (inFlight.has(grant.id)) return json(res, 409, { error: '正在打開，請稍等。' });
    inFlight.add(grant.id);
    try {
      // The agent goes first: no session exists until every process of Piko's on the box is gone.
      try {
        await agentctl(grant.userId, 'hold', phoneScreen(body?.width, body?.height));
      } catch (err) {
        audit('takeover.refused', { why: 'hold failed', grant: grant.id, ip });
        console.error('takeover hold failed:', err instanceof Error ? err.message : err);
        return json(res, 503, { error: '電腦現在交不出來，請回到 LINE 再試一次。' });
      }
      const started = startSession(grant, ip);
      grant = started.grant;
      const attributes = ['Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`, 'HttpOnly', 'SameSite=Strict', ...(SECURE ? ['Secure'] : [])];
      setCookie = { 'set-cookie': `${COOKIE}=${started.cookie}; ${attributes.join('; ')}` };
    } finally {
      inFlight.delete(grant.id);
    }
  }
  json(res, 200, { reason: grant.reason, expiresAt: grant.sessionExpiresAt, resumed: opening.resumed }, setCookie);
}

async function onDone(req: IncomingMessage, res: ServerResponse, temporal: Client): Promise<void> {
  if (!fromOurPage(req)) return json(res, 403, { error: 'forbidden' });
  const grant = session(cookieOf(req));
  if (!grant) return json(res, 401, { error: '這次的操作已經結束了。' });
  closeGrant(grant.id, 'user handed back');
  cut(grant.id);
  await temporal.workflow
    .getHandle(grant.taskId)
    .signal(handedBack, { requestId: grant.requestId })
    .catch(() => undefined); // the task may have moved on already; its own end closes the takeover too
  json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${SECURE ? '; Secure' : ''}` });
}

/** Handles /takeover routes; returns false for anything else. */
export function takeoverRoutes(req: IncomingMessage, res: ServerResponse, temporal: Client): boolean {
  const { pathname } = new URL(req.url ?? '/', 'http://local');
  if (!pathname.startsWith('/takeover')) return false;
  const fail = (err: unknown) => {
    console.error('takeover request failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) json(res, 500, { error: '出了點問題，請回到 LINE 再試一次。' });
  };
  if (req.method === 'GET' && pathname === '/takeover') page(res);
  else if (req.method === 'GET' && (pathname === '/takeover/app.js' || pathname === '/takeover/app.css')) {
    asset(res, realpathSync(WEB), pathname === '/takeover/app.js' ? 'takeover.js' : 'takeover.css');
  } else if (req.method === 'GET' && /^\/takeover\/novnc\/(core|vendor)\//.test(pathname)) {
    asset(res, NOVNC, pathname.slice('/takeover/novnc/'.length));
  } else if (req.method === 'POST' && pathname === '/takeover/open') onOpen(req, res).catch(fail);
  else if (req.method === 'POST' && pathname === '/takeover/done') onDone(req, res, temporal).catch(fail);
  else res.writeHead(404).end();
  return true;
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The screen's WebSocket. Checked here (our Origin, a live session), then joined byte for byte to the box's
 * typing screen (websockify in front of VNC :5900, published on this machine's loopback only). The box's
 * token is added on our side and never reaches the phone.
 */
export function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const { pathname } = new URL(req.url ?? '/', 'http://local');
  if (pathname !== '/takeover/ws') return refuse(socket, 404, 'Not Found');
  if (!fromOurPage(req)) {
    audit('takeover.screen_refused', { why: 'origin', ip: clientIp(req) });
    return refuse(socket, 403, 'Forbidden');
  }
  const grant = session(cookieOf(req));
  if (!grant) return refuse(socket, 401, 'Unauthorized');
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13') {
    return refuse(socket, 400, 'Bad Request');
  }
  const offered = req.headers['sec-websocket-protocol'];
  const protocol = typeof offered === 'string' && /^[A-Za-z0-9 ,.-]{1,64}$/.test(offered) ? offered : undefined;

  typingScreen(grant.userId)
    .then((screen) => {
      cut(grant.id);
      const upstream = connect({ host: '127.0.0.1', port: screen.port });
      const streams = [socket, upstream];
      live.set(grant.id, streams);
      const close = () => streams.forEach((s) => s.destroy());
      for (const s of streams) {
        s.on('error', close);
        s.on('close', close);
      }
      setTimeout(close, Math.max(0, (grant.sessionExpiresAt ?? 0) - Date.now())).unref();
      upstream.on('connect', () => {
        upstream.write(
          [
            `GET /websockify?token=${encodeURIComponent(screen.token)} HTTP/1.1`,
            `Host: 127.0.0.1:${screen.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
            '',
            '',
          ].join('\r\n'),
        );
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      audit('takeover.screen', { grant: grant.id, ip: clientIp(req) });
    })
    .catch((err: unknown) => {
      console.error('takeover screen failed:', err instanceof Error ? err.message : err);
      refuse(socket, 502, 'Bad Gateway');
    });
}
