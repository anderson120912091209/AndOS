import AppKit
import ServiceManagement
import SwiftUI

/// First-run setup: four pages, and the live checks behind them. Pages move on by themselves
/// the moment macOS reports a change, so nobody has to click "I did it".
@MainActor
final class Onboarding: ObservableObject {
  enum Step: Int, CaseIterable {
    case welcome, permissions, tryIt, done
  }

  @Published private(set) var step: Step = .welcome
  @Published private(set) var mic: Permission.Status = .notAsked
  @Published private(set) var accessibility = false
  /// We sent you to System Settings and are watching for Relay's Accessibility switch.
  @Published private(set) var awaitingAccessibility = false
  /// Opened again because Relay lost a permission it had (a reinstall, a new build).
  @Published private(set) var returning = false
  @Published private(set) var globeTap: GlobeKey.TapAction = .nothing
  /// The fn key is physically down (the keycap on "try it" presses with it)…
  @Published private(set) var fnDown = false
  /// …and has been held long enough to count — the moment Relay starts listening.
  @Published private(set) var fnHeld = false
  @Published var practiceText = "" {
    didSet {
      guard !practiced, !practiceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
      practiced = true
      stage.pasted()
    }
  }
  @Published private(set) var practiced = false
  @Published private(set) var launchAtLogin = false
  @Published private(set) var loginNeedsApproval = false

  let speech: ModelDownloader
  let stage = StageDirector()

  /// Set by the window: setup is finished, close up.
  var onDone: (() -> Void)?
  /// Set by the window: Accessibility just came on — bring setup back in front of Settings.
  var onComeBack: (() -> Void)?
  /// Set by the window when there's a Connections screen: the last page offers to go there.
  @Published var offersConnect = false
  var onConnect: (() -> Void)?

  private var ticker: Timer?
  private var fnMonitors: [Any] = []
  private var fnHold: DispatchWorkItem?
  private var autoAdvance: DispatchWorkItem?

  init(speech: ModelDownloader? = nil) {
    self.speech = speech ?? .shared
  }

  var permissionsGranted: Bool { mic == .granted && accessibility }

  // MARK: - When setup opens

  private static let completeKey = "relay.setup.complete"
  static var isComplete: Bool { UserDefaults.standard.bool(forKey: completeKey) }
  static func reset() { UserDefaults.standard.removeObject(forKey: completeKey) }

  /// Setup opens until it's been finished once — and again whenever Relay is missing a
  /// permission it can't work without.
  static var isNeeded: Bool {
    !isComplete || Permission.microphone != .granted || Permission.accessibility != .granted
  }

  /// Start setup: from the top on a first run, at the permissions page if Relay lost one, or
  /// on the last page — a summary — when everything's already fine.
  func begin() {
    practiceText = ""
    practiced = false
    refresh()
    returning = Self.isComplete && !permissionsGranted
    if Self.isComplete { speech.start() }
    if !Self.isComplete {
      go(.welcome)
    } else {
      go(permissionsGranted ? .done : .permissions)
    }
    ticker?.invalidate()
    ticker = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
  }

  /// The window closed: stop every check and animation.
  func end() {
    ticker?.invalidate()
    ticker = nil
    autoAdvance?.cancel()
    autoAdvance = nil
    watchFn(false)
    stage.stop()
    AccessibilityGuide.shared.hide()
    awaitingAccessibility = false
  }

  /// The page's main button.
  func next() {
    switch step {
    case .welcome:
      speech.start() // downloads while you grant permissions
      go(permissionsGranted ? .tryIt : .permissions)
    case .permissions:
      go(returning ? .done : .tryIt)
    case .tryIt:
      go(.done)
    case .done:
      finish()
    }
  }

  private func go(_ next: Step) {
    autoAdvance?.cancel()
    autoAdvance = nil
    withAnimation(.easeInOut(duration: 0.3)) { step = next }
    watchFn(next == .tryIt)
    if next == .done { syncLoginItem(firstRun: !Self.isComplete) }
    stage.play(next, mic: mic == .granted, accessibility: accessibility, practiced: practiced)
  }

  private func finish() {
    applyLoginItem()
    UserDefaults.standard.set(true, forKey: Self.completeKey)
    Log.app.notice("setup: finished")
    onDone?()
  }

  /// "Connect Your Tools": setup counts as done, then straight on to Connections.
  func finishAndConnect() {
    finish()
    onConnect?()
  }

  // MARK: - Permissions

  func allowMicrophone() {
    Permission.requestMicrophone { [weak self] _ in self?.refresh() }
  }

  /// Puts Relay in the Accessibility list (macOS's own prompt says why), opens that page of
  /// System Settings, and floats the guide beside it until the switch is on. "Show Me" lands
  /// here too — the prompt only the first time, so it doesn't nag.
  func turnOnAccessibility() {
    if !awaitingAccessibility { Inserter.promptForTrust() }
    awaitingAccessibility = true
    Permission.open(.accessibility)
    AccessibilityGuide.shared.show()
  }

  func openKeyboardSettings() {
    Permission.open(.keyboard)
  }

  /// Polled while the window is open — cheap checks, and macOS has no callback for most.
  private func refresh() {
    let mic = Permission.microphone
    let ax = Inserter.isTrusted
    let changed = mic != self.mic || ax != accessibility
    if mic != self.mic { self.mic = mic } // publish only real changes, or the page redraws every tick
    if ax != accessibility {
      accessibility = ax
      if ax, awaitingAccessibility { accessibilityCameOn() }
    }
    if step == .tryIt {
      CFPreferencesAppSynchronize("com.apple.HIToolbox" as CFString) // see edits made in Settings
      let tap = GlobeKey.tapAction
      if tap != globeTap { globeTap = tap }
    }
    guard ticker != nil, step == .permissions else { return }
    if changed { stage.play(.permissions, mic: mic == .granted, accessibility: ax, practiced: practiced) }
    if permissionsGranted, autoAdvance == nil { scheduleAdvance() }
  }

  private func accessibilityCameOn() {
    awaitingAccessibility = false
    AccessibilityGuide.shared.succeed { [weak self] in self?.onComeBack?() }
  }

  /// Both on: a moment to see the checkmarks, then on to trying it.
  private func scheduleAdvance() {
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.step == .permissions, self.permissionsGranted else { return }
      self.next()
    }
    autoAdvance = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
  }

  // MARK: - Try it

  /// On the "try it" page the little notch mirrors your fn key. Passive, like ModifierWatcher:
  /// modifier changes only, never the keys you type.
  private func watchFn(_ on: Bool) {
    guard on else {
      fnMonitors.forEach { NSEvent.removeMonitor($0) }
      fnMonitors.removeAll()
      fnHold?.cancel()
      fnHold = nil
      fnDown = false
      fnHeld = false
      return
    }
    guard fnMonitors.isEmpty else { return }
    let changed: (NSEvent) -> Void = { [weak self] event in
      let down = event.modifierFlags.contains(.function)
      MainActor.assumeIsolated { self?.setFn(down) }
    }
    if let global = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: changed) {
      fnMonitors.append(global)
    }
    if let local = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { changed($0); return $0 }) {
      fnMonitors.append(local)
    }
  }

  private func setFn(_ down: Bool) {
    guard down != fnDown else { return }
    fnDown = down
    if down {
      // Same rule as Relay itself: a quick tap is macOS's; only a hold starts listening.
      let hold = DispatchWorkItem { [weak self] in
        guard let self, self.fnDown else { return }
        self.fnHeld = true
        self.stage.fn(true)
      }
      fnHold = hold
      DispatchQueue.main.asyncAfter(deadline: .now() + GlobeKey.holdThreshold, execute: hold)
    } else {
      fnHold?.cancel()
      fnHold = nil
      if fnHeld { stage.fn(false) }
      fnHeld = false
    }
  }

  // MARK: - Open at login

  /// On by default for a real install (in /Applications); off for a development build run
  /// from a project folder, where a login item would point at a moving target.
  private func syncLoginItem(firstRun: Bool) {
    let status = SMAppService.mainApp.status
    loginNeedsApproval = status == .requiresApproval
    if firstRun {
      launchAtLogin = Bundle.main.bundlePath.hasPrefix("/Applications/")
    } else {
      launchAtLogin = status == .enabled || loginNeedsApproval
    }
  }

  /// The switch on the last page. On a first run it's applied when you click Done.
  func setLaunchAtLogin(_ on: Bool) {
    launchAtLogin = on
    if Self.isComplete { applyLoginItem() }
  }

  func approveLoginItem() {
    Permission.open(.loginItems)
  }

  private func applyLoginItem() {
    let service = SMAppService.mainApp
    do {
      if launchAtLogin, service.status != .enabled { try service.register() }
      if !launchAtLogin, service.status == .enabled { try service.unregister() }
    } catch {
      Log.app.error("login item: \(error.localizedDescription, privacy: .public)")
    }
    loginNeedsApproval = service.status == .requiresApproval
    launchAtLogin = service.status == .enabled || loginNeedsApproval
  }

  // MARK: - Dev renders

  /// RELAY_RENDER_SHOTS: one frozen page with made-up state and no live checks.
  static func preview(
    _ step: Step, mic: Bool = true, accessibility: Bool = false, awaiting: Bool = false,
    practice: String = "", globe: GlobeKey.TapAction = .nothing,
    speech: ModelDownloader.State = .ready, returning: Bool = false, connect: Bool = false
  ) -> Onboarding {
    let downloader = ModelDownloader()
    downloader.preview(speech)
    let o = Onboarding(speech: downloader)
    o.step = step
    o.mic = mic ? .granted : .notAsked
    o.accessibility = accessibility
    o.awaitingAccessibility = awaiting
    o.globeTap = globe
    o.returning = returning
    o.offersConnect = connect
    o.stage.freeze(step, mic: mic, accessibility: accessibility, practiced: !practice.isEmpty)
    o.practiceText = practice
    o.launchAtLogin = true
    return o
  }
}
