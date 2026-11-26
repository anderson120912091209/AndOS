import SwiftUI
import WebKit

enum BoxLayout {
  /// the box's display (apps/box, SCREEN)
  static let screen = CGSize(width: 1280, height: 800)
  /// a little black around the screen, so it reads as a window into another computer
  static let inset: CGFloat = 10
}

/// The window's content: the box's screen, and a quiet card while it starts or connects.
struct BoxView: View {
  @ObservedObject var model: BoxModel
  let webView: WKWebView
  var retry: () -> Void

  var body: some View {
    ZStack {
      BoxScreen(webView: webView)
        .opacity(model.phase == .live ? 1 : 0)
      if model.phase != .live {
        BoxStatusCard(phase: model.phase, retry: retry)
          .transition(.opacity)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .padding([.horizontal, .bottom], BoxLayout.inset)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.black)
    .animation(.easeOut(duration: 0.3), value: model.phase)
  }
}

/// The noVNC viewer page (apps/box/relay.html), hosted as is.
struct BoxScreen: NSViewRepresentable {
  let webView: WKWebView
  func makeNSView(context: Context) -> WKWebView { webView }
  func updateNSView(_ nsView: WKWebView, context: Context) {}
}

private struct BoxStatusCard: View {
  var phase: BoxModel.Phase
  var retry: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      if case let .failed(why) = phase {
        Image(systemName: "bolt.horizontal.circle")
          .font(.system(size: 22))
          .foregroundStyle(SetupColor.amber)
        Text(why)
          .font(.system(size: 13.5))
          .foregroundStyle(.white.opacity(0.7))
          .multilineTextAlignment(.center)
          .frame(maxWidth: 380)
        Button("Try Again", action: retry)
          .buttonStyle(SetupButtonStyle(compact: true))
          .padding(.top, 4)
      } else {
        ProgressView().controlSize(.small)
        Text(phase == .starting ? "Starting Relay’s computer…" : "Connecting to Relay’s computer…")
          .font(.system(size: 13))
          .foregroundStyle(.white.opacity(0.5))
          .contentTransition(.opacity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.white.opacity(0.03))
  }
}

/// The toolbar's leading side: what you're asked to do, and where.
struct BoxTitle: View {
  @ObservedObject var model: BoxModel

  private var asking: Bool { model.takeover.id != nil }

  var body: some View {
    HStack(spacing: 10) {
      ServiceBadge(id: (model.takeover.service ?? "box").lowercased())
        .scaleEffect(0.76)
        .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        Text(model.takeover.reason)
          .font(.system(size: 13, weight: .semibold))
        Text(asking ? "On Relay’s computer · Relay waits while you’re here" : "Watching Relay work · take over to use it yourself")
          .font(.system(size: 11.5))
          .foregroundStyle(.white.opacity(0.45))
      }
      .lineLimit(1)
    }
    .foregroundStyle(.white)
    .fixedSize()
    .environment(\.colorScheme, .dark)
  }
}

/// The toolbar's trailing side. Using the box: a hint, "Not Now", "Done". Watching: "Take Over"
/// and "Close". No Return shortcut: Return belongs to the sign-in form.
struct BoxActions: View {
  @ObservedObject var model: BoxModel
  var finish: (_ done: Bool) -> Void
  var takeOver: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      if model.phase == .live, !model.watching {
        Text("⌘V pastes from your Mac")
          .font(.system(size: 11.5))
          .foregroundStyle(.white.opacity(0.38))
          .padding(.trailing, 8)
          .transition(.opacity)
      }
      if model.watching {
        Button("Close") { finish(true) }
          .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
        Button(model.takingOver ? "Taking Over…" : "Take Over", action: takeOver)
          .buttonStyle(SetupButtonStyle(compact: true))
          .disabled(model.phase != .live || model.takingOver)
          .help("Relay’s agent stops while you use its computer")
      } else {
        Button("Not Now") { finish(false) }
          .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
        Button("Done") { finish(true) }
          .buttonStyle(SetupButtonStyle(compact: true))
      }
    }
    .fixedSize()
    .animation(.easeOut(duration: 0.2), value: model.phase)
    .environment(\.colorScheme, .dark)
  }
}
