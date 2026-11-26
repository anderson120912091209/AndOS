import SwiftUI
import AppKit

/// The HUD's view model. One source of truth the notch observes; the AppDelegate drives it.
/// Mic levels live in `meter`, not in a @Published property, so they never re-render the view tree.
@MainActor
final class AppState: ObservableObject {
  enum Phase: Equatable {
    case idle
    /// Fn just went down and might still be a tap (macOS's) — a twitch of life, nothing more.
    case armed
    /// Ears: where your words go on the left; Relay on the right, its mouth moving with your voice.
    case listening
    /// Ears: Relay thinking while your words are written down, then pasting.
    case thinking
    /// Ears: a checkmark for a moment, then gone.
    case pasted
    /// Chin: one line under the notch — launch hint, clipboard fallback, AI hand-off, errors.
    case message(Message)
  }

  struct Message: Equatable, Hashable {
    enum Tone { case calm, good, warn, ai }
    var symbol: String
    var text: String
    var tone: Tone = .calm
    /// one of Relay's agents, drawn in place of the symbol — whoever took your request
    var agent: String? = nil
  }

  @Published var phase: Phase = .idle
  @Published var targetApp: String = ""
  /// Icon of the app the words will land in — follows you if you switch apps mid-sentence.
  @Published var appIcon: NSImage? = nil
  /// true while Fn+Control is held — the "scribe" mode where the AI acts for you.
  @Published var scribe: Bool = false

  /// Notch geometry for the current screen (set by AppDelegate). Drives the HUD's shape.
  @Published var notchWidth: CGFloat = 185
  @Published var notchTopInset: CGFloat = 32
  @Published var hasNotch: Bool = false
  /// Drives the grow/shrink: false = collapsed into the notch, true = showing `phase`.
  @Published var open: Bool = false

  let meter = LevelMeter()
}
