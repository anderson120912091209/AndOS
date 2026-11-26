// The hidden recorder window: the mic opens when you start holding Ctrl + Win and closes the
// moment you let go — it's never on in between, so Windows' "mic in use" icon means you're talking.

interface RecorderBridge {
  onStart(cb: () => void): void;
  onStop(cb: (keep: boolean) => void): void;
  level(value: number): void;
  audio(samples: ArrayBuffer | null): void;
  error(message: string): void;
}

declare const relay: RecorderBridge;

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  chunks: Float32Array[];
  /** resolves when the worklet has handed over its last partial block */
  flushed?: Promise<void>;
  onLast?: () => void;
}

let session: Promise<Session | null> | null = null;

async function open(): Promise<Session | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      // Raw voice: Windows' own echo cancelling and gain riding smear words for a speech model.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext({ sampleRate: 16_000 });
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const node = new AudioWorkletNode(ctx, 'relay-capture');
    const s: Session = { stream, ctx, node, chunks: [] };
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; level: number; last: boolean }>) => {
      if (e.data.samples.length) s.chunks.push(e.data.samples);
      relay.level(e.data.level);
      if (e.data.last) s.onLast?.();
    };
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination); // a node only runs when something listens to it; it outputs silence
    return s;
  } catch (err) {
    relay.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return null;
  }
}

relay.onStart(() => {
  session = open();
});

relay.onStop(async (keep) => {
  const s = await session;
  session = null;
  if (!s) {
    relay.audio(null);
    return;
  }
  if (keep) {
    await Promise.race([
      new Promise<void>((resolve) => {
        s.onLast = resolve;
        s.node.port.postMessage('flush');
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  }
  for (const track of s.stream.getTracks()) track.stop();
  await s.ctx.close().catch(() => undefined);
  if (!keep) {
    relay.audio(null);
    return;
  }
  const total = s.chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const c of s.chunks) {
    all.set(c, at);
    at += c.length;
  }
  relay.audio(all.buffer);
});
