// Putting the words where you're typing: through the clipboard and a Ctrl+V, then putting back
// whatever you had copied — the same trick as Relay on the Mac.
//
// Electron 45's clipboard is the web's (async read/write of MIME-typed items), so "whatever you
// had copied" is every format at once — text, HTML, an image — read out in full up front:
// the items read() returns can point at the live clipboard, which we're about to overwrite.

export interface ClipItemLike {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
}

export interface ClipboardLike {
  read(): Promise<ClipItemLike[]>;
  write(items: never[]): Promise<void>;
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  clear(): void;
}

export interface PasteDeps {
  clipboard: ClipboardLike;
  /** a clipboard item from MIME type → data (Electron's ClipboardItem) */
  item(record: Record<string, unknown>): never;
  /** press Ctrl+V in whatever app has focus */
  pressPaste(): void;
  /** resolves once Ctrl and Win are both up — Ctrl+V sent while Win is still held is Win+Ctrl+V */
  keysReleased(timeoutMs: number): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

/** Everything on the clipboard, read out now. Undefined if another app has it locked. */
export async function snapshot(clipboard: ClipboardLike): Promise<Record<string, unknown>[] | undefined> {
  try {
    const items = await clipboard.read();
    const records = await Promise.all(
      items.map(async (item) => {
        const pairs = await Promise.all(
          item.types.map(async (type) => {
            try {
              return [type, await item.getType(type)] as const;
            } catch {
              return undefined; // a format that can't be read back is left out, not fatal
            }
          }),
        );
        return Object.fromEntries(pairs.filter((p): p is readonly [string, unknown] => p !== undefined));
      }),
    );
    return records.filter((r) => Object.keys(r).length > 0);
  } catch {
    return undefined;
  }
}

export async function pasteText(text: string, deps: PasteDeps): Promise<'pasted' | 'copied'> {
  const { clipboard } = deps;
  const before = await snapshot(clipboard);

  // Still holding the chord? Leave the words on the clipboard instead of sending a stray shortcut.
  if (!(await deps.keysReleased(1500))) {
    await clipboard.writeText(text);
    return 'copied';
  }
  await clipboard.writeText(text);
  deps.pressPaste();
  // Give the app a moment to read the clipboard before restoring yours.
  await deps.wait(400);
  // Only if it's still our text: if you copied something in the meantime, that wins.
  if ((await clipboard.readText().catch(() => '')) === text && before) {
    if (before.length) await clipboard.write(before.map((record) => deps.item(record))).catch(() => undefined);
    else clipboard.clear();
  }
  return 'pasted';
}
