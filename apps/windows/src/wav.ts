// The mic's samples (16 kHz, mono, −1…1 floats) as a 16-bit PCM WAV file — the format the
// speech engine reads without converting anything.

export const SAMPLE_RATE = 16_000;

export function wavFromSamples(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Loud enough to be worth transcribing? Whisper invents words from silence ("Thank you."). */
export function hasSpeech(samples: Float32Array, threshold = 0.012): boolean {
  if (samples.length < SAMPLE_RATE * 0.25) return false; // under a quarter second
  // the loudest 50 ms window, so a short word in a long pause still counts
  const window = SAMPLE_RATE * 0.05;
  let best = 0;
  for (let start = 0; start + window <= samples.length; start += window / 2) {
    let sum = 0;
    for (let i = start; i < start + window; i++) sum += samples[i]! * samples[i]!;
    best = Math.max(best, Math.sqrt(sum / window));
  }
  return best >= threshold;
}
