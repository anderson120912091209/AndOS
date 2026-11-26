import SwiftUI

enum ConnectionsLayout {
  static let size = CGSize(width: 600, height: 620)
}

/// "Connections": the tools Relay's AI can work with. Same black-and-quiet language as setup —
/// one group of rows, one obvious button per row, nothing shouting.
struct ConnectionsView: View {
  @ObservedObject var model: ConnectionsModel
  var openSetup: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScrollView(showsIndicators: false) {
        ConnectionsContent(model: model)
          .padding(.horizontal, 32)
          .padding(.top, 14)
          .padding(.bottom, 20)
      }
      footer
        .padding(.horizontal, 32)
        .padding(.bottom, 22)
    }
    .padding(.top, 26)
    .frame(width: ConnectionsLayout.size.width, height: ConnectionsLayout.size.height)
    .background(Color.black)
    .foregroundStyle(.white)
    .environment(\.colorScheme, .dark)
    .task { await model.refresh() }
  }

  private var footer: some View {
    HStack(spacing: 14) {
      SetupNote(symbol: "lock", text: "Sign-ins stay on this Mac. Relay only reads on its own.")
      Spacer(minLength: 0)
      Button("Set Up Relay…", action: openSetup).buttonStyle(SetupButtonStyle(prominent: false, compact: true))
    }
  }
}

/// Everything above the footer — split out so it can be rendered without a window.
struct ConnectionsContent: View {
  @ObservedObject var model: ConnectionsModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SetupHeader(
        title: "Connections",
        subtitle: "Let Relay’s AI work with your tools. It searches and reads on its own; anything that reaches someone waits for your OK in the notch."
      )
      if model.serverDown {
        ServerDownCard { Task { await model.refresh() } }
          .padding(.top, 22)
          .transition(.opacity)
      } else if model.loaded {
        VStack(spacing: 0) {
          ForEach(Array(model.available.enumerated()), id: \.element.id) { index, item in
            if index > 0 { SetupDivider() }
            ConnectionRow(model: model, item: item)
          }
        }
        .setupGroup()
        .padding(.top, 22)

        if model.available.contains(where: \.onBox) {
          BoxNote { BoxController.shared.showComputer() }
            .padding(.top, 12)
            .padding(.horizontal, 2)
        }

        if !model.upcoming.isEmpty {
          Text("Coming next")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white.opacity(0.38))
            .padding(.top, 22)
            .padding(.leading, 2)
          HStack(spacing: 8) {
            ForEach(model.upcoming) { SoonChip(item: $0) }
          }
          .padding(.top, 9)
        }
      }
    }
    .animation(.spring(response: 0.4, dampingFraction: 0.88), value: model.showsGoogleKey)
  }
}

// MARK: - A row

private struct ConnectionRow: View {
  @ObservedObject var model: ConnectionsModel
  var item: ConnectionsModel.Item
  @State private var hovering = false

  private var connected: Bool { item.state == .connected }
  private var signingIn: Bool { model.signingIn == item.id }
  private var glowing: Bool { model.justConnected == item.id }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 14) {
        ServiceBadge(id: item.id, lit: connected)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.name).font(.system(size: 14, weight: .medium))
          Text(subtitle)
            .font(.system(size: 12.5))
            .foregroundStyle(.white.opacity(0.5))
            .lineLimit(1)
            .contentTransition(.opacity)
        }
        Spacer(minLength: 12)
        trailing
      }

      if connected {
        Text("Try: \(item.example)")
          .font(.system(size: 12.5))
          .foregroundStyle(.white.opacity(0.42))
          .padding(.leading, 48)
          .padding(.top, 8)
          .transition(.opacity)
      }

      if item.id == "gmail", model.showsGoogleKey, !connected {
        GoogleKeyPanel(model: model, item: item)
          .padding(.top, 14)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }

      if let note = model.notes[item.id] {
        Label(note.text, systemImage: note.warn ? "exclamationmark.circle" : "info.circle")
          .font(.system(size: 12))
          .foregroundStyle(note.warn ? SetupColor.amber : .white.opacity(0.5))
          .padding(.leading, 48)
          .padding(.top, 8)
          .transition(.opacity)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(SetupColor.green.opacity(glowing ? 0.09 : 0))
    )
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .animation(.spring(response: 0.35, dampingFraction: 0.86), value: item)
    .animation(.easeOut(duration: 0.18), value: hovering)
    .animation(.easeOut(duration: 0.2), value: signingIn)
  }

  private var subtitle: String {
    switch item.state {
    case .connected:
      let who = item.account.map { $0.contains("@") ? "Signed in as \($0)" : $0 } ?? (item.onBox ? "Signed in" : "Connected")
      if item.onBox { return "\(who) on Relay’s computer" }
      return item.tools == nil ? who : "\(who) · read-only"
    case .broken: return item.note ?? "Signed out — connect again."
    default: return item.blurb
    }
  }

  @ViewBuilder private var trailing: some View {
    if signingIn {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Signing in…").font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.5))
      }
      .transition(.opacity)
    } else if connected {
      if hovering {
        Button(item.onBox ? "Sign Out" : "Disconnect") { model.disconnect(item) }
          .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
          .transition(.opacity)
      } else {
        HStack(spacing: 6) {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(SetupColor.green)
          Text(item.onBox ? "Signed In" : "Connected").foregroundStyle(.white.opacity(0.6))
        }
        .font(.system(size: 13, weight: .medium))
        .transition(.scale(scale: 0.85).combined(with: .opacity))
      }
    } else if item.state == .broken {
      Button("Reconnect") { model.connect(item) }.buttonStyle(SetupButtonStyle(compact: true))
    } else if !(item.id == "gmail" && model.showsGoogleKey) {
      Button(item.onBox ? "Sign In" : "Connect") { model.connect(item) }
        .buttonStyle(SetupButtonStyle(compact: true))
        .transition(.opacity)
    }
  }
}

// MARK: - Pieces

/// A quiet tile with the service's colour — recognisable at a glance, no borrowed logos.
struct ServiceBadge: View {
  var id: String
  var lit = true

  private var look: (symbol: String, color: Color) {
    switch id {
    case "claude": return ("sparkle", Color(red: 0.88, green: 0.54, blue: 0.41))
    case "gmail": return ("envelope.fill", Color(red: 0.92, green: 0.34, blue: 0.29))
    case "fathom": return ("video.fill", Color(red: 0.55, green: 0.47, blue: 0.98))
    case "slack": return ("number", Color(red: 0.85, green: 0.42, blue: 0.67))
    case "notion": return ("doc.text.fill", Color(white: 0.85))
    case "linear": return ("circle.lefthalf.filled", Color(red: 0.45, green: 0.5, blue: 0.95))
    case "box": return ("macwindow", Color(white: 0.9))
    default: return ("globe", Color.white)
    }
  }

  var body: some View {
    Image(systemName: look.symbol)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(look.color.opacity(lit ? 1 : 0.85))
      .frame(width: 34, height: 34)
      .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(look.color.opacity(lit ? 0.2 : 0.12)))
  }
}

private struct SoonChip: View {
  var item: ConnectionsModel.Item

  var body: some View {
    HStack(spacing: 7) {
      ServiceBadge(id: item.id, lit: false).scaleEffect(0.62).frame(width: 22, height: 22)
      Text(item.name).font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white.opacity(0.55))
    }
    .padding(.leading, 5)
    .padding(.trailing, 11)
    .frame(height: 30)
    .background(Capsule().fill(Color.white.opacity(0.045)))
    .overlay(Capsule().strokeBorder(Color.white.opacity(0.07)))
    .help(item.note ?? "Coming soon")
  }
}

/// Under the rows: where box sign-ins live, and a way to look in.
private struct BoxNote: View {
  var open: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      SetupNote(symbol: "macwindow", text: "Relay signs in on its own computer — a private browser on this Mac. You sign in once; it stays signed in there.")
      Spacer(minLength: 8)
      Button("Look", action: open)
        .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
        .help("Open Relay’s computer — watch it work, or lend a hand")
    }
  }
}

private struct ServerDownCard: View {
  var retry: () -> Void

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: "bolt.horizontal.circle")
        .font(.system(size: 18))
        .foregroundStyle(SetupColor.amber)
      VStack(alignment: .leading, spacing: 2) {
        Text("Relay’s server isn’t running").font(.system(size: 14, weight: .medium))
        Text("Start it with pnpm dev in the Relay folder, then try again.")
          .font(.system(size: 12.5))
          .foregroundStyle(.white.opacity(0.5))
      }
      Spacer(minLength: 12)
      Button("Try Again", action: retry).buttonStyle(SetupButtonStyle(compact: true))
    }
    .padding(14)
    .setupGroup()
  }
}
