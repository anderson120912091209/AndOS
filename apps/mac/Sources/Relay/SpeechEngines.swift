import Foundation

/// An on-device speech engine: load once, then turn 16 kHz mono audio into text.
protocol Transcriber: AnyObject {
  var modelExists: Bool { get }
  /// Loaded and ready. Read on the main thread.
  var isReady: Bool { get }
  /// The last transcription, for the menu's "last: X s". Read on the main thread.
  var last: WhisperEngine.Result? { get }
  func preload(_ completion: ((Bool) -> Void)?)
  func loadSync() -> Bool
  /// Calls back on the main thread.
  func transcribe(_ samples: [Float], completion: @escaping (WhisperEngine.Result) -> Void)
  func transcribeSync(_ samples: [Float]) -> WhisperEngine.Result
  func unload()
}

extension WhisperEngine: Transcriber {}

/// Where the speech models live: ~/Library/Application Support/Relay/models, or RELAY_MODELS_DIR
/// (dev runs that must not touch the real ones, like the RELAY_FETCH setup check).
enum ModelStore {
  static var root: URL {
    if let dir = ProcessInfo.processInfo.environment["RELAY_MODELS_DIR"] { return URL(fileURLWithPath: dir, isDirectory: true) }
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Relay/models", isDirectory: true)
  }
}

/// Which engine turns your voice into text — the choice in Relay's menu.
///   whisper     any language, the most accurate; it runs on the GPU, so its speed depends on the Mac
///   senseVoice  Mandarin, English, Japanese, Korean, Cantonese — about 5× faster, on the CPU
enum SpeechEngine: String, CaseIterable {
  case whisper
  case senseVoice = "sensevoice"

  private static let key = "RelaySpeechEngine"

  /// The engine a Mac starts with, and the one setup downloads: Whisper on Apple silicon, where
  /// the GPU makes it fast and it knows every language; SenseVoice on an Intel Mac, where Whisper
  /// would take seconds a sentence on the CPU.
  static var setupDefault: SpeechEngine {
    #if arch(arm64)
    return .whisper
    #else
    return .senseVoice
    #endif
  }

  /// RELAY_ENGINE overrides the saved choice (dev runs, the RELAY_TRANSCRIBE hook).
  static var chosen: SpeechEngine {
    get {
      let raw = ProcessInfo.processInfo.environment["RELAY_ENGINE"] ?? UserDefaults.standard.string(forKey: key)
      return raw.flatMap(SpeechEngine.init(rawValue:)) ?? setupDefault
    }
    set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
  }

  var engine: Transcriber {
    switch self {
    case .whisper: WhisperEngine.shared
    case .senseVoice: SenseVoiceEngine.shared
    }
  }

  /// Whether this Mac has what the engine needs: its model, and for SenseVoice its runtime.
  var available: Bool {
    switch self {
    case .whisper: WhisperEngine.shared.modelExists
    case .senseVoice: SenseVoiceEngine.runtimeAvailable && SenseVoiceEngine.shared.modelExists
    }
  }

  var name: String {
    switch self {
    case .whisper: "Whisper"
    case .senseVoice: "SenseVoice"
    }
  }

  /// What you can speak to it, short enough for the notch.
  var languages: String {
    switch self {
    case .whisper: "any language"
    case .senseVoice: "中文 · English"
    }
  }

  /// The menu's line for this engine.
  var menuTitle: String {
    switch self {
    case .whisper: "Whisper — any language, most accurate"
    case .senseVoice: "SenseVoice — 中文 · English · 日本語 · 한국어 · 粵語, fastest"
    }
  }
}
