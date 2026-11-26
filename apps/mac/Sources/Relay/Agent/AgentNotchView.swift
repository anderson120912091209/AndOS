import AppKit
import SwiftUI

/// Sizes for the agent's notch forms — relative to the notch, like the HUD's NotchLayout, so
/// it always reads as the notch itself growing.
enum AgentLayout {
  static let ear: CGFloat = 34
  static let badgeEar: CGFloat = 40
  static let chinRow: CGFloat = 36
  static let chinMaxWidth: CGFloat = 420
  static let cardWidth: CGFloat = 420
  static let pad: CGFloat = 18
  static let earRadius: CGFloat = 10
  static let chinRadius: CGFloat = 18
  static let cardRadius: CGFloat = 26
  static let blue = Color(red: 0.42, green: 0.66, blue: 1.0)
  static let amber = Color(red: 1.0, green: 0.74, blue: 0.36)
  static let green = Color(red: 0.45, green: 0.86, blue: 0.55)
}

/// What the agent's corner of the notch is showing. One source of truth; the controller
/// drives it, the view only draws it.
@MainActor
final class AgentNotchState: ObservableObject {
  enum Form: Equatable {
    case hidden
    /// Resting beside the notch: who's on a job (their characters, stacked) and how much waits
    /// for you (a count). Tap it for the stack — or straight into the one thing there is.
    case glance(Glance)
    /// The stack: every job, one row each — what needs you first, then who's working (on which
    /// step), then answers you haven't opened. Its rows are `stackRows`, so they update live
    /// without the notch re-forming (AgentStack.swift).
    case stack
    /// "It's back": one line under the notch. Click to open.
    case ready(AgentTicket)
    /// The review card — the draft itself, with the buttons.
    case card(AgentTicket)
    /// How it ended: "Sent to Alex", "Discarded", an error.
    case toast(Toast)
    /// It couldn't run because something isn't set up: one line with the button that fixes it.
    case setup(AgentTicket)
    /// The agent needs you to sign in / do something private on the box browser — hand it over.
    case takeover(Takeover)
    /// Setting up a key right here in the notch — paste, connect, done.
    case keySetup(KeySetup)
    /// An answer, opened: who did it, the conclusion, one block, what to say next (AnswerViews).
    case answer(AgentTicket)
    /// A long answer — a report, a plan — in the reader, which grows on from the card.
    case reader(AgentTicket)
  }

  /// A connection that signs in with a pasted key (Claude), and the request waiting on it.
  struct KeySetup: Equatable {
    var ticket: AgentTicket?
    var connection: String
    var name: String
    var prefix: String
    var getKeyURL: URL

    static func claude(for ticket: AgentTicket?) -> KeySetup {
      KeySetup(ticket: ticket, connection: "claude", name: "Claude", prefix: "sk-ant-",
               getKeyURL: URL(string: "https://platform.claude.com/settings/keys")!)
    }
  }

  enum KeyStatus: Equatable { case idle, checking, error(String), connected }

  /// A moment where only you should act in the box browser (sign-in, 2FA). The viewer lives in
  /// its own Box window; the notch is just the "it needs you" handoff.
  struct Takeover: Equatable {
    var ticketID: String
    /// what the person has to do, in their words ("Sign in to Gmail")
    var reason: String
    /// the account/site, for the icon + chip
    var service: String
    /// the box's viewer, opened when you tap Take over
    var viewerURL: URL?
    /// the takeover session id, for telling the box you're done
    var id: String?
    /// which of Relay's agents is asking (the character in the chin)
    var agent: String? = nil
  }

  struct Toast: Hashable {
    var symbol: String
    var text: String
    var tone: Tone = .calm
  }

  enum Tone: Hashable { case calm, good, warn, ai }

  /// What the resting notch says at a glance.
  struct Glance: Equatable {
    /// the agents on running jobs, newest first — one character per job
    var working: [String?] = []
    /// drafts, sign-ins and questions waiting for you
    var waiting = 0
    /// answers that came back while you were elsewhere, not opened yet
    var unread = 0
    /// the newest waiting draft's kind (its app icon), shown when nobody is working
    var kind = ""
    /// who to show when nobody is working: the newest one waiting on you, or back
    var lead: String? = nil
  }

  /// Between pressing a button and the worker confirming it.
  enum Busy: Equatable { case sending, discarding, revising }

  @Published var form: Form = .hidden
  /// false = tucked into the notch; true = showing `form`. Same grow/shrink as the HUD.
  @Published var open = false
  @Published var busy: Busy?
  /// The key being typed or pasted into the setup card, and how checking it went.
  @Published var keyText = ""
  @Published var keyStatus: KeyStatus = .idle
  @Published var notchWidth: CGFloat = 185
  @Published var notchTopInset: CGFloat = 32
  @Published var hasNotch = false
  /// How tall the screen is — the reader grows to at most most of it.
  @Published var screenHeight: CGFloat = 900
  /// "Copied" on the reader's Copy button, for a moment after you press it.
  @Published var copied = false
  /// Headless renders can't draw AppKit-backed views (scroll views), so they turn this off.
  var scrollableBody = true
  /// Renders hold the characters still at one moment; nil = they move.
  var stillTime: TimeInterval?
  /// The stack's rows, top to bottom, while it's open — kept current as jobs move.
  @Published var stackRows: [AgentTicket] = []

  func size(of form: Form) -> CGSize {
    let notch = notchWidth
    let top = notchTopInset
    switch form {
    case .hidden: return CGSize(width: notch, height: hasNotch ? top : 0)
    case let .glance(g): return CGSize(width: notch + 2 * AgentStackLayout.earWidth(g), height: top)
    case .stack: return CGSize(width: AgentLayout.cardWidth, height: top + AgentStackLayout.height(rows: stackRows.count))
    case let .ready(t) where t.answer != nil:
      return CGSize(width: AnswerMetrics.chinWidth(t, notch: notch), height: top + AgentLayout.chinRow)
    // extra = everything on the line besides the text: icon, "Ready", the Review pill, gaps.
    case let .ready(t): return CGSize(width: chinWidth(ReadyLine.text(for: t), extra: 168, max: 480), height: top + AgentLayout.chinRow)
    case let .answer(t): return CGSize(width: AgentLayout.cardWidth, height: top + AnswerMetrics.cardHeight(t))
    case let .reader(t):
      return CGSize(width: AnswerLayout.readerWidth, height: top + AnswerMetrics.readerHeight(t, available: screenHeight - top))
    case let .toast(t): return CGSize(width: chinWidth(t.text, extra: 30), height: top + AgentLayout.chinRow)
    case let .card(t): return CGSize(width: AgentLayout.cardWidth, height: top + Self.cardHeight(t))
    case let .setup(t): return CGSize(width: chinWidth(SetupLine.text(for: t), extra: 150, max: 480), height: top + AgentLayout.chinRow)
    case let .takeover(k): return CGSize(width: chinWidth(k.reason, extra: 150, max: 500), height: top + AgentLayout.chinRow)
    case .keySetup: return CGSize(width: AgentLayout.cardWidth, height: top + 218)
    }
  }

  static func cardHeight(_ t: AgentTicket) -> CGFloat {
    switch t.proposal?.preview.kind {
    case "email": return 322
    case "event":
      let p = t.proposal?.preview
      let rows = 2 + (p?.location == nil ? 0 : 1) + ((p?.attendees ?? []).isEmpty ? 0 : 1)
      return 100 + CGFloat(rows) * 26
    default: return 150 + CGFloat(min(3, t.result?.artifacts?.count ?? 0)) * 22
    }
  }

  private func chinWidth(_ text: String, extra: CGFloat, max cap: CGFloat = AgentLayout.chinMaxWidth) -> CGFloat {
    let font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
    let w = ceil((text as NSString).size(withAttributes: [.font: font]).width)
    return min(cap, max(notchWidth + 2 * AgentLayout.badgeEar, w + extra + 2 * AgentLayout.pad))
  }
}

/// What the buttons do — supplied by the controller.
struct AgentActions {
  var open: () -> Void = {}
  var collapse: () -> Void = {}
  var approve: () -> Void = {}
  var discard: () -> Void = {}
  var dismiss: () -> Void = {}
  // the key card
  var takeOver: () -> Void = {}
  var getKey: () -> Void = {}
  var pasteKey: () -> Void = {}
  var submitKey: () -> Void = {}
  // answers
  /// a follow-up button or a tapped option: ask the same agent, carrying on from its answer
  var followUp: (String) -> Void = { _ in }
  var copyAnswer: () -> Void = {}
  var openInApp: () -> Void = {}
  // the stack
  /// one row: its draft, its answer, its sign-in — or, while it works, Relay's computer to watch
  var openTicket: (String) -> Void = { _ in }
  /// everything, history and every step, in the Command Center
  var showAll: () -> Void = {}
}

enum SetupLine {
  static func text(for t: AgentTicket) -> String {
    switch t.needsSetup?.connection {
    case "claude": return "Claude isn't set up yet"
    case let other?: return "\(other.prefix(1).uppercased())\(other.dropFirst()) isn't connected"
    case nil: return t.title
    }
  }
}

enum ReadyLine {
  static func text(for t: AgentTicket) -> String {
    t.proposal.map(\.summary) ?? t.title
  }
}

/// Native app icons as the "what is this" mark: Mail for email, Calendar for events.
@MainActor
enum ArtifactIcon {
  private static var cache: [String: NSImage] = [:]

  static func image(for kind: String?) -> NSImage? {
    let path: String
    switch kind {
    case "email": path = "/System/Applications/Mail.app"
    case "event": path = "/System/Applications/Calendar.app"
    default: return nil
    }
    if let hit = cache[path] { return hit }
    let icon = NSWorkspace.shared.icon(forFile: path)
    cache[path] = icon
    return icon
  }
}

struct AgentNotchView: View {
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions

  private var form: AgentNotchState.Form { state.open ? state.form : .hidden }

  private var radius: CGFloat {
    switch form {
    case .card, .keySetup, .answer, .stack: return AgentLayout.cardRadius
    case .reader: return AnswerLayout.readerRadius
    case .ready, .toast, .setup, .takeover: return AgentLayout.chinRadius
    default: return AgentLayout.earRadius
    }
  }

  var body: some View {
    let size = state.size(of: form)
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
    case .hidden:
      EmptyView()
    case let .glance(g):
      Button(action: actions.open) {
        ears(left: AnyView(glanceLeft(g)), right: AnyView(glanceRight(g)))
      }
      .buttonStyle(.plain)
      .transition(Self.materialize)
    case .stack:
      AgentStackCard(state: state, actions: actions)
        .transition(Self.materialize)
    case let .ready(t):
      if t.answer != nil {
        AnswerChin(ticket: t, state: state, actions: actions)
          .id("answer-chin-\(t.id)")
          .transition(Self.materialize)
      } else {
        Button(action: actions.open) { readyChin(t) }
          .buttonStyle(.plain)
          .id(t.proposal?.id ?? t.id)
          .transition(Self.materialize)
      }
    case let .answer(t):
      AnswerCard(ticket: t, state: state, actions: actions)
        .id("answer-\(t.id)")
        .transition(Self.materialize)
    case let .reader(t):
      ReaderCard(ticket: t, state: state, actions: actions)
        .id("reader-\(t.id)")
        .transition(Self.materialize)
    case let .toast(t):
      Button(action: actions.dismiss) { toastChin(t) }
        .buttonStyle(.plain)
        .id(t)
        .transition(Self.materialize)
    case let .card(t):
      AgentCard(ticket: t, state: state, actions: actions)
        .id(t.proposal?.id ?? t.id)
        .transition(Self.materialize)
    case let .setup(t):
      Button(action: actions.open) { setupChin(t) }
        .buttonStyle(.plain)
        .id("setup-\(t.id)")
        .transition(Self.materialize)
    case let .keySetup(k):
      KeySetupCard(setup: k, state: state, actions: actions)
        .transition(Self.materialize)
    case let .takeover(k):
      Button(action: actions.takeOver) { takeoverChin(k) }
        .buttonStyle(.plain)
        .id("takeover-\(k.id ?? k.ticketID)")
        .transition(Self.materialize)
    }
  }

  /// "Gmail needs you to sign in  [Take over]" — tap to open the box's screen and do it yourself.
  private func takeoverChin(_ k: AgentNotchState.Takeover) -> some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset)
      HStack(spacing: 9) {
        AgentCharacter(agent: AgentID(k.agent), mood: .needsYou, size: 20)
        Text(k.reason)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
        Spacer(minLength: 4)
        HStack(spacing: 5) {
          Image(systemName: "hand.point.up.left.fill").font(.system(size: 10, weight: .bold))
          Text("Take over").font(.system(size: 11.5, weight: .semibold))
        }
        .foregroundStyle(.black)
        .padding(.horizontal, 10)
        .padding(.vertical, 3.5)
        .background(Capsule().fill(AgentLayout.blue))
      }
      .padding(.horizontal, AgentLayout.pad)
      .frame(height: AgentLayout.chinRow)
    }
    .contentShape(Rectangle())
  }

  /// "Claude isn't set up yet  [Set up Claude]" — the whole line is the button.
  private func setupChin(_ t: AgentTicket) -> some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset)
      HStack(spacing: 9) {
        AgentCharacter(agent: AgentID(t.agent), mood: .needsYou, size: 20)
        Text(SetupLine.text(for: t))
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
        Spacer(minLength: 4)
        Text(t.needsSetup?.label ?? "Set up")
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(.black)
          .padding(.horizontal, 10)
          .padding(.vertical, 3.5)
          .background(Capsule().fill(AgentLayout.amber))
      }
      .padding(.horizontal, AgentLayout.pad)
      .frame(height: AgentLayout.chinRow)
    }
    .contentShape(Rectangle())
  }

  // MARK: Ears — around the notch, menu-bar height

  private func ears(left: AnyView, right: AnyView) -> some View {
    HStack(spacing: 0) {
      left.frame(width: earWidth)
      Spacer(minLength: 0) // the physical notch sits here
      right.frame(width: earWidth)
    }
    .frame(maxWidth: .infinity)
    .frame(height: state.notchTopInset)
    .contentShape(Rectangle())
  }

  private var earWidth: CGFloat {
    if case let .glance(g) = form { return AgentStackLayout.earWidth(g) }
    return AgentLayout.ear
  }

  private func countDot(_ n: Int, fill: Color = AgentLayout.amber) -> some View {
    Text("\(n)")
      .font(.system(size: 11, weight: .bold, design: .rounded))
      .foregroundStyle(.black)
      .frame(minWidth: 18, minHeight: 18)
      .background(Circle().fill(fill))
  }

  /// Left of the notch: who's working, stacked — or, when nobody is, who's waiting on you.
  @ViewBuilder private func glanceLeft(_ g: AgentNotchState.Glance) -> some View {
    if !g.working.isEmpty {
      StackedAgents(agents: g.working, time: state.stillTime)
    } else if g.waiting > 0 {
      icon(g.kind, size: 18, agent: g.lead, mood: .needsYou)
    } else {
      AgentCharacter(agent: AgentID(g.lead), mood: .done, size: 20, time: state.stillTime)
    }
  }

  /// Right of the notch: how many wait for you (amber), else answers you haven't opened
  /// (green), else — only work in progress — the working wave.
  @ViewBuilder private func glanceRight(_ g: AgentNotchState.Glance) -> some View {
    if g.waiting > 0 {
      countDot(g.waiting)
    } else if g.unread > 0 {
      countDot(g.unread, fill: AgentLayout.green)
    } else {
      LiveMeter(meter: Self.idleMeter, mode: .working, tint: AgentLayout.blue).frame(width: 24, height: 14)
    }
  }

  /// The draft's app icon (Mail, Calendar) when there's a draft; otherwise the agent itself.
  @ViewBuilder private func icon(_ kind: String?, size: CGFloat, agent: String? = nil, mood: AgentMood = .idle) -> some View {
    if let image = ArtifactIcon.image(for: kind) {
      Image(nsImage: image).resizable().interpolation(.high).frame(width: size, height: size)
    } else {
      AgentCharacter(agent: AgentID(agent), mood: mood, size: size + 2)
    }
  }

  // MARK: Chins — one line under the notch

  private func readyChin(_ t: AgentTicket) -> some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset)
      HStack(spacing: 9) {
        icon(t.proposal?.preview.kind, size: 18, agent: t.agent, mood: t.proposal == nil ? .done : .idle)
        Text(t.proposal == nil ? "Done" : "Ready")
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(AgentLayout.blue)
        Text(ReadyLine.text(for: t))
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 4)
        Text(t.proposal == nil ? "Open" : "Review")
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(.black)
          .padding(.horizontal, 9)
          .padding(.vertical, 3.5)
          .background(Capsule().fill(.white.opacity(0.9)))
      }
      .padding(.horizontal, AgentLayout.pad)
      .frame(height: AgentLayout.chinRow)
    }
    .contentShape(Rectangle())
  }

  private func toastChin(_ t: AgentNotchState.Toast) -> some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset)
      HStack(spacing: 8) {
        Image(systemName: t.symbol)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(tint(t.tone))
        Text(t.text)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .padding(.horizontal, AgentLayout.pad)
      .frame(height: AgentLayout.chinRow)
    }
    .contentShape(Rectangle())
  }

  private func tint(_ tone: AgentNotchState.Tone) -> Color {
    switch tone {
    case .calm: return .white.opacity(0.7)
    case .good: return AgentLayout.green
    case .warn: return AgentLayout.amber
    case .ai: return AgentLayout.blue
    }
  }

  /// The working wave doesn't follow a microphone — it just needs a meter to read from.
  private static let idleMeter = LevelMeter()

  /// Same arrival as the HUD: the black leads, content comes into focus a beat later.
  static let materialize = AnyTransition.asymmetric(
    insertion: .modifier(active: AgentSoftFocus(amount: 1), identity: AgentSoftFocus(amount: 0))
      .animation(.easeOut(duration: 0.22).delay(0.07)),
    removal: .opacity.animation(.easeIn(duration: 0.08))
  )
}

struct AgentSoftFocus: ViewModifier {
  var amount: CGFloat
  func body(content: Content) -> some View {
    content
      .blur(radius: 5 * amount)
      .scaleEffect(1 - 0.05 * amount, anchor: .top)
      .opacity(Double(1 - amount))
  }
}

// MARK: - The review card

struct AgentCard: View {
  let ticket: AgentTicket
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions

  private var preview: AgentTicket.Preview? { ticket.proposal?.preview }

  var body: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset)
      header
      Group {
        switch preview?.kind {
        case "email": email
        case "event": event
        default: result
        }
      }
      .opacity(state.busy == .revising ? 0.18 : 1)
      .blur(radius: state.busy == .revising ? 2 : 0)
      .overlay { if state.busy == .revising { revisingVeil } }
      Spacer(minLength: 0)
      footer
    }
  }

  // MARK: header

  private var header: some View {
    HStack(spacing: 10) {
      if let image = ArtifactIcon.image(for: preview?.kind) {
        Image(nsImage: image).resizable().interpolation(.high).frame(width: 26, height: 26)
      } else {
        // Happy when it's a finished result; waiting quietly on a draft for your OK.
        AgentCharacter(agent: AgentID(ticket.agent), mood: ticket.proposal == nil && ticket.result != nil ? .done : .idle, size: 28)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(headline)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
        Text(subline)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.white.opacity(0.45))
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      Button(action: actions.collapse) {
        Image(systemName: "chevron.up")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(.white.opacity(0.55))
          .frame(width: 24, height: 24)
          .background(Circle().fill(.white.opacity(0.08)))
      }
      .buttonStyle(.plain)
      .help("Later — keep it in the notch")
    }
    .padding(.horizontal, AgentLayout.pad)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }

  private var headline: String {
    switch preview?.kind {
    case "email": return "Email draft"
    case "event": return "Calendar event"
    default: return ticket.title
    }
  }

  private var subline: String {
    switch preview?.kind {
    case "email": return "Relay wrote this · not sent yet"
    case "event": return "Relay set this up · not on your calendar yet"
    default: return ticket.status == "failed" ? "Couldn't finish" : "Relay finished this"
    }
  }

  // MARK: email

  private var email: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 5) {
        field("To", value: (preview?.to ?? []).joined(separator: ", "), missing: "No recipient — hold fn ⌃ and say who")
        if let cc = preview?.cc, !cc.isEmpty { field("Cc", value: cc.joined(separator: ", ")) }
        field("Subject", value: preview?.subject ?? "", strong: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, AgentLayout.pad)
      .padding(.bottom, 10)
      hairline
      bodyText(preview?.body ?? "")
    }
  }

  @ViewBuilder private func bodyText(_ text: String) -> some View {
    let label = Text(text)
      .font(.system(size: 12.5))
      .lineSpacing(3)
      .foregroundStyle(.white.opacity(0.86))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, AgentLayout.pad)
      .padding(.vertical, 10)
    if state.scrollableBody {
      // No text selection: selecting would make the panel key and pull focus from your app.
      ScrollView(.vertical, showsIndicators: false) { label }
        .frame(height: 172)
    } else {
      label.frame(height: 172, alignment: .top).clipped()
    }
  }

  // MARK: event

  private var event: some View {
    VStack(alignment: .leading, spacing: 7) {
      field("What", value: preview?.title ?? "", strong: true)
      field("When", value: Self.when(preview?.start, preview?.end))
      if let location = preview?.location { field("Where", value: location) }
      if let people = preview?.attendees, !people.isEmpty { field("Invite", value: people.joined(separator: ", ")) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, AgentLayout.pad)
    .padding(.top, 2)
  }

  static func when(_ start: String?, _ end: String?) -> String {
    let iso = ISO8601DateFormatter()
    guard let start, let s = iso.date(from: start) else { return start ?? "" }
    let day = DateFormatter()
    day.setLocalizedDateFormatFromTemplate("EEE MMM d")
    let time = DateFormatter()
    time.timeStyle = .short
    let e = end.flatMap { iso.date(from: $0) }
    return "\(day.string(from: s)) · \(time.string(from: s))" + (e.map { "–\(time.string(from: $0))" } ?? "")
  }

  // MARK: plain result (nothing to approve)

  private var result: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ticket.result?.summary ?? ticket.error ?? "")
        .font(.system(size: 12.5))
        .lineSpacing(2.5)
        .foregroundStyle(.white.opacity(0.88))
        .lineLimit(4)
        .frame(maxWidth: .infinity, alignment: .leading)
      ForEach((ticket.result?.artifacts ?? []).prefix(3), id: \.self) { a in
        field(a.label, value: a.value)
      }
    }
    .padding(.horizontal, AgentLayout.pad)
    .padding(.top, 2)
  }

  // MARK: footer

  private var footer: some View {
    HStack(spacing: 8) {
      if ticket.proposal != nil {
        HStack(spacing: 5) {
          Image(systemName: "mic.fill").font(.system(size: 10))
          Text("hold fn ⌃ to change it").font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(.white.opacity(0.4))
        Spacer(minLength: 0)
        secondary(state.busy == .discarding ? "Discarding…" : "Discard", action: actions.discard)
        primary
      } else {
        Spacer(minLength: 0)
        secondary("Copy") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(ticket.result?.summary ?? "", forType: .string)
        }
        secondary("Done", action: actions.dismiss)
      }
    }
    .padding(.horizontal, AgentLayout.pad - 4)
    .padding(.top, 8)
    .padding(.bottom, 14)
    .allowsHitTesting(state.busy == nil)
  }

  private var canApprove: Bool {
    !(preview?.kind == "email" && (preview?.to ?? []).isEmpty)
  }

  private var primary: some View {
    Button(action: actions.approve) {
      HStack(spacing: 6) {
        if state.busy == .sending { Spinner().frame(width: 11, height: 11) }
        Text(state.busy == .sending ? "Sending…" : ticket.proposal?.verb ?? "OK")
          .font(.system(size: 12.5, weight: .semibold))
        if state.busy != .sending, preview?.kind == "email" {
          Image(systemName: "paperplane.fill").font(.system(size: 10.5, weight: .semibold))
        }
      }
      .foregroundStyle(.black)
      .padding(.horizontal, 14)
      .frame(height: 28)
      .background(Capsule().fill(canApprove ? AgentLayout.blue : AgentLayout.blue.opacity(0.35)))
    }
    .buttonStyle(.plain)
    .disabled(!canApprove)
  }

  private func secondary(_ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 12.5, weight: .medium))
        .foregroundStyle(.white.opacity(state.busy == nil ? 0.75 : 0.35))
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(Capsule().fill(.white.opacity(0.09)))
    }
    .buttonStyle(.plain)
  }

  // MARK: bits

  private func field(_ label: String, value: String, strong: Bool = false, missing: String? = nil) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(label)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.white.opacity(0.4))
        .lineLimit(1)
        .frame(width: 64, alignment: .leading)
      if value.isEmpty, let missing {
        Text(missing).font(.system(size: 12.5, weight: .medium)).foregroundStyle(AgentLayout.amber)
      } else {
        Text(value)
          .font(.system(size: 12.5, weight: strong ? .semibold : .regular))
          .foregroundStyle(.white.opacity(strong ? 0.96 : 0.82))
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
  }

  private var hairline: some View {
    Rectangle().fill(.white.opacity(0.08)).frame(height: 1).padding(.horizontal, AgentLayout.pad)
  }

  private var revisingVeil: some View {
    ZStack {
      HStack(spacing: 8) {
        Spinner(color: .white).frame(width: 12, height: 12)
        Text("Revising…").font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white.opacity(0.85))
      }
    }
  }
}

/// A small spinner drawn in SwiftUI (renders headlessly, unlike ProgressView).
struct Spinner: View {
  var color: Color = .black

  var body: some View {
    TimelineView(.animation) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      Circle()
        .trim(from: 0.12, to: 0.82)
        .stroke(color.opacity(0.75), style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
        .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 0.9) / 0.9 * 360))
    }
  }
}

// MARK: - Setting up a key, right in the notch

/// Two steps and a button: get a key (opens Anthropic's page), paste it, Connect. The key is
/// checked with Anthropic before it's saved, so a typo shows up here — not on your next request.
struct KeySetupCard: View {
  let setup: AgentNotchState.KeySetup
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions
  @FocusState private var fieldFocused: Bool

  private var checking: Bool { state.keyStatus == .checking }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Color.clear.frame(height: state.notchTopInset)
      header
      step(1) {
        Button(action: actions.getKey) {
          HStack(spacing: 5) {
            Text("Get a key").font(.system(size: 12.5, weight: .semibold))
            Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .bold))
          }
          .foregroundStyle(AgentLayout.blue)
        }
        .buttonStyle(.plain)
        Text("on platform.claude.com, then copy it")
          .font(.system(size: 12))
          .foregroundStyle(.white.opacity(0.45))
      }
      step(2) {
        field
        Button(action: actions.pasteKey) {
          Text("Paste")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 11)
            .frame(height: 26)
            .background(Capsule().fill(.white.opacity(0.1)))
        }
        .buttonStyle(.plain)
      }
      Spacer(minLength: 0)
      footer
    }
    .padding(.bottom, 14)
    .onAppear { fieldFocused = true }
    .allowsHitTesting(!checking)
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(systemName: "key.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.black)
        .frame(width: 26, height: 26)
        .background(Circle().fill(AgentLayout.amber))
      VStack(alignment: .leading, spacing: 1) {
        Text("Set up \(setup.name)").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
        Text(setup.ticket == nil ? "Relay's AI runs on your own Anthropic key" : "Then Relay runs what you just asked")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.white.opacity(0.45))
      }
      Spacer(minLength: 0)
      Button(action: actions.dismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(.white.opacity(0.55))
          .frame(width: 24, height: 24)
          .background(Circle().fill(.white.opacity(0.08)))
      }
      .buttonStyle(.plain)
      .help("Not now")
    }
    .padding(.horizontal, AgentLayout.pad)
    .padding(.top, 10)
    .padding(.bottom, 10)
  }

  private func step<Content: View>(_ n: Int, @ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 10) {
      Text("\(n)")
        .font(.system(size: 11, weight: .bold, design: .rounded))
        .foregroundStyle(.white.opacity(0.7))
        .frame(width: 18, height: 18)
        .background(Circle().stroke(.white.opacity(0.25), lineWidth: 1))
      content()
    }
    .padding(.horizontal, AgentLayout.pad)
    .padding(.vertical, 5)
  }

  @ViewBuilder private var field: some View {
    Group {
      if state.scrollableBody {
        // The real field: masked, so the key is never shown on screen as you paste it.
        SecureField("", text: $state.keyText, prompt: Text("\(setup.prefix)…").foregroundColor(.white.opacity(0.3)))
          .textFieldStyle(.plain)
          .font(.system(size: 12.5, design: .monospaced))
          .foregroundStyle(.white)
          .focused($fieldFocused)
          .onSubmit(actions.submitKey)
      } else {
        // AppKit text fields can't draw in the headless renderer (ImageRenderer), so dev shots
        // paint a representative masked value instead.
        Text(state.keyText.isEmpty ? "\(setup.prefix)…" : String(repeating: "•", count: min(state.keyText.count, 28)))
          .font(.system(size: 12.5, design: .monospaced))
          .foregroundStyle(state.keyText.isEmpty ? .white.opacity(0.3) : .white.opacity(0.85))
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
      .padding(.horizontal, 10)
      .frame(height: 28)
      .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.08)))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(borderColor, lineWidth: 1))
  }

  private var borderColor: Color {
    if case .error = state.keyStatus { return AgentLayout.amber.opacity(0.8) }
    return looksRight ? AgentLayout.green.opacity(0.6) : .white.opacity(0.06)
  }

  private var looksRight: Bool {
    let k = state.keyText.trimmingCharacters(in: .whitespacesAndNewlines)
    return k.hasPrefix(setup.prefix) && k.count >= 24
  }

  private var footer: some View {
    HStack(spacing: 8) {
      status
      Spacer(minLength: 0)
      Button(action: actions.submitKey) {
        HStack(spacing: 6) {
          if checking { Spinner().frame(width: 11, height: 11) }
          Text(checking ? "Checking…" : "Connect").font(.system(size: 12.5, weight: .semibold))
        }
        .foregroundStyle(.black)
        .padding(.horizontal, 14)
        .frame(height: 28)
        .background(Capsule().fill(state.keyText.isEmpty ? AgentLayout.blue.opacity(0.35) : AgentLayout.blue))
      }
      .buttonStyle(.plain)
      .disabled(state.keyText.isEmpty)
    }
    .padding(.horizontal, AgentLayout.pad - 4)
  }

  @ViewBuilder private var status: some View {
    switch state.keyStatus {
    case let .error(why):
      Label(why, systemImage: "exclamationmark.triangle.fill")
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(AgentLayout.amber)
        .lineLimit(2)
    case .checking:
      Text("Checking it with Anthropic…").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
    default:
      Label("Saved only in your Mac's Keychain", systemImage: "lock.fill")
        .font(.system(size: 11.5))
        .foregroundStyle(.white.opacity(0.4))
    }
  }
}
