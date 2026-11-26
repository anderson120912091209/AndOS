// The HUD's page: one state at a time from the app, and the mic's loudness for the waveform.

export type HudState =
  | { kind: 'hidden' }
  | { kind: 'listening' }
  | { kind: 'thinking' }
  | { kind: 'done'; text?: string }
  | { kind: 'says'; text: string; warn?: boolean };

interface HudBridge {
  onState(cb: (state: HudState) => void): void;
  onLevel(cb: (level: number) => void): void;
}

declare const relay: HudBridge;

const pill = document.getElementById('pill')!;
const text = pill.querySelector<HTMLSpanElement>('.text')!;
const bars = [...pill.querySelectorAll<HTMLElement>('.wave i')];

// The bars follow the voice: louder in the middle, a little lag on the edges, eased down.
const shape = [0.55, 0.85, 1, 0.8, 0.5];
let target = 0;
let shown = 0;
let t = 0;
function frame(): void {
  shown += (target - shown) * (target > shown ? 0.5 : 0.18);
  t += 0.18;
  bars.forEach((bar, i) => {
    const wobble = 0.75 + 0.25 * Math.sin(t + i * 1.3);
    bar.style.height = `${4 + Math.min(1, shown) * 14 * shape[i]! * wobble}px`;
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

relay.onLevel((level) => {
  // speech sits around 0.02–0.2 RMS; map it onto 0…1 with a gentle curve
  target = Math.min(1, Math.sqrt(level * 6));
});

relay.onState((state) => {
  pill.className = 'pill';
  if (state.kind === 'hidden') return;
  void pill.offsetWidth; // restart the animations for the new state
  pill.classList.add('on', state.kind);
  if (state.kind === 'says' || (state.kind === 'done' && state.text)) {
    pill.classList.add('says');
    text.textContent = state.text ?? '';
  }
  if (state.kind === 'says' && state.warn) pill.classList.add('warn');
  if (state.kind !== 'listening') target = 0;
});
