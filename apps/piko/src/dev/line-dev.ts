// One command for a dev session on the real LINE channel: `pnpm dev`.
//
// 1. Makes sure .env has a working channel access token. If it's missing or rejected, issues a 30-day
//    token from the channel ID + secret and saves it to .env.
// 2. Starts Temporal (unless running), the worker, the gateway, and a Cloudflare quick tunnel to the gateway.
// 3. Points the channel's webhook at the tunnel and asks LINE to test it. The tunnel's address changes on
//    every run, which is why this step runs every time.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureTemporal, startNode, waitForHealth } from './procs.js';

const ENV_FILE = '.env';
const API = 'https://api.line.me';
const port = Number(process.env.PORT ?? 8790);

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Sets KEY=value in .env, replacing an existing line or adding one. Never prints the value. */
function saveEnv(key: string, value: string): void {
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(lines.length - 1, 0, `${key}=${value}`);
  writeFileSync(ENV_FILE, lines.join('\n'));
}

async function issueToken(channelId: string, secret: string): Promise<string> {
  const res = await fetch(`${API}/v2/oauth/accessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: channelId, client_secret: secret }),
  });
  if (!res.ok) fail(`LINE refused to issue a token (${res.status}): ${await res.text()}. Check LINE_CHANNEL_ID and LINE_CHANNEL_SECRET.`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

function api(token: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
}

/** At startup the Mac may still be offline (waking from sleep, Wi-Fi coming back): wait for LINE rather than quit. */
async function waitForNetwork(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetch(`${API}/v2/bot/info`, { signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      if (attempt === 1) console.log('… no network yet; waiting for api.line.me');
      if (attempt > 120) fail('still no network after 10 minutes');
      await delay(5000);
    }
  }
}

async function workingToken(): Promise<string> {
  const channelId = process.env.LINE_CHANNEL_ID ?? '';
  const secret = process.env.LINE_CHANNEL_SECRET ?? '';
  if (!secret) fail('Put LINE_CHANNEL_SECRET in apps/piko/.env (Developers Console → Basic settings).');
  const saved = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '';
  if (saved) {
    const probe = await fetch(`${API}/v2/bot/channel/webhook/endpoint`, { headers: { authorization: `Bearer ${saved}` } });
    if (probe.status !== 401) return saved;
    console.log('… the saved access token was rejected (expired or revoked); issuing a new one');
  }
  if (!channelId) fail('Put LINE_CHANNEL_ID in .env (the Channel ID on the Messaging API page) so I can issue a token.');
  const token = await issueToken(channelId, secret);
  saveEnv('LINE_CHANNEL_ACCESS_TOKEN', token);
  console.log('✓ issued a 30-day channel access token and saved it to .env');
  return token;
}

/** PIKO_SECRET signs OAuth state. Generated once and kept in .env, so links stay valid across restarts. */
function ensureSecret(): void {
  if (process.env.PIKO_SECRET) return;
  const secret = randomBytes(32).toString('base64url');
  saveEnv('PIKO_SECRET', secret);
  process.env.PIKO_SECRET = secret;
  console.log('✓ generated PIKO_SECRET and saved it to .env');
}

/**
 * With ngrok, Piko keeps one fixed address, which Google sign-in needs. A free ngrok account comes with one
 * assigned dev domain (its name can't be chosen); without NGROK_DOMAIN we start ngrok on it, learn the name
 * and save it to .env.
 */
async function startNgrok(domain: string | undefined): Promise<string> {
  // --inspect=false: ngrok's local inspector would otherwise keep a copy of every request (LINE messages,
  // OAuth codes, takeover tickets) on a port anything on this Mac can read.
  const args = ['http', `127.0.0.1:${port}`, '--inspect=false', '--log=stdout', '--log-format=json', ...(domain ? [`--url=https://${domain}`] : [])];
  const tunnel = spawn('ngrok', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  process.on('exit', () => tunnel.kill());
  tunnel.on('error', () => fail('ngrok is not installed (brew install ngrok)'));
  let log = '';
  tunnel.stdout.on('data', (d: Buffer) => {
    log += d.toString();
  });
  tunnel.on('exit', (code) => fail(`ngrok stopped (exit ${code}): ${log.slice(-800)}`));
  for (let i = 0; i < 60; i++) {
    try {
      const { tunnels } = (await (await fetch('http://127.0.0.1:4040/api/tunnels')).json()) as { tunnels: { public_url: string }[] };
      const url = tunnels.map((t) => t.public_url).find((u) => u.startsWith('https://') && (!domain || u === `https://${domain}`));
      if (url) {
        if (!domain) {
          saveEnv('NGROK_DOMAIN', new URL(url).host);
          console.log(`✓ found your ngrok domain ${new URL(url).host} and saved it to .env`);
        }
        return url;
      }
    } catch {
      // ngrok's local API isn't up yet
    }
    await delay(500);
  }
  return fail(`ngrok did not come up. It said: ${log.slice(-800)}`);
}

function startServices(token: string, publicUrl: string | undefined): void {
  const env = { ...process.env, LINE_CHANNEL_ACCESS_TOKEN: token, PORT: String(port), ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}) };
  startNode('worker', 'src/worker.ts', env);
  startNode('gateway', 'src/gateway.ts', env);
}

/** Starts a Cloudflare quick tunnel to the gateway and resolves with its public https address. */
function startTunnel(): Promise<string> {
  // 127.0.0.1, not localhost: the tunnel must reach exactly the address the gateway listens on.
  const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  process.on('exit', () => tunnel.kill());
  tunnel.on('error', () => fail('cloudflared is not installed (brew install cloudflared)'));
  let log = '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(`the tunnel didn't come up in 30 s. cloudflared said:\n${log.slice(-1500)}`), 30_000);
    tunnel.stderr.on('data', (d: Buffer) => {
      log += d.toString();
      // cloudflared prints the address before it has connected to Cloudflare; wait for both.
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0];
      if (url && log.includes('Registered tunnel connection')) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  });
}

/**
 * Waits until the tunnel's hostname exists, asking trycloudflare.com's own (authoritative) nameservers. Public
 * resolvers, this Mac's included, cache "no such host" for minutes if they are asked a moment too early, and LINE
 * must not be told the URL before it resolves for the same reason.
 */
async function published(url: string): Promise<void> {
  const host = new URL(url).hostname;
  const zone = host.split('.').slice(-2).join('.');
  const system = new Resolver();
  const nameservers = await system.resolveNs(zone);
  const ips = (await Promise.all(nameservers.map((ns) => system.resolve4(ns).catch(() => [] as string[])))).flat();
  const authority = new Resolver();
  authority.setServers(ips);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await authority.resolve4(host)).length > 0) return;
    } catch {
      // not published yet
    }
    await delay(1000);
  }
  fail(`${host} never appeared in DNS`);
}

type WebhookTest = { success: boolean; statusCode?: number; reason: string; detail: string };

/** LINE's own reachability check, retried briefly while Cloudflare finishes routing the new hostname. */
async function verify(line: ReturnType<typeof api>, endpoint: string): Promise<WebhookTest> {
  let test = await line<WebhookTest>('POST', '/v2/bot/channel/webhook/test', { endpoint });
  for (let attempt = 1; !test.success && test.statusCode !== 401 && attempt < 5; attempt++) {
    await delay(4000);
    test = await line<WebhookTest>('POST', '/v2/bot/channel/webhook/test', { endpoint });
  }
  return test;
}

// While Piko runs on this Mac, keep the Mac from sleeping (closing the lid still sleeps it).
if (process.platform === 'darwin') spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => undefined);
await waitForNetwork();
const token = await workingToken();
const line = api(token);
ensureSecret();
await ensureTemporal();
// ngrok's address is fixed, so it can open before the gateway and hand it PUBLIC_URL for Google sign-in.
const fixed = process.env.NGROK_AUTHTOKEN ? await startNgrok(process.env.NGROK_DOMAIN || undefined) : undefined;
startServices(token, fixed);
await waitForHealth(`http://127.0.0.1:${port}/healthz`);
const base = fixed ?? (await startTunnel());
if (!fixed) await published(base);

const endpoint = `${base}/webhooks/line`;
await line('PUT', '/v2/bot/channel/webhook/endpoint', { endpoint });
console.log(`✓ webhook URL set to ${endpoint}`);

const test = await verify(line, endpoint);
if (test.success) console.log('✓ LINE verified the webhook (200 OK)');
else if (test.statusCode === 401) fail('LINE reached the bot but the signature check failed: LINE_CHANNEL_SECRET in .env is not the channel\'s current secret.');
else fail(`LINE could not verify the webhook: ${test.reason} ${test.detail}`);

const { active } = await line<{ active: boolean }>('GET', '/v2/bot/channel/webhook/endpoint');
if (!active) console.log('! Webhook is OFF for this channel, so LINE won\'t deliver messages yet. Turn on "Webhook" in manager.line.biz → 回應設定.');

try {
  const bot = await line<{ basicId: string; displayName: string }>('GET', '/v2/bot/info');
  console.log(`✓ ${bot.displayName} is live. Add it as a friend: https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}`);
} catch {
  console.log('✓ live. Message the bot from LINE.');
}
if (fixed) {
  const google = process.env.GOOGLE_CLIENT_ID ? '✓ Google sign-in is on' : '! Google sign-in is off until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are in .env';
  console.log(`${google}. Its redirect URI is ${base}/oauth/google/callback`);
} else {
  console.log('! Google sign-in needs a fixed address: put your ngrok authtoken in NGROK_AUTHTOKEN in .env');
}
console.log('Watch tasks run step by step at http://localhost:8233. Ctrl+C stops everything.');
