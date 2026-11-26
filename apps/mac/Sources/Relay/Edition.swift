import Foundation

/// Which Relay this is. The download for other people is the dictation edition: hold Fn, talk,
/// and the words are typed where you are, all on this Mac. The AI half (Fn+Control, the box,
/// Connections, the Command Center) runs on Relay's server and worker, so that edition leaves it
/// out entirely: nothing it hears is ever sent anywhere, and the only download it makes is the
/// speech model during setup. scripts/release.sh sets it (RelayEdition in Info.plist); a dev
/// build from build.sh is the full app.
enum Edition {
  static let dictationOnly = (Bundle.main.object(forInfoDictionaryKey: "RelayEdition") as? String) == "dictation"

  /// The one line the notch shows when Relay is ready to go — with the languages of the engine in
  /// use, since SenseVoice (an Intel Mac's engine) doesn't take every language Whisper does.
  static var readyHint: String {
    let languages = SpeechEngine.chosen.languages
    return dictationOnly ? "Hold Fn to dictate · \(languages)" : "Hold Fn to dictate · \(languages) · ⌃ AI"
  }
}
