import AppKit
import SwiftUI

/// While you're in System Settings switching Relay on, a small black card floats beside the
/// window with the one instruction that matters, plus Relay's icon to drag into the list if
/// Relay isn't there. It follows the window, steps aside when you leave Settings, and leaves
/// with a checkmark the moment macOS says Relay is allowed.
@MainActor
final class AccessibilityGuide {
  static let shared = AccessibilityGuide()
  static let size = CGSize(width: 312, height: 128)

  final class Model: ObservableObject {
    @Published var done = false
    /// Still off after a while — usually a switch that's on for an older build of Relay.
    @Published var stuck = false
  }

  private static let settingsID = "com.apple.systempreferences"

  private let model = Model()
  private var panel: NSPanel?
  private var follow: Timer?
  /// Seconds spent with System Settings in front, waiting for the switch.
  private var waited: TimeInterval = 0

  func show() {
    model.done = false
    model.stuck = false
    waited = 0
    if panel == nil { panel = makePanel() }
    follow?.invalidate()
    follow = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
      MainActor.assumeIsolated { AccessibilityGuide.shared.track() }
    }
    track()
  }

  /// macOS just allowed Relay: a beat of checkmark, then out of the way.
  func succeed(then comeBack: @escaping @MainActor @Sendable () -> Void) {
    follow?.invalidate()
    follow = nil
    guard let panel, panel.isVisible else {
      comeBack()
      return
    }
    withAnimation(.easeOut(duration: 0.2)) { model.done = true }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
      MainActor.assumeIsolated {
        AccessibilityGuide.shared.hide()
        comeBack()
      }
    }
  }

  func hide() {
    follow?.invalidate()
    follow = nil
    panel?.orderOut(nil)
  }

  /// Sit beside System Settings while it's in front; step aside when it isn't.
  private func track() {
    guard let panel else { return }
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Self.settingsID,
          let window = Self.settingsWindowFrame()
    else {
      if panel.isVisible { panel.orderOut(nil) }
      return
    }
    waited += 0.25
    if waited > 20, !model.stuck {
      withAnimation(.easeOut(duration: 0.2)) { model.stuck = true }
    }
    let origin = Self.origin(for: Self.size, beside: window)
    if panel.frame.origin != origin { panel.setFrameOrigin(origin) }
    if !panel.isVisible { panel.orderFrontRegardless() }
  }

  /// System Settings' main window, in AppKit coordinates. Window bounds are readable
  /// without Screen Recording permission (titles and contents aren't, and we don't need them).
  private static func settingsWindowFrame() -> NSRect? {
    guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: settingsID).first?.processIdentifier,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return nil }
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    for info in windows {
      guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
            (info[kCGWindowLayer as String] as? Int) == 0,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
            rect.width > 320, rect.height > 320
      else { continue }
      // Quartz measures from the top of the primary screen, AppKit from the bottom.
      return NSRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }
    return nil
  }

  /// Right of the window, level with the top of its list; else on the left; else tucked
  /// inside its bottom-right corner.
  private static func origin(for size: CGSize, beside window: NSRect) -> NSPoint {
    let screen = (NSScreen.screens.first { $0.frame.intersects(window) } ?? NSScreen.main)?.visibleFrame ?? window
    let gap: CGFloat = 12
    let y = min(max(window.maxY - size.height - 56, screen.minY + 8), screen.maxY - size.height - 8)
    if window.maxX + gap + size.width <= screen.maxX { return NSPoint(x: window.maxX + gap, y: y) }
    if window.minX - gap - size.width >= screen.minX { return NSPoint(x: window.minX - gap - size.width, y: y) }
    return NSPoint(x: window.maxX - size.width - 16, y: window.minY + 16)
  }

  private func makePanel() -> NSPanel {
    let p = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    p.level = .floating
    p.isFloatingPanel = true
    p.hidesOnDeactivate = false
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = false // flat black, like the notch
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let host = NSHostingView(rootView: GuideCard(model: model))
    host.frame = NSRect(origin: .zero, size: Self.size)
    p.contentView = host
    return p
  }
}

struct GuideCard: View {
  @ObservedObject var model: AccessibilityGuide.Model

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.black)
      RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.14))
      if model.done {
        HStack(spacing: 10) {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 18))
            .foregroundStyle(SetupColor.green)
          Text("Relay can paste for you now").font(.system(size: 14, weight: .semibold))
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
      } else {
        instructions.transition(.opacity)
      }
    }
    .foregroundStyle(.white)
    .frame(width: AccessibilityGuide.size.width, height: AccessibilityGuide.size.height)
    .environment(\.colorScheme, .dark)
  }

  private var instructions: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 14) {
        AppIconDragSource().frame(width: 44, height: 44)
        VStack(alignment: .leading, spacing: 3) {
          Text("Switch on Relay").font(.system(size: 14, weight: .semibold))
          Text(model.stuck ? "Already on? Switch it off, then on again." : "Find Relay in the list and flip its switch.")
            .font(.system(size: 12.5))
            .foregroundStyle(.white.opacity(0.6))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
      Text("Not in the list? Drag this icon into it.")
        .font(.system(size: 11.5))
        .foregroundStyle(.white.opacity(0.45))
    }
    .padding(16)
  }
}

/// Relay's own icon, draggable: dropping it on the Accessibility list adds Relay there.
struct AppIconDragSource: NSViewRepresentable {
  func makeNSView(context: Context) -> IconView { IconView() }
  func updateNSView(_ view: IconView, context: Context) {}

  final class IconView: NSView, NSDraggingSource {
    private let icon = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    private var dragging = false

    override func draw(_ dirtyRect: NSRect) { icon.draw(in: bounds) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } // the panel never activates
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) {} // keep the press here so the drag starts here

    override func mouseDragged(with event: NSEvent) {
      guard !dragging else { return }
      dragging = true
      let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
      item.setDraggingFrame(bounds, contents: icon)
      beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
      context == .outsideApplication ? .copy : []
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
      dragging = false
    }
  }
}
