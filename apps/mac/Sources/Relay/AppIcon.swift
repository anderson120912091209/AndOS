import AppKit
import SwiftUI

/// Relay's app icon: the notch's five-bar meter, white on black. Drawn in code so it stays in
/// step with the HUD; scripts/make-icon.sh turns it into Resources/AppIcon.icns. Matters most
/// in System Settings' Accessibility list, where you have to spot Relay to switch it on.
struct RelayIcon: View {
  /// LiveMeter's bar weights, so the icon is the meter at full voice.
  private static let weights: [CGFloat] = [0.55, 0.85, 1.0, 0.85, 0.55]

  var body: some View {
    GeometryReader { geometry in
      let s = geometry.size.width / 1024 // Apple's icon grid: a 824-pt body on a 1024 canvas
      ZStack {
        RoundedRectangle(cornerRadius: 185 * s, style: .continuous)
          .fill(Color.black)
        RoundedRectangle(cornerRadius: 185 * s, style: .continuous)
          .strokeBorder(Color.white.opacity(0.13), lineWidth: 4 * s)
        HStack(spacing: 40 * s) {
          ForEach(Array(Self.weights.enumerated()), id: \.offset) { _, weight in
            Capsule().fill(Color.white).frame(width: 64 * s, height: 400 * s * weight)
          }
        }
      }
      .frame(width: 824 * s, height: 824 * s)
      .frame(width: geometry.size.width, height: geometry.size.height)
    }
  }
}

/// RELAY_RENDER_SHOTS also writes the 1024-pt master for the icon.
@MainActor
func renderAppIcon(to dir: String) {
  let renderer = ImageRenderer(content: RelayIcon().frame(width: 1024, height: 1024))
  renderer.scale = 1
  guard
    let tiff = renderer.nsImage?.tiffRepresentation,
    let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
  else {
    print("render failed: app-icon-1024.png")
    return
  }
  try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("app-icon-1024.png"))
  print("rendered app-icon-1024.png")
}
