import Foundation
import CWhisper

/// Local, multilingual speech-to-text via whisper.cpp (statically linked, Metal-accelerated).
/// It detects the spoken language by itself — English, Mandarin, or both in one sentence —
/// so there's nothing to switch. The model loads once and stays warm in memory.
final class WhisperEngine {
  static let shared = WhisperEngine()

  static let modelName = ProcessInfo.processInfo.environment["RELAY_WHISPER_MODEL"]
    ?? "ggml-large-v3-turbo-q5_0.bin"

  static var modelURL: URL {
    ModelStore.root.appendingPathComponent(modelName)
  }

  struct Result {
    let text: String
    let language: String?
    let millis: Int
    /// how much speech it was, in seconds
    let seconds: Double
  }

  private var ctx: OpaquePointer?
  private let queue = DispatchQueue(label: "relay.whisper", qos: .userInitiated)

  var modelExists: Bool { FileManager.default.fileExists(atPath: Self.modelURL.path) }
  /// True once the model is loaded. Read on the main thread.
  private(set) var isReady = false
  /// The last transcription, for the menu: how long it took is the number to ask for when Relay
  /// feels slow on someone's Mac. Read on the main thread.
  private(set) var last: Result?

  /// Load the model in the background (idempotent). Calls back on the main thread.
  func preload(_ completion: ((Bool) -> Void)? = nil) {
    queue.async {
      let ok = self.loadOnQueue()
      DispatchQueue.main.async {
        self.isReady = ok
        completion?(ok)
      }
    }
  }

  /// Blocking load, for dev tools that aren't running a main run loop.
  func loadSync() -> Bool {
    let ok = queue.sync { loadOnQueue() }
    isReady = ok
    return ok
  }

  /// Transcribe 16 kHz mono Float32 PCM. Calls back on the main thread.
  func transcribe(_ samples: [Float], completion: @escaping (Result) -> Void) {
    queue.async {
      let result = self.transcribeOnQueue(samples)
      DispatchQueue.main.async {
        self.last = result
        completion(result)
      }
    }
  }

  /// Blocking transcription, for dev tools.
  func transcribeSync(_ samples: [Float]) -> Result {
    queue.sync { transcribeOnQueue(samples) }
  }

  /// Free the model before the process exits. Without this, ggml's Metal device is torn
  /// down by a static destructor while the context still holds GPU buffers, and the app
  /// aborts on quit ("Relay quit unexpectedly").
  func unload() {
    queue.sync {
      if let ctx { whisper_free(ctx) }
      ctx = nil
    }
    isReady = false
  }

  // MARK: - On the whisper queue

  private func loadOnQueue() -> Bool {
    if ctx == nil, modelExists {
      var params = whisper_context_default_params()
      // Apple silicon's GPU does the work. An Intel Mac's GPU can't run it well, so there it's the
      // CPU (AVX2) — slow for this model, which is why Intel Macs start on SenseVoice instead.
      #if arch(arm64)
      params.use_gpu = true
      #else
      params.use_gpu = false
      #endif
      params.flash_attn = true
      ctx = Self.modelURL.path.withCString { whisper_init_from_file_with_params($0, params) }
    }
    return ctx != nil
  }

  private func transcribeOnQueue(_ samples: [Float]) -> Result {
    let start = Date()
    let seconds = Double(samples.count) / 16_000
    // Under ~0.25 s there's nothing worth transcribing (and Whisper tends to invent words).
    guard let ctx, samples.count >= 4_000 else { return Result(text: "", language: nil, millis: 0, seconds: seconds) }

    // Greedy decoding: the same transcripts as beam search in our tests (English, Mandarin,
    // mixed), with a decoder 2-4× faster, which on a MacBook Air is a real share of the wait.
    // RELAY_WHISPER_BEAM=5 brings beam search back.
    let beam = Int32(ProcessInfo.processInfo.environment["RELAY_WHISPER_BEAM"] ?? "1") ?? 1
    var p = whisper_full_default_params(beam > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY)
    if beam > 1 { p.beam_search.beam_size = beam }
    p.n_threads = Int32(max(4, ProcessInfo.processInfo.activeProcessorCount / 2))
    p.translate = false
    p.no_context = true
    p.no_timestamps = true
    p.print_special = false
    p.print_progress = false
    p.print_realtime = false
    p.print_timestamps = false
    p.suppress_blank = true
    p.suppress_nst = true
    p.temperature = 0

    // The language is detected per utterance. Our whisper.cpp patch (scripts/whisper-encode-once
    // .patch) reuses that detection's encoder pass for the transcript, so "auto" costs one encoder
    // pass, the same as a fixed language; unpatched, it ran the encoder twice.
    let raw: String = "auto".withCString { lang in
      p.language = lang
      let rc = samples.withUnsafeBufferPointer { whisper_full(ctx, p, $0.baseAddress, Int32($0.count)) }
      guard rc == 0 else { return "" }
      var out = ""
      for i in 0..<whisper_full_n_segments(ctx) {
        if let seg = whisper_full_get_segment_text(ctx, i) { out += String(cString: seg) }
      }
      return out
    }

    let id = whisper_full_lang_id(ctx)
    let language = id >= 0 ? whisper_lang_str(id).map { String(cString: $0) } : nil
    var text = TextPolish.polish(raw, language: language)
    if TextPolish.isLikelyHallucination(text) { text = "" }
    let millis = Int(Date().timeIntervalSince(start) * 1000)
    Log.app.notice("whisper: \(millis) ms for \(seconds, format: .fixed(precision: 1)) s, lang=\(language ?? "?", privacy: .public)")
    return Result(text: text, language: language, millis: millis, seconds: seconds)
  }
}
