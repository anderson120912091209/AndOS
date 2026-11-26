import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Writes dictated text into whatever field has focus *when the words are ready* — the app
/// you're in now, not the one you started in — by pasting: the text goes on the pasteboard,
/// Relay presses ⌘V for you, then puts your clipboard back.
///
/// What makes that dependable:
/// - **Honest about permission.** macOS only lets an app press keys for you once it's allowed
///   under Accessibility. Without it we say so and leave the words on the clipboard instead of
///   claiming they were pasted.
/// - **Modifier-safe.** We wait until you've let go of Fn/Shift/Control/Option/⌘, so ⌘V can't
///   become ⇧⌘V ("paste and match style" — or a different command entirely).
/// - **Layout-aware.** ⌘V goes to whichever key types "v" in your keyboard layout.
/// - **Read receipt.** The text is offered lazily (`NSPasteboardItemDataProvider`), so we learn
///   the instant the target app actually reads it — proof the paste landed — and restore your
///   clipboard right after, instead of guessing with a timer.
/// - **Polite.** Marked transient (nspasteboard.org convention) so clipboard managers skip it,
///   and current-host-only so it never syncs to your other devices.
@MainActor
enum Inserter {
  enum Outcome: Equatable {
    /// The focused app read the text — it's in your document.
    case pasted
    /// Couldn't paste; the words are on the clipboard for a manual ⌘V.
    case copied(Reason)
  }

  enum Reason: Equatable {
    /// macOS hasn't allowed Relay (under Accessibility) to press keys for you.
    case needsAccessibility
    /// ⌘V went out but nothing read the text — no text field had focus, or the app ignored it.
    case nothingAccepted
  }

  static var isTrusted: Bool { AXIsProcessTrusted() }

  /// Ask macOS to show its Accessibility prompt (no-op if already trusted).
  static func promptForTrust() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
  }

  static func openAccessibilitySettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
      NSWorkspace.shared.open(url)
    }
  }

  /// Calls `onChange` whenever Relay gains or loses the Accessibility permission, so the app
  /// can react the moment you flip the switch — no relaunch needed.
  static func watchTrust(_ onChange: @escaping @MainActor (Bool) -> Void) {
    var last = isTrusted
    func check() {
      let now = isTrusted
      if now != last {
        last = now
        onChange(now)
      }
      // Poll only while waiting for the switch; once it's on, the announcement below is enough.
      if now {
        trustTimer?.invalidate()
        trustTimer = nil
      } else if trustTimer == nil {
        trustTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
          MainActor.assumeIsolated { check() }
        }
      }
    }
    // macOS announces changes to the Accessibility list; the new state lands a beat later.
    DistributedNotificationCenter.default().addObserver(
      forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: .main
    ) { _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { check() }
    }
    check()
  }

  /// Paste `text` into the focused app; the outcome is reported on the main thread.
  static func insert(_ text: String, completion: @escaping (Outcome) -> Void = { _ in }) {
    guard isTrusted else {
      Clipboard.put(text, on: .general)
      Log.app.notice("insert: copied only — accessibility not granted")
      completion(.copied(.needsAccessibility))
      return
    }
    whenModifiersReleased {
      // A newer paste supersedes one that's still waiting for its read receipt.
      pending?.supersede()
      let paste = PendingPaste(text: text, pasteboard: .general, sendKeystroke: Keystroke.commandV) { outcome in
        Log.app.notice("insert: \(outcome == .pasted ? "pasted" : "nothing read it — left on clipboard", privacy: .public)")
        completion(outcome)
      }
      pending = paste
      paste.start()
    }
  }

  private static var pending: PendingPaste?
  private static var trustTimer: Timer?

  /// Run `body` once no modifier keys are physically held (or after a short cap).
  private static func whenModifiersReleased(_ body: @escaping () -> Void) {
    let held: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
    let deadline = Date().addingTimeInterval(0.8)
    func poll() {
      if CGEventSource.flagsState(.hidSystemState).isDisjoint(with: held) || Date() >= deadline {
        body()
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.012) { poll() }
      }
    }
    poll()
  }
}

/// One paste in flight: borrow the clipboard, press ⌘V, wait for the receipt, give it back.
/// Main thread only — AppKit calls the data-provider method on the main thread.
final class PendingPaste: NSObject, NSPasteboardItemDataProvider {
  /// How long to wait for the focused app to read the text before calling it a miss.
  static let receiptTimeout: TimeInterval = 1.0
  /// After the first read, how long the reader gets before we hand the clipboard back.
  static let restoreDelay: TimeInterval = 0.25

  private let text: String
  private let pasteboard: NSPasteboard
  private let sendKeystroke: () -> Void
  private var completion: ((Inserter.Outcome) -> Void)?
  private var saved: [[(NSPasteboard.PasteboardType, Data)]] = []
  private var ourChangeCount = 0
  private var wasRead = false

  init(text: String, pasteboard: NSPasteboard, sendKeystroke: @escaping () -> Void, completion: @escaping (Inserter.Outcome) -> Void) {
    self.text = text
    self.pasteboard = pasteboard
    self.sendKeystroke = sendKeystroke
    self.completion = completion
  }

  func start() {
    saved = Clipboard.snapshot(pasteboard)
    pasteboard.prepareForNewContents(with: .currentHostOnly) // clears; keeps it off Universal Clipboard
    let item = NSPasteboardItem()
    item.setDataProvider(self, forTypes: [.string])
    item.setData(Data(), forType: Clipboard.transient)
    pasteboard.writeObjects([item])
    ourChangeCount = pasteboard.changeCount
    sendKeystroke()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.receiptTimeout) { [weak self] in self?.giveUp() }
  }

  /// The target app is reading the text right now — the paste landed.
  func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
    item.setString(text, forType: type)
    guard !wasRead else { return }
    wasRead = true
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.restoreDelay) { [self] in
      restoreClipboard()
      finish(.pasted)
    }
  }

  func pasteboardFinishedWithDataProvider(_ pasteboard: NSPasteboard) {}

  /// A newer paste is starting: hand the clipboard back now so it snapshots the real one.
  func supersede() {
    guard completion != nil else { return }
    restoreClipboard()
    finish(wasRead ? .pasted : .copied(.nothingAccepted))
  }

  private func giveUp() {
    guard !wasRead, completion != nil else { return }
    // Nobody read it. Leave the words as plain text so a manual ⌘V still works anywhere.
    if pasteboard.changeCount == ourChangeCount { Clipboard.put(text, on: pasteboard) }
    finish(.copied(.nothingAccepted))
  }

  private func restoreClipboard() {
    // If something else was copied meanwhile, that's newer than what we saved — keep it.
    guard pasteboard.changeCount == ourChangeCount else { return }
    Clipboard.restore(saved, to: pasteboard)
  }

  private func finish(_ outcome: Inserter.Outcome) {
    completion?(outcome)
    completion = nil
  }
}

enum Clipboard {
  /// nspasteboard.org: "temporary content — clipboard managers, please don't record this".
  static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

  private static let maxBytesPerType = 20 * 1024 * 1024
  /// Reading a type can make the source app render it on the spot (spreadsheets offer dozens),
  /// so saving stops after this long; types come best-first, so the important ones are kept.
  private static let snapshotBudget: TimeInterval = 0.15

  /// Everything on the clipboard — including app-private formats like copied design layers —
  /// except types macOS synthesizes on demand (`dyn.*`) and promised files.
  static func snapshot(_ pb: NSPasteboard) -> [[(NSPasteboard.PasteboardType, Data)]] {
    let deadline = Date().addingTimeInterval(snapshotBudget)
    return (pb.pasteboardItems ?? []).map { item in
      item.types.compactMap { type -> (NSPasteboard.PasteboardType, Data)? in
        let name = type.rawValue
        guard Date() < deadline, !name.hasPrefix("dyn."), !name.localizedCaseInsensitiveContains("promise"),
              let data = item.data(forType: type), data.count <= maxBytesPerType
        else { return nil }
        return (type, data)
      }
    }.filter { !$0.isEmpty }
  }

  static func restore(_ items: [[(NSPasteboard.PasteboardType, Data)]], to pb: NSPasteboard) {
    pb.clearContents()
    guard !items.isEmpty else { return }
    pb.writeObjects(items.map { pairs in
      let item = NSPasteboardItem()
      for (type, data) in pairs { item.setData(data, forType: type) }
      return item
    })
  }

  static func put(_ text: String, on pb: NSPasteboard) {
    pb.clearContents()
    pb.setString(text, forType: .string)
  }
}

enum Keystroke {
  /// Press ⌘V in the focused app.
  static func commandV() {
    let source = CGEventSource(stateID: .combinedSessionState)
    let v = keyCode(typing: "v") ?? CGKeyCode(kVK_ANSI_V)
    // ⌘ plus its left-hand device bit (NX_DEVICELCMDKEYMASK = 0x8): a few apps check which ⌘.
    let flags = CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x8)
    for keyDown in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: keyDown)
      event?.flags = flags
      event?.post(tap: .cghidEventTap)
    }
  }

  /// The key that types `character` with ⌘ held in the current keyboard layout — so ⌘V lands
  /// on the right key in Dvorak, AZERTY, "Dvorak – QWERTY ⌘", and friends.
  static func keyCode(typing character: Character) -> CGKeyCode? {
    guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let layoutData = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    let want = String(character)
    return layoutData.withUnsafeBytes { buffer -> CGKeyCode? in
      guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      var deadKeys: UInt32 = 0
      var chars = [UniChar](repeating: 0, count: 4)
      var length = 0
      for code in UInt16(0)..<128 {
        let status = UCKeyTranslate(
          layout, code, UInt16(kUCKeyActionDown), UInt32((cmdKey >> 8) & 0xFF), UInt32(LMGetKbdType()),
          OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars
        )
        if status == noErr, length > 0, String(utf16CodeUnits: chars, count: length).lowercased() == want {
          return CGKeyCode(code)
        }
      }
      return nil
    }
  }
}
