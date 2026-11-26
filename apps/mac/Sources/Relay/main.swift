import AppKit

// Menu-bar-only app: no Dock icon, no main window. The HUD is a floating panel and
// the only persistent UI is the status-bar item. Top-level code runs on the main
// thread; assumeIsolated bridges it to the main actor our types require.
MainActor.assumeIsolated {
  let app = NSApplication.shared
  let env = ProcessInfo.processInfo.environment

  // Dev: render the HUD to PNGs and exit (RELAY_RENDER_SHOTS=<dir>). No window shown.
  if let dir = env["RELAY_RENDER_SHOTS"] {
    app.setActivationPolicy(.prohibited)
    renderShots(to: dir)
    exit(0)
  }

  // Dev: render the agent's notch card states to PNGs and exit (RELAY_RENDER_AGENT_SHOTS=<dir>).
  if let dir = env["RELAY_RENDER_AGENT_SHOTS"] {
    app.setActivationPolicy(.prohibited)
    renderAgentShots(to: dir)
    exit(0)
  }

  // Dev: open the Box window off-screen on Relay's computer, save a picture of it, and exit
  // (RELAY_PREVIEW_BOX=<png>; RELAY_PREVIEW_REASON="Sign in to Gmail" previews a takeover).
  if let path = env["RELAY_PREVIEW_BOX"] {
    app.setActivationPolicy(.accessory)
    let box = BoxController.shared
    box.offscreen = true
    if let reason = env["RELAY_PREVIEW_REASON"] {
      box.show(BoxTakeover(id: "preview", reason: reason, service: env["RELAY_PREVIEW_SERVICE"], viewerURL: nil))
    } else {
      box.showComputer()
    }
    Task { @MainActor in
      for _ in 0..<60 where box.model.phase != .live { try? await Task.sleep(nanoseconds: 250_000_000) }
      try? await Task.sleep(nanoseconds: 1_500_000_000) // let the first frames land
      print(await box.snapshot(to: path) ? "saved \(path) (\(box.model.phase))" : "snapshot failed")
      exit(0)
    }
    app.run()
  }

  // Dev: run setup's model download headless and exit (RELAY_FETCH=1): the model this Mac's
  // architecture starts on, fetched, checked and loaded the way setup does it. Pair it with
  // RELAY_MODELS_DIR=<empty dir> to leave the real models alone, and `arch -x86_64` for an Intel Mac's.
  if env["RELAY_FETCH"] != nil {
    let downloader = ModelDownloader.shared
    print("setup downloads \(SpeechEngine.setupDefault.name) into \(ModelStore.root.path)")
    downloader.start()
    var shown = -1
    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
      MainActor.assumeIsolated {
        switch downloader.state {
        case let .downloading(fraction) where Int(fraction * 10) > shown:
          shown = Int(fraction * 10)
          print("  \(shown * 10)%")
        case .ready:
          print("ready: \(SpeechEngine.setupDefault.name) loaded")
          exit(0)
        case let .failed(why):
          print("failed: \(why)")
          exit(1)
        default:
          break
        }
      }
    }
    app.setActivationPolicy(.prohibited)
    app.run()
  }

  // Dev: run the in-app Whisper engine on audio files and exit
  // (RELAY_TRANSCRIBE=/path/a.wav,/path/b.wav). Same code path as live dictation, minus the mic.
  // RELAY_TRANSCRIBE_GAP=<seconds> waits between files, the way real dictations come after a pause.
  // RELAY_ENGINE=sensevoice runs the fast engine instead of Whisper.
  if let files = env["RELAY_TRANSCRIBE"] {
    let loadStart = Date()
    let engine = SpeechEngine.chosen
    let ok = engine.engine.loadSync()
    print("\(engine.name) \(ok ? "loaded" : "MISSING") in \(Int(Date().timeIntervalSince(loadStart) * 1000)) ms")
    let gap = Double(env["RELAY_TRANSCRIBE_GAP"] ?? "") ?? 0
    for (i, path) in files.split(separator: ",").map(String.init).enumerated() {
      if i > 0, gap > 0 { Thread.sleep(forTimeInterval: gap) }
      guard let pcm = SpeechService.loadPCM16k(URL(fileURLWithPath: path)) else {
        print("can't read \(path)")
        continue
      }
      let r = engine.engine.transcribeSync(pcm)
      let secs = String(format: "%.1f", Double(pcm.count) / 16_000)
      print("\(r.millis) ms for \(secs) s [\(r.language ?? "?")] \(r.text)")
    }
    engine.engine.unload()
    exit(0)
  }

  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  app.run()
}
