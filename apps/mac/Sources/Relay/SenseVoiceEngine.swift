import CSherpa
import Darwin
import Foundation

/// Relay's fast speech engine: SenseVoice-Small (Alibaba's FunASR team, FunASR Model License 1.1),
/// run on the CPU by sherpa-onnx. Mandarin, English, Japanese, Korean and Cantonese, punctuated,
/// about 5× faster than Whisper on the same words: it reads only the audio you spoke, where
/// Whisper always pays for a full 30-second window, and it writes the sentence in one pass rather
/// than word by word. It's CPU work, so a MacBook Air keeps up with a Pro. Whisper stays the engine
/// for every other language. The model is scripts/fetch-sensevoice.sh's (~240 MB, once).
final class SenseVoiceEngine: Transcriber {
  static let shared = SenseVoiceEngine()

  static var modelDir: URL {
    ModelStore.root.appendingPathComponent("sensevoice-small-int8", isDirectory: true)
  }

  /// Whether sherpa-onnx loaded at all. It's weak-linked, so a binary run without its dylibs
  /// (a bare `swift build` product) still starts — with Whisper only.
  static let runtimeAvailable = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "SherpaOnnxCreateOfflineRecognizer") != nil // RTLD_DEFAULT

  /// The performance cores: SenseVoice is CPU work, and an efficiency core only slows a pass down.
  /// An Intel Mac has no core kinds, so there it's every physical core.
  private static let threads: Int32 = {
    func count(_ name: String) -> Int32 {
      var n: Int32 = 0
      var size = MemoryLayout<Int32>.size
      return sysctlbyname(name, &n, &size, nil, 0) == 0 ? n : 0
    }
    let n = count("hw.perflevel0.physicalcpu") > 0 ? count("hw.perflevel0.physicalcpu") : count("hw.physicalcpu")
    return min(max(n, 2), 8)
  }()

  private var recognizer: OpaquePointer?
  private let queue = DispatchQueue(label: "relay.sensevoice", qos: .userInitiated)

  var modelExists: Bool {
    let files = ["model.int8.onnx", "tokens.txt"].map { Self.modelDir.appendingPathComponent($0).path }
    return files.allSatisfy { FileManager.default.fileExists(atPath: $0) }
  }

  /// True once the model is loaded. Read on the main thread.
  private(set) var isReady = false
  /// The last transcription, for the menu's "last: X s". Read on the main thread.
  private(set) var last: WhisperEngine.Result?

  func preload(_ completion: ((Bool) -> Void)? = nil) {
    queue.async {
      let ok = self.loadOnQueue()
      DispatchQueue.main.async {
        self.isReady = ok
        completion?(ok)
      }
    }
  }

  func loadSync() -> Bool {
    let ok = queue.sync { loadOnQueue() }
    isReady = ok
    return ok
  }

  func transcribe(_ samples: [Float], completion: @escaping (WhisperEngine.Result) -> Void) {
    queue.async {
      let result = self.transcribeOnQueue(samples)
      DispatchQueue.main.async {
        self.last = result
        completion(result)
      }
    }
  }

  func transcribeSync(_ samples: [Float]) -> WhisperEngine.Result {
    queue.sync { transcribeOnQueue(samples) }
  }

  func unload() {
    queue.sync {
      if let recognizer { SherpaOnnxDestroyOfflineRecognizer(recognizer) }
      recognizer = nil
    }
    isReady = false
  }

  // MARK: - On the engine's queue

  private func loadOnQueue() -> Bool {
    guard recognizer == nil else { return true }
    guard Self.runtimeAvailable, modelExists else { return false }
    // sherpa-onnx copies every string while it builds the recognizer, so these live only that long.
    let values: [String] = [
      Self.modelDir.appendingPathComponent("model.int8.onnx").path,
      Self.modelDir.appendingPathComponent("tokens.txt").path,
      "auto", "cpu", "greedy_search",
    ]
    let strings: [UnsafeMutablePointer<CChar>?] = values.map { strdup($0) }
    defer { strings.forEach { free($0) } }

    var config = SherpaOnnxOfflineRecognizerConfig()
    config.feat_config.sample_rate = 16_000
    config.feat_config.feature_dim = 80
    config.model_config.sense_voice.model = UnsafePointer(strings[0])
    config.model_config.tokens = UnsafePointer(strings[1])
    config.model_config.sense_voice.language = UnsafePointer(strings[2]) // detected per utterance
    config.model_config.sense_voice.use_itn = 1 // punctuation, and numbers written as numbers
    config.model_config.provider = UnsafePointer(strings[3])
    config.model_config.num_threads = Self.threads
    config.decoding_method = UnsafePointer(strings[4])
    recognizer = SherpaOnnxCreateOfflineRecognizer(&config)
    return recognizer != nil
  }

  private func transcribeOnQueue(_ samples: [Float]) -> WhisperEngine.Result {
    let start = Date()
    let seconds = Double(samples.count) / 16_000
    let nothing = WhisperEngine.Result(text: "", language: nil, millis: 0, seconds: seconds)
    // Under ~0.25 s there's nothing worth transcribing.
    guard let recognizer, samples.count >= 4_000, let stream = SherpaOnnxCreateOfflineStream(recognizer) else { return nothing }
    defer { SherpaOnnxDestroyOfflineStream(stream) }
    samples.withUnsafeBufferPointer { SherpaOnnxAcceptWaveformOffline(stream, 16_000, $0.baseAddress, Int32($0.count)) }
    SherpaOnnxDecodeOfflineStream(recognizer, stream)
    guard let result = SherpaOnnxGetOfflineStreamResult(stream) else { return nothing }
    defer { SherpaOnnxDestroyOfflineRecognizerResult(result) }

    let raw = result.pointee.text.map { String(cString: $0) } ?? ""
    // "<|zh|>" → "zh"; Cantonese ("yue") is written in Chinese characters too, so it gets the same polish.
    let language = result.pointee.lang.map { String(cString: $0).trimmingCharacters(in: CharacterSet(charactersIn: "<|>")) }
    var text = TextPolish.polish(raw, language: language == "yue" ? "zh" : language)
    if TextPolish.isLikelyHallucination(text) { text = "" }
    let millis = Int(Date().timeIntervalSince(start) * 1000)
    Log.app.notice("sensevoice: \(millis) ms for \(seconds, format: .fixed(precision: 1)) s, lang=\(language ?? "?", privacy: .public)")
    return WhisperEngine.Result(text: text, language: language, millis: millis, seconds: seconds)
  }
}
