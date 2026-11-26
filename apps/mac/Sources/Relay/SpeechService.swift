import Foundation
import Speech
import AVFoundation

/// Captures the microphone while Fn is held: drives the waveform level and collects 16 kHz
/// mono samples for the on-device engine you chose (SpeechEngine: Whisper, or SenseVoice, the
/// fast one), which transcribes them on release. If no engine is loaded, falls back to Apple's
/// recognizer (one language) so dictation still works.
final class SpeechService: NSObject {
  private let engine = AVAudioEngine()
  private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
  private var converter: AVAudioConverter?
  private let sampleLock = NSLock()
  private var samples: [Float] = []
  /// This dictation's engine; nil while Apple's recognizer stands in.
  private var local: Transcriber?

  // Apple Speech fallback (single language).
  private var appleRecognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var appleText = ""

  /// Smoothed microphone level, 0…1, emitted per audio buffer to drive the waveform.
  var onLevel: ((Float) -> Void)?

  let fallbackLocaleID = SpeechService.defaultLocaleID()

  /// The engine for the next dictation: the one you chose if it's loaded, else Whisper.
  static var activeEngine: Transcriber? {
    let chosen = SpeechEngine.chosen.engine
    if chosen.isReady { return chosen }
    return WhisperEngine.shared.isReady ? WhisperEngine.shared : nil
  }

  /// The engine, and how fast the last dictation was — shown in the menu, so "it's slow on my
  /// Mac" comes with a number.
  var engineName: String {
    guard let engine = Self.activeEngine else { return "Apple Speech · \(fallbackLocaleID)" }
    let name = engine === SenseVoiceEngine.shared ? "SenseVoice" : "Whisper"
    guard let last = engine.last, last.millis > 0 else {
      return engine === SenseVoiceEngine.shared ? "SenseVoice · fastest" : "Whisper · any language"
    }
    let took = last.millis < 1_000 ? "\(last.millis) ms" : String(format: "%.1f s", Double(last.millis) / 1000)
    return String(format: "%@ · last: %@ for %.0f s of speech", name, took, last.seconds)
  }

  static func requestAuthorization(_ completion: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async { completion(status == .authorized) }
    }
  }

  // MARK: - Capture

  func start() throws {
    sampleLock.lock()
    samples.removeAll(keepingCapacity: true)
    sampleLock.unlock()
    local = Self.activeEngine
    let usingLocal = local != nil

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    converter = AVAudioConverter(from: format, to: target)
    converter?.downmix = true

    if !usingLocal { startAppleFallback() }

    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let self else { return }
      if !usingLocal { self.request?.append(buffer) }
      self.collect(buffer)
      self.meter(buffer)
    }
    engine.prepare()
    try engine.start()
  }

  /// Stop capture and resolve with the final text (main thread). Empty if nothing was said.
  func stop(_ completion: @escaping (String) -> Void) {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)

    guard let local else {
      request?.endAudio()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
        self?.task?.finish()
        completion(self?.appleText ?? "")
      }
      return
    }

    sampleLock.lock()
    let pcm = samples
    sampleLock.unlock()
    // Silence gate: don't hand pure room noise to Whisper.
    let rms = (pcm.reduce(0) { $0 + $1 * $1 } / Float(max(1, pcm.count))).squareRoot()
    guard rms > 0.002 else {
      DispatchQueue.main.async { completion("") }
      return
    }
    local.transcribe(pcm) { result in
      completion(result.text)
    }
  }

  private func collect(_ buffer: AVAudioPCMBuffer) {
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, out.frameLength > 0, let ch = out.floatChannelData?[0] else { return }
    let chunk = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
    sampleLock.lock()
    samples.append(contentsOf: chunk)
    sampleLock.unlock()
  }

  private func meter(_ buffer: AVAudioPCMBuffer) {
    guard let onLevel, let ch = buffer.floatChannelData?[0] else { return }
    let n = Int(buffer.frameLength)
    guard n > 0 else { return }
    var sum: Float = 0
    for i in 0..<n { let s = ch[i]; sum += s * s }
    let level = min(1, (sum / Float(n)).squareRoot() * 14) // visual knob, not calibrated
    DispatchQueue.main.async { onLevel(level) }
  }

  private func startAppleFallback() {
    appleText = ""
    task?.cancel()
    if appleRecognizer == nil { appleRecognizer = SFSpeechRecognizer(locale: Locale(identifier: fallbackLocaleID)) }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = appleRecognizer?.supportsOnDeviceRecognition ?? false
    req.addsPunctuation = true
    request = req
    task = appleRecognizer?.recognitionTask(with: req) { [weak self] result, _ in
      guard let self, let result else { return }
      self.appleText = result.bestTranscription.formattedString
    }
  }

  // MARK: - Files (dev tools)

  /// Read an audio file as 16 kHz mono Float32 — the format Whisper wants.
  static func loadPCM16k(_ url: URL) -> [Float]? {
    guard let file = try? AVAudioFile(forReading: url),
          let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
          (try? file.read(into: input)) != nil
    else { return nil }
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    guard let conv = AVAudioConverter(from: file.processingFormat, to: target) else { return nil }
    conv.downmix = true
    let capacity = AVAudioFrameCount(Double(input.frameLength) * 16_000 / file.processingFormat.sampleRate) + 1_024
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .endOfStream
        return nil
      }
      fed = true
      status.pointee = .haveData
      return input
    }
    guard error == nil, let ch = out.floatChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
  }

  // MARK: - Apple fallback locale

  static func supportedIDs() -> Set<String> {
    Set(SFSpeechRecognizer.supportedLocales().map { $0.identifier.replacingOccurrences(of: "_", with: "-") })
  }

  /// Map a preferred-language tag ("zh-Hant-TW", "en-TW") to a recognizer locale. Chinese →
  /// Mandarin by script (Traditional → zh-TW, Simplified → zh-CN); Cantonese (zh-HK) only for
  /// a Hong Kong region. Deterministic.
  static func recognizerLocale(for tag: String, supported: Set<String>) -> String? {
    if supported.contains(tag) { return tag }
    let loc = Locale(identifier: tag)
    guard let lang = loc.language.languageCode?.identifier else { return nil }
    if let region = loc.region?.identifier, supported.contains("\(lang)-\(region)") { return "\(lang)-\(region)" }
    switch lang {
    case "zh":
      let pick = loc.language.script?.identifier == "Hans" ? "zh-CN" : "zh-TW"
      return supported.contains(pick) ? pick : nil
    case "en":
      return supported.contains("en-US") ? "en-US" : nil
    default:
      let canonical = "\(lang)-\(lang.uppercased())"
      if supported.contains(canonical) { return canonical }
      return supported.sorted().first { $0.hasPrefix(lang + "-") }
    }
  }

  static func defaultLocaleID() -> String {
    let supported = supportedIDs()
    for pref in Locale.preferredLanguages {
      if let id = recognizerLocale(for: pref, supported: supported) { return id }
    }
    return supported.contains("en-US") ? "en-US" : (supported.sorted().first ?? "en-US")
  }
}
