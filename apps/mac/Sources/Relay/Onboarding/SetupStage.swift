import AppKit
import SwiftUI

/// Runs the little notch at the top of each setup page. It's the real HUD view, fed a script
/// instead of a microphone, so setup shows exactly what Relay will look like — and on the
/// "try it" page it moves with your fn key.
@MainActor
final class StageDirector: ObservableObject {
  /// The HUD's own model, driving a miniature NotchHUDView.
  let hud = AppState()
  /// What the little window on the stage holds: the words Relay just "pasted".
  @Published private(set) var windowText = ""

  private var script: Task<Void, Never>?
  private var levels: Timer?
  /// Dev renders: hold still.
  private var frozen = false

  init() {
    hud.hasNotch = true
    hud.notchWidth = 185 // a 14"/16" MacBook Pro's, like Shots.swift
    hud.notchTopInset = 32
  }

  private struct Demo {
    let app: String
    let text: String
  }

  /// Any app, any language — including both in one sentence.
  private static let demos = [
    Demo(app: "/System/Applications/Notes.app", text: "Running five minutes late, start without me."),
    Demo(app: "/System/Applications/Messages.app", text: "明天早上十點開會，記得帶筆電。"),
    Demo(app: "/System/Applications/Mail.app", text: "幫我把 Q3 的 deck 寄給 Alex，謝謝。"),
  ]

  func play(_ step: Onboarding.Step, mic: Bool, accessibility: Bool, practiced: Bool) {
    guard !frozen else { return }
    script?.cancel()
    stopLevels()
    switch step {
    case .welcome:
      script = Task { [weak self] in await self?.loopDemo() }
    case .permissions:
      present(.message(Self.permissionNote(mic: mic, accessibility: accessibility)))
    case .tryIt:
      windowText = ""
      if practiced { present(.pasted) } else { close() }
    case .done:
      present(.message(.init(symbol: "mic", text: Edition.readyHint)))
    }
  }

  /// "Try it": the little notch does what the real one is doing.
  func fn(_ down: Bool) {
    guard !frozen else { return }
    script?.cancel()
    if down {
      hud.appIcon = nil
      present(.listening)
    } else {
      withAnimation(Motion.morph) { hud.phase = .thinking }
      // Nothing arrives after a tap or silence — fold back up.
      script = Task { [weak self] in
        guard await self?.pause(4) == true else { return }
        self?.close()
      }
    }
  }

  func pasted() {
    guard !frozen else { return }
    script?.cancel()
    present(.pasted)
    script = Task { [weak self] in
      guard await self?.pause(0.9) == true else { return }
      self?.close()
    }
  }

  func stop() {
    script?.cancel()
    script = nil
    stopLevels()
    var still = Transaction()
    still.disablesAnimations = true
    withTransaction(still) {
      hud.open = false
      hud.phase = .idle
    }
  }

  // MARK: - Scripts

  private func loopDemo() async {
    var i = 0
    while !Task.isCancelled {
      let demo = Self.demos[i % Self.demos.count]
      hud.appIcon = NSWorkspace.shared.icon(forFile: demo.app)
      withAnimation(.easeOut(duration: 0.2)) { windowText = "" }
      present(.listening)
      startLevels()
      guard await pause(2.0) else { return }
      stopLevels()
      withAnimation(Motion.morph) { hud.phase = .thinking }
      guard await pause(0.5) else { return }
      withAnimation(Motion.morph) { hud.phase = .pasted }
      withAnimation(.easeOut(duration: 0.2)) { windowText = demo.text }
      guard await pause(0.7) else { return }
      close()
      guard await pause(2.6) else { return }
      i += 1
    }
  }

  private static func permissionNote(mic: Bool, accessibility: Bool) -> AppState.Message {
    if !mic { return .init(symbol: "mic", text: "Relay needs your microphone") }
    if !accessibility { return .init(symbol: "hand.raised", text: "Turn on Relay in Accessibility so it can paste", tone: .warn) }
    return .init(symbol: "checkmark.circle.fill", text: "Auto-paste is on", tone: .good)
  }

  private func pause(_ seconds: Double) async -> Bool {
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    return !Task.isCancelled
  }

  /// Same choreography as AppDelegate.present: appear closed, grow out on the next frame.
  private func present(_ phase: AppState.Phase) {
    if hud.open {
      withAnimation(Motion.morph) { hud.phase = phase }
      return
    }
    var still = Transaction()
    still.disablesAnimations = true
    withTransaction(still) { hud.phase = phase }
    DispatchQueue.main.async { [hud] in
      guard !hud.open, hud.phase == phase else { return }
      withAnimation(Motion.open) { hud.open = true }
    }
  }

  private func close() {
    guard hud.open else { return }
    withAnimation(Motion.close) { hud.open = false }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [hud] in
      guard !hud.open else { return }
      hud.phase = .idle
    }
  }

  /// A speech-like level for the demo: syllable bumps riding a slower phrase.
  private func startLevels() {
    stopLevels()
    let meter = hud.meter
    let start = Date()
    levels = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
      let t = Date().timeIntervalSince(start)
      let syllables = 0.5 + 0.5 * sin(t * 11) * sin(t * 3.7 + 1)
      let phrase = 0.55 + 0.45 * sin(t * 1.6)
      meter.push(Float(max(0.08, syllables * phrase)))
    }
  }

  private func stopLevels() {
    levels?.invalidate()
    levels = nil
    hud.meter.push(0)
  }

  // MARK: - Dev renders

  func freeze(_ step: Onboarding.Step, mic: Bool, accessibility: Bool, practiced: Bool) {
    frozen = true
    var still = Transaction()
    still.disablesAnimations = true
    withTransaction(still) {
      switch step {
      case .welcome:
        hud.appIcon = NSWorkspace.shared.icon(forFile: Self.demos[0].app)
        hud.phase = .listening
        windowText = Self.demos[0].text
        settleMeter(on: 0.7)
      case .permissions:
        hud.phase = .message(Self.permissionNote(mic: mic, accessibility: accessibility))
      case .tryIt:
        hud.phase = practiced ? .pasted : .idle
      case .done:
        hud.phase = .message(.init(symbol: "mic", text: Edition.readyHint))
      }
      hud.open = hud.phase != .idle
    }
  }

  private func settleMeter(on level: Float) {
    hud.meter.push(level)
    let now = Date().timeIntervalSinceReferenceDate
    for i in 0..<60 { _ = hud.meter.value(at: now - 1 + Double(i) / 60) }
  }
}

/// A miniature Mac screen at the top of every page: a menu bar with the notch, and a window
/// to type into (on "try it", the fn key instead).
struct SetupStage: View {
  @ObservedObject var director: StageDirector
  var step: Onboarding.Step
  var fnDown: Bool
  var listening: Bool

  /// The welcome page lets the demo be the hero; later pages make room for what you do.
  static func height(for step: Onboarding.Step) -> CGFloat {
    step == .welcome ? 236 : 160
  }

  var body: some View {
    ZStack(alignment: .top) {
      Color(white: 0.075)
      MenuBarSketch().frame(height: 32)
      ZStack {
        if step == .tryIt {
          SetupKeycap(down: fnDown, listening: listening).transition(.opacity)
        } else {
          SketchWindow(text: director.windowText)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, step == .welcome ? 34 : 16)
            .transition(.opacity)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .padding(.top, 32)
      // The physical notch, which the HUD grows out of.
      NotchShape(bottomRadius: 8).fill(Color.black).frame(width: 185, height: 32)
      NotchHUDView(state: director.hud)
    }
    .frame(height: Self.height(for: step))
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
  }
}

/// Just enough of a menu bar to read as one — no fake words.
private struct MenuBarSketch: View {
  var body: some View {
    HStack(spacing: 0) {
      HStack(spacing: 13) {
        Circle().frame(width: 9, height: 9)
        ForEach([30, 24, 34, 28], id: \.self) { w in
          Capsule().frame(width: CGFloat(w), height: 5)
        }
      }
      Spacer(minLength: 0)
      HStack(spacing: 12) {
        ForEach(0..<3, id: \.self) { _ in
          RoundedRectangle(cornerRadius: 2.5).frame(width: 10, height: 10)
        }
        Capsule().frame(width: 44, height: 5)
      }
    }
    .foregroundStyle(Color.white.opacity(0.15))
    .padding(.horizontal, 16)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.white.opacity(0.035))
  }
}

/// A plain window with a blinking caret — where the demo's words land.
private struct SketchWindow: View {
  var text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 5) {
        ForEach(0..<3, id: \.self) { _ in
          Circle().fill(Color.white.opacity(0.14)).frame(width: 6, height: 6)
        }
      }
      Spacer(minLength: 0)
      HStack(spacing: 1) {
        if !text.isEmpty {
          Text(text)
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(0.88))
            .lineLimit(1)
            .transition(.opacity)
        }
        TimelineView(.periodic(from: .now, by: 0.53)) { context in
          let on = Int(context.date.timeIntervalSinceReferenceDate / 0.53) % 2 == 0
          Rectangle().fill(Color.white.opacity(on ? 0.75 : 0)).frame(width: 1.5, height: 15)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(width: 330, height: 74, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05)))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
  }
}

/// The fn key at a readable size, pressing down while you hold the real one.
struct SetupKeycap: View {
  var down: Bool
  var listening: Bool

  var body: some View {
    VStack(spacing: 9) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(Color(white: down ? 0.2 : 0.12))
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(down ? 0.34 : 0.12), lineWidth: 1)
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Spacer(minLength: 0)
            Text("fn").font(.system(size: 14, weight: .medium))
          }
          Spacer(minLength: 0)
          Image(systemName: "globe").font(.system(size: 13))
        }
        .foregroundStyle(.white.opacity(down ? 0.95 : 0.7))
        .padding(9)
      }
      .frame(width: 62, height: 62)
      .scaleEffect(down ? 0.94 : 1)
      .offset(y: down ? 1.5 : 0)
      Text(listening ? "Listening…" : "Hold")
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(.white.opacity(listening ? 0.7 : 0.4))
    }
    .animation(.spring(response: 0.18, dampingFraction: 0.7), value: down)
  }
}
