import AppKit
import Combine
import SwiftUI

/// Agent tasks that come back to the notch.
///
/// You hand a job to the AI (Fn+Control); it goes off and works on a worker somewhere. While it
/// works, a small wave sits beside the notch. When it comes back:
/// - with a draft that needs your OK → "Ready · Email to Alex" drops from the notch; click it
///   and the notch opens into the draft itself, with Send / Discard. Hold Fn+Control while it's
///   open and say what to change — the agent redoes that same draft.
/// - with an answer → its conclusion drops from the notch in one line. If that line is the whole
///   answer, that's all; otherwise click it for the card (a list, a comparison, a receipt, a
///   choice) or the reader (a write-up). Tap a follow-up there — or hold Fn+Control and say
///   one — and the same agent carries on from what it said.
/// Ignore it and it shrinks to a badge on the notch until you get to it.
/// - several at once: beside the notch sit who's working (their characters) and how much waits
///   for you; tap there for the stack — one row per job, what needs you first (AgentStack.swift).
///   Only what needs you, or what came back, ever pops up — progress never does (interrupts).
/// - because something isn't set up (no Claude key yet) → "Claude isn't set up · [Set up]";
///   click it and the notch becomes a small form: get a key, paste it, Connect. Once it's
///   connected, what you asked for runs on its own — you never repeat yourself.
///
/// The card lives in its own panel, separate from the dictation HUD: the HUD stays click-through,
/// and while you're dictating this panel steps aside — dictation always owns the notch.
@MainActor
final class AgentNotchController {
  private let hud: AppState
  let state = AgentNotchState()
  private let stream = TaskStream()
  private var panel: AgentPanel?

  private var tickets: [String: AgentTicket] = [:]
  /// Dispatched from this Mac — their plain results come back here too.
  private var tracked = Set<String>()
  /// Drafts already announced, so a reconnect or a status blip doesn't re-announce them.
  private var announced = Set<String>()
  private var hudOpen = false
  private var timer: DispatchWorkItem?
  private var frameWork: DispatchWorkItem?
  private var subscriptions = Set<AnyCancellable>()
  /// Sign-ins happening elsewhere (Gmail, Fathom), each with the request to run once it's done.
  private var awaiting: [String: AgentTicket] = [:]
  /// Answers you've opened (or read whole on their one line); the rest wait in the glance's count.
  private var seen = Set<String>()

  init(hud: AppState) {
    self.hud = hud
  }

  func start() {
    setupPanel()
    hud.$open
      .removeDuplicates()
      .sink { [weak self] open in self?.hudChanged(open) }
      .store(in: &subscriptions)
    stream.onSnapshot = { [weak self] in self?.snapshot($0) }
    stream.onTicket = { [weak self] in self?.update($0) }
    stream.start()
  }

  /// A task you just dispatched — follow it so its result can come back to the notch.
  func track(_ taskId: String) {
    tracked.insert(taskId)
    settle()
  }

  /// Fn+Control while a draft is in front of you talks to *that* ticket ("make it shorter").
  /// Returns true if it took the words.
  func revise(with utterance: String) -> Bool {
    guard let ticket = focusedDraft, let proposal = ticket.proposal else { return false }
    if case .ready = state.form { show(.card(ticket)) }
    state.busy = .revising
    stream.decide(ticket.id, proposalID: proposal.id, verdict: "revise", feedback: utterance) { [weak self] ok in
      guard let self, !ok else { return }
      self.state.busy = nil
      self.toast(.init(symbol: "exclamationmark.triangle.fill", text: "Couldn't reach Relay to revise — try again", tone: .warn))
    }
    return true
  }

  /// Fn+Control while an answer is in front of you carries on from it ("reply to Sam"). Returns
  /// true if it took the words.
  func followUp(with utterance: String) -> Bool {
    guard let id = focusedID, let t = tickets[id], t.answer != nil else { return false }
    ask(utterance, after: t)
    return true
  }

  // MARK: - Server events

  private func snapshot(_ list: [AgentTicket]) {
    tickets = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
    // Drafts that were already waiting when we connected get a badge, not a fanfare.
    for t in list where t.awaitingYou { announced.insert(t.proposal!.id) }
    if state.form == .stack { refreshStack() }
    settle()
  }

  private func update(_ t: AgentTicket) {
    let before = tickets[t.id]
    tickets[t.id] = t
    if state.form == .stack { refreshStack() } // you're looking at every job: keep it current

    // A draft is ready for you.
    if t.awaitingYou, let p = t.proposal, !announced.contains(p.id) {
      announced.insert(p.id)
      state.busy = nil
      if case let .card(open) = state.form, open.id == t.id {
        show(.card(t)) // revised while you watched: swap the new draft in, in place
      } else if interrupts(t, over: state.form) {
        show(.ready(t))
        later(8) { [weak self] in self?.settle(force: true) }
      } else {
        settle()
      }
      return
    }

    // The agent needs you to sign in on the box.
    if let takeover = t.awaitingTakeover, !announced.contains(takeover.id) {
      announced.insert(takeover.id)
      state.busy = nil
      if interrupts(t, over: state.form) {
        show(.takeover(.init(ticketID: t.id, reason: takeover.reason, service: takeover.service,
                             viewerURL: nil, id: takeover.id, agent: t.agent)))
        later(30) { [weak self] in self?.settle(force: true) }
      } else {
        settle()
      }
      return
    }

    // It finished.
    if t.isFinished, let before, !before.isFinished {
      finished(t)
      return
    }

    if case let .card(open) = state.form, open.id == t.id, !t.awaitingYou, !t.working {
      settle(force: true)
    } else {
      settle()
    }
  }

  private func finished(_ t: AgentTicket) {
    let decided = t.proposal?.decision?.verdict
    let wasFocused = focusedID == t.id
    state.busy = nil
    switch (t.status, decided) {
    case ("done", "approve"):
      // Approved, but with nothing to send from it's only saved in Relay's outbox — a green ✓
      // would say it went out. Short, because the toast is one line.
      if t.result?.artifacts?.contains(where: { $0.label == "Saved in" }) == true {
        toast(.init(symbol: "tray.and.arrow.down.fill", text: "Not sent — saved in Relay’s outbox", tone: .warn), for: 4)
      } else {
        toast(.init(symbol: "checkmark.circle.fill", text: t.result?.summary ?? "Done", tone: .good))
      }
    case ("canceled", "reject"):
      if wasFocused { toast(.init(symbol: "trash", text: "Discarded — nothing was sent")) } else { settle() }
    case ("failed", _) where tracked.contains(t.id) || decided != nil:
      let what = decided == "approve" ? "Couldn't \(t.proposal?.verb.lowercased() ?? "finish")" : "Couldn't finish"
      toast(.init(symbol: "exclamationmark.triangle.fill", text: "\(what) — \(t.error ?? "unknown error")", tone: .warn), for: 4)
    case ("done", nil) where t.needsSetup != nil && (tracked.contains(t.id) || !isCardOpen):
      show(.setup(t)) // "Claude isn't set up yet · [Set up Claude]"
      later(20) { [weak self] in self?.settle(force: true) }
    case ("done", nil) where tracked.contains(t.id) && interrupts(t, over: state.form):
      show(.ready(t)) // a plain result coming back
      later(10) { [weak self] in self?.settle(force: true) }
    default:
      settle()
    }
  }

  // MARK: - What to show when nothing is happening

  /// Waiting on you — drafts to approve, sign-ins only you can do, and questions it came back
  /// with (until you've opened them) — newest first.
  private var waitingOnYou: [AgentTicket] {
    tickets.values.filter { $0.needsYou || ($0.answer?.tone == "needs_you" && isUnread($0)) }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  /// Off working: what you asked for from here, or what you approved being carried out.
  private var workingJobs: [AgentTicket] {
    tickets.values.filter { $0.working && (tracked.contains($0.id) || $0.proposal?.decision != nil) }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  /// Answers to what you asked from here, back while you were elsewhere and not opened yet.
  private var unreadAnswers: [AgentTicket] {
    tickets.values.filter { isUnread($0) && $0.answer?.tone != "needs_you" }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  private func isUnread(_ t: AgentTicket) -> Bool {
    t.status == "done" && t.proposal == nil && t.needsSetup == nil && tracked.contains(t.id) && !seen.contains(t.id)
  }

  /// The stack, top to bottom.
  private func stackRows() -> [AgentTicket] { waitingOnYou + workingJobs + unreadAnswers }

  private var focusedID: String? {
    switch state.form {
    case let .card(t), let .ready(t), let .answer(t), let .reader(t): return t.id
    default: return nil
    }
  }

  private var focusedDraft: AgentTicket? {
    guard let id = focusedID, let t = tickets[id], t.awaitingYou else { return nil }
    return t
  }

  private var isCardOpen: Bool {
    switch state.form {
    case .card, .answer, .reader, .stack: return true
    default: return false
    }
  }

  /// The glance: who's working and what waits for you — never which step anyone is on.
  private func restingForm() -> AgentNotchState.Form {
    let waiting = waitingOnYou, working = workingJobs, back = unreadAnswers
    if waiting.isEmpty, working.isEmpty, back.isEmpty { return .hidden }
    return .glance(.init(
      working: working.map(\.agent), waiting: waiting.count, unread: back.count,
      kind: waiting.first?.proposal?.preview.kind ?? "", lead: (waiting.first ?? back.first)?.agent
    ))
  }

  /// The notch's whole attention policy. `t` just changed — a draft is ready, it needs you to
  /// sign in, or its answer came back — and `current` is what the notch shows right now. It pops
  /// up only over something that matters less: what needs you > what came back > a passing toast.
  /// What you've opened is never covered, and it's one thing at a time — whatever doesn't pop up
  /// waits in the glance's count (and the stack) until you look. Progress never gets here at all.
  private func interrupts(_ t: AgentTicket, over current: AgentNotchState.Form) -> Bool {
    weight(of: t) > weight(of: current)
  }

  /// How much a change deserves the notch: it needs you (2), it came back (1), nothing to say (0).
  private func weight(of t: AgentTicket) -> Int {
    if t.needsYou || t.answer?.tone == "needs_you" { return 2 }
    return t.isFinished ? 1 : 0
  }

  /// How much what's showing is worth keeping: what you opened can't be covered (3), a chin is
  /// worth what it's about, and a toast or the glance makes way.
  private func weight(of form: AgentNotchState.Form) -> Int {
    switch form {
    case .card, .answer, .reader, .stack, .keySetup: return 3
    case .takeover, .setup: return 2
    case let .ready(t): return weight(of: t)
    case .hidden, .glance, .toast: return 0
    }
  }

  /// Return to the resting form — unless something you're looking at is still up (`force` overrides).
  private func settle(force: Bool = false) {
    if !force {
      switch state.form {
      case .card, .ready, .toast, .setup, .keySetup, .takeover, .answer, .reader, .stack: return
      default: break
      }
    }
    timer?.cancel()
    show(restingForm())
  }

  private func toast(_ t: AgentNotchState.Toast, for seconds: Double = 2.4) {
    show(.toast(t))
    later(seconds) { [weak self] in self?.settle(force: true) }
  }

  private func later(_ seconds: Double, _ work: @escaping @MainActor () -> Void) {
    timer?.cancel()
    let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
    timer = item
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
  }

  // MARK: - Buttons

  private var actions: AgentActions {
    AgentActions(
      open: { [weak self] in self?.openCard() },
      collapse: { [weak self] in self?.settle(force: true) },
      approve: { [weak self] in self?.answer("approve") },
      discard: { [weak self] in self?.answer("reject") },
      dismiss: { [weak self] in self?.settle(force: true) },
      takeOver: { [weak self] in self?.beginTakeover() },
      getKey: { [weak self] in self?.getKey() },
      pasteKey: { [weak self] in self?.pasteKey() },
      submitKey: { [weak self] in self?.submitKey() },
      followUp: { [weak self] in self?.followUp($0) },
      copyAnswer: { [weak self] in self?.copyAnswer() },
      openInApp: { [weak self] in self?.openInApp() },
      openTicket: { [weak self] in self?.openTicket($0) },
      showAll: { [weak self] in self?.showAll() }
    )
  }

  private func openCard() {
    timer?.cancel()
    switch state.form {
    case let .setup(t): startSetup(t)
    case let .ready(t):
      let t = tickets[t.id] ?? t
      if t.answer == nil {
        show(.card(t))
      } else {
        show(t.placement == "reader" ? .reader(t) : .answer(t))
      }
    case .glance:
      // One thing there, and it's for you? Straight into it. Otherwise, the stack.
      let rows = stackRows()
      if rows.count == 1, let only = rows.first, !only.working { openTicket(only.id) } else if !rows.isEmpty { showStack() }
    default: break
    }
  }

  private func answer(_ verdict: String) {
    guard case let .card(t) = state.form, let proposal = (tickets[t.id] ?? t).proposal else { return }
    state.busy = verdict == "approve" ? .sending : .discarding
    stream.decide(t.id, proposalID: proposal.id, verdict: verdict) { [weak self] ok in
      guard let self else { return }
      if !ok {
        self.state.busy = nil
        self.toast(.init(symbol: "exclamationmark.triangle.fill", text: "That draft changed or Relay is unreachable — try again", tone: .warn), for: 3)
      }
      // Success is confirmed by the worker: finished(_:) shows "Sent…" / "Discarded".
    }
  }

  // MARK: - Answers

  /// A follow-up button or an option you tapped, on the answer in front of you.
  private func followUp(_ utterance: String) {
    guard let id = focusedID, let t = tickets[id] else { return }
    ask(utterance, after: t)
  }

  /// Ask the same agent, carrying on from its answer: the card steps aside for the working wave,
  /// and the new answer comes back to the notch like any other.
  private func ask(_ utterance: String, after t: AgentTicket) {
    settle(force: true)
    Task {
      guard let id = await stream.dispatch(utterance, context: t.context, followUpOf: t.id) else {
        toast(.init(symbol: "exclamationmark.triangle.fill", text: "Couldn't reach Relay — ask again", tone: .warn), for: 3)
        return
      }
      track(id)
    }
  }

  /// The reader's Copy: the write-up as Markdown, or the answer as plain text.
  private func copyAnswer() {
    guard let id = focusedID, let t = tickets[id] else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(t.answer?.block?.markdown ?? t.result?.summary ?? "", forType: .string)
    state.copied = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in self?.state.copied = false }
  }

  /// Keep a write-up: save it as a Markdown file and open it in whatever app opens those. It goes
  /// in Relay's own folder, which needs no permission prompt (Documents would ask).
  private func openInApp() {
    guard let id = focusedID, let t = tickets[id], let a = t.answer else { return }
    let title = a.block?.title ?? a.headline
    var markdown = a.block?.markdown ?? t.result?.summary ?? a.headline
    if !markdown.hasPrefix("#") { markdown = "# \(title)\n\n\(markdown)" }
    let name = title.components(separatedBy: CharacterSet(charactersIn: "/\\:?%*|\"<>\n")).joined(separator: " ")
    do {
      let dir = try FileManager.default
        .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("Relay/Docs", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let file = dir.appendingPathComponent("\(name.prefix(80)).md")
      try (markdown + "\n").write(to: file, atomically: true, encoding: .utf8)
      NSWorkspace.shared.open(file)
      settle(force: true)
    } catch {
      toast(.init(symbol: "exclamationmark.triangle.fill", text: "Couldn't save it — \(error.localizedDescription)", tone: .warn), for: 3)
    }
  }

  // MARK: - The stack

  private func showStack() {
    state.stackRows = stackRows()
    show(.stack)
  }

  /// Keep the open stack current — rows come and go as jobs move; it closes once it's empty.
  private func refreshStack() {
    let rows = stackRows()
    guard !rows.isEmpty else { return settle(force: true) }
    guard rows.map(\.id) != state.stackRows.map(\.id) else {
      state.stackRows = rows // the same jobs, newer steps: update in place
      return
    }
    let before = state.size(of: .stack)
    withAnimation(Motion.morph) { state.stackRows = rows }
    resize(from: before, to: .stack)
  }

  /// The form stayed but grew or shrank (the stack's rows): big enough while it animates,
  /// trimmed after — as show(_:) does between forms.
  private func resize(from before: CGSize, to form: AgentNotchState.Form) {
    guard let panel, let screen = NSScreen.main else { return }
    let after = state.size(of: form)
    place(panel, on: screen, size: CGSize(width: max(before.width, after.width), height: max(before.height, after.height)))
    frameWork?.cancel()
    let trim = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let panel = self.panel, self.state.form == form, let screen = NSScreen.main else { return }
        self.place(panel, on: screen, size: self.state.size(of: form))
      }
    }
    frameWork = trim
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: trim)
  }

  /// One row of the stack: straight into what it is — its draft, its sign-in, its answer — or,
  /// while it's still working, Relay's computer, to watch it.
  private func openTicket(_ id: String) {
    guard let t = tickets[id] else { return }
    timer?.cancel()
    if t.awaitingYou {
      show(.card(t))
    } else if let k = t.awaitingTakeover {
      settle(force: true)
      BoxController.shared.show(BoxTakeover(id: k.id, reason: k.reason, service: k.service, viewerURL: nil))
    } else if t.answer != nil {
      show(t.placement == "reader" ? .reader(t) : .answer(t))
    } else if t.working {
      settle(force: true)
      BoxController.shared.show(.look)
    } else {
      show(.card(t)) // a plain result
    }
  }

  /// Everything, history and every step: the Command Center, which Relay's server serves.
  private func showAll() {
    settle(force: true)
    NSWorkspace.shared.open(RelayClient.base)
  }

  // MARK: - Setting things up

  /// Open the Claude key card directly — e.g. from a menu item. No request waiting on it.
  func setUpClaude() {
    beginKeySetup(.claude(for: nil))
  }

  private func startSetup(_ t: AgentTicket) {
    guard let setup = t.needsSetup else { return }
    if setup.connection == "claude" {
      beginKeySetup(.claude(for: t))
    } else {
      // Gmail, Fathom: a real sign-in, in the Connections sheet. Watch for it to finish.
      ConnectionsController.shared.runAfterConnect.insert(setup.connection)
      ConnectionsController.shared.show(connecting: setup.connection)
      awaiting[setup.connection] = t
      watch(setup.connection)
      settle(force: true)
    }
  }

  private func beginKeySetup(_ k: AgentNotchState.KeySetup) {
    state.keyText = ""
    state.keyStatus = .idle
    show(.keySetup(k))
    panel?.makeKey() // so you can type or ⌘V straight away — without taking focus from your app's menu bar
  }

  /// Open the box's screen in its own window so you can do the sign-in yourself. When you finish,
  /// the server re-queues the task (box.takeovers.onFinished) and the agent carries on — the notch
  /// just follows the task stream from here.
  private func beginTakeover() {
    guard case let .takeover(k) = state.form else { return }
    settle(force: true) // the Box window takes over; tuck the notch chin away
    BoxController.shared.show(
      BoxTakeover(id: k.id, reason: k.reason, service: k.service, viewerURL: k.viewerURL)
    )
  }

  private func getKey() {
    guard case let .keySetup(k) = state.form else { return }
    NSWorkspace.shared.open(k.getKeyURL)
  }

  /// "Paste": read the clipboard (you asked to), and if it's a key, connect straight away.
  private func pasteKey() {
    guard case let .keySetup(k) = state.form else { return }
    let text = (NSPasteboard.general.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      state.keyStatus = .error("The clipboard is empty — copy the key on Anthropic's page first.")
      return
    }
    state.keyText = text
    if text.hasPrefix(k.prefix) { submitKey() }
  }

  private func submitKey() {
    guard case let .keySetup(k) = state.form, state.keyStatus != .checking else { return }
    let key = state.keyText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard key.hasPrefix(k.prefix), key.count >= 24, !key.contains(where: \.isWhitespace) else {
      state.keyStatus = .error("That's not a Claude key — they start with \(k.prefix)")
      return
    }
    state.keyStatus = .checking
    Task {
      if await KeyCheck.claude(key) == .rejected {
        state.keyStatus = .error("Anthropic didn't accept that key — copy it again, all of it.")
        return
      }
      switch await stream.saveKey(key, for: k.connection) {
      case .saved:
        state.keyStatus = .connected
        state.keyText = ""
        Log.app.notice("connected \(k.connection, privacy: .public) from the notch")
        if let t = k.ticket {
          toast(.init(symbol: "checkmark.circle.fill", text: "\(k.name) is set up — running your request", tone: .good))
          rerun(t)
        } else {
          toast(.init(symbol: "checkmark.circle.fill", text: "\(k.name) is set up — try it with Fn + Control", tone: .good), for: 3)
        }
      case let .rejected(why):
        state.keyStatus = .error(why)
      }
    }
  }

  /// Run the request you made before setting things up — as if you'd just asked again.
  private func rerun(_ t: AgentTicket) {
    Task {
      guard let id = await stream.dispatch(t.utterance, context: t.context) else {
        toast(.init(symbol: "exclamationmark.triangle.fill", text: "Couldn't reach Relay to run it — ask again", tone: .warn), for: 3)
        return
      }
      track(id)
    }
  }

  /// A sign-in in the Connections sheet: notice when it lands, then run the waiting request.
  private func watch(_ connection: String, deadline: Date = Date().addingTimeInterval(600)) {
    Task {
      while Date() < deadline, awaiting[connection] != nil {
        if await stream.isConnected(connection) {
          guard let t = awaiting.removeValue(forKey: connection) else { return }
          rerun(t)
          // let the HUD's "connected — running your request" line read the flag first
          try? await Task.sleep(nanoseconds: 3_000_000_000)
          ConnectionsController.shared.runAfterConnect.remove(connection)
          return
        }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
      }
      awaiting.removeValue(forKey: connection)
      ConnectionsController.shared.runAfterConnect.remove(connection)
    }
  }

  // MARK: - Panel

  private func setupPanel() {
    let p = AgentPanel(
      contentRect: NSRect(x: 0, y: 0, width: AgentLayout.cardWidth, height: 80),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    p.isFloatingPanel = true
    p.level = .screenSaver // above the menu bar, so it can grow out of the notch
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    p.backgroundColor = .clear
    p.isOpaque = false
    p.hasShadow = false
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    p.ignoresMouseEvents = true
    p.onEscape = { [weak self] in
      if case .keySetup = self?.state.form { self?.settle(force: true) }
    }
    let host = ClickThroughHostingView(rootView: AgentNotchView(state: state, actions: actions))
    host.sizingOptions = [] // we place the panel; SwiftUI mustn't resize it
    p.contentView = host
    panel = p
  }

  private func show(_ form: AgentNotchState.Form) {
    guard let panel, let screen = NSScreen.main else { return }
    switch form { // opening an answer reads it; a one-line answer is read on its line
    case let .answer(t), let .reader(t), let .card(t): seen.insert(t.id)
    case let .ready(t) where t.answer != nil && t.placement == "chin": seen.insert(t.id)
    default: break
    }
    let wasOpen = state.open
    let from = wasOpen ? state.form : .hidden
    if form == from, wasOpen == (form != .hidden) { return }

    let metrics = NotchMetrics(screen)
    state.notchWidth = metrics.notchWidth
    state.notchTopInset = metrics.topInset
    state.hasNotch = metrics.hasNotch
    state.screenHeight = screen.frame.height

    // Big enough for both shapes while it morphs; trimmed to the final shape afterwards, so
    // empty corners of the panel never sit over the menu bar catching clicks.
    if case .keySetup = from, panel.isKeyWindow {
      if case .keySetup = form {} else { panel.giveBackFocus() }
    }

    let a = state.size(of: from)
    let b = state.size(of: form)
    place(panel, on: screen, size: CGSize(width: max(a.width, b.width), height: max(a.height, b.height)))
    panel.ignoresMouseEvents = !interactive(form) || hudOpen

    if form == .hidden {
      withAnimation(Motion.close) { state.open = false }
      later(0.3) { [weak self] in
        guard let self, !self.state.open else { return }
        self.state.form = .hidden
        self.panel?.orderOut(nil)
      }
      return
    }
    if !wasOpen {
      var still = Transaction()
      still.disablesAnimations = true
      withTransaction(still) { state.form = form }
      panel.orderFrontRegardless()
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.state.open, self.state.form == form else { return }
        withAnimation(Motion.open) { self.state.open = true }
      }
    } else {
      withAnimation(Motion.morph) { state.form = form }
    }

    frameWork?.cancel()
    let trim = DispatchWorkItem { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let panel = self.panel, self.state.form == form, let screen = NSScreen.main else { return }
        self.place(panel, on: screen, size: self.state.size(of: form))
      }
    }
    frameWork = trim
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: trim)
  }

  private func place(_ panel: NSPanel, on screen: NSScreen, size: CGSize) {
    let w = ceil(size.width) + 2
    let h = ceil(size.height) + 2
    let frame = NSRect(x: screen.frame.midX - w / 2, y: screen.frame.maxY - h, width: w, height: h)
    if panel.frame != frame { panel.setFrame(frame, display: false) }
  }

  private func interactive(_ form: AgentNotchState.Form) -> Bool {
    switch form {
    case .hidden: return false
    default: return true // the glance too: tap it for the stack
    }
  }

  /// Dictation owns the notch: step aside the moment the HUD opens, come back after it closes.
  private func hudChanged(_ open: Bool) {
    hudOpen = open
    guard let panel else { return }
    if open {
      panel.alphaValue = 0
      panel.ignoresMouseEvents = true
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) { [weak self] in
        guard let self, !self.hudOpen, let panel = self.panel else { return }
        panel.ignoresMouseEvents = !self.interactive(self.state.form)
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = 0.18
          panel.animator().alphaValue = 1
        }
      }
    }
  }
}

/// Lets the first click on a button land even though the panel never becomes key — so the
/// card works without stealing focus from the app you're in.
/// The agent's panel. It can take the keyboard (for the key card) without activating Relay, so
/// the app you were in stays in front; ⌘V/⌘C/⌘A work in its fields even though Relay has no
/// Edit menu; Esc closes the key card.
final class AgentPanel: NSPanel {
  var onEscape: (() -> Void)?

  override var canBecomeKey: Bool { true }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
    guard flags == .command, let key = event.charactersIgnoringModifiers?.lowercased() else {
      return super.performKeyEquivalent(with: event)
    }
    let action: Selector?
    switch key {
    case "v": action = #selector(NSText.paste(_:))
    case "c": action = #selector(NSText.copy(_:))
    case "x": action = #selector(NSText.cut(_:))
    case "a": action = #selector(NSText.selectAll(_:))
    default: action = nil
    }
    if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
    return super.performKeyEquivalent(with: event)
  }

  override func cancelOperation(_ sender: Any?) {
    onEscape?()
  }

  /// Hand the keyboard back to whatever had it before the key card took it.
  func giveBackFocus() {
    orderOut(nil)
    orderFrontRegardless()
  }
}

final class ClickThroughHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
