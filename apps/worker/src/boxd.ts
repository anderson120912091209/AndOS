// The box's hands, as the worker reaches them: boxd's HTTP API (apps/box/boxd/boxd.mjs).
//
// One client per job. Its `session` is the job's own shell and its claim on the screen, so two jobs
// running at once never share a working directory or fight over the mouse. The endpoint is found
// lazily — the first time the job reaches for the computer — which also wakes a sleeping box.

export interface BoxdEndpoint {
  url: string;
  token: string;
}

/** A refusal or failure from the box, with boxd's own explanation (what the model reads). */
export class BoxdError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ExecResult {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface Screenshot {
  /** base64 PNG */
  data: string;
  media_type: 'image/png';
}

export class BoxdClient {
  private endpoint?: Promise<BoxdEndpoint>;

  constructor(
    private find: () => Promise<BoxdEndpoint>,
    readonly session: string,
    private http: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    // Found once per job; if finding it fails, the next call tries again.
    const endpoint = await (this.endpoint ??= this.find().catch((err) => {
      this.endpoint = undefined;
      throw err;
    }));
    let res: Response;
    try {
      res = await this.http(`${endpoint.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ session: this.session, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.endpoint = undefined; // the box restarted, maybe with a new token — look again next time
      throw new BoxdError(503, `Relay's computer didn't answer (${(err as Error).message}).`);
    }
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      if (res.status === 401) this.endpoint = undefined;
      throw new BoxdError(res.status, out.error ?? `the box refused ${path} (${res.status})`);
    }
    return out;
  }

  /** Run a command in this job's shell; cd and variables carry over to the next one. */
  exec(command: string, timeoutMs = 120_000): Promise<ExecResult> {
    return this.call('/exec', { command, timeout_ms: timeoutMs }, timeoutMs + 15_000);
  }

  async restart(): Promise<string> {
    return (await this.call<{ output: string }>('/exec', { restart: true })).output;
  }

  async view(path: string, viewRange?: [number, number]): Promise<string> {
    return (await this.call<{ text: string }>('/files/view', { path, view_range: viewRange })).text;
  }

  async create(path: string, fileText: string): Promise<string> {
    return (await this.call<{ text: string }>('/files/create', { path, file_text: fileText })).text;
  }

  async strReplace(path: string, oldStr: string, newStr: string): Promise<string> {
    return (await this.call<{ text: string }>('/files/str_replace', { path, old_str: oldStr, new_str: newStr })).text;
  }

  async insert(path: string, after: number, text: string): Promise<string> {
    return (await this.call<{ text: string }>('/files/insert', { path, insert_line: after, insert_text: text })).text;
  }

  /** The whole screen, or a region of it enlarged to the screen's size (a zoom). */
  screenshot(region?: number[]): Promise<Screenshot> {
    return this.call('/screenshot', region ? { region } : {});
  }

  cursor(): Promise<{ x: number; y: number }> {
    return this.call('/cursor', {});
  }

  /** One mouse/keyboard member of the computer toolset, by name, with the model's input. */
  async input(action: string, input: unknown): Promise<void> {
    await this.call('/input', { action, input }, 30_000);
  }
}

/**
 * How a worker finds boxd: asks the server to make sure the box is up, then takes the address that
 * works from where the worker runs — this Mac, or a container on the box's network (RELAY_BOXD_URL).
 */
export function boxdFinder(server: string, auth: Record<string, string>, env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch) {
  return async (): Promise<BoxdEndpoint> => {
    const res = await http(`${server}/api/worker/box/ensure`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{}' });
    const out = (await res.json().catch(() => ({}))) as {
      computer?: boolean;
      note?: string;
      error?: string;
      boxd?: { host: string; network: string; token: string };
    };
    if (!res.ok || !out.computer || !out.boxd) {
      throw new BoxdError(res.ok ? 409 : res.status, out.error ?? out.note ?? "Relay's computer isn't available right now.");
    }
    return { url: env.RELAY_BOXD_URL?.replace(/\/$/, '') || out.boxd.host, token: out.boxd.token };
  };
}
