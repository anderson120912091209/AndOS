import AppKit
import SwiftUI
import WebKit

/// The Box window: Relay's computer on your screen, for the moments a site needs you.
///
/// `show(_:then:)` opens it for a takeover — the notch's "Take over", or "Sign In" in
/// Connections. Done, Not Now, or closing the window hands the box back and tells the server
/// (closing counts as Done: the agent looks for itself and asks again if it still needs you).
/// ⌘V types your Mac's clipboard into the box, so a password manager works as usual.
@MainActor
final class BoxController: NSObject, NSWindowDelegate, NSToolbarDelegate, WKNavigationDelegate {
  static let shared = BoxController()

  /// You handed the box back (`done`) or declined — for the notch.
  var onFinished: ((_ takeover: BoxTakeover, _ done: Bool) -> Void)?

  let model = BoxModel()
  private var window: BoxWindow?
  private lazy var webView = makeWebView()
  /// who's waiting on each open takeover (Connections' sign-in rows)
  private var waiters: [String: (Bool) -> Void] = [:]
  /// You pressed ⌘C/⌘X in the box a moment ago, so the box's next clipboard is yours to have.
  private var copyAsked: Date?
  private var watchdog: Task<Void, Never>?
  /// Dev previews keep the window off-screen and out of your way.
  var offscreen = false

  /// Open the box for `takeover`; `then` hears whether you finished (true) or declined (false).
  func show(_ takeover: BoxTakeover, then: ((Bool) -> Void)? = nil) {
    let previous = model.takeover
    if let old = previous.id, old != takeover.id {
      // Another request is taking the window. The old one stays open on the server (its task
      // keeps waiting, the notch can bring it back); only whoever waited here lets go.
      waiters.removeValue(forKey: old)?(false)
    }
    if let id = takeover.id, let then { waiters[id] = then }
    model.takeover = takeover

    let window = self.window ?? makeWindow()
    self.window = window
    window.title = takeover.reason
    if !window.isVisible { place(window) }
    if offscreen {
      window.orderFrontRegardless()
    } else {
      if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
      window.makeKeyAndOrderFront(nil)
    }
    if previous.id == takeover.id, model.phase == .live, window.isVisible { return } // already showing it
    connect(takeover.viewerURL)
  }

  /// Relay's computer, nothing asked of you — watch it work, or lend a hand.
  func showComputer() {
    show(.look)
  }

  /// Done (true) or Not Now (false): put the window away, hang up the screen, tell the server.
  func finish(done: Bool) {
    let takeover = model.takeover
    watchdog?.cancel()
    window?.orderOut(nil)
    webView.load(URLRequest(url: URL(string: "about:blank")!)) // the box stops streaming its screen
    model.phase = .starting
    model.takeover = .look
    guard let id = takeover.id else { return }
    Task {
      await BoxAPI.finish(id, done: done)
      waiters.removeValue(forKey: id)?(done)
      onFinished?(takeover, done)
    }
  }

  private func connect(_ known: URL?) {
    watchdog?.cancel()
    model.phase = known == nil ? .starting : .connecting
    watchdog = Task {
      do {
        var url = known
        if url == nil { url = try await BoxAPI.viewerURL() }
        guard var url, !Task.isCancelled else { return }
        // Watching: the server hands out its view-only door already; asking the page not to send
        // input as well keeps an older box (one door for both) view-only too.
        if model.watching, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
           !(parts.queryItems ?? []).contains(where: { $0.name == "view" }) {
          parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "view", value: "1")]
          url = parts.url ?? url
        }
        model.phase = .connecting
        webView.load(URLRequest(url: url))
        // The page says when it's connected; if it never does, say so instead of spinning.
        try await Task.sleep(nanoseconds: 15_000_000_000)
        if model.phase != .live {
          model.phase = .failed("Relay’s computer isn’t answering. Is Docker Desktop running?")
        }
      } catch is CancellationError {
      } catch {
        model.phase = .failed(error.localizedDescription)
      }
    }
  }

  // MARK: - The page's messages and your shortcuts

  private func received(_ body: Any) {
    guard let msg = body as? [String: Any] else { return }
    if let connected = msg["connected"] as? Bool {
      if connected {
        watchdog?.cancel()
        model.phase = .live
        window?.makeFirstResponder(webView) // so typing goes straight to the box
      } else if model.phase == .live {
        model.phase = .connecting // the page reconnects on its own
        connect(nil)
      }
    }
    // The box's clipboard reaches your Mac only right after you copy there — never because
    // something on the box happened to copy.
    if let text = msg["clipboard"] as? String, let asked = copyAsked, Date().timeIntervalSince(asked) < 2 {
      copyAsked = nil
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }
  }

  /// Watching → using: open a takeover of your own (the agent stops first), then let you type.
  func takeOver() {
    guard model.watching, !model.takingOver else { return }
    model.takingOver = true
    Task {
      defer { model.takingOver = false }
      do {
        // Watching and typing are different doors on the box: the screen you watch ignores input,
        // and the one you type into only opens during a takeover, once the agent is stopped. So
        // taking over reconnects to the door the server just opened.
        let takeover = try await BoxAPI.takeOver(reason: "You’re using Relay’s computer")
        model.takeover = BoxTakeover(id: takeover.id, reason: takeover.reason, service: "box", viewerURL: takeover.viewerURL)
        window?.title = takeover.reason
        connect(takeover.viewerURL)
      } catch {
        NSSound.beep()
        Log.app.error("take over failed: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  /// ⌘ shortcuts, Mac-style: ⌘V pastes your clipboard into the box; ⌘A/C/X/Z mean Ctrl there.
  fileprivate func shortcut(_ key: String) -> Bool {
    guard model.phase == .live, !model.watching else { return false }
    switch key {
    case "v":
      guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return true }
      webView.callAsyncJavaScript("window.relayPaste(text)", arguments: ["text": text], in: nil, in: .page)
    case "c", "x", "a", "z":
      if key == "c" || key == "x" { copyAsked = Date() }
      webView.callAsyncJavaScript("window.relayShortcut(key)", arguments: ["key": key], in: nil, in: .page)
    default:
      return false
    }
    return true
  }

  // MARK: - Window

  private func makeWindow() -> BoxWindow {
    let w = BoxWindow(
      contentRect: NSRect(origin: .zero, size: NSSize(width: 1000, height: 640)),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    w.controller = self
    w.titleVisibility = .hidden
    w.titlebarAppearsTransparent = true
    w.titlebarSeparatorStyle = .none
    w.toolbarStyle = .unified
    let toolbar = NSToolbar(identifier: "relay.box")
    toolbar.delegate = self
    toolbar.allowsUserCustomization = false
    toolbar.displayMode = .iconOnly // no label row under the items, so they center on the traffic lights
    w.toolbar = toolbar
    w.backgroundColor = .black
    w.appearance = NSAppearance(named: .darkAqua)
    w.isReleasedWhenClosed = false
    w.contentMinSize = NSSize(width: 640, height: 420)
    w.contentView = NSHostingView(rootView: BoxView(model: model, webView: webView) { [weak self] in
      self?.connect(nil)
    })
    w.delegate = self
    return w
  }

  /// Big enough to read the box's 1280 × 800 screen comfortably, never bigger than your screen.
  private func place(_ window: NSWindow) {
    let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let toolbar: CGFloat = 52
    let ratio = BoxLayout.screen.height / BoxLayout.screen.width
    var width = min(1120, visible.width * 0.82)
    let height = { (w: CGFloat) in (w - 2 * BoxLayout.inset) * ratio + BoxLayout.inset }
    while height(width) + toolbar > visible.height * 0.88, width > 640 { width -= 20 }
    window.setContentSize(NSSize(width: width, height: height(width)))
    if offscreen {
      window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    } else {
      window.center()
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    finish(done: true)
    return false
  }

  // MARK: - Toolbar

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.boxTitle, .flexibleSpace, .boxActions]
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
               willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    let item = NSToolbarItem(itemIdentifier: id)
    switch id {
    case .boxTitle:
      item.view = NSHostingView(rootView: BoxTitle(model: model))
    case .boxActions:
      item.view = NSHostingView(rootView: BoxActions(
        model: model,
        finish: { [weak self] done in self?.finish(done: done) },
        takeOver: { [weak self] in self?.takeOver() }
      ))
    default:
      return nil
    }
    return item
  }

  // MARK: - Web view

  private func makeWebView() -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent() // the viewer keeps nothing on your Mac
    config.userContentController.add(BoxBridge { [weak self] body in self?.received(body) }, name: "relay")
    let view = WKWebView(frame: .zero, configuration: config)
    view.setValue(false, forKey: "drawsBackground")
    view.allowsBackForwardNavigationGestures = false
    view.allowsMagnification = false
    view.navigationDelegate = self
    return view
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    failed(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(error)
  }

  private func failed(_ error: Error) {
    // Hanging up (about:blank) or reloading cancels the previous load — that's not a failure.
    if (error as NSError).code == NSURLErrorCancelled || model.phase == .starting { return }
    watchdog?.cancel()
    model.phase = .failed("Relay’s computer isn’t answering. Is Docker Desktop running?")
  }

  // MARK: - Dev preview

  /// A picture of the window as it is — toolbar and box screen — for checking the design
  /// (RELAY_PREVIEW_BOX=<png>). WebKit draws out of process, so its snapshot is laid in by hand.
  func snapshot(to path: String) async -> Bool {
    guard let window, let frameView = window.contentView?.superview else { return false }
    let image: NSImage? = await withCheckedContinuation { cont in
      webView.takeSnapshot(with: nil) { image, _ in cont.resume(returning: image) }
    }
    guard let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) else { return false }
    frameView.cacheDisplay(in: frameView.bounds, to: rep)
    let out = NSImage(size: frameView.bounds.size)
    out.lockFocus()
    NSColor.black.setFill()
    frameView.bounds.fill()
    rep.draw(in: frameView.bounds)
    if let image, model.phase == .live {
      let rect = webView.convert(webView.bounds, to: frameView)
      let clip = NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10)
      clip.addClip()
      image.draw(in: rect)
    }
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
          let png = bmp.representation(using: .png, properties: [:]) else { return false }
    return (try? png.write(to: URL(fileURLWithPath: path))) != nil
  }
}

private extension NSToolbarItem.Identifier {
  static let boxTitle = Self("relay.box.title")
  static let boxActions = Self("relay.box.actions")
}

/// Relay has no Edit menu (it lives in the menu bar), and the box is Linux: the window turns
/// your ⌘ shortcuts into what the box understands before the page ever sees them.
final class BoxWindow: NSWindow {
  weak var controller: BoxController?

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
    if flags == .command, let key = event.charactersIgnoringModifiers?.lowercased() {
      if key == "w" {
        performClose(nil)
        return true
      }
      if controller?.shortcut(key) == true { return true }
    }
    return super.performKeyEquivalent(with: event)
  }
}

/// The page's messages, without the content controller holding on to the Box controller.
private final class BoxBridge: NSObject, WKScriptMessageHandler {
  let receive: @MainActor (Any) -> Void
  init(_ receive: @escaping @MainActor (Any) -> Void) { self.receive = receive }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    let body = message.body
    MainActor.assumeIsolated { receive(body) }
  }
}
