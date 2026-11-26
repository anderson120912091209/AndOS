// The browser on the box, as the agent sees it.
//
// For accounts with no official connect (email, WhatsApp, any site), the agent works a real
// browser running on the remote machine. It reads the page as a short list of tagged elements
// (not a screenshot wall), and acts by element ref. For the sign-in — and anything private —
// it doesn't type your password; it calls request_takeover and hands you that same browser.
//
// `BrowserSession` is the seam the agent depends on. `CdpBrowserSession` speaks the Chrome
// DevTools Protocol to the box's headful Chromium (RELAY_BROWSER_CDP). The box itself, the
// viewer, and the takeover transport are the server/box's side (apps/server /api/box/*).

export interface PageElement {
  /** stable within one snapshot; what click/type refer to */
  ref: string;
  role: string; // link | button | textbox | checkbox | …
  name: string;
  value?: string;
}

export interface PageView {
  url: string;
  title: string;
  /** the interactive things, in reading order */
  elements: PageElement[];
  /** visible text, trimmed — what the page says */
  text: string;
}

export interface BrowserSession {
  navigate(url: string): Promise<PageView>;
  read(): Promise<PageView>;
  click(ref: string): Promise<PageView>;
  type(ref: string, text: string, opts?: { submit?: boolean }): Promise<PageView>;
  /** base64 PNG, for the notch and the model's eyes */
  screenshot(): Promise<string>;
  /** the page target the agent is on (CDP target id), for handing the right tab to the user */
  targetId(): string | undefined;
  /** detach the CDP debugger from the box. Call before a takeover: a session with Runtime.enable
   *  on makes Google flag the browser as automated and refuse the sign-in. */
  close(): void;
}

// --- CDP implementation -------------------------------------------------------
//
// Integration-untested until the relay-browser container is up (needs a live Chromium on CDP);
// the agent tool surface above it is unit-tested against a mock. Uses Node 22's global
// WebSocket and fetch — no dependency.
//
// The box's CDP contract (relay-browser, from the box owner):
//   RELAY_BROWSER_CDP = http://127.0.0.1:19222  (host worker, `pnpm dev`)
//                     = http://172.29.71.10:9222 (container worker, --network relay-box)
//   - Chrome's DevTools HTTP rejects a Host header that isn't an IP or "localhost" — use the IP.
//   - Don't send an Origin on the websocket (Node's WebSocket doesn't by default); Chrome
//     refuses Origins it wasn't told about, which is also what keeps web pages off CDP.
//   - One visible 1280×800 window; new tabs open in it.
// Integration TODO (finalize against the live container): prefer GET /json/version +
// Target.getTargets/attachToTarget({flatten:true}) with per-command sessionId for multi-tab,
// and Target.activateTarget before a takeover so the viewer shows the right tab. The single-page
// /json approach below is enough for one window; switch to flatten when tabs matter.

const SNAPSHOT_JS = String.raw`(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const roleOf = (el) => {
    const t = el.tagName.toLowerCase();
    if (el.getAttribute('role')) return el.getAttribute('role');
    if (t === 'a') return 'link';
    if (t === 'button' || (t === 'input' && ['button','submit'].includes(el.type))) return 'button';
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (t === 'input') return ({ checkbox: 'checkbox', radio: 'radio', password: 'textbox', email: 'textbox', text: 'textbox', search: 'searchbox' })[el.type] || 'textbox';
    return t;
  };
  // What you type into a password, one-time-code or card field never reaches the model, even as a
  // field's name: the agent hands those steps to you (request_takeover) and never reads them back.
  const secret = (el) => el.type === 'password' || /one-time-code|cc-number|cc-csc|cc-exp/.test(el.autocomplete || '');
  const valueOf = (el) => (secret(el) ? undefined : el.value || undefined);
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
    (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || valueOf(el) || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true]';
  const els = [...document.querySelectorAll(sel)].filter(vis).slice(0, 120);
  const out = els.map((el, i) => { el.setAttribute('data-relay-ref', 'e' + i);
    return { ref: 'e' + i, role: roleOf(el), name: nameOf(el), value: valueOf(el) }; });
  return { url: location.href, title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\s+\n/g, '\n').trim().slice(0, 6000), elements: out };
})()`;

const actJs = (ref: string, op: 'click' | 'focus') =>
  `(() => { const el = document.querySelector('[data-relay-ref=${JSON.stringify(ref)}]'); if (!el) return false; el.scrollIntoView({block:'center'}); el.${op}(); return true; })()`;

const typeJs = (ref: string, text: string) =>
  `(() => { const el = document.querySelector('[data-relay-ref=${JSON.stringify(ref)}]'); if (!el) return false;
    el.focus(); const set = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set;
    if (set) set.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`;

export class CdpBrowserSession implements BrowserSession {
  private ws?: WebSocket;
  private currentTargetId?: string;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private base: string) {}

  /** Open a page target's debugger socket. http://host:9222 → its ws:// endpoint. */
  private async socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    const http = this.base.replace(/^ws/, 'http').replace(/\/$/, '');
    const list = (await (await fetch(`${http}/json`)).json()) as { id: string; type: string; webSocketDebuggerUrl?: string }[];
    let page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) {
      // An empty box browser has no page yet — open one (Chrome's /json/new, PUT on recent builds).
      page = (await (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' })).json()) as typeof list[number];
    }
    if (!page?.webSocketDebuggerUrl) throw new Error('no page target on the box browser');
    this.currentTargetId = page.id;
    const wsUrl = page.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('could not reach the box browser (CDP)')), { once: true });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
    });
    this.ws = ws;
    await this.send('Page.enable', {});
    await this.send('Runtime.enable', {});
    return ws;
  }

  private async send<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const ws = await this.socket();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000);
    });
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value: T } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result.value;
  }

  async navigate(url: string): Promise<PageView> {
    await this.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1200)); // let it settle; a load-event race is fine for a snapshot
    return this.read();
  }

  read(): Promise<PageView> {
    return this.evaluate<PageView>(SNAPSHOT_JS);
  }

  async click(ref: string): Promise<PageView> {
    if (!(await this.evaluate<boolean>(actJs(ref, 'click')))) throw new Error(`no element ${ref} on the page`);
    await new Promise((r) => setTimeout(r, 800));
    return this.read();
  }

  async type(ref: string, text: string, opts: { submit?: boolean } = {}): Promise<PageView> {
    if (!(await this.evaluate<boolean>(typeJs(ref, text)))) throw new Error(`no element ${ref} on the page`);
    if (opts.submit) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await new Promise((r) => setTimeout(r, 1000));
    }
    return this.read();
  }

  async screenshot(): Promise<string> {
    const res = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return res.data;
  }

  targetId(): string | undefined {
    return this.currentTargetId;
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }
}

/** The box browser, when the worker is pointed at one. Unset = no box (the agent gets no browser tools). */
export function browserFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserSession | undefined {
  const endpoint = env.RELAY_BROWSER_CDP;
  return endpoint ? new CdpBrowserSession(endpoint) : undefined;
}
