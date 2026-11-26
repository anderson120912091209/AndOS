import Foundation

/// macOS can give a quick *tap* of the Globe (Fn) key a job of its own — System Settings ›
/// Keyboard › "Press 🌐 key to": change input source, show emoji, or start Apple Dictation.
/// Relay listens for a *hold*. When a tap means something to macOS, Relay can wait a beat
/// before it starts, so taps stay macOS's and holds are Relay's.
///
/// What we measured on a Mac set to "Change Input Source" (ABC ⇄ 注音): every input-source
/// switch followed an Fn press of 0.06–0.21 s; no press held 0.25 s or longer switched anything.
enum GlobeKey {
  enum TapAction: Int {
    case nothing = 0
    case changeInputSource = 1
    case emoji = 2
    case dictation = 3
  }

  /// What a tap of 🌐 does on this Mac (com.apple.HIToolbox › AppleFnUsageType).
  static var tapAction: TapAction {
    let raw = CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, "com.apple.HIToolbox" as CFString) as? Int
    // Never set means macOS's default, which does give the tap a job — treat it like emoji.
    return raw.flatMap(TapAction.init(rawValue:)) ?? .emoji
  }

  /// How long Fn must be held before Relay starts listening (0 = start the instant it's down).
  static var holdThreshold: TimeInterval {
    // Just past the longest tap macOS acted on (0.21 s): taps stay macOS's, and a deliberate
    // hold still feels instant because the notch twitches the moment Fn goes down.
    tapAction == .nothing ? 0 : 0.24
  }
}
