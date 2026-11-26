import AppKit
import SwiftUI

/// Opens the Connections window, or brings it forward if it's already open.
@MainActor
final class ConnectionsController: NSObject, NSWindowDelegate {
  static let shared = ConnectionsController()

  let model = ConnectionsModel()
  /// Set Up Relay… in the footer.
  var openSetup: (() -> Void)?
  /// Connections a waiting request is about to resume on (Agent/ adds the id before
  /// show(connecting:) and removes it once it re-runs), so the notch says "running your
  /// request" instead of "try it".
  var runAfterConnect = Set<String>()
  private var window: NSWindow?

  func show() {
    let window = self.window ?? makeWindow()
    self.window = window
    model.window = window
    if !window.isVisible { window.center() }
    if #available(macOS 14, *) {
      NSApp.activate()
    } else {
      NSApp.activate(ignoringOtherApps: true)
    }
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    Task { await model.refresh() }
  }

  /// Open Connections and start connecting `id` straight away — what a "Set up" button calls
  /// when a request needs an account you haven't connected. Gmail without your Google key opens
  /// its key panel instead; anything already connected (or not available yet) just shows.
  func show(connecting id: String) {
    show()
    Task {
      await model.refresh()
      guard let item = model.items.first(where: { $0.id == id }), item.state == .available || item.state == .broken else { return }
      model.connect(item)
    }
  }

  private func makeWindow() -> NSWindow {
    // SetupWindow routes ⌘V/⌘C to the text fields — Relay has no Edit menu of its own.
    let w = SetupWindow(
      contentRect: NSRect(origin: .zero, size: ConnectionsLayout.size),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    w.title = "Connections"
    w.titleVisibility = .hidden
    w.titlebarAppearsTransparent = true
    w.isMovableByWindowBackground = true
    w.backgroundColor = .black
    w.appearance = NSAppearance(named: .darkAqua)
    w.isReleasedWhenClosed = false
    w.standardWindowButton(.miniaturizeButton)?.isHidden = true
    w.standardWindowButton(.zoomButton)?.isHidden = true
    w.contentView = NSHostingView(rootView: ConnectionsView(model: model) { [weak self] in
      self?.window?.close()
      self?.openSetup?()
    })
    w.delegate = self
    return w
  }
}
