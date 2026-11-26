import AppKit
import SwiftUI

/// Opens setup when it's needed and gets out of the way when it's done.
@MainActor
final class OnboardingController: NSObject, NSWindowDelegate {
  static let shared = OnboardingController()

  /// Called when setup finishes, so the notch can take over.
  var onFinish: (() -> Void)?

  /// Opens the Connections window. When set, setup's last page offers "Connect Your Tools".
  var onConnectTools: (() -> Void)? {
    didSet { model.offersConnect = onConnectTools != nil }
  }

  private let model = Onboarding()
  private var window: NSWindow?

  static var isComplete: Bool { Onboarding.isComplete }

  /// At launch: open setup if it was never finished, or if Relay lost a permission it can't
  /// work without. Returns whether it opened.
  @discardableResult
  func showIfNeeded() -> Bool {
    // Dev: RELAY_SETUP=1 starts setup from the top, as on a brand-new Mac.
    if ProcessInfo.processInfo.environment["RELAY_SETUP"] == "1" { Onboarding.reset() }
    guard Onboarding.isNeeded else { return false }
    show()
    return true
  }

  /// Open setup — or, if it's already open, bring it to the front.
  func show() {
    if let window, window.isVisible {
      bringForward()
      return
    }
    model.onDone = { [weak self] in self?.finish() }
    model.onComeBack = { [weak self] in self?.bringForward() }
    model.onConnect = { [weak self] in self?.onConnectTools?() }
    model.begin()
    let window = self.window ?? makeWindow()
    self.window = window
    window.center()
    bringForward()
    Log.app.notice("setup: opened on \(String(describing: self.model.step), privacy: .public)")
  }

  func windowWillClose(_ notification: Notification) {
    model.end()
  }

  private func finish() {
    window?.close()
    onFinish?()
  }

  private func bringForward() {
    guard let window else { return }
    if #available(macOS 14, *) {
      NSApp.activate()
    } else {
      NSApp.activate(ignoringOtherApps: true)
    }
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless() // in front even if macOS won't switch apps right now
  }

  private func makeWindow() -> NSWindow {
    let w = SetupWindow(
      contentRect: NSRect(origin: .zero, size: SetupLayout.size),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    w.title = "Set Up Relay"
    w.titleVisibility = .hidden
    w.titlebarAppearsTransparent = true
    w.isMovableByWindowBackground = true
    w.backgroundColor = .black
    w.appearance = NSAppearance(named: .darkAqua)
    w.isReleasedWhenClosed = false
    w.standardWindowButton(.miniaturizeButton)?.isHidden = true
    w.standardWindowButton(.zoomButton)?.isHidden = true
    w.contentView = NSHostingView(rootView: OnboardingView(model: model, speech: model.speech))
    w.delegate = self
    return w
  }
}

/// Relay has no menu bar of its own (it's a menu-bar extra), so the Edit-menu shortcuts that
/// text fields rely on — including the ⌘V Relay presses to paste — would go nowhere. The
/// setup window routes them itself.
final class SetupWindow: NSWindow {
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
    guard flags == .command || flags == [.command, .shift],
          let key = event.charactersIgnoringModifiers?.lowercased()
    else { return super.performKeyEquivalent(with: event) }

    let shift = flags.contains(.shift)
    let action: Selector?
    switch key {
    case "v" where !shift: action = #selector(NSText.paste(_:))
    case "c" where !shift: action = #selector(NSText.copy(_:))
    case "x" where !shift: action = #selector(NSText.cut(_:))
    case "a" where !shift: action = #selector(NSText.selectAll(_:))
    case "z": action = shift ? Selector(("redo:")) : Selector(("undo:"))
    case "w" where !shift:
      performClose(nil)
      return true
    default: action = nil
    }
    if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
    return super.performKeyEquivalent(with: event)
  }
}
