import CryptoKit
import Foundation

/// Gets this Mac's speech model onto it during setup, once: downloads it with progress, checks
/// every file against its published SHA-256, then warms the engine up. Which model is
/// SpeechEngine.setupDefault's — Whisper on Apple silicon (~574 MB, any language), SenseVoice on
/// an Intel Mac (~240 MB: Mandarin, English, Japanese, Korean, Cantonese). Same files and places as
/// scripts/fetch-model.sh and scripts/fetch-sensevoice.sh — just without the terminal.
@MainActor
final class ModelDownloader: NSObject, ObservableObject {
  static let shared = ModelDownloader()

  enum State: Equatable {
    case idle
    case downloading(Double)
    /// Checking the file, then loading it into memory.
    case preparing
    case ready
    case failed(String)
  }

  @Published private(set) var state: State = .idle

  /// One file of a model: where it comes from, where it goes, and what it must be.
  struct File {
    let url: URL
    let destination: URL
    let bytes: Int64
    /// Hugging Face's published SHA-256 (its x-linked-etag header); nil skips the check.
    let sha256: String?
  }

  /// The files a model is made of, from Hugging Face, smallest first.
  nonisolated static func files(for engine: SpeechEngine) -> [File] {
    switch engine {
    case .whisper:
      // A different model (RELAY_WHISPER_MODEL) skips the hash check.
      let isDefault = WhisperEngine.modelName == "ggml-large-v3-turbo-q5_0.bin"
      return [
        File(
          url: URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/\(WhisperEngine.modelName)")!,
          destination: WhisperEngine.modelURL,
          bytes: 574_041_195,
          sha256: isDefault ? "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2" : nil
        ),
      ]
    case .senseVoice:
      let base = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
      let dir = SenseVoiceEngine.modelDir
      return [
        File(
          url: URL(string: "\(base)/tokens.txt")!, destination: dir.appendingPathComponent("tokens.txt"),
          bytes: 315_894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"
        ),
        File(
          url: URL(string: "\(base)/model.int8.onnx")!, destination: dir.appendingPathComponent("model.int8.onnx"),
          bytes: 239_233_841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"
        ),
      ]
    }
  }

  private var engine = SpeechEngine.setupDefault
  /// Files still to fetch, the one on its way, and how many bytes of the model are already in place.
  private var pending: [File] = []
  private var current: File?
  private var fetched: Int64 = 0
  private var total: Int64 = 0
  private var session: URLSession?

  /// Start if needed; safe to call again. A model that's already on disk just gets loaded.
  func start() {
    switch state {
    case .downloading, .preparing, .ready: return
    case .idle, .failed: break
    }
    engine = SpeechEngine.setupDefault
    if engine.engine.modelExists {
      load()
      return
    }
    let fm = FileManager.default
    pending = Self.files(for: engine).filter { !fm.fileExists(atPath: $0.destination.path) }
    total = pending.reduce(0) { $0 + $1.bytes }
    fetched = 0
    let free = try? fm.homeDirectoryForCurrentUser
      .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
      .volumeAvailableCapacityForImportantUsage
    let needed = total + 200_000_000
    if let free, free < needed {
      fail("Needs about \(ByteCountFormatter.string(fromByteCount: needed, countStyle: .file)) of free space", nil)
      return
    }
    state = .downloading(0)
    Log.app.notice("model: downloading \(self.engine.name, privacy: .public)")
    next()
  }

  /// Dev renders: show a state without downloading anything.
  func preview(_ state: State) {
    self.state = state
  }

  /// Fetch the next file, or load the engine once they're all in place.
  private func next() {
    guard !pending.isEmpty else {
      load()
      return
    }
    let file = pending.removeFirst()
    current = file
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    self.session = session
    session.downloadTask(with: file.url).resume()
  }

  private func load() {
    state = .preparing
    engine.engine.preload { [weak self] ok in
      MainActor.assumeIsolated {
        self?.state = ok ? .ready : .failed("The speech engine didn't load")
      }
    }
  }

  /// Hash off the main thread (about a second for 574 MB), then move the file into place.
  private func verify(_ part: URL, as file: File) {
    if pending.isEmpty { state = .preparing }
    DispatchQueue.global(qos: .userInitiated).async {
      let intact = file.sha256 == nil || Self.sha256(of: part) == file.sha256
      Task { @MainActor in
        let fm = FileManager.default
        guard intact else {
          try? fm.removeItem(at: part)
          self.fail("The download was damaged — try again", nil)
          return
        }
        do {
          try fm.createDirectory(at: file.destination.deletingLastPathComponent(), withIntermediateDirectories: true)
          try? fm.removeItem(at: file.destination)
          try fm.moveItem(at: part, to: file.destination)
          Log.app.notice("model: installed \(file.destination.lastPathComponent, privacy: .public)")
          self.fetched += file.bytes
          self.next()
        } catch {
          self.fail("Couldn't save the speech engine", error)
        }
      }
    }
  }

  private func fail(_ message: String, _ error: Error?) {
    state = .failed(message)
    session = nil
    pending = []
    current = nil
    Log.app.error("model: \(message, privacy: .public) \(error.map { String(describing: $0) } ?? "", privacy: .public)")
  }

  nonisolated private static func sha256(of url: URL) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try? handle.read(upToCount: 8 << 20), !chunk.isEmpty {
      hash.update(data: chunk)
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

// The session delivers on the main queue (see `next`), so each callback can step onto the
// main actor directly.
extension ModelDownloader: URLSessionDownloadDelegate {
  nonisolated func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    MainActor.assumeIsolated {
      guard total > 0 else { return }
      let fraction = min(1, Double(fetched + totalBytesWritten) / Double(total))
      // Callbacks arrive every few KB; a new value per half percent is plenty for a bar.
      if case let .downloading(shown) = state, fraction - shown < 0.005 { return }
      state = .downloading(fraction)
    }
  }

  nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    // The temporary file is deleted when this returns, so claim it now (same volume: a rename).
    MainActor.assumeIsolated {
      guard let file = current else { return }
      let fm = FileManager.default
      let part = file.destination.appendingPathExtension("part")
      do {
        guard (downloadTask.response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        try fm.createDirectory(at: part.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? fm.removeItem(at: part)
        try fm.moveItem(at: location, to: part)
        verify(part, as: file)
      } catch {
        fail("Download failed — try again", error)
      }
    }
  }

  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    session.finishTasksAndInvalidate()
    guard let error else { return }
    MainActor.assumeIsolated { fail("Download failed — check your connection", error) }
  }
}
