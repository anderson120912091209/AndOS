import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem?
  private var keysItem: NSMenuItem?
  private var engineItem: NSMenuItem?
  /// Speech Engine ▸ Whisper / SenseVoice — shown once this Mac has more than one to choose from
  private var engineChoicesItem: NSMenuItem?
  private var engineChoices: NSMenu?
  private var pasteItem: NSMenuItem?
  private var panel: NSPanel?
  private let state = AppState()
  private let speech = SpeechService()
  private let modifiers = ModifierWatcher()
  /// Mic start/stop run here, off the main thread, so the notch keeps animating while the
  /// audio hardware spins up (~70 ms). Serial, so a stop always runs after its start.
  private let audioQueue = DispatchQueue(label: "relay.audio", qos: .userInteractive)
  private var listening = false
  private var hideWork: DispatchWorkItem?
  /// Where the words will land (app, page host, field label), read off the main thread while
  /// Whisper transcribes; `targetRead` lets submit wait for it, which it almost never has to.
  private var target: TypingTarget?
  /// AI mode only: what "this" is — page address, window title, your selection (AgentPointer).
  private var pointer: AgentPointer?
  private let targetRead = DispatchGroup()
  /// Agent tasks that come back to the notch for your OK (Agent/AgentNotchController.swift).
  private lazy var agent = AgentNotchController(hud: state)

  func applicationDidFinishLaunching(_ notification: Notification) {
    setupStatusItem()
    setupPanel()
    if !Edition.dictationOnly { agent.start() } // the dictation edition has no tasks to follow

    let meter = state.meter
    speech.onLevel = { level in meter.push(level) }
    // Apple Speech only stands in when this Mac's speech model is missing. Setup downloads the
    // model instead, so a new Mac never sees this prompt before the welcome screen.
    if !SpeechEngine.setupDefault.available, !SpeechEngine.chosen.available, OnboardingController.isComplete {
      SpeechService.requestAuthorization { _ in }
    }

    // Load the speech engine now so the first dictation is instant: the one you chose in the menu,
    // or Whisper (~0.6 GB, about a second) if that one isn't on this Mac or won't load.
    let chosen = SpeechEngine.chosen.available ? SpeechEngine.chosen : SpeechEngine.setupDefault
    chosen.engine.preload { [weak self] ok in
      guard let self else { return }
      if !ok, chosen != .whisper { WhisperEngine.shared.preload { [weak self] _ in self?.refreshEngineItem() } }
      self.refreshEngineItem()
      Log.app.notice("speech engine: \(self.speech.engineName, privacy: .public) (\(chosen.name, privacy: .public) \(ok ? "loaded" : "missing — run scripts/fetch-model.sh or fetch-sensevoice.sh", privacy: .public))")
    }

    // Hold Fn to dictate (any language) · add Control to hand it to the AI. The dictation edition
    // has no AI half, so there Control changes nothing and a held Fn always dictates.
    let held: (DictationMode) -> DictationMode = { Edition.dictationOnly ? DictationMode() : $0 }
    modifiers.onArm = { [weak self] in self?.arm() }
    modifiers.onDisarm = { [weak self] in self?.disarm() }
    modifiers.onStart = { [weak self] mode in self?.startListening(mode: held(mode)) }
    modifiers.onModeChange = { [weak self] mode in
      withAnimation(Motion.morph) { self?.state.scribe = held(mode).scribe }
    }
    modifiers.onStop = { [weak self] mode in self?.stopListening(mode: held(mode)) }
    modifiers.start()

    // The words land wherever you are when they're ready — keep the HUD's app icon in step.
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] note in
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      MainActor.assumeIsolated { self?.followFocus(to: app) }
    }

    // So "Fn does nothing" / "nothing pasted" is diagnosable — see Log.swift.
    Log.app.notice("launched — accessibility trusted: \(Inserter.isTrusted ? "yes" : "NO", privacy: .public)")
    Inserter.watchTrust { [weak self] trusted in self?.trustChanged(trusted) }
    refreshPasteItem()

    OnboardingController.shared.onFinish = { [weak self] in self?.showReady() }
    if !Edition.dictationOnly { // Connections are for the AI; setup's "Connect Your Tools" stays hidden without them
      OnboardingController.shared.onConnectTools = { ConnectionsController.shared.show() }
      ConnectionsController.shared.openSetup = { OnboardingController.shared.show() }
      ConnectionsController.shared.model.onConnected = { [weak self] id, name in
        // Connected because a request was waiting on it? Then it's already running again.
        let resuming = ConnectionsController.shared.runAfterConnect.contains(id)
        let text = resuming ? "\(name) connected — running your request" : "\(name) connected — try it with Fn + Control"
        self?.present(.message(.init(symbol: "checkmark.circle.fill", text: text, tone: .good)), hideAfter: resuming ? 2 : 3)
      }
    }
    if OnboardingController.shared.showIfNeeded() {
      // Setup asks for each permission on its own screen, right where it's explained.
    } else if Inserter.isTrusted {
      showReady()
    } else {
      Inserter.promptForTrust()
      showPermissionHint()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    modifiers.stop()
    WhisperEngine.shared.unload() // free GPU buffers before ggml's exit-time teardown
    // ggml keeps a *static* Metal-device registry whose C++ destructor aborts at normal exit()
    // (ggml_metal_rsets_free → ggml_abort) — that's the "Relay quit unexpectedly" on every quit.
    // We've released everything we own above, so hard-exit before C++ static teardown runs.
    _exit(0)
  }

  // Double-clicking Relay.app while it's already running lands here, not in
  // applicationDidFinishLaunching — without this, a second open looks like nothing happened.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    // The menu-bar icon can hide behind the notch, so opening Relay again is the way in: setup
    // if something's missing (a permission went stale), otherwise your connections.
    if !listening, !OnboardingController.shared.showIfNeeded() {
      if Edition.dictationOnly { showReady() } else { ConnectionsController.shared.show() }
    }
    return false
  }

  private func showReady() {
    present(.message(.init(symbol: "mic", text: Edition.readyHint)), hideAfter: 4)
  }

  private func showPermissionHint() {
    present(.message(.init(symbol: "hand.raised", text: "Turn on Relay in Accessibility so it can paste", tone: .warn)), hideAfter: 6)
  }

  private func trustChanged(_ trusted: Bool) {
    Log.app.notice("accessibility trusted: \(trusted ? "yes" : "NO", privacy: .public)")
    refreshPasteItem()
    guard trusted, !listening else { return }
    present(.message(.init(symbol: "checkmark.circle.fill", text: "Auto-paste is on", tone: .good)), hideAfter: 2.2)
  }

  // MARK: - Menu bar

  private func setupStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Relay")

    let menu = NSMenu()
    keysItem = menu.addItem(withTitle: Self.keysTitle, action: nil, keyEquivalent: "")
    engineItem = menu.addItem(withTitle: "Speech: loading…", action: nil, keyEquivalent: "")
    let choices = NSMenu()
    choices.autoenablesItems = false // an engine that isn't on this Mac stays greyed out
    for engine in SpeechEngine.allCases {
      let item = choices.addItem(withTitle: engine.menuTitle, action: #selector(chooseEngine(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = engine.rawValue
    }
    engineChoices = choices
    engineChoicesItem = menu.addItem(withTitle: "Speech Engine", action: nil, keyEquivalent: "")
    engineChoicesItem?.submenu = choices
    engineChoicesItem?.isHidden = SpeechEngine.allCases.filter(\.available).count < 2
    pasteItem = menu.addItem(withTitle: "", action: nil, keyEquivalent: "")
    pasteItem?.target = self
    menu.addItem(.separator())
    if !Edition.dictationOnly {
      menu.addItem(withTitle: "Open Command Center", action: #selector(openCommandCenter), keyEquivalent: "o").target = self
      menu.addItem(withTitle: "Connections…", action: #selector(openConnections), keyEquivalent: ",").target = self
      menu.addItem(withTitle: "Relay’s Computer…", action: #selector(openBox), keyEquivalent: "").target = self
    }
    menu.addItem(withTitle: "Set Up Relay…", action: #selector(openSetup), keyEquivalent: "").target = self
    menu.addItem(withTitle: "About Relay", action: #selector(about), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Relay", action: #selector(quit), keyEquivalent: "q").target = self
    item.menu = menu
    statusItem = item
  }

  /// The menu's first line: the keys, and what you can speak with the engine in use.
  private static var keysTitle: String {
    let languages = SpeechEngine.chosen.languages
    return Edition.dictationOnly ? "Hold Fn: dictate (\(languages))" : "Hold Fn: dictate (\(languages)) · Fn+Control: AI"
  }

  private func refreshEngineItem() {
    keysItem?.title = Self.keysTitle
    engineItem?.title = "Speech: \(speech.engineName)"
    // A choice of one isn't a choice: someone without SenseVoice's model never sees the menu.
    engineChoicesItem?.isHidden = SpeechEngine.allCases.filter(\.available).count < 2
    for item in engineChoices?.items ?? [] {
      guard let engine = (item.representedObject as? String).flatMap(SpeechEngine.init(rawValue:)) else { continue }
      item.state = engine == SpeechEngine.chosen ? .on : .off
      item.isEnabled = engine.available
      item.title = engine.available ? engine.menuTitle : "\(engine.menuTitle) (not installed)"
    }
  }

  /// Switch engines: load the new one, then free the old one (two models at once is too much for
  /// an 8 GB Mac). Dictation keeps using the old engine until the new one is ready.
  @objc private func chooseEngine(_ sender: NSMenuItem) {
    guard let engine = (sender.representedObject as? String).flatMap(SpeechEngine.init(rawValue:)), engine.available else { return }
    SpeechEngine.chosen = engine
    refreshEngineItem()
    engine.engine.preload { [weak self] ok in
      guard let self else { return }
      if ok, !self.listening {
        for other in SpeechEngine.allCases where other != engine { other.engine.unload() }
      }
      self.refreshEngineItem()
      let text = ok ? "\(engine.name) is on" : "\(engine.name) didn't load — staying on the other engine"
      self.present(.message(.init(symbol: "waveform", text: text, tone: ok ? .good : .warn)), hideAfter: 1.8)
    }
  }

  private func refreshPasteItem() {
    let trusted = Inserter.isTrusted
    pasteItem?.title = trusted ? "Auto-paste: on" : "Turn On Auto-Paste (Accessibility)…"
    pasteItem?.state = trusted ? .on : .off
    pasteItem?.action = trusted ? nil : #selector(enableInsertion)
  }

  @objc private func openCommandCenter() {
    if let url = URL(string: "http://localhost:5173") { NSWorkspace.shared.open(url) }
  }

  @objc private func enableInsertion() {
    OnboardingController.shared.show() // opens on the permissions step, with the Settings guide
  }

  @objc private func openSetup() {
    OnboardingController.shared.show()
  }

  @objc private func openConnections() {
    ConnectionsController.shared.show()
  }

  /// The box's screen, nothing asked of you — watch the agent work, or lend a hand.
  @objc private func openBox() {
    BoxController.shared.showComputer()
  }

  /// The standard About window, with Resources/Credits.html: the engines and their credits.
  @objc private func about() {
    NSApp.activate(ignoringOtherApps: true)
    NSApp.orderFrontStandardAboutPanel(nil)
  }

  @objc private func quit() {
    NSApplication.shared.terminate(nil)
  }

  // MARK: - Notch panel

  private func setupPanel() {
    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: NotchLayout.chinMaxWidth + 40, height: 80),
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
    p.ignoresMouseEvents = true
    let host = NSHostingView(rootView: NotchHUDView(state: state))
    host.sizingOptions = [] // we place the panel; SwiftUI mustn't resize it
    p.contentView = host
    panel = p
  }

  /// Place the panel at the top-center of the active screen — only as big as the largest
  /// shape, flush with the top edge — and publish that screen's notch so the HUD fits it.
  private func positionPanel() {
    guard let panel, let screen = NSScreen.main else { return }
    let m = NotchMetrics(screen)
    state.notchWidth = m.notchWidth
    state.notchTopInset = m.topInset
    state.hasNotch = m.hasNotch

    let w = NotchLayout.chinMaxWidth + 40
    let h = m.topInset + NotchLayout.chinRow + 16 // a little room for the spring
    let frame = NSRect(x: screen.frame.midX - w / 2, y: screen.frame.maxY - h, width: w, height: h)
    if panel.frame != frame { panel.setFrame(frame, display: false) }
  }

  /// Show `phase`: grow out of the notch if hidden, otherwise morph in place.
  private func present(_ phase: AppState.Phase, hideAfter: TimeInterval? = nil, motion: Animation = Motion.open) {
    hideWork?.cancel()
    hideWork = nil
    if state.open {
      withAnimation(Motion.morph) { state.phase = phase }
    } else {
      positionPanel()
      // First frame: the closed shape, tucked inside the notch…
      var still = Transaction()
      still.disablesAnimations = true
      withTransaction(still) { state.phase = phase }
      panel?.orderFrontRegardless()
      // …then grow out of it on the next one.
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.state.open, self.state.phase == phase else { return }
        withAnimation(motion) { self.state.open = true }
      }
    }
    if let hideAfter { hide(after: hideAfter) }
  }

  private func hide(after seconds: TimeInterval) {
    hideWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      withAnimation(Motion.close) { self.state.open = false }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        guard !self.state.open else { return } // reopened meanwhile
        self.state.phase = .idle
        self.panel?.orderOut(nil)
      }
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  // MARK: - Dictation / scribe flow

  /// Fn just went down: twitch the notch so the press feels instant, before we know it's a hold.
  private func arm() {
    guard !listening, state.phase != .thinking else { return }
    present(.armed, motion: Motion.arm)
  }

  /// It was a quick tap — macOS's, not ours. Settle back without a sound.
  private func disarm() {
    guard state.phase == .armed else { return }
    hide(after: 0)
  }

  private func startListening(mode: DictationMode) {
    guard !listening else { return }
    listening = true
    state.scribe = mode.scribe
    followFocus(to: NSWorkspace.shared.frontmostApplication)
    state.meter.reset()
    present(.listening)

    let speech = self.speech
    let began = Date()
    audioQueue.async { [weak self] in
      do {
        try speech.start()
        Log.app.debug("mic live in \(Int(Date().timeIntervalSince(began) * 1000)) ms (off the main thread)")
      } catch {
        Task { @MainActor in self?.micFailed() }
      }
    }
  }

  private func stopListening(mode: DictationMode) {
    guard listening else { return }
    listening = false
    withAnimation(Motion.morph) { state.phase = .thinking }

    let speech = self.speech
    let finished: @Sendable (String) -> Void = { [weak self] text in
      Task { @MainActor in
        self?.refreshEngineItem() // how long that one took
        self?.submit(text, scribe: mode.scribe)
      }
    }
    audioQueue.async { speech.stop(finished) }

    // Meanwhile, note where you're typing, so the text can be laid out for it — and in AI mode,
    // what "this" is, so the agent works on that very thing.
    let read = targetRead
    read.enter()
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let found = TypingTarget.capture()
      let looking = mode.scribe ? AgentPointer.capture() : nil
      Task { @MainActor in
        self?.target = found
        self?.pointer = looking
        read.leave()
      }
    }
  }

  private func micFailed() {
    listening = false
    present(.message(.init(symbol: "mic.slash", text: "Microphone unavailable", tone: .warn)), hideAfter: 2.2)
  }

  /// Keep the HUD's icon on the app the words will land in, even if you switch mid-sentence.
  private func followFocus(to app: NSRunningApplication?) {
    guard let app, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
    switch state.phase {
    case .armed, .listening, .thinking: break
    default: guard listening else { return }
    }
    withAnimation(.easeOut(duration: 0.18)) {
      state.targetApp = app.localizedName ?? ""
      state.appIcon = app.icon
    }
  }

  private func submit(_ text: String, scribe: Bool) {
    let utterance = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !utterance.isEmpty else {
      hide(after: 0.1)
      return
    }
    // A draft is open in the notch: Fn+Control talks to *that* ticket ("make it shorter").
    if scribe, agent.revise(with: utterance) {
      present(.message(.init(symbol: "arrow.triangle.2.circlepath", text: "Revising the draft…", tone: .ai)), hideAfter: 1.6)
      return
    }
    // An answer is open in the notch: Fn+Control carries that conversation on ("times 3?").
    if scribe, agent.followUp(with: utterance) {
      present(.message(.init(symbol: "arrow.turn.down.right", text: "Asking…", tone: .ai)), hideAfter: 1.4)
      return
    }
    targetRead.notify(queue: .main) { [weak self] in
      MainActor.assumeIsolated { self?.send(utterance, scribe: scribe) }
    }
  }

  private func send(_ utterance: String, scribe: Bool) {
    let target = self.target
    // The dictation edition cleans the words up right here and pastes them: nothing it hears
    // leaves this Mac.
    if Edition.dictationOnly {
      paste(LocalScribe.clean(utterance, appName: state.targetApp, target: target?.json))
      return
    }
    // Fn pins dictation (always paste); Fn+Control pins agent (AI does it).
    let forceKind = scribe ? "agent" : "dictation"
    if let target {
      Log.app.notice("typing into \(target.bundleId ?? "?", privacy: .public) · \(target.role ?? "?", privacy: .public) \"\(target.label ?? "", privacy: .private)\" · \(target.host ?? "-", privacy: .private)")
    }
    let pointer = scribe ? self.pointer?.json : nil
    RelayClient.submit(utterance, appName: state.targetApp, forceKind: forceKind, target: target?.json, pointer: pointer) { [weak self] routed in
      guard let self else { return }
      guard let routed else {
        // Server down: still paste dictation so typing never depends on the backend.
        if scribe {
          self.present(.message(.init(symbol: "exclamationmark.triangle", text: "Is the Relay server running?", tone: .warn)), hideAfter: 2.6)
        } else {
          self.paste(utterance)
        }
        return
      }
      if routed.kind == "agent" {
        // Whoever took it says so, with what it understood: "Scout’s on it — “Q3 numbers”"
        // beats repeating your words back.
        let who = AgentID(routed.agent)
        let what = routed.pointerChip ?? routed.title
        let text = who == .relay ? "On it — \(what)" : "\(who.name)’s on it — \(what)"
        self.present(.message(.init(symbol: "sparkles", text: text, tone: .ai, agent: who.rawValue)), hideAfter: 2.4)
        if let id = routed.taskId { self.agent.track(id) }
      } else {
        self.paste(routed.summary)
      }
    }
  }

  /// Paste into whatever has focus now, and say honestly how it went.
  private func paste(_ text: String) {
    Inserter.insert(text) { [weak self] outcome in
      guard let self else { return }
      switch outcome {
      case .pasted:
        self.present(.pasted, hideAfter: 0.6)
      case .copied(.needsAccessibility):
        self.present(.message(.init(symbol: "doc.on.clipboard", text: "Copied — turn on Accessibility to paste for you", tone: .warn)), hideAfter: 3.5)
      case .copied(.nothingAccepted):
        self.present(.message(.init(symbol: "doc.on.clipboard", text: "Copied — press ⌘V to paste")), hideAfter: 2.8)
      }
    }
  }
}

/// SpeechService's start/stop are only ever called on AppDelegate's serial `audioQueue`; that
/// confinement is what makes handing it to that queue safe.
extension SpeechService: @unchecked Sendable {}
