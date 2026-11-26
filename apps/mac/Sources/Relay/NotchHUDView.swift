import AppKit
import SwiftUI

/// Notch geometry for one screen. Notched laptops use the real notch; other screens get a tiny
/// virtual one at the top-center, so the HUD behaves the same everywhere.
struct NotchMetrics {
  let hasNotch: Bool
  let notchWidth: CGFloat
  let topInset: CGFloat

  init(_ screen: NSScreen) {
    let safeTop = screen.safeAreaInsets.top
    let menuBar = max(0, screen.frame.maxY - screen.visibleFrame.maxY)
    if safeTop > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
      hasNotch = true
      notchWidth = max(120, screen.frame.width - left.width - right.width)
      topInset = safeTop
    } else {
      hasNotch = false
      notchWidth = 24 // no notch: the two ears sit almost side by side
      topInset = max(menuBar, 24)
    }
  }
}

/// Every size the HUD can take, relative to the notch, so it always reads as the notch itself
/// growing — never as a separate window.
enum NotchLayout {
  /// Each side, while dictating: the notch just gets a little wider. No drop below the menu bar.
  static let ear: CGFloat = 40
  /// The "I felt that" twitch when Fn goes down, before we know it's a hold.
  static let armedEar: CGFloat = 6
  /// The single line of text that hangs under the notch for messages.
  static let chinRow: CGFloat = 30
  static let chinPadding: CGFloat = 16
  static let chinMaxWidth: CGFloat = 400
  static let earRadius: CGFloat = 10
  static let chinRadius: CGFloat = 16
  static let textSize: CGFloat = 12.5
}

/// One place for the HUD's motion, so every change feels like the same object moving.
enum Motion {
  static let open = Animation.spring(response: 0.32, dampingFraction: 0.78)
  static let morph = Animation.spring(response: 0.28, dampingFraction: 0.86)
  static let close = Animation.spring(response: 0.24, dampingFraction: 1.0)
  static let arm = Animation.spring(response: 0.18, dampingFraction: 0.7)
}

/// The HUD: pure black, molded to the notch, no shadow.
/// - Dictating: the notch grows two small "ears" and stays exactly as tall as the menu bar. On the
///   left, where your words go: the app you're in (or ✦, the AI). On the right, Relay talking
///   along with you — its mouth follows your voice — then thinking while your words are written
///   down, then a ✓ once they're in.
/// - Messages: one line of text hangs just under the notch.
/// Content is clipped to the shape, so nothing ever shows outside the black while it morphs.
struct NotchHUDView: View {
  @ObservedObject var state: AppState

  private static let blue = Color(red: 0.42, green: 0.66, blue: 1.0)
  private static let amber = Color(red: 1.0, green: 0.74, blue: 0.36)
  private static let green = Color(red: 0.45, green: 0.86, blue: 0.55)

  private enum Form: Equatable {
    case closed, armed, ears
    case chin(AppState.Message)
  }

  private var form: Form {
    guard state.open else { return .closed }
    switch state.phase {
    case .idle: return .closed
    case .armed: return .armed
    case .listening, .thinking, .pasted: return .ears
    case let .message(m): return .chin(m)
    }
  }

  private var size: CGSize {
    let notch = state.notchWidth
    let top = state.notchTopInset
    switch form {
    case .closed: return CGSize(width: notch, height: state.hasNotch ? top : 0)
    case .armed: return CGSize(width: notch + 2 * NotchLayout.armedEar, height: top)
    case .ears: return CGSize(width: notch + 2 * NotchLayout.ear, height: top)
    case let .chin(m): return CGSize(width: chinWidth(for: m), height: top + NotchLayout.chinRow)
    }
  }

  private var radius: CGFloat {
    if case .chin = form { return NotchLayout.chinRadius }
    return NotchLayout.earRadius
  }

  var body: some View {
    let size = self.size
    ZStack(alignment: .top) {
      NotchShape(bottomRadius: radius).fill(Color.black)
      content
    }
    .frame(width: size.width, height: size.height, alignment: .top)
    .clipShape(NotchShape(bottomRadius: radius))
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  @ViewBuilder private var content: some View {
    switch form {
    case .closed, .armed:
      EmptyView()
    case .ears:
      ears.transition(Self.materialize)
    case let .chin(m):
      chin(m).id(m).transition(Self.materialize)
    }
  }

  // MARK: Ears — while dictating

  private var ears: some View {
    HStack(spacing: 0) {
      leftEar.frame(width: NotchLayout.ear)
      Spacer(minLength: 0) // the physical notch sits here
      rightEar.frame(width: NotchLayout.ear)
    }
    .frame(maxWidth: .infinity)
    .frame(height: state.notchTopInset)
  }

  /// Where your words go: the app they'll land in — or, talking to the AI, ✦.
  @ViewBuilder private var leftEar: some View {
    if state.scribe {
      Image(systemName: "sparkles")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Self.blue)
        .transition(.scale(scale: 0.6).combined(with: .opacity))
    } else if let icon = state.appIcon {
      Image(nsImage: icon)
        .resizable()
        .interpolation(.high)
        .frame(width: 18, height: 18)
        .id(ObjectIdentifier(icon)) // cross-fade when you switch apps mid-sentence
        .transition(.opacity)
    } else {
      Image(systemName: "mic.fill")
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.75))
    }
  }

  /// Relay: talking along with you (its mouth is the level meter now), thinking while your words
  /// are written down, and a ✓ in its place once they're in.
  @ViewBuilder private var rightEar: some View {
    if state.phase == .pasted {
      Image(systemName: "checkmark")
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(Self.green)
        .transition(.scale(scale: 0.4).combined(with: .opacity))
    } else {
      AgentCharacter(agent: .relay, mood: state.phase == .thinking ? .thinking : .listening, size: 30, voice: state.meter)
        .transition(.scale(scale: 0.6).combined(with: .opacity))
    }
  }

  // MARK: Chin — one line of news

  private func chin(_ m: AppState.Message) -> some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset) // the notch's own row
      HStack(spacing: 8) {
        if let agent = m.agent {
          AgentCharacter(agent: AgentID(agent), mood: .working, size: 22)
        } else {
          Image(systemName: m.symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(tint(m.tone))
        }
        Text(m.text)
          .font(.system(size: NotchLayout.textSize, weight: .medium))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .padding(.horizontal, NotchLayout.chinPadding)
      .frame(height: NotchLayout.chinRow)
    }
  }

  private func chinWidth(for m: AppState.Message) -> CGFloat {
    let font = NSFont.systemFont(ofSize: NotchLayout.textSize, weight: .medium)
    let text = ceil((m.text as NSString).size(withAttributes: [.font: font]).width)
    let mark: CGFloat = m.agent == nil ? 16 : 22 // a symbol, or an agent
    let wanted = mark + 8 + text + 2 * NotchLayout.chinPadding + 4 // mark, gap, text, padding, slack
    let atLeast = state.notchWidth + 2 * NotchLayout.ear
    return min(NotchLayout.chinMaxWidth, max(atLeast, wanted))
  }

  private func tint(_ tone: AppState.Message.Tone) -> Color {
    switch tone {
    case .calm: return .white.opacity(0.7)
    case .good: return Self.green
    case .warn: return Self.amber
    case .ai: return Self.blue
    }
  }

  /// Content arrives a beat after the shape starts growing (soft focus → sharp) and leaves
  /// fast, so the black always leads and text is never squeezed by a moving edge.
  private static let materialize = AnyTransition.asymmetric(
    insertion: .modifier(active: SoftFocus(amount: 1), identity: SoftFocus(amount: 0))
      .animation(.easeOut(duration: 0.2).delay(0.06)),
    removal: .opacity.animation(.easeIn(duration: 0.08))
  )
}

private struct SoftFocus: ViewModifier {
  var amount: CGFloat
  func body(content: Content) -> some View {
    content
      .blur(radius: 5 * amount)
      .scaleEffect(1 - 0.06 * amount, anchor: .top)
      .opacity(Double(1 - amount))
  }
}
