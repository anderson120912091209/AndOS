// The speech engine: whisper.cpp's server (whisper-server.exe), kept running with the model
// loaded so each dictation only pays for the listening, not for loading 190 MB again. It listens
// on 127.0.0.1 only, on a port picked at random — nothing outside this PC can reach it.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';

export interface EngineOptions {
  exe: string;
  model: string;
  log: (line: string) => void;
  /** where the exe's DLLs live (the Visual C++ runtime sits beside it) */
  cwd?: string;
}

/** A free port on 127.0.0.1, by asking the OS for one. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Physical cores, roughly: laptops report twice as many logical ones, and Whisper wants the real ones. */
export function threadsFor(logical = os.cpus().length): number {
  return Math.max(2, Math.min(8, Math.round(logical / 2)));
}

/**
 * How Hindi is written. Hinglish is usually typed in English letters ("kal milte hain"), so that's
 * the default: Whisper is told it's English, and a line of romanized Hinglish shows it the style —
 * without the hint it translates Hindi instead ("I will come to office"). Plain English comes
 * through unchanged. "devanagari" lets Whisper pick the language and its own script (कल मिलते हैं).
 */
export type Script = 'latin' | 'devanagari';

export const SCRIPTS: Record<Script, Record<string, string>> = {
  latin: { language: 'en', prompt: 'Haan yaar, kal milte hain. Theek hai, main bhej dunga.' },
  devanagari: { language: 'auto' },
};

export class SpeechEngine {
  private proc?: ChildProcess;
  private port = 0;
  private ready?: Promise<void>;
  private stopping = false;
  private restarts = 0;

  constructor(private opts: EngineOptions) {}

  get model(): string {
    return this.opts.model;
  }

  /** Start (or restart with another model). Resolves once the model is loaded. */
  start(model = this.opts.model): Promise<void> {
    this.opts.model = model;
    this.stop();
    this.stopping = false;
    this.ready = this.launch();
    return this.ready;
  }

  private async launch(): Promise<void> {
    this.port = await freePort();
    const args = [
      '-m', this.opts.model,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-t', String(threadsFor()),
      '-l', 'auto', // each request says how it wants Hindi written (see `Script`)
      '-nt',
      '-sns', // no "[Music]" or "(applause)"
    ];
    this.opts.log(`engine: starting ${this.opts.exe} with ${this.opts.model.split(/[\\/]/).pop()} on :${this.port}`);
    const proc = spawn(this.opts.exe, args, { cwd: this.opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const tail: string[] = [];
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) tail.push(line.trim());
      tail.splice(0, Math.max(0, tail.length - 30));
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);

    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (err) => reject(new Error(`the speech engine couldn't start: ${err.message}`)));
      proc.once('exit', (code) => {
        // 0xC0000135 (STATUS_DLL_NOT_FOUND): a DLL is missing — say which, it's in the log
        const why = code === -1073741515 || code === 3221225781 ? 'a Windows component it needs is missing' : `it stopped (code ${code})`;
        this.opts.log(`engine: exited (${code}); last output:\n  ${tail.slice(-8).join('\n  ')}`);
        reject(new Error(`the speech engine ${why}`));
        if (!this.stopping && this.proc === proc && this.restarts < 3) {
          // Crashed mid-session: bring it back for the next dictation.
          this.restarts++;
          this.ready = this.launch();
          this.ready.catch(() => undefined);
        }
      });
    });

    const loaded = (async () => {
      for (let i = 0; i < 600; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) return;
        } catch {
          /* still loading the model */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the speech engine took too long to start');
    })();

    await Promise.race([loaded, exited]);
    this.opts.log('engine: ready');
  }

  /** Text for a 16 kHz mono WAV, with Hindi written the way you chose. */
  async transcribe(wav: Uint8Array, script: Script = 'latin'): Promise<string> {
    if (!this.ready) throw new Error('the speech engine isn’t running');
    await this.ready;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    for (const [k, v] of Object.entries(SCRIPTS[script])) form.append(k, v);
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`the speech engine answered ${res.status}`);
    const out = (await res.json()) as { text?: string; error?: string };
    if (out.error) throw new Error(out.error);
    return (out.text ?? '').replace(/\s+/g, ' ').trim();
  }

  stop(): void {
    this.stopping = true;
    this.proc?.kill();
    this.proc = undefined;
  }
}
