import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { routeIntent } from '@relay/shared';
import type { RoutedIntent } from '@relay/shared';
import { useSpeech } from '../hooks/useSpeech.js';
import { submitUtterance } from '../lib/api.js';
import { KIND_META } from '../lib/format.js';
import { Waveform } from './Waveform.js';

const VERB: Record<string, string> = {
  dictation: 'Writing it down',
  command: 'Running command',
  agent: 'Dispatching agent',
};

/** The always-present voice bar. Press Space (or click the orb) to START listening,
 *  press again to STOP and submit. Type as a fallback. Shows a live routing preview
 *  and surfaces mic/permission errors so a blocked mic never looks like it "just quit". */
export function VoiceHud({ onSubmitted }: { onSubmitted?: (intent: RoutedIntent) => void }) {
  const speech = useSpeech();
  const [text, setText] = useState('');
  const [flash, setFlash] = useState<RoutedIntent | null>(null);
  const textRef = useRef('');
  const typingRef = useRef(false);
  textRef.current = text;

  const open = speech.listening || Boolean(speech.error) || text.trim().length > 0;

  // Mirror the live transcript into the editable text while listening.
  useEffect(() => {
    if (speech.listening) setText(speech.transcript);
  }, [speech.transcript, speech.listening]);

  // Live routing preview (pure, instant) — the "never a black box" affordance.
  const preview = useMemo<RoutedIntent | null>(() => {
    const t = text.trim();
    return t ? routeIntent(t) : null;
  }, [text]);

  async function submit() {
    const utterance = textRef.current.trim();
    if (!utterance) return;
    setText('');
    speech.reset();
    const { intent } = await submitUtterance(utterance, { appName: 'Relay', capturedAt: Date.now() });
    setFlash(intent);
    onSubmitted?.(intent);
    setTimeout(() => setFlash(null), 1600);
  }

  function stopAndSubmit() {
    speech.stop();
    setTimeout(submit, 160); // let the engine flush its final result, then send
  }

  // Press Space to toggle listening on/off (ignored while typing or when a button is focused).
  function toggle() {
    if (!speech.supported) return;
    if (speech.listening) stopAndSubmit();
    else speech.start();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || typingRef.current) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.listening, speech.supported]);

  const previewColor = preview ? KIND_META[preview.kind].color : 'text-faint';

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col items-center px-4 pb-7">
      {/* Expanded panel: transcript / error + routing preview */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="glass pointer-events-auto mb-3 w-full max-w-xl overflow-hidden rounded-3xl p-5 shadow-hud hairline"
          >
            {speech.listening && <Waveform active />}

            {speech.error && !text ? (
              <p className="mt-1 text-center text-[14px] leading-snug text-bad">{speech.error}</p>
            ) : (
              <p className="mt-1 min-h-[28px] text-center font-display text-[20px] leading-snug tracking-tight text-bone">
                {text || <span className="text-faint">Listening…</span>}
              </p>
            )}

            <div className="mt-3 flex items-center justify-center">
              <AnimatePresence mode="wait">
                {preview && (
                  <motion.div
                    key={preview.kind}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="flex max-w-lg items-center gap-2 rounded-full bg-[rgba(236,232,225,0.05)] px-3 py-1.5"
                  >
                    <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${previewColor}`}>
                      {VERB[preview.kind]}
                    </span>
                    <span className="h-3 w-px bg-[rgba(236,232,225,0.15)]" />
                    <span className="truncate text-[12px] text-dim">{preview.reason}</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Verdict flash after submit */}
      <AnimatePresence>
        {flash && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="pointer-events-none absolute -top-2 flex items-center gap-2 rounded-full bg-[rgba(203,242,78,0.12)] px-4 py-2 hairline"
          >
            <span className={`text-[13px] ${KIND_META[flash.kind].color}`}>{KIND_META[flash.kind].glyph}</span>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone">
              {flash.kind === 'agent' ? 'Dispatched' : flash.kind === 'command' ? 'Done' : 'Captured'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The dock: orb + input */}
      <div className="glass pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-full py-2.5 pl-2.5 pr-3 shadow-hud hairline">
        <button
          onClick={(e) => {
            e.currentTarget.blur(); // so a later Space press isn't swallowed by the button
            toggle();
          }}
          disabled={!speech.supported}
          title={speech.supported ? 'Click or press Space to start / stop' : 'Speech not supported in this browser — type instead'}
          className="group relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition-all disabled:opacity-40"
          style={{
            background: speech.listening ? 'rgba(203,242,78,0.16)' : 'rgba(236,232,225,0.06)',
            boxShadow: speech.listening ? '0 0 0 1px rgba(203,242,78,0.5), 0 0 28px -6px rgba(203,242,78,0.6)' : 'none',
          }}
        >
          {speech.listening && <span className="absolute inset-0 animate-breathe rounded-full bg-signal/20" />}
          <MicGlyph active={speech.listening} />
        </button>

        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (speech.error) speech.reset(); // typing clears a stale mic error
          }}
          onFocus={() => (typingRef.current = true)}
          onBlur={() => (typingRef.current = false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={speech.listening ? 'Listening… press Space to stop' : 'Say it, or type it — e.g. “research the top CRMs and draft an email”'}
          className="min-w-0 flex-1 bg-transparent font-sans text-[15px] text-bone placeholder:text-faint focus:outline-none"
        />

        <div className="hidden shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-faint sm:flex">
          <kbd className="rounded bg-[rgba(236,232,225,0.07)] px-1.5 py-0.5">space</kbd>
          <span>to {speech.listening ? 'stop' : 'talk'}</span>
        </div>
      </div>
    </div>
  );
}

function MicGlyph({ active }: { active: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" className={active ? 'text-signal' : 'text-bone/80'}>
      <rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 18v3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
