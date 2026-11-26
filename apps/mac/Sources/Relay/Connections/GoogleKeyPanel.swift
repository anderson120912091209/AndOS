import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Gmail's one-time setup, inline under its row: make a key in your own Google Cloud project,
/// then drop its file here. Your mail only ever travels between your Mac and Google — no one
/// else's app sits in between, and you can revoke the key whenever you like.
struct GoogleKeyPanel: View {
  @ObservedObject var model: ConnectionsModel
  var item: ConnectionsModel.Item

  @State private var opened: Set<Int> = []
  @State private var clientId = ""
  @State private var clientSecret = ""
  @State private var loadedFile: String?
  @State private var dropping = false
  @State private var problem: String?

  private struct Step {
    var title: String
    var detail: String
    var url: String
  }

  private let steps = [
    Step(title: "Set up sign-in for a project", detail: "App name “Relay”, your email, audience External.", url: "https://console.cloud.google.com/auth/overview"),
    Step(title: "Add yourself as a test user", detail: "Audience → Test users → your Gmail address.", url: "https://console.cloud.google.com/auth/audience"),
    Step(title: "Turn on Gmail and Calendar", detail: "One click enables both.", url: "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com"),
    Step(title: "Create a Desktop app key", detail: "Then download its JSON file.", url: "https://console.cloud.google.com/auth/clients/create"),
  ]

  private var ready: Bool {
    clientId.trimmingCharacters(in: .whitespaces).hasSuffix(".apps.googleusercontent.com")
      && !clientSecret.trimmingCharacters(in: .whitespaces).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Gmail signs in with a key from your own Google Cloud project, so your mail only travels between this Mac and Google. About five minutes, once.")
        .font(.system(size: 12.5))
        .foregroundStyle(.white.opacity(0.55))
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)

      VStack(spacing: 10) {
        ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
          stepRow(index, step)
        }
      }
      .padding(.top, 14)

      dropZone.padding(.top, 14)

      VStack(spacing: 8) {
        KeyField(label: "Client ID", text: $clientId, placeholder: "…apps.googleusercontent.com")
        KeyField(label: "Secret", text: $clientSecret, placeholder: "GOCSPX-…", secure: true)
      }
      .padding(.top, 10)

      HStack(spacing: 10) {
        if let problem {
          Label(problem, systemImage: "exclamationmark.circle")
            .font(.system(size: 12))
            .foregroundStyle(SetupColor.amber)
            .transition(.opacity)
        }
        Spacer(minLength: 0)
        Button("Cancel") {
          withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { model.showsGoogleKey = false }
        }
        .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
        Button("Sign In with Google") {
          model.connect(item, clientId: clientId.trimmingCharacters(in: .whitespaces), clientSecret: clientSecret.trimmingCharacters(in: .whitespaces))
        }
        .buttonStyle(SetupButtonStyle(compact: true))
        .disabled(!ready || model.signingIn != nil)
      }
      .padding(.top, 14)
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.035)))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white.opacity(0.07)))
    .padding(.leading, 48)
    .animation(.easeOut(duration: 0.2), value: opened)
    .animation(.easeOut(duration: 0.2), value: problem)
  }

  private func stepRow(_ index: Int, _ step: Step) -> some View {
    let done = opened.contains(index)
    return HStack(alignment: .top, spacing: 11) {
      ZStack {
        Circle().fill(done ? SetupColor.green.opacity(0.18) : Color.white.opacity(0.07))
        if done {
          Image(systemName: "checkmark").font(.system(size: 9.5, weight: .bold)).foregroundStyle(SetupColor.green)
        } else {
          Text("\(index + 1)").font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
        }
      }
      .frame(width: 20, height: 20)
      VStack(alignment: .leading, spacing: 1) {
        Text(step.title).font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(done ? 0.55 : 0.9))
        Text(step.detail).font(.system(size: 12)).foregroundStyle(.white.opacity(0.42))
      }
      Spacer(minLength: 8)
      Button(done ? "Open Again" : "Open") {
        if let url = URL(string: step.url) { NSWorkspace.shared.open(url) }
        opened.insert(index)
      }
      .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
    }
  }

  private var dropZone: some View {
    HStack(spacing: 10) {
      Image(systemName: loadedFile == nil ? "arrow.down.doc" : "checkmark.seal.fill")
        .font(.system(size: 15))
        .foregroundStyle(loadedFile == nil ? .white.opacity(0.55) : SetupColor.green)
      VStack(alignment: .leading, spacing: 1) {
        Text(loadedFile == nil ? "Drop the key file you downloaded" : "Key loaded")
          .font(.system(size: 13, weight: .medium))
        Text(loadedFile ?? "Or paste the ID and secret below.")
          .font(.system(size: 12))
          .foregroundStyle(.white.opacity(0.42))
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 8)
      Button("Choose File…", action: chooseFile).buttonStyle(SetupButtonStyle(prominent: false, compact: true))
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(Color.white.opacity(dropping ? 0.08 : 0.025))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .strokeBorder(Color.white.opacity(dropping ? 0.35 : 0.12), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
    )
    .modifier(DropTarget(dropping: $dropping, enabled: !offscreen) { url in load(url) })
    .animation(.easeOut(duration: 0.15), value: dropping)
  }

  @Environment(\.offscreenRender) private var offscreen

  private func chooseFile() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.json]
    panel.message = "Choose the key file you downloaded from Google Cloud"
    if panel.runModal() == .OK, let url = panel.url { load(url) }
  }

  /// Google's key file: {"installed": {"client_id": …, "client_secret": …}} ("web" for web apps).
  private func load(_ url: URL) {
    guard
      let data = try? Data(contentsOf: url),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let body = (json["installed"] ?? json["web"]) as? [String: Any],
      let id = body["client_id"] as? String,
      let secret = body["client_secret"] as? String
    else {
      problem = "That file isn’t a Google key — download it from the key’s page."
      return
    }
    clientId = id
    clientSecret = secret
    loadedFile = url.lastPathComponent
    problem = json["web"] != nil ? "That’s a Web app key — a Desktop app key works best." : nil
  }
}

/// Accepts a dropped key file. Off for offscreen renders, which can't draw a drop target.
private struct DropTarget: ViewModifier {
  @Binding var dropping: Bool
  var enabled: Bool
  var load: (URL) -> Void

  func body(content: Content) -> some View {
    if enabled {
      content.onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
        guard let provider = providers.first else { return false }
        _ = provider.loadObject(ofClass: URL.self) { url, _ in
          guard let url else { return }
          Task { @MainActor in load(url) }
        }
        return true
      }
    } else {
      content
    }
  }
}

extension EnvironmentValues {
  /// True while rendering to a PNG (RELAY_RENDER_SHOTS): AppKit-backed controls draw as text.
  @Entry var offscreenRender = false
}

private struct KeyField: View {
  var label: String
  @Binding var text: String
  var placeholder: String
  var secure = false
  @Environment(\.offscreenRender) private var offscreen

  var body: some View {
    HStack(spacing: 10) {
      Text(label)
        .font(.system(size: 12.5, weight: .medium))
        .foregroundStyle(.white.opacity(0.55))
        .frame(width: 62, alignment: .leading)
      Group {
        if offscreen {
          Text(text.isEmpty ? placeholder : text)
            .foregroundStyle(.white.opacity(text.isEmpty ? 0.3 : 0.9))
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if secure {
          SecureField(placeholder, text: $text)
        } else {
          TextField(placeholder, text: $text)
        }
      }
      .textFieldStyle(.plain)
      .font(.system(size: 12.5, design: .monospaced))
      .padding(.horizontal, 9)
      .frame(height: 26)
      .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.white.opacity(0.06)))
      .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
    }
  }
}
