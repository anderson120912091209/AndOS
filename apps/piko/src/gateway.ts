// Piko's LINE gateway. It checks LINE's signature, answers LINE at once, and turns each message into a
// durable task (a new one, or a reply to the task that is waiting on this user). Button taps become signals.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { Client, Connection } from '@temporalio/client';
import { config, googleReady } from './config.js';
import { consentUrl, finishConnect, readState } from './connect/google.js';
import { type LineMessage, reply, startLoading } from './line/api.js';
import { mediaFile } from './media.js';
import { readUser, recordFeedback } from './store.js';
import { isStuck, retire, route, startTask } from './tasks.js';
import { onUpgrade, takeoverRoutes } from './takeover-http.js';
import type { ReplyToken } from './types.js';
import { connected, decision, userMessage } from './workflows.js';

interface LineEvent {
  type: string;
  replyToken?: string;
  webhookEventId?: string;
  source?: { type: string; userId?: string; groupId?: string };
  message?: { type: string; text?: string };
  postback?: { data: string };
}

if (!config.line.secret || !config.line.token) {
  console.error('Set LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN in apps/piko/.env');
  process.exit(1);
}

const temporal = new Client({ connection: await Connection.connect({ address: config.temporalAddress }) });
const seen = new Set<string>(); // LINE may redeliver an event; handle each webhookEventId once
/** LINE's webhook bodies are small; anything bigger is not from LINE. */
const MAX_WEBHOOK_BYTES = 1_000_000;

function signatureOk(body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', config.line.secret).update(body).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function token(replyToken: string | undefined): ReplyToken | undefined {
  return replyToken ? { token: replyToken, receivedAt: Date.now() } : undefined;
}

async function say(replyToken: string | undefined, text: string): Promise<void> {
  const messages: LineMessage[] = [{ type: 'text', text }];
  if (replyToken) await reply(replyToken, messages);
}

/** A message goes to the user's open task if it still belongs there (see route); otherwise it starts a new one. */
async function onText(userId: string, text: string, replyToken: string | undefined): Promise<void> {
  void startLoading(userId);
  const active = readUser(userId).activeTask;
  const where = active ? await route(temporal, active) : { kind: 'closed' as const, carry: [] };
  if (where.kind === 'live') {
    await where.handle.signal(userMessage, { text, reply: token(replyToken) });
    return;
  }
  await startTask(temporal, { userId, text: [...where.carry, text].join('\n'), reply: token(replyToken) });
}

async function onPostback(userId: string, data: string, replyToken: string | undefined): Promise<void> {
  const [kind, taskId, value, extra] = data.split('|');
  if (kind === 'd' && taskId && value) {
    void startLoading(userId);
    try {
      const handle = temporal.workflow.getHandle(taskId);
      const { status, raw } = await handle.describe();
      if (status.name !== 'RUNNING') throw new Error('closed');
      if (await isStuck(temporal, taskId, raw.pendingWorkflowTask?.attempt ?? 0)) {
        await retire(temporal, taskId, 'Its steps kept failing; the user tapped a button.');
        throw new Error('retired');
      }
      await handle.signal(decision, { requestId: value, approved: extra === '1', reply: token(replyToken) });
    } catch {
      await say(replyToken, '這件事已經結束了，需要的話可以再跟我說一次 🙏');
    }
  } else if (kind === 'f' && taskId && value) {
    recordFeedback(taskId, value);
    await say(replyToken, value === 'up' ? '謝謝您！有需要隨時找我 😊' : '謝謝您告訴我，我會再改進 🙏');
  }
}

async function onEvent(event: LineEvent): Promise<void> {
  if (event.webhookEventId) {
    if (seen.has(event.webhookEventId)) return;
    if (seen.size > 50_000) seen.clear(); // redeliveries come within minutes; don't grow forever
    seen.add(event.webhookEventId);
  }
  const userId = event.source?.userId;
  if (event.source?.type !== 'user' || !userId) return; // group chats come with job C
  if (event.type === 'message' && event.message?.type === 'text' && event.message.text) {
    await onText(userId, event.message.text, event.replyToken);
  } else if (event.type === 'postback' && event.postback) {
    await onPostback(userId, event.postback.data, event.replyToken);
  } else if (event.type === 'message') {
    await say(event.replyToken, '我現在先看得懂文字。語音和照片很快就會學會 🙏');
  } else if (event.type === 'follow') {
    await say(event.replyToken, '您好！我是 Piko 來福 😊\n想查什麼、問什麼、辦什麼事，直接打字跟我說就好。');
  }
}

/** The LINE chat to send people back to after they finish in the browser. */
let backToLine = 'https://line.me/';
fetch(`${config.line.api}/v2/bot/info`, { headers: { authorization: `Bearer ${config.line.token}` } })
  .then(async (res) => {
    if (res.ok) backToLine = `https://line.me/R/ti/p/${encodeURIComponent(((await res.json()) as { basicId: string }).basicId)}`;
  })
  .catch(() => undefined);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A small page for the phone's browser: big text, one button back to the LINE chat. */
function page(res: import('node:http').ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;margin:0;padding:48px 24px;text-align:center;color:#222}
h1{font-size:28px;margin:0 0 16px}p{font-size:19px;line-height:1.6;color:#555}a{display:block;margin:32px auto 0;max-width:320px;padding:18px;border-radius:14px;background:#06C755;color:#fff;font-size:21px;font-weight:600;text-decoration:none}</style>
</head><body><h1>${title}</h1><p>${body}</p><a href="${backToLine}">回到 LINE</a></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
}

/** Google sign-in, step 1: check our signed ticket, then hand the browser to Google's consent page. */
function onConnectStart(url: URL, res: import('node:http').ServerResponse): void {
  const state = url.searchParams.get('s') ?? '';
  const payload = readState(state);
  if (!googleReady()) return page(res, 503, '暫時無法連結', 'Google 連結還沒設定好，請稍後再試。');
  if (!payload) return page(res, 400, '這個連結過期了', '請回到 LINE，再跟 Piko 說一次。');
  res.writeHead(302, { location: consentUrl(state, payload), 'cache-control': 'no-store' }).end();
}

/** Google sign-in, step 2: Google sends the browser back here with a one-time code. */
async function onConnectCallback(url: URL, res: import('node:http').ServerResponse): Promise<void> {
  const payload = readState(url.searchParams.get('state') ?? '');
  if (!payload) return page(res, 400, '這個連結過期了', '請回到 LINE，再跟 Piko 說一次。');
  const code = url.searchParams.get('code');
  if (!code) return page(res, 200, '沒有連結', '你沒有同意連結，沒關係。回到 LINE 就可以繼續。');
  try {
    const email = await finishConnect(code, payload);
    if (payload.taskId) {
      await temporal.workflow.getHandle(payload.taskId).signal(connected, { service: 'google', email }).catch(() => undefined);
    }
    page(res, 200, '連結成功 ✅', `已連結 ${escapeHtml(email ?? '你的 Google 帳號')}。<br>回到 LINE，Piko 會接著幫你。`);
  } catch (err) {
    console.error('google connect failed:', err);
    page(res, 500, '連結沒有成功', '請回到 LINE 再試一次。');
  }
}

const server = createServer((req, res) => {
  if (takeoverRoutes(req, res, temporal)) return;
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://local');
  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    // Pictures and files Piko sent. The random id in the path is the only key.
    const file = mediaFile(url.pathname.slice('/media/'.length));
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    createReadStream(file.path).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/connect/google') return onConnectStart(url, res);
  if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
    onConnectCallback(url, res).catch((err: unknown) => console.error('callback failed:', err));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/webhooks/line') {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) {
      res.writeHead(413).end();
      req.destroy();
    } else chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > MAX_WEBHOOK_BYTES) return;
    const body = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];
    if (!signatureOk(body, typeof signature === 'string' ? signature : undefined)) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200).end(); // answer LINE first; the work happens in tasks
    const { events = [] } = JSON.parse(body.toString('utf8')) as { events?: LineEvent[] };
    for (const event of events) {
      onEvent(event).catch((err: unknown) => console.error('event failed:', err));
    }
  });
});
server.on('upgrade', onUpgrade); // the takeover screen's WebSocket; every other upgrade is refused there
server.listen(config.port, config.host, () => console.log(`Piko gateway on http://${config.host}:${config.port}/webhooks/line`));
