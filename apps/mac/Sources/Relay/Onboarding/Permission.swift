import AppKit
import AVFoundation

/// The two things macOS has to allow before Relay can work: hearing you (Microphone), and
/// typing for you (Accessibility — what lets Relay press ⌘V in the app you're in).
@MainActor
enum Permission {
  enum Status: Equatable {
    case granted
    /// Never asked: asking shows macOS's own prompt.
    case notAsked
    /// Turned down once — from then on the switch only lives in System Settings.
    case denied
  }

  static var microphone: Status {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return .granted
    case .notDetermined: return .notAsked
    default: return .denied
    }
  }

  /// macOS never tells an app it was refused Accessibility — the switch is simply off.
  static var accessibility: Status { Inserter.isTrusted ? .granted : .notAsked }

  /// Ask for the microphone: macOS's prompt the first time, System Settings after a refusal.
  static func requestMicrophone(_ completion: @escaping @MainActor @Sendable (Bool) -> Void) {
    switch microphone {
    case .granted:
      completion(true)
    case .notAsked:
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        Task { @MainActor in completion(granted) }
      }
    case .denied:
      open(.microphone)
      completion(false)
    }
  }

  enum Pane: String {
    case microphone = "com.apple.preference.security?Privacy_Microphone"
    case accessibility = "com.apple.preference.security?Privacy_Accessibility"
    case keyboard = "com.apple.Keyboard-Settings.extension"
    case loginItems = "com.apple.LoginItems-Settings.extension"
  }

  static func open(_ pane: Pane) {
    if let url = URL(string: "x-apple.systempreferences:\(pane.rawValue)") {
      NSWorkspace.shared.open(url)
    }
  }
}
