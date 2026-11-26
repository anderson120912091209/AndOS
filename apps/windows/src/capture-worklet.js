// Runs on the audio thread: collects the mic's samples (already 16 kHz — the AudioContext
// resamples) in 100 ms blocks, each with its loudness for the HUD's waveform.
class RelayCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1600);
    this.filled = 0;
    // The recorder asks for whatever is left when you let go, so the last word isn't clipped.
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.send(true);
    };
  }

  send(last) {
    const samples = this.block.slice(0, this.filled);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    this.port.postMessage({ samples, level: samples.length ? Math.sqrt(sum / samples.length) : 0, last }, [samples.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.block.length) this.send(false);
      }
    }
    return true;
  }
}

registerProcessor('relay-capture', RelayCapture);
