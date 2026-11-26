import AppKit

/// What the held modifiers mean for one utterance.
struct DictationMode: Equatable {
  /// Fn+Control — hand the request to the AI ("scribe") instead of pasting it.
  var scribe = false
}

/// Push-to-talk via the Fn (Globe) key, watched globally.
///
/// Hold **Fn** to dictate (any language — Whisper detects it), add **Control** for the AI.
/// We observe only modifier-flag changes (`.flagsChanged`) — never the keys you type. That
/// works even before Accessibility is granted (only *pasting* needs it). Electron/Carbon
/// hotkey APIs can't bind Fn at all, which is why this is a native monitor.
///
/// A press only becomes a hold after `GlobeKey.holdThreshold`, so a quick tap stays macOS's
/// (switching ABC ⇄ 注音, the emoji picker…) and never wakes the microphone. `onArm` fires on
/// the raw press so the HUD can react instantly; `onDisarm` if it turned out to be a tap.
///
/// Control *latches on* for the rest of the hold: once it's been down while Fn is held, the
/// utterance stays an AI request even if Control is released a moment before Fn — so
/// key-release order can never turn an AI request into a paste.
@MainActor
final class ModifierWatcher {
  var onArm: (() -> Void)?
  var onDisarm: (() -> Void)?
  var onStart: ((DictationMode) -> Void)?
  var onModeChange: ((DictationMode) -> Void)?
  var onStop: ((DictationMode) -> Void)?

  private var globalMonitor: Any?
  private var localMonitor: Any?
  private var fnDown = false
  /// The press has lasted long enough to count — we're listening.
  private var holding = false
  private var mode = DictationMode()
  private var pendingHold: DispatchWorkItem?
  private var watchdog: Timer?

  func start() {
    globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.handle(event)
    }
    // Local monitor covers the rare case our own (accessory) UI is key.
    localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.handle(event)
      return event
    }
  }

  private func handle(_ event: NSEvent) {
    let flags = event.modifierFlags
    let fn = flags.contains(.function)
    let ctrl = flags.contains(.control)

    if fn && !fnDown {
      fnDown = true
      mode = DictationMode(scribe: ctrl)
      pressBegan()
    } else if !fn && fnDown {
      pressEnded()
    } else if fn && fnDown && ctrl && !mode.scribe {
      mode.scribe = true // latch on
      if holding { onModeChange?(mode) }
    }
  }

  private func pressBegan() {
    startWatchdog()
    let threshold = GlobeKey.holdThreshold
    guard threshold > 0 else {
      becomeHold()
      return
    }
    onArm?()
    let work = DispatchWorkItem { [weak self] in self?.becomeHold() }
    pendingHold = work
    DispatchQueue.main.asyncAfter(deadline: .now() + threshold, execute: work)
  }

  private func becomeHold() {
    guard fnDown, !holding else { return }
    holding = true
    onStart?(mode)
  }

  private func pressEnded() {
    fnDown = false
    pendingHold?.cancel()
    pendingHold = nil
    watchdog?.invalidate()
    watchdog = nil
    if holding {
      holding = false
      onStop?(mode)
    } else {
      onDisarm?()
    }
  }

  /// If a key-up ever goes missing, don't leave the microphone running: check the real Fn
  /// state every quarter second. Only trusted if it reported Fn as down when the press began.
  private func startWatchdog() {
    watchdog?.invalidate()
    watchdog = nil
    guard CGEventSource.flagsState(.hidSystemState).contains(.maskSecondaryFn) else { return }
    watchdog = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.fnDown, !CGEventSource.flagsState(.hidSystemState).contains(.maskSecondaryFn) else { return }
        Log.app.notice("fn: release event missed — stopping from the watchdog")
        self.pressEnded()
      }
    }
  }

  func stop() {
    if let g = globalMonitor { NSEvent.removeMonitor(g) }
    if let l = localMonitor { NSEvent.removeMonitor(l) }
    globalMonitor = nil
    localMonitor = nil
    watchdog?.invalidate()
    watchdog = nil
  }
}
