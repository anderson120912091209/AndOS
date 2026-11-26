import AppKit
import SwiftUI

/// Render the notch HUD over a simulated menu bar + notch + wallpaper, offscreen (no window,
/// mic, or permissions), via SwiftUI's ImageRenderer. Triggered by RELAY_RENDER_SHOTS=<dir>.
/// Geometry matches a 14"/16" MacBook Pro notch (185 × 32 pt).
@MainActor
func renderShots(to dir: String) {
  let notchW: CGFloat = 185
  let topInset: CGFloat = 32

  func make(_ name: String, level: Float = 0, _ configure: (AppState) -> Void) {
    let s = AppState()
    s.hasNotch = true
    s.notchWidth = notchW
    s.notchTopInset = topInset
    s.open = true
    configure(s)
    // Let the meter settle on `level`, as if you'd been talking for a moment.
    s.meter.push(level)
    let now = Date().timeIntervalSinceReferenceDate
    for i in 0..<60 { _ = s.meter.value(at: now - 1 + Double(i) / 60) }

    let content = ZStack(alignment: .top) {
      LinearGradient(
        colors: [Color(red: 0.05, green: 0.10, blue: 0.22), Color(red: 0.16, green: 0.28, blue: 0.47)],
        startPoint: .top, endPoint: .bottom
      )
      // the menu bar, so you can see how much of it the HUD covers
      Rectangle().fill(Color.white.opacity(0.18)).frame(height: topInset)
      // the physical notch, which the HUD appears to grow from
      NotchShape(bottomRadius: 8)
        .fill(Color.black)
        .frame(width: notchW, height: topInset)
        .frame(maxWidth: .infinity, alignment: .top)
      NotchHUDView(state: s)
    }
    .frame(width: 560, height: 120)

    let renderer = ImageRenderer(content: content)
    renderer.scale = 2
    guard
      let img = renderer.nsImage,
      let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff),
      let png = bmp.representation(using: .png, properties: [:])
    else {
      print("render failed: \(name)")
      return
    }
    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    print("rendered \(name)")
  }

  func icon(_ path: String) -> NSImage { NSWorkspace.shared.icon(forFile: path) }

  /// Relay in motion: a row of frames a beat apart — to see the "blah blah" and the thought bubbles.
  func strip(_ name: String, mood: AgentMood, level: Float?, span: Double, frames: Int = 8) {
    let meter = level.map { level -> LevelMeter in
      let m = LevelMeter()
      m.push(level)
      let now = Date().timeIntervalSinceReferenceDate
      for i in 0..<60 { _ = m.value(at: now - 1 + Double(i) / 60) }
      return m
    }
    let row = HStack(spacing: 8) {
      ForEach(0..<frames, id: \.self) { i in
        AgentCharacter(agent: .relay, mood: mood, size: 56, time: span * Double(i) / Double(frames), voice: meter)
      }
    }
    .padding(12)
    .background(Color.black)
    let renderer = ImageRenderer(content: row)
    renderer.scale = 2
    guard let img = renderer.nsImage, let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
          let png = bmp.representation(using: .png, properties: [:]) else { return print("render failed: \(name)") }
    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    print("rendered \(name)")
  }
  strip("relay-talking.png", mood: .listening, level: 0.55, span: 0.38)
  strip("relay-thinking.png", mood: .thinking, level: nil, span: 0.9) // as long as thinking really lasts

  make("notch-armed.png") { s in s.phase = .armed }
  make("notch-dictation.png", level: 0.75) { s in
    s.phase = .listening
    s.appIcon = icon("/System/Applications/Notes.app")
  }
  // Relay's mouth at a pause, a soft word, and full voice (the one above).
  make("notch-dictation-quiet.png", level: 0) { s in
    s.phase = .listening
    s.appIcon = icon("/System/Applications/Notes.app")
  }
  make("notch-dictation-soft.png", level: 0.22) { s in
    s.phase = .listening
    s.appIcon = icon("/System/Applications/Notes.app")
  }
  make("notch-scribe.png", level: 0.6) { s in
    s.phase = .listening
    s.scribe = true
  }
  make("notch-thinking.png") { s in
    s.phase = .thinking
    s.appIcon = icon("/System/Applications/Notes.app")
  }
  make("notch-pasted.png") { s in
    s.phase = .pasted
    s.appIcon = icon("/System/Applications/Notes.app")
  }
  make("notch-ready.png") { s in
    s.phase = .message(.init(symbol: "mic", text: "Hold Fn to dictate · any language · ⌃ AI"))
  }
  make("notch-copied.png") { s in
    s.phase = .message(.init(symbol: "doc.on.clipboard", text: "Copied — turn on Accessibility to paste for you", tone: .warn))
  }
  make("notch-dispatched.png") { s in
    s.phase = .message(.init(symbol: "sparkles", text: "On it — “Q3 numbers”", tone: .ai, agent: "relay"))
  }
  make("notch-dispatched-scout.png") { s in
    s.phase = .message(.init(symbol: "sparkles", text: "Scout’s on it — the top 3 CRMs", tone: .ai, agent: "scout"))
  }

  renderSetupShots(to: dir)
  renderConnectionsShots(to: dir)
  renderCastShots(to: dir)
  renderAppIcon(to: dir)
}
