import { describe, expect, it } from 'vitest';
import { Hold, type HoldEvent } from '../src/hold.js';
import { pasteText, snapshot, type ClipboardLike, type PasteDeps } from '../src/paste.js';
import { hasSpeech, SAMPLE_RATE, wavFromSamples } from '../src/wav.js';
import { clean } from '../src/support.js';
import { threadsFor } from '../src/whisper.js';

function holdWith() {
  const events: HoldEvent[] = [];
  const hold = new Hold((e) => events.push(e));
  return { hold, events, kinds: () => events.map((e) => e.type) };
}

describe('hold Ctrl + Win to talk', () => {
  it('starts when both are down, in either order, and finishes when either comes up', () => {
    const { hold, events, kinds } = holdWith();
    hold.down('win', 0);
    expect(kinds()).toEqual([]);
    hold.down('ctrl', 10);
    expect(kinds()).toEqual(['arm']);
    expect(hold.talking).toBe(true);
    hold.down('ctrl', 400); // Windows repeats a held key — nothing new
    hold.up('win', 2010);
    expect(events.at(-1)).toEqual({ type: 'finish', heldMs: 2000 });
    expect(hold.released).toBe(false); // Ctrl is still down: no Ctrl+V yet
    hold.up('ctrl', 2050);
    expect(hold.released).toBe(true);
  });

  it('steps aside for real shortcuts: Ctrl + Win + D, ← →', () => {
    const { hold, kinds } = holdWith();
    hold.down('ctrl', 0);
    hold.down('win', 5);
    hold.down('other', 80); // D
    expect(kinds()).toEqual(['arm', 'cancel']);
    hold.up('other', 120);
    hold.up('win', 150);
    hold.up('ctrl', 160);
    expect(kinds()).toEqual(['arm', 'cancel']); // no finish after a cancel
    hold.down('ctrl', 1000);
    hold.down('win', 1001);
    expect(kinds()).toEqual(['arm', 'cancel', 'arm']); // ready again once both came up
  });

  it('a quick tap isn’t dictation', () => {
    const { hold, events } = holdWith();
    hold.down('ctrl', 0);
    hold.down('win', 0);
    hold.up('ctrl', 120);
    expect(events.at(-1)).toEqual({ type: 'cancel', why: 'tap' });
  });

  it('doesn’t re-arm while a key from the last hold is still down', () => {
    const { hold, kinds } = holdWith();
    hold.down('ctrl', 0);
    hold.down('win', 0);
    hold.up('win', 1000); // finish
    hold.down('win', 1100); // win again while ctrl never came up
    expect(kinds()).toEqual(['arm', 'finish']);
  });
});

describe('audio', () => {
  it('writes a 16 kHz mono 16-bit WAV', () => {
    const wav = wavFromSamples(new Float32Array([0, 1, -1, 0.5]));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });

  it('skips silence instead of letting Whisper invent words', () => {
    const quiet = new Float32Array(SAMPLE_RATE).fill(0.001);
    expect(hasSpeech(quiet)).toBe(false);
    const voice = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => (i > 8000 && i < 9600 ? 0.2 * Math.sin(i / 7) : 0.001));
    expect(hasSpeech(voice)).toBe(true);
    expect(hasSpeech(new Float32Array(1000).fill(0.3))).toBe(false); // too short to be a word
  });
});

/** The clipboard as Electron 45 shows it: items of MIME-typed data, read and written async. */
class FakeClipboard implements ClipboardLike {
  items: Record<string, unknown>[] = [];
  locked = false;
  async read() {
    if (this.locked) throw new Error('OpenClipboard failed');
    return this.items.map((r) => ({ types: Object.keys(r), getType: async (t: string) => r[t] }));
  }
  async write(items: never[]) {
    this.items = items as unknown as Record<string, unknown>[];
  }
  async readText() {
    return String(this.items[0]?.['text/plain'] ?? '');
  }
  async writeText(text: string) {
    this.items = [{ 'text/plain': text }];
  }
  clear() {
    this.items = [];
  }
}

const deps = (clipboard: FakeClipboard, over: Partial<PasteDeps> = {}): PasteDeps => ({
  clipboard,
  item: (record) => record as never,
  pressPaste: () => undefined,
  keysReleased: async () => true,
  wait: async () => undefined,
  ...over,
});

describe('pasting', () => {
  it('pastes, then gives you back everything you had copied — text, formatting, image', async () => {
    const clipboard = new FakeClipboard();
    clipboard.items = [{ 'text/plain': 'what you copied', 'text/html': '<b>what you copied</b>', 'image/png': 'PNG…' }];
    const pressed: string[] = [];
    const how = await pasteText('Hello there.', deps(clipboard, { pressPaste: () => void clipboard.readText().then((t) => pressed.push(t)) }));
    expect(how).toBe('pasted');
    expect(pressed).toEqual(['Hello there.']);
    expect(clipboard.items).toEqual([{ 'text/plain': 'what you copied', 'text/html': '<b>what you copied</b>', 'image/png': 'PNG…' }]);
  });

  it('never presses Ctrl+V while Win is still held — it leaves the words on the clipboard', async () => {
    const clipboard = new FakeClipboard();
    let pressed = false;
    const how = await pasteText('नमस्ते, कल मिलते हैं।', deps(clipboard, { pressPaste: () => (pressed = true), keysReleased: async () => false }));
    expect(how).toBe('copied');
    expect(pressed).toBe(false);
    expect(await clipboard.readText()).toBe('नमस्ते, कल मिलते हैं।');
  });

  it('leaves alone something you copied while it was pasting', async () => {
    const clipboard = new FakeClipboard();
    clipboard.items = [{ 'text/plain': 'old' }];
    await pasteText('new words', deps(clipboard, { wait: async () => void (clipboard.items = [{ 'text/plain': 'copied meanwhile' }]) }));
    expect(await clipboard.readText()).toBe('copied meanwhile');
  });

  it('still pastes when another app has the clipboard locked — it just can’t put yours back', async () => {
    const clipboard = new FakeClipboard();
    clipboard.locked = true;
    let pressed = false;
    expect(await pasteText('hi', deps(clipboard, { pressPaste: () => (pressed = true) }))).toBe('pasted');
    expect(pressed).toBe(true);
  });

  it('an empty clipboard stays empty afterwards', async () => {
    const clipboard = new FakeClipboard();
    await pasteText('hi', deps(clipboard));
    expect(clipboard.items).toEqual([]);
  });

  it('reads every format out before overwriting (live items would change underneath)', async () => {
    const clipboard = new FakeClipboard();
    clipboard.items = [{ 'text/plain': 'a', 'text/rtf': '{\\rtf1 a}' }];
    expect(await snapshot(clipboard)).toEqual([{ 'text/plain': 'a', 'text/rtf': '{\\rtf1 a}' }]);
  });
});

describe('cleanup (the Mac app’s own code)', () => {
  it('cleans English and keeps Hindi intact', () => {
    // the fillers go, the comma stays — same as the Mac (packages/shared dictation.test.ts)
    expect(clean('um so I think we should, uh, ship it on Friday.')).toBe('So I think we should, ship it on Friday.');
    expect(clean('नमस्ते, मैं कल ऑफिस आऊंगा।')).toBe('नमस्ते, मैं कल ऑफिस आऊंगा।');
    expect(clean('kal milte hain, okay?')).toBe('Kal milte hain, okay?');
  });
});

describe('speech engine', () => {
  it('uses the physical cores of a laptop, within reason', () => {
    expect(threadsFor(8)).toBe(4); // a 4-core, 8-thread Core i5
    expect(threadsFor(2)).toBe(2);
    expect(threadsFor(32)).toBe(8);
  });
});
