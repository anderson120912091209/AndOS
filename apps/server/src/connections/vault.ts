// Your connections, as Relay remembers them: one Keychain entry per service, holding its
// tokens and how to refresh them. Everything that reads a token goes through here, so a
// short-lived token is always fresh and a rotated refresh token is never lost.

import { CATALOG, type ConnectionCredential, type ConnectionId, type ConnectionStatus } from '@relay/shared';
import { type Fetch, type Registration, refreshTokens } from './oauth.js';
import type { SecretStore } from './secrets.js';

interface Base {
  connectedAt: number;
  account?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** set when a refresh failed: the service signed Relay out */
  broken?: string;
}
export interface McpRecord extends Base {
  kind: 'mcp';
  url: string;
  resource: string;
  /** read-only tools the agent may use on its own */
  tools: string[];
}
export interface GoogleRecord extends Base {
  kind: 'google';
  scopes: string[];
}
/** A pasted API key (Claude). No tokens to refresh — it works until you revoke it. */
export interface KeyRecord {
  kind: 'key';
  apiKey: string;
  connectedAt: number;
}
export type OAuthRecord = McpRecord | GoogleRecord;
export type ConnectionRecord = OAuthRecord | KeyRecord;

/** The key you created in your Google Cloud project. Kept so reconnecting is one click. */
export interface GoogleKey {
  clientId: string;
  clientSecret: string;
}

export class Vault {
  private cache = new Map<string, string | undefined>();

  constructor(
    private secrets: SecretStore,
    private http: Fetch = fetch,
    private now = () => Date.now(),
  ) {}

  private async read<T>(key: string): Promise<T | undefined> {
    if (!this.cache.has(key)) this.cache.set(key, await this.secrets.get(key));
    const raw = this.cache.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  private async write(key: string, value: unknown): Promise<void> {
    const raw = JSON.stringify(value);
    await this.secrets.set(key, raw);
    this.cache.set(key, raw);
  }

  private async drop(key: string): Promise<void> {
    await this.secrets.delete(key);
    this.cache.set(key, undefined);
  }

  record(id: ConnectionId): Promise<ConnectionRecord | undefined> {
    return this.read(`connection:${id}`);
  }
  save(id: ConnectionId, record: ConnectionRecord): Promise<void> {
    return this.write(`connection:${id}`, record);
  }
  remove(id: ConnectionId): Promise<void> {
    return this.drop(`connection:${id}`);
  }

  googleKey(): Promise<GoogleKey | undefined> {
    return this.read('google-key');
  }
  saveGoogleKey(key: GoogleKey): Promise<void> {
    return this.write('google-key', key);
  }

  /** How Relay registered itself with an MCP service's sign-in server. */
  registration(issuer: string): Promise<Registration | undefined> {
    return this.read(`client:${issuer}`);
  }
  saveRegistration(issuer: string, registration: Registration): Promise<void> {
    return this.write(`client:${issuer}`, registration);
  }

  /**
   * A token that will outlast an agent job: anything with under ten minutes left is refreshed
   * (and the new one saved) first, so a long run never hits an expired token halfway through.
   */
  async token(id: ConnectionId): Promise<string> {
    const rec = await this.record(id);
    if (!rec) throw new Error('not connected');
    if (rec.kind === 'key') return rec.apiKey;
    if (!rec.expiresAt || rec.expiresAt - this.now() > 10 * 60_000) return rec.accessToken;
    if (!rec.refreshToken) throw new Error('signed out — connect again');
    try {
      const t = await refreshTokens(this.http, rec.tokenEndpoint, {
        refreshToken: rec.refreshToken,
        clientId: rec.clientId,
        clientSecret: rec.clientSecret,
        resource: rec.kind === 'mcp' ? rec.resource : undefined,
      });
      const next: OAuthRecord = {
        ...rec,
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? rec.refreshToken,
        expiresAt: t.expires_in ? this.now() + t.expires_in * 1000 : undefined,
        broken: undefined,
      };
      await this.save(id, next);
      return next.accessToken;
    } catch (err) {
      await this.save(id, { ...rec, broken: (err as Error).message });
      throw err;
    }
  }

  /** What each catalog entry's record says. How an unconnected one connects is the routes' call. */
  async statuses(): Promise<ConnectionStatus[]> {
    return Promise.all(
      CATALOG.map(async (c): Promise<ConnectionStatus> => {
        const base = { id: c.id, name: c.name, blurb: c.blurb, example: c.example };
        if (c.auth.type === 'soon') return { ...base, state: 'soon', note: c.auth.note };
        const rec = await this.record(c.id);
        if (rec?.kind === 'key') {
          return { ...base, state: 'connected', account: `API key …${rec.apiKey.slice(-4)}`, connectedAt: rec.connectedAt };
        }
        if (rec?.broken) return { ...base, state: 'broken', account: rec.account, note: 'Signed out — connect again.' };
        if (rec) {
          return {
            ...base,
            state: 'connected',
            account: rec.account,
            connectedAt: rec.connectedAt,
            tools: rec.kind === 'mcp' ? rec.tools : undefined,
          };
        }
        return { ...base, state: 'available' };
      }),
    );
  }

  /** Fresh tokens for one agent job. A connection that can't refresh is left out, not fatal. */
  async credentials(): Promise<ConnectionCredential[]> {
    const out: ConnectionCredential[] = [];
    for (const c of CATALOG) {
      if (c.auth.type === 'soon') continue;
      const rec = await this.record(c.id);
      if (!rec) continue;
      if (rec.kind === 'key') {
        out.push({ id: 'claude', kind: 'anthropic', apiKey: rec.apiKey });
        continue;
      }
      if (rec.broken) continue;
      try {
        const token = await this.token(c.id);
        if (rec.kind === 'mcp') out.push({ id: c.id, kind: 'mcp', name: c.name, url: rec.url, token, tools: rec.tools, account: rec.account });
        else out.push({ id: 'gmail', kind: 'google', token, scopes: rec.scopes, account: rec.account });
      } catch {
        /* marked broken; the Connections window asks you to sign in again */
      }
    }
    return out;
  }
}
