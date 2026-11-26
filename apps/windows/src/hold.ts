// Hold-to-talk on Windows: hold Ctrl + Win, talk, let go.
//
// Windows can't see a laptop's Fn key (the keyboard firmware keeps it), so Relay uses the chord
// Wispr Flow uses on Windows: Ctrl + Win, in either order. Held on its own it does nothing in
// Windows. But it's also how real shortcuts begin — Ctrl+Win+D opens a desktop, Ctrl+Win+←/→
// switches desktops — so any other key during the hold means "that was a shortcut", and the
// dictation quietly steps aside.
//
// Pure: keys in, decisions out. The Electron side (main.ts) feeds it the global keyboard hook.

export type HoldKey = 'ctrl' | 'win' | 'other';

export type HoldEvent =
  /** both keys are down: open the mic now (so the first word isn't lost) and show "listening" */
  | { type: 'arm' }
  /** let go after talking: transcribe what was heard and paste it */
  | { type: 'finish'; heldMs: number }
  /** another key joined in (a shortcut), or the hold was too short to be speech */
  | { type: 'cancel'; why: 'shortcut' | 'tap' };

export interface HoldOptions {
  /** shorter than this is a tap, not dictation */
  minHoldMs: number;
}

export class Hold {
  private ctrl = false;
  private win = false;
  /** idle → armed (talking) → spent (waiting for both keys to come up) → idle */
  private state: 'idle' | 'armed' | 'spent' = 'idle';
  private armedAt = 0;

  constructor(
    private readonly emit: (e: HoldEvent) => void,
    private readonly opts: HoldOptions = { minHoldMs: 300 },
  ) {}

  get talking(): boolean {
    return this.state === 'armed';
  }

  /** Both chord keys are up — safe to send Ctrl+V without Windows reading it as Win+Ctrl+V. */
  get released(): boolean {
    return !this.ctrl && !this.win;
  }

  down(key: HoldKey, now: number): void {
    if (key === 'other') {
      if (this.state === 'armed') {
        this.state = 'spent';
        this.emit({ type: 'cancel', why: 'shortcut' });
      }
      return;
    }
    // Windows repeats a held key's "down" — a key that's already down changes nothing.
    if (key === 'ctrl') this.ctrl = true;
    else this.win = true;
    if (this.state === 'idle' && this.ctrl && this.win) {
      this.state = 'armed';
      this.armedAt = now;
      this.emit({ type: 'arm' });
    }
  }

  up(key: HoldKey, now: number): void {
    if (key === 'other') return;
    if (key === 'ctrl') this.ctrl = false;
    else this.win = false;
    if (this.state === 'armed') {
      // Letting go of either key ends it; the other may still be on its way up.
      this.state = 'spent';
      const heldMs = now - this.armedAt;
      this.emit(heldMs >= this.opts.minHoldMs ? { type: 'finish', heldMs } : { type: 'cancel', why: 'tap' });
    }
    if (this.state === 'spent' && this.released) this.state = 'idle';
  }

  /** Something else ended the dictation (too long, an error): wait for the keys to come up. */
  abandon(): void {
    if (this.state === 'armed') this.state = this.released ? 'idle' : 'spent';
  }
}
