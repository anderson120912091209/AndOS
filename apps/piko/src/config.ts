// Settings shared by the gateway and the worker. Values come from apps/piko/.env.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  // Separate queues keep `pnpm chat` tasks away from the real-LINE worker when both run against one Temporal.
  taskQueue: process.env.PIKO_TASK_QUEUE ?? 'piko',
  dataDir: resolve(APP_ROOT, process.env.PIKO_DATA_DIR ?? '.data/piko'),
  model: 'claude-opus-5-5',
  // `PIKO_MODEL=fake` swaps Claude for a scripted stand-in, so the harness can be tested without an API key.
  fakeModel: process.env.PIKO_MODEL === 'fake',
  line: {
    secret: process.env.LINE_CHANNEL_SECRET ?? '',
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    api: process.env.LINE_API_BASE ?? 'https://api.line.me',
  },
  // 8790, not 8787: Relay's server owns localhost:8787 on the dev Mac.
  port: Number(process.env.PORT ?? 8790),
  host: process.env.HOST ?? '127.0.0.1',
  /** Piko's fixed public address (an ngrok static domain today, our own domain later). OAuth needs it. */
  publicUrl: process.env.PUBLIC_URL ?? (process.env.NGROK_DOMAIN ? `https://${process.env.NGROK_DOMAIN}` : ''),
  /** Signs OAuth state so a callback can't be forged or replayed for another user. */
  secret: process.env.PIKO_SECRET ?? '',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
  /**
   * LIFF opens the takeover page inside LINE and proves who is holding the phone. `channelId` is the channel the
   * LIFF app belongs to: LINE signs the ID token for it.
   */
  liff: {
    id: process.env.LIFF_ID ?? '',
    channelId: process.env.LINE_LOGIN_CHANNEL_ID ?? '',
  },
  production: process.env.NODE_ENV === 'production',
};

export function googleReady(): boolean {
  return Boolean(config.publicUrl && config.secret && config.google.clientId && config.google.clientSecret);
}

export function liffReady(): boolean {
  return Boolean(config.liff.id && config.liff.channelId);
}

/** Takeover needs a public address, and outside development a LINE identity check on whoever opens it. */
export function takeoverReady(): boolean {
  return Boolean(config.publicUrl || !config.production) && (liffReady() || !config.production);
}
