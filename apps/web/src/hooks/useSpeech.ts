import { useCallback, useEffect, useRef, useState } from 'react';

// Minimal typings for the vendor-prefixed Web Speech API (not in lib.dom for all TS setups).
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorLike {
  error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
}

function getRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/** Map a raw SpeechRecognition error code to a short, user-facing message. */
function friendlyError(code: string): string | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone blocked — click the 🎤 / site icon in the address bar and allow it.';
    case 'audio-capture':
      return 'No microphone found. Check System Settings › Sound › Input.';
    case 'network':
      return 'Network error reaching the speech service.';
    case 'no-speech':
    case 'aborted':
      return null; // benign — not worth alarming the user
    default:
      return `Speech error: ${code}`;
  }
}

export interface SpeechState {
  supported: boolean;
  listening: boolean;
  interim: string;
  transcript: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/**
 * Toggle-to-talk dictation via the browser's speech engine (demo stand-in for local
 * whisper.cpp). Surfaces permission/other errors instead of silently stopping, so a
 * blocked mic is visible rather than looking like the HUD "just quit".
 */
export function useSpeech(): SpeechState {
  const [supported] = useState(() => getRecognition() !== null);
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const r = getRecognition();
    if (!r) return;
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onstart = () => {
      setError(null);
      setListening(true);
    };
    r.onresult = (e) => {
      let fin = '';
      let inter = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) fin += res[0].transcript;
        else inter += res[0].transcript;
      }
      if (fin) setFinalText((prev) => (prev + ' ' + fin).trim());
      setInterim(inter);
    };
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setListening(false);
      const msg = friendlyError(e?.error ?? 'unknown');
      if (msg) setError(msg);
    };
    rec.current = r;
    return () => r.abort();
  }, []);

  const start = useCallback(() => {
    if (!rec.current) return;
    setFinalText('');
    setInterim('');
    setError(null);
    try {
      rec.current.start();
      setListening(true); // optimistic; onstart confirms, onerror reverts
    } catch {
      // "already started" — ignore; a stop/start race is harmless here.
    }
  }, []);

  const stop = useCallback(() => {
    rec.current?.stop();
    setListening(false);
  }, []);

  const reset = useCallback(() => {
    setFinalText('');
    setInterim('');
    setError(null);
  }, []);

  return {
    supported,
    listening,
    interim,
    transcript: (finalText + ' ' + interim).trim(),
    error,
    start,
    stop,
    reset,
  };
}
