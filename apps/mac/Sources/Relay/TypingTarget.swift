import AppKit
import ApplicationServices

/// Where the dictated words are about to land: the app, the web page's host, and the focused
/// field's role and label. Gmail's compose box in Dia reads as
/// `AXTextArea` · "Message Body" · mail.google.com. The server lays the text out for that place
/// (packages/shared/src/layout.ts): an email gets its greeting, paragraphs and sign-off on their
/// own lines; a search box or subject line gets one line.
///
/// Only *where*, never *what*: we read accessibility metadata — role, label, page host — not the
/// field's contents, the page's text, or the full URL.
struct TypingTarget {
  var bundleId: String?
  var host: String?
  var role: String?
  var subrole: String?
  var label: String?

  var json: [String: String] {
    var out: [String: String] = [:]
    out["bundleId"] = bundleId
    out["host"] = host
    out["role"] = role
    out["subrole"] = subrole
    out["label"] = label
    return out
  }

  /// Read the frontmost app's focused field. Call off the main thread: each read is a round trip
  /// to that app, capped by a short timeout so a busy app can't stall dictation. Nil without
  /// Accessibility.
  static func capture() -> TypingTarget? {
    NSWorkspace.shared.frontmostApplication.flatMap(capture(in:))
  }

  /// Same, for a given app's focused field.
  static func capture(in app: NSRunningApplication) -> TypingTarget? {
    guard AXIsProcessTrusted() else { return nil }
    AX.boundTimeouts()

    var target = TypingTarget(bundleId: app.bundleIdentifier)
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    guard let field = AX.element(appElement, kAXFocusedUIElementAttribute) else { return target }
    target.role = AX.string(field, kAXRoleAttribute)
    target.subrole = AX.string(field, kAXSubroleAttribute)
    // Only a text box's own label ("Message Body", "Subject"). A focused page or document would
    // answer with its title — a search query, a subject line — so we don't ask those.
    if let role = target.role, inputRoles.contains(role) {
      target.label = [kAXDescriptionAttribute, kAXTitleAttribute, "AXPlaceholderValue"]
        .lazy.compactMap { AX.string(field, $0) }
        .first { !$0.isEmpty }
        .map { String($0.prefix(60)) }
    }
    target.host = AX.webURL(above: field, until: Date().addingTimeInterval(0.25))?.host
    return target
  }

  private static let inputRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]
}

/// What "this" is, when you hold Fn+Control and ask the AI to act on what's in front of you:
/// the page's address, the window's title, and the text you've selected. The server turns it
/// into an exact pointer (packages/shared/src/pointer.ts) — a Slack thread, a Fathom call, the
/// Gmail thread with that subject — so the agent works on that very thing.
///
/// Read only in AI mode, because there you've asked Relay to act on it. Dictation stays
/// "where, never what" (TypingTarget).
struct AgentPointer {
  var url: String?
  var windowTitle: String?
  var selection: String?

  var json: [String: String] {
    var out: [String: String] = [:]
    out["url"] = url
    out["windowTitle"] = windowTitle
    out["selectionText"] = selection
    return out
  }

  static func capture() -> AgentPointer? {
    NSWorkspace.shared.frontmostApplication.flatMap(capture(in:))
  }

  static func capture(in app: NSRunningApplication) -> AgentPointer? {
    guard AXIsProcessTrusted() else { return nil }
    AX.boundTimeouts()
    let deadline = Date().addingTimeInterval(0.35)
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    let window = AX.element(appElement, kAXFocusedWindowAttribute)
    let field = AX.element(appElement, kAXFocusedUIElementAttribute)

    var p = AgentPointer()
    p.windowTitle = window.flatMap { AX.string($0, kAXTitleAttribute) }.flatMap(nonEmpty).map { String($0.prefix(200)) }
    p.selection = field.flatMap { AX.string($0, kAXSelectedTextAttribute) }.flatMap(nonEmpty).map { String($0.prefix(4000)) }
    // The page you're on: above the focused field, or — focus in the address bar, say — anywhere
    // in the window.
    let url = field.flatMap { AX.webURL(above: $0, until: deadline) } ?? window.flatMap { AX.webURL(inside: $0, until: deadline) }
    p.url = url?.absoluteString
    return p.url == nil && p.windowTitle == nil && p.selection == nil ? nil : p
  }

  private static func nonEmpty(_ s: String) -> String? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }
}

/// The few accessibility reads both of the above need.
private enum AX {
  /// On the system-wide element this timeout applies to every accessibility call Relay makes,
  /// so one busy app can't stall dictation.
  static func boundTimeouts() {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.15)
  }

  static func value(_ el: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, attribute as CFString, &out) == .success ? out : nil
  }

  static func string(_ el: AXUIElement, _ attribute: String) -> String? {
    value(el, attribute) as? String
  }

  static func element(_ el: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let v = value(el, attribute), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
  }

  static func children(_ el: AXUIElement) -> [AXUIElement] {
    (value(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
  }

  /// Browsers expose the page's address on the web area that contains the field. Gives up at
  /// `deadline`, so a hung app costs a moment, not a timeout per step.
  static func webURL(above field: AXUIElement, until deadline: Date) -> URL? {
    var current: AXUIElement? = field
    for _ in 0..<40 {
      guard let el = current, Date() < deadline else { return nil }
      if string(el, kAXRoleAttribute) == "AXWebArea" { return value(el, "AXURL") as? URL }
      current = element(el, kAXParentAttribute)
    }
    return nil
  }

  /// The first web area in a window, breadth-first, within a small budget.
  static func webURL(inside window: AXUIElement, until deadline: Date) -> URL? {
    var queue = [window]
    var seen = 0
    while !queue.isEmpty, seen < 300, Date() < deadline {
      let el = queue.removeFirst()
      seen += 1
      if string(el, kAXRoleAttribute) == "AXWebArea", let url = value(el, "AXURL") as? URL { return url }
      queue.append(contentsOf: children(el))
    }
    return nil
  }
}
