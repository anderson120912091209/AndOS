import SwiftUI

enum SetupLayout {
  static let size = CGSize(width: 600, height: 560)
}

enum SetupColor {
  /// The same green and amber the notch uses for "done" and "heads up".
  static let green = Color(red: 0.45, green: 0.86, blue: 0.55)
  static let amber = Color(red: 1.0, green: 0.74, blue: 0.36)
}

/// The setup window: the stage with the notch on top, one idea per page, one main button.
struct OnboardingView: View {
  @ObservedObject var model: Onboarding
  @ObservedObject var speech: ModelDownloader

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SetupStage(director: model.stage, step: model.step, fnDown: model.fnDown, listening: model.fnHeld)
      ZStack(alignment: .topLeading) {
        page
          .id(model.step)
          .transition(Self.pageTurn)
      }
      Spacer(minLength: 0)
      footer
    }
    .padding(.horizontal, 32)
    .padding(.top, 40)
    .padding(.bottom, 24)
    .frame(width: SetupLayout.size.width, height: SetupLayout.size.height)
    .background(Color.black)
    .foregroundStyle(.white)
    .environment(\.colorScheme, .dark)
  }

  @ViewBuilder private var page: some View {
    switch model.step {
    case .welcome: WelcomePage()
    case .permissions: PermissionsPage(model: model)
    case .tryIt: TryItPage(model: model, speech: speech)
    case .done: DonePage(model: model)
    }
  }

  private var footer: some View {
    HStack(spacing: 14) {
      SetupDots(count: Onboarding.Step.allCases.count, current: model.step.rawValue)
      if model.step != .welcome { SpeechStatus(speech: speech) }
      Spacer(minLength: 0)
      secondaryButton
      primaryButton
    }
    .frame(height: 32)
  }

  @ViewBuilder private var secondaryButton: some View {
    switch model.step {
    case .permissions where model.mic == .granted && !model.accessibility:
      Button("Not Now") { model.next() }.buttonStyle(SetupButtonStyle(prominent: false))
    case .tryIt where !model.practiced:
      Button("Skip") { model.next() }.buttonStyle(SetupButtonStyle(prominent: false))
    case .done where model.offersConnect:
      Button("Connect Your Tools") { model.finishAndConnect() }.buttonStyle(SetupButtonStyle(prominent: false))
    default:
      EmptyView()
    }
  }

  @ViewBuilder private var primaryButton: some View {
    switch model.step {
    case .welcome:
      Button("Get Started") { model.next() }
        .buttonStyle(SetupButtonStyle())
        .keyboardShortcut(.defaultAction)
    case .permissions:
      Button("Continue") { model.next() }
        .buttonStyle(SetupButtonStyle())
        .keyboardShortcut(.defaultAction)
        .disabled(!model.permissionsGranted)
    case .tryIt:
      // No Return shortcut here: Return belongs to the practice field.
      if model.practiced {
        Button("Continue") { model.next() }.buttonStyle(SetupButtonStyle())
      }
    case .done:
      Button("Done") { model.next() }
        .buttonStyle(SetupButtonStyle())
        .keyboardShortcut(.defaultAction)
    }
  }

  /// The new page rises a touch as the old one fades — quick, nothing flashy.
  private static let pageTurn = AnyTransition.asymmetric(
    insertion: .opacity.combined(with: .offset(y: 8)).animation(.easeOut(duration: 0.3).delay(0.06)),
    removal: .opacity.animation(.easeIn(duration: 0.12))
  )
}

// MARK: - Pages

private struct WelcomePage: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SetupHeader(
        title: "Say it. Relay types it.",
        subtitle: "Hold fn in any app, talk, then let go — your words appear right where your cursor is. English, 中文, or both in one sentence."
      )
      Label("Transcribed on this Mac — your audio never leaves it.", systemImage: "lock")
        .font(.system(size: 12.5))
        .foregroundStyle(.white.opacity(0.42))
        .padding(.top, 18)
    }
  }
}

private struct PermissionsPage: View {
  @ObservedObject var model: Onboarding

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SetupHeader(title: title, subtitle: subtitle)
      VStack(spacing: 0) {
        PermissionRow(
          symbol: "mic", title: "Microphone", detail: "Only while you hold fn.",
          state: micState, action: model.allowMicrophone
        )
        SetupDivider()
        PermissionRow(
          symbol: "keyboard", title: "Accessibility", detail: "So Relay can paste into the app you're in.",
          state: accessibilityState, action: model.turnOnAccessibility
        )
      }
      .setupGroup()
      .padding(.top, 22)
    }
  }

  private var title: String {
    if model.permissionsGranted { return "You're all set" }
    return model.returning ? "Turn Relay back on" : "Two quick permissions"
  }

  private var subtitle: String {
    if model.permissionsGranted { return "Relay can hear you and type for you." }
    return model.returning
      ? "Relay lost a permission it needs. Switch it back on and you're done."
      : "macOS asks before any app can use your microphone or type into other apps."
  }

  private var micState: PermissionRow.RowState {
    switch model.mic {
    case .granted: return .done
    case .notAsked: return .todo("Allow", prominent: true)
    case .denied: return .todo("Open Settings", prominent: true)
    }
  }

  private var accessibilityState: PermissionRow.RowState {
    if model.accessibility { return .done }
    if model.awaitingAccessibility { return .waiting("Show Me") }
    return .todo("Turn On", prominent: model.mic == .granted)
  }
}

private struct TryItPage: View {
  @ObservedObject var model: Onboarding
  @ObservedObject var speech: ModelDownloader
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SetupHeader(
        title: model.practiced ? "That's it" : "Hold fn and say something",
        subtitle: model.practiced
          ? "It works the same in every app — your words land wherever your cursor is."
          : "Let go when you're done. Speak English, 中文, or mix them — there's nothing to switch."
      )
      ZStack(alignment: .topLeading) {
        TextEditor(text: $model.practiceText)
          .font(.system(size: 15))
          .scrollContentBackground(.hidden)
          .focused($focused)
        if model.practiceText.isEmpty {
          Text(placeholder)
            .font(.system(size: 15))
            .foregroundStyle(.white.opacity(0.3))
            .padding(.leading, 5)
            .allowsHitTesting(false)
        }
      }
      .padding(12)
      .frame(height: 84)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(focused ? 0.2 : 0.09))
      )
      .padding(.top, 20)
      note.padding(.top, 12)
    }
    // Relay pastes into whatever has focus, so the field must have it before you speak.
    .onAppear { DispatchQueue.main.async { focused = true } }
    .onChange(of: model.fnHeld) { held in
      if held { focused = true }
    }
  }

  private var placeholder: String {
    switch speech.state {
    case let .downloading(fraction): return "Getting the speech engine ready… \(Int(fraction * 100))%"
    case .preparing: return "Getting the speech engine ready…"
    default: return "Your words land here"
    }
  }

  @ViewBuilder private var note: some View {
    if !model.accessibility {
      SetupNote(symbol: "doc.on.clipboard", text: "Accessibility is off, so Relay copies instead of pasting — press ⌘V to drop it in.")
    } else if let tip = globeTip {
      HStack(alignment: .center, spacing: 12) {
        SetupNote(symbol: "globe", text: tip)
        Spacer(minLength: 0)
        Button("Keyboard Settings") { model.openKeyboardSettings() }
          .buttonStyle(SetupButtonStyle(prominent: false, compact: true))
      }
    }
  }

  /// Taps stay macOS's and holds are Relay's (GlobeKey.holdThreshold), so switching input
  /// source or opening emoji is fine. Only Apple Dictation is worth a word: two dictation
  /// systems on one key is confusing.
  private var globeTip: String? {
    guard model.globeTap == .dictation else { return nil }
    return "A quick tap of fn starts Apple Dictation; holding it is Relay. To keep fn for Relay, choose “Do Nothing” for “Press 🌐 key to”."
  }
}

private struct DonePage: View {
  @ObservedObject var model: Onboarding

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SetupHeader(title: "You're ready", subtitle: "Relay lives in the notch. Hold fn whenever you'd rather talk than type.")
      VStack(spacing: 0) {
        ShortcutRow(keys: ["fn"], title: "Dictate", detail: "Hold, talk, let go — it's typed where you are.")
        SetupDivider(inset: 14)
        if !Edition.dictationOnly {
          ShortcutRow(keys: ["fn", "control"], title: "Ask AI", detail: "Relay does it in the background and reports back.")
          SetupDivider(inset: 14)
        }
        HStack(spacing: 14) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Open at login").font(.system(size: 14, weight: .medium))
            if model.loginNeedsApproval {
              Button("Allow in System Settings") { model.approveLoginItem() }
                .buttonStyle(.plain)
                .font(.system(size: 12.5))
                .foregroundStyle(SetupColor.amber)
            }
          }
          Spacer(minLength: 0)
          Toggle("Open at login", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
      }
      .setupGroup()
      .padding(.top, 20)
    }
  }
}

// MARK: - Pieces

struct SetupHeader: View {
  var title: String
  var subtitle: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.system(size: 24, weight: .semibold))
        .contentTransition(.opacity)
      Text(subtitle)
        .font(.system(size: 14))
        .foregroundStyle(.white.opacity(0.55))
        .lineSpacing(2.5)
        .fixedSize(horizontal: false, vertical: true)
        .contentTransition(.opacity)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 26)
    .animation(.easeOut(duration: 0.25), value: title)
  }
}

private struct PermissionRow: View {
  enum RowState: Equatable {
    case todo(String, prominent: Bool)
    case waiting(String)
    case done
  }

  var symbol: String
  var title: String
  var detail: String
  var state: RowState
  var action: () -> Void

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(.white.opacity(0.85))
        .frame(width: 34, height: 34)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.white.opacity(0.07)))
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 14, weight: .medium))
        Text(detail).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.5))
      }
      Spacer(minLength: 12)
      trailing
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .animation(.easeOut(duration: 0.2), value: state)
  }

  @ViewBuilder private var trailing: some View {
    switch state {
    case let .todo(label, prominent):
      Button(label, action: action).buttonStyle(SetupButtonStyle(prominent: prominent, compact: true))
    case let .waiting(label):
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Button(label, action: action).buttonStyle(SetupButtonStyle(prominent: false, compact: true))
      }
    case .done:
      HStack(spacing: 6) {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(SetupColor.green)
        Text("On").foregroundStyle(.white.opacity(0.6))
      }
      .font(.system(size: 13, weight: .medium))
      .transition(.scale(scale: 0.8).combined(with: .opacity))
    }
  }
}

private struct ShortcutRow: View {
  var keys: [String]
  var title: String
  var detail: String

  var body: some View {
    HStack(spacing: 14) {
      HStack(spacing: 4) {
        ForEach(keys, id: \.self) { SetupKey(label: $0) }
      }
      .frame(width: 92, alignment: .leading)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 14, weight: .medium))
        Text(detail).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.5))
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }
}

private struct SetupKey: View {
  var label: String

  var body: some View {
    Text(label)
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(.white.opacity(0.85))
      .frame(minWidth: 24)
      .padding(.horizontal, 5)
      .frame(height: 22)
      .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.white.opacity(0.09)))
      .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.white.opacity(0.12)))
  }
}

struct SetupNote: View {
  var symbol: String
  var text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      Image(systemName: symbol).font(.system(size: 11.5))
      Text(text).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(.white.opacity(0.5))
  }
}

/// Downloading, preparing, or failed — quiet, beside the page dots. Nothing once it's ready.
private struct SpeechStatus: View {
  @ObservedObject var speech: ModelDownloader

  var body: some View {
    switch speech.state {
    case let .downloading(fraction):
      HStack(spacing: 8) {
        Capsule()
          .fill(Color.white.opacity(0.12))
          .frame(width: 64, height: 3)
          .overlay(alignment: .leading) {
            Capsule().fill(Color.white.opacity(0.7)).frame(width: 64 * fraction, height: 3)
          }
        Text("Speech engine \(Int(fraction * 100))%")
      }
      .font(.system(size: 11.5))
      .foregroundStyle(.white.opacity(0.45))
    case .preparing:
      Text("Preparing speech engine…")
        .font(.system(size: 11.5))
        .foregroundStyle(.white.opacity(0.45))
    case let .failed(message):
      HStack(spacing: 8) {
        Text(message).font(.system(size: 11.5)).foregroundStyle(SetupColor.amber)
        Button("Retry") { speech.start() }.buttonStyle(SetupButtonStyle(prominent: false, compact: true))
      }
    case .idle, .ready:
      EmptyView()
    }
  }
}

private struct SetupDots: View {
  var count: Int
  var current: Int

  var body: some View {
    HStack(spacing: 6) {
      ForEach(0..<count, id: \.self) { i in
        Capsule()
          .fill(Color.white.opacity(i == current ? 0.9 : 0.18))
          .frame(width: i == current ? 16 : 6, height: 6)
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.8), value: current)
  }
}

struct SetupDivider: View {
  /// Lines up with the text of the rows, past their icons.
  var inset: CGFloat = 62

  var body: some View {
    Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1).padding(.leading, inset)
  }
}

/// White on black for the one thing to do; a quiet grey for everything else.
struct SetupButtonStyle: ButtonStyle {
  var prominent = true
  var compact = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    // Disabled reads as "not yet": a faint outline of the button, not a grey slab.
    let solid = prominent && isEnabled
    return configuration.label
      .font(.system(size: compact ? 12.5 : 13, weight: .semibold))
      .foregroundStyle(solid ? Color.black : Color.white.opacity(isEnabled ? 0.88 : 0.3))
      .padding(.horizontal, compact ? 12 : 16)
      .frame(height: compact ? 26 : 32)
      .background(
        RoundedRectangle(cornerRadius: compact ? 7 : 8, style: .continuous)
          .fill(solid ? Color.white : Color.white.opacity(isEnabled ? 0.09 : 0.05))
      )
      .opacity(configuration.isPressed ? 0.78 : 1)
      .contentShape(Rectangle())
      .animation(.easeOut(duration: 0.15), value: isEnabled)
  }
}

extension View {
  /// A quiet grouped list, like a Settings section on black.
  func setupGroup() -> some View {
    background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.035)))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
  }
}
