import { useEffect, useRef, useState } from 'react';

const BARS = 32;

/** A lively amplitude-style waveform. Real mic amplitude needs an AudioContext
 *  analyser; for the HUD we drive believable motion with a smoothed random walk,
 *  resting to a flat line when idle. */
export function Waveform({ active }: { active: boolean }) {
  const [heights, setHeights] = useState<number[]>(() => Array(BARS).fill(0.12));
  const raf = useRef<number>();
  const phase = useRef(0);

  useEffect(() => {
    if (!active) {
      setHeights(Array(BARS).fill(0.1));
      return;
    }
    const tick = () => {
      phase.current += 0.18;
      setHeights((prev) =>
        prev.map((h, i) => {
          // standing-wave envelope (tall in the middle) + jitter, eased toward target
          const envelope = Math.sin((i / BARS) * Math.PI);
          const target = 0.15 + envelope * (0.45 + 0.4 * Math.abs(Math.sin(phase.current + i * 0.5))) * Math.random();
          return h + (target - h) * 0.4;
        }),
      );
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [active]);

  return (
    <div className="flex h-10 items-center justify-center gap-[3px]">
      {heights.map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full transition-colors ${active ? 'bg-signal' : 'bg-[rgba(236,232,225,0.18)]'}`}
          style={{ height: `${Math.max(3, h * 40)}px`, opacity: active ? 0.55 + h : 0.5 }}
        />
      ))}
    </div>
  );
}
