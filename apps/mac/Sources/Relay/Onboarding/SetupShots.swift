import AppKit
import SwiftUI

/// Dev renders of every setup page and the Settings guide (part of RELAY_RENDER_SHOTS).
/// Drawn through AppKit (cacheDisplay) rather than ImageRenderer, so the real text field,
/// switch and spinner show up as they will on screen.
@MainActor
func renderSetupShots(to dir: String) {
  func snap(_ name: String, size: CGSize, _ view: some View) {
    let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
    host.frame = NSRect(origin: .zero, size: size)
    let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.3)) // let SwiftUI lay out and settle
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    print("rendered \(name)")
    window.contentView = nil
  }

  func page(_ name: String, _ onboarding: Onboarding) {
    snap(name, size: SetupLayout.size, OnboardingView(model: onboarding, speech: onboarding.speech))
  }

  page("setup-1-welcome.png", .preview(.welcome))
  page("setup-2-permissions.png", .preview(.permissions, mic: false))
  page("setup-2b-waiting.png", .preview(.permissions, awaiting: true, speech: .downloading(0.41)))
  page("setup-2c-granted.png", .preview(.permissions, accessibility: true, speech: .downloading(0.63)))
  page("setup-2d-returning.png", .preview(.permissions, returning: true))
  page("setup-3-try.png", .preview(.tryIt, accessibility: true, globe: .dictation))
  page("setup-3b-tried.png", .preview(.tryIt, accessibility: true, practice: "明天早上十點開會，記得帶筆電。"))
  page("setup-4-done.png", .preview(.done, accessibility: true))
  page("setup-4b-done-connect.png", .preview(.done, accessibility: true, connect: true))
  snap("setup-guide.png", size: AccessibilityGuide.size, GuideCard(model: AccessibilityGuide.Model()))
}
