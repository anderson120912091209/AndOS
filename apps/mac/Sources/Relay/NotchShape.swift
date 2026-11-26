import SwiftUI

/// The black shape that grows out of the notch: square across the top (so it merges with the
/// notch and the screen edge), softly rounded at the bottom. The corner radius is animatable,
/// so it eases between the tight "ears" and the rounder message chin as the shape morphs.
struct NotchShape: Shape {
  var bottomRadius: CGFloat = 22

  var animatableData: CGFloat {
    get { bottomRadius }
    set { bottomRadius = newValue }
  }

  func path(in rect: CGRect) -> Path {
    let r = max(0, min(bottomRadius, rect.height / 2, rect.width / 2))
    var p = Path()
    p.move(to: CGPoint(x: rect.minX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
    p.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
    p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r), control: CGPoint(x: rect.minX, y: rect.maxY))
    p.closeSubpath()
    return p
  }
}
