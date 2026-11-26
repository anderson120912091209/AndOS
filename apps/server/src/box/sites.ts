// Which sites Relay's computer is signed in to — read from the *names* of its browser's cookies
// over CDP, so the Connections window can say "Signed in" without opening anything. Cookie
// values never leave the box. Signing out expires that site's cookies there.

import { CATALOG, type CatalogEntry, type ConnectionAuth, type ConnectionId } from '@relay/shared';
import { BOX } from './driver.js';
import { withBrowser } from './cdp.js';

/** A cookie as far as the sites list needs it — never its value. */
export interface BoxCookie {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  partitionKey?: unknown;
}

export interface BoxPage {
  url: string;
  title: string;
}

/** The box's browser, as much of it as the sites list touches. */
export interface BoxBrowser {
  cookies(): Promise<BoxCookie[]>;
  expire(cookies: BoxCookie[]): Promise<void>;
  pages(): Promise<BoxPage[]>;
}

export class CdpBoxBrowser implements BoxBrowser {
  constructor(
    private base = `http://127.0.0.1:${BOX.cdpPort}`,
    private http: typeof fetch = fetch,
  ) {}

  async cookies(): Promise<BoxCookie[]> {
    const out = await withBrowser(this.base, (send) => send('Storage.getCookies'), this.http);
    return ((out.cookies ?? []) as (BoxCookie & { value?: string })[]).map(
      ({ name, domain, path, secure, httpOnly, sameSite, partitionKey }) => ({ name, domain, path, secure, httpOnly, sameSite, partitionKey }),
    );
  }

  /** Setting a cookie that expired long ago deletes it. Host-only cookies are named by URL. */
  async expire(cookies: BoxCookie[]): Promise<void> {
    if (cookies.length === 0) return;
    const gone = cookies.map((c) => ({
      name: c.name,
      value: '',
      ...(c.domain.startsWith('.') ? { domain: c.domain } : { url: `https://${c.domain}${c.path}` }),
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
      expires: 1,
    }));
    await withBrowser(this.base, (send) => send('Storage.setCookies', { cookies: gone }), this.http);
  }

  async pages(): Promise<BoxPage[]> {
    const res = await this.http(`${this.base}/json/list`, { signal: AbortSignal.timeout(4000) });
    const targets = (await res.json()) as { type: string; url: string; title: string }[];
    return targets.filter((t) => t.type === 'page').map(({ url, title }) => ({ url, title }));
  }
}

export interface SiteSession {
  signedIn: boolean;
  /** who, when the site says so in its tab title (Gmail does) */
  account?: string;
}

type BoxAuth = Extract<ConnectionAuth, { type: 'box' }>;

/** The catalog's box sites: signed in on Relay's computer, not through an API. */
export const boxSites = (): (CatalogEntry & { auth: BoxAuth })[] =>
  CATALOG.filter((c): c is CatalogEntry & { auth: BoxAuth } => c.auth.type === 'box');

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** Does a cookie set for `cookieDomain` belong to one of `domains` (subdomains included)? */
export function onDomain(cookieDomain: string, domains: string[]): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  return domains.some((x) => d === x || d.endsWith(`.${x}`));
}

/** A site's own domain, from its sign-in URL: app.example.com → example.com. */
const siteDomain = (url: string): string => new URL(url).hostname.split('.').slice(-2).join('.');

export class BoxSites {
  /** sign-ins you finished on sites Relay can't check by cookie — taken at your word */
  private finished = new Set<ConnectionId>();
  /** the last account each site showed, so the row keeps it after the tab closes */
  private accounts = new Map<ConnectionId, string>();
  /** what the browser said last time — sign-ins don't vanish while the box is held or off */
  private last?: Map<ConnectionId, SiteSession>;

  constructor(private browser: BoxBrowser = new CdpBoxBrowser()) {}

  /**
   * Every box site's sign-in. When the browser can't be asked — the box is off, or held while
   * you use it — the last answer stands (the sign-ins live on in its profile); undefined if
   * there never was one.
   */
  async sessions(): Promise<Map<ConnectionId, SiteSession> | undefined> {
    let cookies: BoxCookie[];
    try {
      cookies = await this.browser.cookies();
    } catch {
      return this.last;
    }
    const pages = await this.browser.pages().catch(() => [] as BoxPage[]);
    const out = new Map<ConnectionId, SiteSession>();
    for (const site of boxSites()) {
      const rule = site.auth.signedIn;
      const signedIn = rule
        ? cookies.some((c) => c.name === rule.cookie && onDomain(c.domain, rule.domains))
        : this.finished.has(site.id);
      if (!signedIn) {
        this.accounts.delete(site.id);
        out.set(site.id, { signedIn });
        continue;
      }
      const host = new URL(site.auth.url).host;
      const seen = pages
        .filter((p) => URL.canParse(p.url) && new URL(p.url).host === host)
        .map((p) => EMAIL.exec(p.title)?.[0])
        .find(Boolean);
      if (seen) this.accounts.set(site.id, seen);
      out.set(site.id, { signedIn, account: this.accounts.get(site.id) });
    }
    this.last = out;
    return out;
  }

  /** You pressed Done on a sign-in. Sites with a session cookie will show it on their own. */
  finishedSignIn(id: ConnectionId): void {
    this.finished.add(id);
  }

  /** Sign Relay's computer out of a site: every cookie of that site's domains, expired. */
  async signOut(id: ConnectionId): Promise<void> {
    this.finished.delete(id);
    this.accounts.delete(id);
    this.last?.set(id, { signedIn: false });
    const site = boxSites().find((s) => s.id === id);
    if (!site) return;
    const domains = site.auth.signedIn?.domains ?? [siteDomain(site.auth.url)];
    const cookies = await this.browser.cookies();
    await this.browser.expire(cookies.filter((c) => onDomain(c.domain, domains)));
  }
}
