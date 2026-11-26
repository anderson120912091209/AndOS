// Talk to Piko from the terminal, with no phone and no LINE channel: `pnpm chat`.
//
// Starts Temporal, the worker and the gateway, and plays the LINE Platform around them. Each line you type
// becomes a signed webhook event; every message Piko sends is printed, marked (reply) when it was free and
// (push $) when LINE would bill it. Buttons are numbered: type /1, /2 … to tap one.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise the scripted fake model (PIKO_MODEL=fake).
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureTemporal, startNode, waitForHealth } from './procs.js';

const SECRET = 'dev-secret';
const GATEWAY_PORT = 8797;
const LINE_PORT = 8798;
const USER = process.env.CHAT_USER ?? 'Udevuser';
const fake = !process.env.ANTHROPIC_API_KEY || process.env.PIKO_MODEL === 'fake';

type Action = { type: string; label: string; text?: string; data?: string; displayText?: string; uri?: string };
type Message = { type: string; text?: string; altText?: string; quickReply?: { items: { action: Action }[] }; contents?: unknown };

// Buttons are saved, so a tap still works after restarting the chat (that's how durability is tested).
const BUTTONS_FILE = '.data/piko-chat/buttons.json';
let buttons: Action[] = existsSync(BUTTONS_FILE) ? (JSON.parse(readFileSync(BUTTONS_FILE, 'utf8')) as Action[]) : [];
let lastSpoke = 0;
let spokeReal = false;

function collectFlexButtons(node: unknown, into: Action[]): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (record.type === 'button' && record.action) into.push(record.action as Action);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const v of value) collectFlexButtons(v, into);
    else if (value && typeof value === 'object') collectFlexButtons(value, into);
  }
}

/** The visible text of a Flex bubble, in reading order. */
function flexTexts(node: unknown, into: string[] = []): string[] {
  if (!node || typeof node !== 'object') return into;
  const record = node as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') into.push(record.text);
  for (const key of ['hero', 'header', 'body', 'contents']) {
    const value = record[key];
    if (Array.isArray(value)) for (const v of value) flexTexts(v, into);
    else if (value && typeof value === 'object') flexTexts(value, into);
  }
  return into;
}

function show(message: Message, how: string): void {
  const found: Action[] = [];
  if (message.type === 'text') console.log(`Piko ${how} › ${message.text}`);
  else if (message.type === 'flex') {
    const contents = message.contents as { type?: string; contents?: unknown[] };
    const bubbles = contents.type === 'carousel' ? (contents.contents ?? []) : [contents];
    console.log(`Piko ${how} › [${contents.type === 'carousel' ? `${bubbles.length} 張卡片` : '卡片'}]`);
    for (const bubble of bubbles) {
      const before = found.length;
      collectFlexButtons(bubble, found);
      const tapped = found.slice(before).map((b, i) => `/${before + i + 1} ${b.label}`).join('  ');
      console.log(`   ┃ ${flexTexts(bubble).join(' · ')}${tapped ? `\n   ┃   ${tapped}` : ''}`);
    }
  } else if (message.type === 'image') {
    const image = message as Message & { originalContentUrl?: string };
    console.log(`Piko ${how} › [圖片] ${image.originalContentUrl}`);
  } else console.log(`Piko ${how} › [${message.type}]`);
  const quick = (message.quickReply?.items ?? []).map((item) => item.action);
  if (quick.length > 0) {
    console.log(`        ${quick.map((b, i) => `/${found.length + i + 1} ${b.label}`).join('   ')}`);
    found.push(...quick);
  }
  if (found.length > 0) {
    buttons = found;
    mkdirSync('.data/piko-chat', { recursive: true });
    writeFileSync(BUTTONS_FILE, JSON.stringify(found));
  }
  lastSpoke = Date.now();
  if (message.text !== '收到了！我正在幫您處理，好了馬上告訴您 🙏') spokeReal = true;
}

// The stand-in for LINE's API.
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/oauth2/v2.1/verify') {
      // LIFF's ID token check, for testing takeover with LIFF on: a token `dev-id-token:<userId>` is that user.
      const form = new URLSearchParams(raw);
      const user = /^dev-id-token:(U\w+)$/.exec(form.get('id_token') ?? '')?.[1];
      if (!user) return void res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_request"}');
      const claims = { iss: 'https://access.line.me', sub: user, aud: form.get('client_id'), exp: Math.floor(Date.now() / 1000) + 600 };
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(claims));
    }
    const body = (raw ? JSON.parse(raw) : {}) as { messages?: Message[] };
    const how = req.url?.endsWith('/reply') ? '(reply)' : req.url?.endsWith('/push') ? '(push $)' : '';
    for (const message of body.messages ?? []) show(message, how);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
}).listen(LINE_PORT, '127.0.0.1');

function webhook(event: Record<string, unknown>): string {
  return JSON.stringify({
    destination: 'Udevbot',
    events: [
      {
        mode: 'active',
        timestamp: Date.now(),
        webhookEventId: randomUUID(),
        deliveryContext: { isRedelivery: false },
        replyToken: randomUUID(),
        source: { type: 'user', userId: USER },
        ...event,
      },
    ],
  });
}

async function post(body: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/webhooks/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', SECRET).update(body).digest('base64') },
    body,
  });
  if (res.status !== 200) console.log(`gateway answered ${res.status}`);
}

/** Waits until Piko said something real and then went quiet, so piped input stays in step with the bot. */
async function settle(): Promise<void> {
  spokeReal = false;
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    await delay(200);
    if (spokeReal && Date.now() - lastSpoke > 2000) return;
  }
}

async function send(line: string): Promise<void> {
  const tap = /^\/(\d+)$/.exec(line);
  const button = tap ? buttons[Number(tap[1]) - 1] : undefined;
  if (tap && !button) {
    console.log('(no such button)');
    return;
  }
  if (button?.type === 'uri') {
    console.log(`you tapped › ${button.label}  (opens ${button.uri})`);
    return;
  }
  if (button?.type === 'postback') {
    console.log(`you tapped › ${button.displayText ?? button.label}`);
    await post(webhook({ type: 'postback', postback: { data: button.data } }));
  } else {
    const text = button?.text ?? line;
    if (button) console.log(`you tapped › ${text}`);
    await post(webhook({ type: 'message', message: { id: String(Date.now()), type: 'text', text, quoteToken: randomUUID() } }));
  }
  await settle();
}

await ensureTemporal();
const env = {
  ...process.env,
  LINE_CHANNEL_SECRET: SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: 'dev-token',
  LINE_API_BASE: `http://127.0.0.1:${LINE_PORT}`,
  PORT: String(GATEWAY_PORT),
  // Links Piko makes (pictures, takeover) point at this stand-in gateway, not the live one.
  PUBLIC_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
  PIKO_DATA_DIR: '.data/piko-chat',
  PIKO_TASK_QUEUE: 'piko-chat',
  ...(fake ? { PIKO_MODEL: 'fake' } : {}),
};
startNode('worker', 'src/worker.ts', env);
startNode('gateway', 'src/gateway.ts', env);
await waitForHealth(`http://127.0.0.1:${GATEWAY_PORT}/healthz`);
await delay(1500); // let the worker finish bundling the workflow code
console.log(`Chatting as ${USER} with ${fake ? 'the fake model (set ANTHROPIC_API_KEY for Claude)' : 'Claude'}. Ctrl+C quits.`);

const interactive = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output: interactive ? process.stdout : undefined, prompt: 'you › ' });
rl.on('SIGINT', () => rl.close());
if (interactive) rl.prompt();
for await (const line of rl) {
  if (line.trim()) {
    if (!interactive) console.log(`you › ${line.trim()}`);
    await send(line.trim());
  }
  if (interactive) rl.prompt();
}
process.exit(0);
