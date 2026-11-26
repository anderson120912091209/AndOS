import SwiftUI

/// Latest microphone level (0…1). Written ~43×/s from the audio side, read once per frame by
/// `LiveMeter`. Deliberately *not* @Published: mic levels never re-render the HUD's view tree —
/// only the meter's Canvas redraws, in step with the display.
final class LevelMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var target: Float = 0
  private var shown: Float = 0
  private var lastTime: TimeInterval = 0

  func push(_ level: Float) {
    lock.lock()
    target = max(0, min(1, level))
    lock.unlock()
  }

  func reset() {
    lock.lock()
    target = 0
    shown = 0
    lastTime = 0
    lock.unlock()
  }

  /// Display value at time `t`: rises fast, falls gently, same feel at 60 Hz or 120 Hz.
  func value(at t: TimeInterval) -> Float {
    lock.lock()
    defer { lock.unlock() }
    let dt = lastTime == 0 ? 1.0 / 60 : min(0.1, max(0, t - lastTime))
    lastTime = t
    let rate: Float = target > shown ? 30 : 10
    shown += (target - shown) * (1 - exp(-rate * Float(dt)))
    return shown
  }
}

/// The little five-bar meter in the notch's right ear. Drawn with Canvas on the display's own
/// clock (TimelineView), so it moves at the screen's refresh rate with no SwiftUI diffing.
struct LiveMeter: View {
  enum Mode { case live, working }

  let meter: LevelMeter
  var mode: Mode = .live
  var tint: Color = .white

  private static let weights: [Double] = [0.55, 0.85, 1.0, 0.85, 0.55]

  var body: some View {
    TimelineView(.animation) { timeline in
      Canvas { ctx, size in
        let t = timeline.date.timeIntervalSinceReferenceDate
        let level = Double(meter.value(at: t))
        let barWidth: CGFloat = 3
        let gap: CGFloat = 2.5
        let count = Self.weights.count
        var x = (size.width - CGFloat(count) * barWidth - CGFloat(count - 1) * gap) / 2
        for (i, weight) in Self.weights.enumerated() {
          let fraction: Double
          switch mode {
          case .live:
            // A little independent life per bar, scaled by how loud you are.
            let wobble = 0.8 + 0.2 * sin(t * (6.5 + Double(i) * 1.9) + Double(i) * 1.3)
            fraction = max(0.16, min(1, pow(level, 0.7) * weight * wobble * 1.25))
          case .working:
            // A calm travelling wave: "got it, working on it".
            fraction = 0.2 + 0.28 * (0.5 + 0.5 * sin(t * 7 - Double(i) * 0.8))
          }
          let height = max(barWidth, size.height * fraction)
          let rect = CGRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
          ctx.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(tint.opacity(0.55 + 0.45 * fraction)))
          x += barWidth + gap
        }
      }
    }
  }
}
