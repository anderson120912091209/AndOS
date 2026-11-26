import SwiftUI

/// Relay's agents (packages/shared/src/agents.ts): a small cast who live in the notch. Each has
/// its own silhouette so you can tell them apart at 20 points — a red blob with a bite out of
/// it, a sprout, a desk calendar, an ink drop, a pair of headphones, a speech bubble — and much
/// the same face: eyes, a blush, a mouth that changes with what they're doing. Relay's is the
/// user's own drawing: flat, white pill eyes, coral cheeks, no mouth until there's something to say.
enum AgentID: String, CaseIterable {
  case relay, scout, tock, quill, echo, chirp

  init(_ raw: String?) { self = raw.flatMap(AgentID.init(rawValue:)) ?? .relay }

  var name: String {
    switch self {
    case .relay: return "Relay"
    case .scout: return "Scout"
    case .tock: return "Tock"
    case .quill: return "Quill"
    case .echo: return "Echo"
    case .chirp: return "Chirp"
    }
  }

  /// Same colours as the shared cast.
  var color: RGB {
    switch self {
    case .relay: return RGB(0xE5493A)
    case .scout: return RGB(0x34D399)
    case .tock: return RGB(0x60A5FA)
    case .quill: return RGB(0xA78BFA)
    case .echo: return RGB(0xFB923C)
    case .chirp: return RGB(0xF472B6)
    }
  }
}

/// What they're doing, which is how they move.
enum AgentMood: CaseIterable {
  /// breathing, blinking now and then
  case idle
  /// you're talking to them: leaning in, bouncing, mouth open
  case listening
  /// they heard you and are working out what to do: eyes up, a slow sway
  case thinking
  /// on it: hopping along, eyes darting across the work
  case working
  /// finished: happy eyes, a big smile, a little jump
  case done
  /// they need you (a sign-in, an OK): rocking, wide-eyed
  case needsYou
}

struct AgentCharacter: View {
  var agent: AgentID
  var mood: AgentMood = .idle
  var size: CGFloat = 22
  /// A fixed moment, for renders; live otherwise. (In renders it's also how long the mood has run.)
  var time: TimeInterval?
  /// Your voice while you talk to them: `.listening` opens the mouth with it — "blah blah".
  var voice: LevelMeter? = nil
  /// When the current mood began, so a mood's own little show — Relay's thought bubbles — starts
  /// from its beginning instead of wherever the clock happens to be.
  @State private var moodStart = Date.timeIntervalSinceReferenceDate

  init(agent: AgentID, mood: AgentMood = .idle, size: CGFloat = 22, time: TimeInterval? = nil, voice: LevelMeter? = nil) {
    self.agent = agent
    self.mood = mood
    self.size = size
    self.time = time
    self.voice = voice
  }

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 60, paused: time != nil)) { timeline in
      let t = time ?? timeline.date.timeIntervalSinceReferenceDate
      Canvas { gc, canvas in
        AgentDrawing(agent: agent, mood: mood, t: t, voice: voice.map { Double($0.value(at: t)) },
                     inMood: time ?? max(0, t - moodStart))
          .draw(in: &gc, size: canvas)
      }
    }
    .frame(width: size, height: size)
    .onChange(of: mood) { _ in moodStart = Date.timeIntervalSinceReferenceDate }
    .accessibilityLabel("\(agent.name), \(String(describing: mood))")
  }
}

/// A colour that can be mixed — the cast's bodies shade a little lighter on top, darker below.
struct RGB {
  var r, g, b: Double

  init(_ hex: Int) {
    r = Double((hex >> 16) & 0xFF) / 255
    g = Double((hex >> 8) & 0xFF) / 255
    b = Double(hex & 0xFF) / 255
  }

  init(r: Double, g: Double, b: Double) {
    self.r = r
    self.g = g
    self.b = b
  }

  func mixed(with other: RGB, _ amount: Double) -> RGB {
    RGB(r: r + (other.r - r) * amount, g: g + (other.g - g) * amount, b: b + (other.b - b) * amount)
  }

  var color: Color { Color(red: r, green: g, blue: b) }
  static let white = RGB(0xFFFFFF)
  static let black = RGB(0x000000)
}

/// One frame of one agent. Drawn in a unit square (0…1, y down), then scaled to the canvas.
private struct AgentDrawing {
  var agent: AgentID
  var mood: AgentMood
  var t: TimeInterval
  /// your voice right now (0…1), while you're talking to them
  var voice: Double? = nil
  /// seconds since the current mood began
  var inMood: TimeInterval = 0

  private static let ink = Color(red: 0.09, green: 0.09, blue: 0.11)
  /// Relay's mouth, and its cheeks (and tongue)
  private static let mouthInk = Color(red: 0.27, green: 0.05, blue: 0.04)
  private static let coral = RGB(0xFF8574).color
  /// cheeks: pink, warmed toward each body so they never go muddy (pink on green turns grey)
  private var blush: Color { agent.color.mixed(with: RGB(0xFF5C8A), 0.6).color }

  /// Each agent blinks on its own rhythm, so a crowd of them never blinks in unison.
  private var phase: Double { Double(AgentID.allCases.firstIndex(of: agent) ?? 0) * 0.73 }

  func draw(in gc: inout GraphicsContext, size: CGSize) {
    let s = min(size.width, size.height)
    gc.translateBy(x: (size.width - s) / 2, y: (size.height - s) / 2)
    gc.scaleBy(x: s, y: s)
    let still = gc // the unit square before any body motion, for things that float on their own

    // Body language: squash and stretch around the feet, a hop, a tilt.
    let m = motion
    gc.translateBy(x: 0.5, y: 0.92 + m.lift)
    gc.rotate(by: .degrees(m.tilt))
    gc.scaleBy(x: m.squash.width, y: m.squash.height)
    gc.translateBy(x: -0.5, y: -0.92)

    drawBehind(&gc)
    // Relay is flat, like the drawing it came from; the rest are gummy — lighter on top, a shine.
    let flat = agent == .relay
    let top = agent.color.mixed(with: .white, flat ? 0.03 : 0.16)
    let bottom = agent.color.mixed(with: .black, flat ? 0.05 : 0.14)
    let skin = GraphicsContext.Shading.linearGradient(Gradient(colors: [top.color, bottom.color]),
                                                      startPoint: CGPoint(x: 0.5, y: 0.15), endPoint: CGPoint(x: 0.5, y: 0.95))
    // Filled one by one: overlapping parts of a single path can cancel out and leave a hole.
    for part in bodyParts { gc.fill(part, with: skin) }
    drawInFront(&gc)
    if flat {
      drawRelayFace(&gc)
      if mood == .thinking {
        var thoughts = still // they float in place while the body sways
        drawThoughts(&thoughts)
      }
      return
    }
    // a gummy shine, top left
    let shine = faceCenter.applying(.init(translationX: -0.17, y: -0.2))
    gc.fill(Path(ellipseIn: CGRect(x: shine.x - 0.07, y: shine.y - 0.035, width: 0.14, height: 0.07)),
            with: .color(.white.opacity(0.38)))
    drawFace(&gc)
  }

  // MARK: Motion

  private var motion: (lift: CGFloat, tilt: Double, squash: CGSize) {
    let breathe = sin(t * 2 * .pi / 2.6 + phase)
    switch mood {
    case .idle:
      return (0, 0, CGSize(width: 1 - 0.015 * breathe, height: 1 + 0.025 * breathe))
    case .listening:
      if voice != nil { // talking along with you: a bob and a stretch with every "blah"
        let o = talk
        return (-0.06 * o, 0, CGSize(width: 1 - 0.05 * o, height: 1 + 0.1 * o))
      }
      let b = abs(sin(t * 2 * .pi / 0.9))
      return (-0.035 * b, 0, CGSize(width: 1 + 0.03 * (1 - b), height: 1 - 0.03 * (1 - b) + 0.02 * b))
    case .thinking:
      return (0, 4 * sin(t * 2.1), CGSize(width: 1 - 0.01 * breathe, height: 1 + 0.015 * breathe))
    case .working:
      let hop = max(0, sin(t * 2 * .pi / 0.7))
      let landing = hop < 0.15 ? (0.15 - hop) / 0.15 : 0 // squash as the feet touch down
      return (-0.07 * hop, 2.5 * sin(t * 2 * .pi / 1.4), CGSize(width: 1 + 0.06 * landing, height: 1 - 0.07 * landing))
    case .done:
      let jump = max(0, sin(t * 2 * .pi / 1.1))
      return (-0.05 * jump * jump, 0, CGSize(width: 1 + 0.02 * (1 - jump), height: 1 - 0.02 * (1 - jump)))
    case .needsYou:
      return (0, 9 * sin(t * 2 * .pi / 0.85), CGSize(width: 1, height: 1 + 0.02 * breathe))
    }
  }

  // MARK: Silhouettes

  private var bodyPath: Path {
    switch agent {
    case .relay: // a soft blob with a bite out of its top right — the user's drawing
      var p = Path()
      p.move(to: CGPoint(x: 0.55, y: 0.238))
      p.addCurve(to: CGPoint(x: 0.655, y: 0.27), control1: CGPoint(x: 0.6, y: 0.232), control2: CGPoint(x: 0.64, y: 0.245))
      p.addCurve(to: CGPoint(x: 0.825, y: 0.445), control1: CGPoint(x: 0.67, y: 0.36), control2: CGPoint(x: 0.76, y: 0.42)) // the bite
      p.addCurve(to: CGPoint(x: 0.885, y: 0.69), control1: CGPoint(x: 0.875, y: 0.455), control2: CGPoint(x: 0.89, y: 0.57))
      p.addCurve(to: CGPoint(x: 0.8, y: 0.88), control1: CGPoint(x: 0.885, y: 0.8), control2: CGPoint(x: 0.86, y: 0.86))
      p.addCurve(to: CGPoint(x: 0.4, y: 0.92), control1: CGPoint(x: 0.7, y: 0.91), control2: CGPoint(x: 0.52, y: 0.925))
      p.addCurve(to: CGPoint(x: 0.13, y: 0.76), control1: CGPoint(x: 0.24, y: 0.915), control2: CGPoint(x: 0.13, y: 0.86))
      p.addCurve(to: CGPoint(x: 0.16, y: 0.47), control1: CGPoint(x: 0.115, y: 0.66), control2: CGPoint(x: 0.13, y: 0.55))
      p.addCurve(to: CGPoint(x: 0.55, y: 0.238), control1: CGPoint(x: 0.19, y: 0.33), control2: CGPoint(x: 0.36, y: 0.245)) // round top-left
      p.closeSubpath()
      return p
    case .scout: // round, with a sprout on top
      return Path(ellipseIn: CGRect(x: 0.14, y: 0.24, width: 0.72, height: 0.7))
    case .tock: // a desk calendar
      return Path(roundedRect: CGRect(x: 0.14, y: 0.28, width: 0.72, height: 0.64), cornerRadius: 0.17, style: .continuous)
    case .quill: // an ink drop
      var p = Path()
      p.move(to: CGPoint(x: 0.5, y: 0.08))
      p.addCurve(to: CGPoint(x: 0.84, y: 0.62), control1: CGPoint(x: 0.6, y: 0.26), control2: CGPoint(x: 0.84, y: 0.4))
      p.addArc(center: CGPoint(x: 0.5, y: 0.62), radius: 0.34, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: false)
      p.addCurve(to: CGPoint(x: 0.5, y: 0.08), control1: CGPoint(x: 0.16, y: 0.4), control2: CGPoint(x: 0.4, y: 0.26))
      p.closeSubpath()
      return p
    case .echo: // round, wearing headphones
      return Path(ellipseIn: CGRect(x: 0.18, y: 0.28, width: 0.64, height: 0.64))
    case .chirp: // a speech bubble (its tail is drawn with it — see bodyParts)
      return Path(roundedRect: CGRect(x: 0.1, y: 0.24, width: 0.8, height: 0.58), cornerRadius: 0.24, style: .continuous)
    }
  }

  /// The body, plus anything else in its skin: Chirp's tail.
  private var bodyParts: [Path] {
    guard agent == .chirp else { return [bodyPath] }
    var tail = Path()
    tail.move(to: CGPoint(x: 0.22, y: 0.7))
    tail.addQuadCurve(to: CGPoint(x: 0.15, y: 0.95), control: CGPoint(x: 0.24, y: 0.88))
    tail.addQuadCurve(to: CGPoint(x: 0.46, y: 0.76), control: CGPoint(x: 0.33, y: 0.9))
    tail.closeSubpath()
    return [tail, bodyPath]
  }

  /// Where the face sits on each body.
  private var faceCenter: CGPoint {
    switch agent {
    case .relay: return CGPoint(x: 0.55, y: 0.66)
    case .scout: return CGPoint(x: 0.5, y: 0.6)
    case .tock: return CGPoint(x: 0.5, y: 0.64)
    case .quill: return CGPoint(x: 0.5, y: 0.62)
    case .echo: return CGPoint(x: 0.5, y: 0.61)
    case .chirp: return CGPoint(x: 0.5, y: 0.52)
    }
  }

  /// Things behind the body: Scout's sprout, Echo's headband.
  private func drawBehind(_ gc: inout GraphicsContext) {
    switch agent {
    case .scout:
      var stem = Path()
      stem.move(to: CGPoint(x: 0.5, y: 0.27))
      stem.addQuadCurve(to: CGPoint(x: 0.53, y: 0.12), control: CGPoint(x: 0.49, y: 0.18))
      gc.stroke(stem, with: .color(agent.color.mixed(with: .black, 0.35).color), style: StrokeStyle(lineWidth: 0.04, lineCap: .round))
      var leaf = gc
      leaf.translateBy(x: 0.6, y: 0.11)
      leaf.rotate(by: .degrees(-28 + (mood == .working ? 10 * sin(t * 6) : 4 * sin(t * 1.7))))
      leaf.fill(Path(ellipseIn: CGRect(x: -0.09, y: -0.045, width: 0.18, height: 0.09)), with: .color(RGB(0x6EE7B7).color))
    case .echo:
      var band = Path()
      band.addArc(center: CGPoint(x: 0.5, y: 0.6), radius: 0.39, startAngle: .degrees(195), endAngle: .degrees(345), clockwise: false)
      gc.stroke(band, with: .color(agent.color.mixed(with: .white, 0.5).color), style: StrokeStyle(lineWidth: 0.06, lineCap: .round))
    default:
      break
    }
  }

  /// Things in front of the body: Tock's header and rings, Echo's ear cups.
  private func drawInFront(_ gc: inout GraphicsContext) {
    switch agent {
    case .tock:
      var header = gc
      header.clip(to: bodyPath)
      header.fill(Path(CGRect(x: 0.1, y: 0.26, width: 0.8, height: 0.15)), with: .color(agent.color.mixed(with: .black, 0.22).color))
      for x in [0.34, 0.66] {
        gc.fill(Path(roundedRect: CGRect(x: x - 0.04, y: 0.18, width: 0.08, height: 0.18), cornerRadius: 0.04),
                with: .color(RGB(0xE5E7EB).color))
      }
    case .echo:
      let cup = agent.color.mixed(with: .white, 0.5).color
      for x in [0.1, 0.78] {
        gc.fill(Path(roundedRect: CGRect(x: x, y: 0.5, width: 0.12, height: 0.24), cornerRadius: 0.06), with: .color(cup))
      }
    default:
      break
    }
  }

  // MARK: Face

  private func drawFace(_ gc: inout GraphicsContext) {
    let c = faceCenter
    let gap: CGFloat = agent == .echo ? 0.12 : 0.13
    let look = self.look
    let wide: CGFloat = (mood == .listening || mood == .needsYou) ? 1.12 : 1

    // blush first, under the eyes
    for side in [-1.0, 1.0] {
      let x = c.x + CGFloat(side) * (gap + 0.07)
      gc.fill(Path(ellipseIn: CGRect(x: x - 0.06, y: c.y + 0.03, width: 0.12, height: 0.06)), with: .color(blush.opacity(0.5)))
    }

    for side in [-1.0, 1.0] {
      let eye = CGPoint(x: c.x + CGFloat(side) * gap + look.x, y: c.y - 0.05 + look.y)
      if mood == .done {
        // happy eyes: ^ ^
        var arc = Path()
        arc.move(to: CGPoint(x: eye.x - 0.05, y: eye.y + 0.02))
        arc.addQuadCurve(to: CGPoint(x: eye.x + 0.05, y: eye.y + 0.02), control: CGPoint(x: eye.x, y: eye.y - 0.06))
        gc.stroke(arc, with: .color(Self.ink), style: StrokeStyle(lineWidth: 0.035, lineCap: .round))
        continue
      }
      let w = 0.1 * wide, h = 0.13 * wide * blink
      gc.fill(Path(ellipseIn: CGRect(x: eye.x - w / 2, y: eye.y - h / 2, width: w, height: h)), with: .color(Self.ink))
      if blink > 0.5 {
        let r: CGFloat = 0.022
        gc.fill(Path(ellipseIn: CGRect(x: eye.x + 0.012 - r, y: eye.y - 0.03 - r, width: 2 * r, height: 2 * r)),
                with: .color(.white.opacity(0.95)))
      }
    }

    let mouth = CGPoint(x: c.x + look.x * 0.5, y: c.y + 0.07)
    switch mood {
    case .listening, .needsYou:
      let r: CGFloat = mood == .listening ? 0.028 + 0.012 * abs(sin(t * 2 * .pi / 0.45)) : 0.034
      gc.fill(Path(ellipseIn: CGRect(x: mouth.x - r, y: mouth.y - r * 0.8, width: 2 * r, height: 2 * r)), with: .color(Self.ink))
    case .working, .thinking:
      var line = Path()
      line.move(to: CGPoint(x: mouth.x - 0.03, y: mouth.y))
      line.addLine(to: CGPoint(x: mouth.x + 0.03, y: mouth.y))
      gc.stroke(line, with: .color(Self.ink), style: StrokeStyle(lineWidth: 0.028, lineCap: .round))
    case .idle, .done:
      let half: CGFloat = mood == .done ? 0.07 : 0.045
      var smile = Path()
      smile.move(to: CGPoint(x: mouth.x - half, y: mouth.y - 0.01))
      smile.addQuadCurve(to: CGPoint(x: mouth.x + half, y: mouth.y - 0.01),
                         control: CGPoint(x: mouth.x, y: mouth.y + (mood == .done ? 0.07 : 0.045)))
      gc.stroke(smile, with: .color(Self.ink), style: StrokeStyle(lineWidth: 0.028, lineCap: .round))
    }
  }

  /// How wide Relay's mouth is while you talk — "blah blah blah". How loud you are sets how wide; a
  /// syllable-paced flap, about five a second, snaps it open and nearly shut, so it reads as talking
  /// even on one long vowel. Under a murmur it stays shut. 0 = shut, 1 = wide open.
  private var talk: CGFloat {
    guard let v = voice else { return 0 }
    let loud = min(1, max(0, (v - 0.06) / 0.24))
    guard loud > 0 else { return 0 }
    let flap = abs(sin(t * 2 * .pi / 0.38)) // |sin| peaks twice a period: ~5.3 flaps a second
    return CGFloat((0.5 + 0.5 * loud) * (0.12 + 0.88 * flap)) // even a soft word opens it half way
  }

  /// Thinking: thought bubbles rising out of the bite, small to big. Thinking is short — Whisper
  /// takes well under a second — so they start the moment it does, all three up within a third of
  /// a second; if it runs longer, a slow ripple runs through them, like a loading "…".
  private func drawThoughts(_ gc: inout GraphicsContext) {
    let bubbles: [(x: CGFloat, y: CGFloat, r: CGFloat)] = [(0.775, 0.3, 0.04), (0.865, 0.185, 0.056), (0.925, 0.075, 0.07)]
    for (i, b) in bubbles.enumerated() {
      let pop = min(1, max(0, (inMood - Double(i) * 0.11) / 0.1)) // one after another, fast
      guard pop > 0 else { continue }
      let grow = 1 - (1 - pop) * (1 - pop) // ease out
      let ripple = inMood > 0.4 ? 0.88 + 0.12 * sin((inMood - Double(i) * 0.22) * 2 * .pi / 0.9) : 1
      let r = b.r * CGFloat((0.5 + 0.5 * grow) * ripple)
      gc.fill(Path(ellipseIn: CGRect(x: b.x - r, y: b.y - r, width: 2 * r, height: 2 * r)),
              with: .color(.white.opacity(0.95)))
    }
  }

  /// Relay's face, from the user's drawing: two white pills leaning a little, the right one a touch
  /// higher; coral cheeks; and no mouth until there's something to say.
  private func drawRelayFace(_ gc: inout GraphicsContext) {
    let look = self.look
    let cheeks: [(CGFloat, CGFloat)] = [(0.355, 0.745), (0.755, 0.708)]
    for (x, y) in cheeks {
      gc.fill(Path(ellipseIn: CGRect(x: x - 0.042, y: y - 0.023, width: 0.084, height: 0.046)), with: .color(Self.coral))
    }
    let wide: CGFloat = mood == .needsYou ? 1.15 : 1
    let eyes: [(CGFloat, CGFloat)] = [(0.433, 0.635), (0.662, 0.61)]
    for (x, y) in eyes {
      let eye = CGPoint(x: x + look.x, y: y + look.y)
      if mood == .done { // happy: ^ ^
        var arc = Path()
        arc.move(to: CGPoint(x: eye.x - 0.042, y: eye.y + 0.02))
        arc.addQuadCurve(to: CGPoint(x: eye.x + 0.042, y: eye.y + 0.02), control: CGPoint(x: eye.x, y: eye.y - 0.055))
        gc.stroke(arc, with: .color(.white), style: StrokeStyle(lineWidth: 0.034, lineCap: .round))
        continue
      }
      let w: CGFloat = 0.07 * wide, h: CGFloat = 0.16 * wide * blink
      var pill = gc
      pill.translateBy(x: eye.x, y: eye.y)
      pill.rotate(by: .degrees(-6))
      pill.fill(Path(roundedRect: CGRect(x: -w / 2, y: -h / 2, width: w, height: h), cornerRadius: min(w, h) / 2),
                with: .color(.white))
    }

    let mouth = CGPoint(x: 0.548 + look.x * 0.5, y: 0.76)
    switch mood {
    case .listening:
      // talking: "blah blah" with your voice; with no voice to follow, it chats on its own
      let open = voice == nil ? CGFloat(0.2 + 0.7 * abs(sin(t * 2 * .pi / 0.38))) : talk
      guard open > 0.04 else { return }
      // a cartoon "D" mid-word — flat on top, round below — big enough to read at 28 points
      let w = 0.11 + 0.08 * open, h = 0.035 + 0.165 * open, top: CGFloat = 0.7
      var d = Path()
      d.move(to: CGPoint(x: mouth.x - w / 2, y: top))
      d.addLine(to: CGPoint(x: mouth.x + w / 2, y: top))
      d.addCurve(to: CGPoint(x: mouth.x, y: top + h), control1: CGPoint(x: mouth.x + w / 2, y: top + h * 0.8),
                 control2: CGPoint(x: mouth.x + w * 0.3, y: top + h))
      d.addCurve(to: CGPoint(x: mouth.x - w / 2, y: top), control1: CGPoint(x: mouth.x - w * 0.3, y: top + h),
                 control2: CGPoint(x: mouth.x - w / 2, y: top + h * 0.8))
      d.closeSubpath()
      gc.fill(d, with: .color(Self.mouthInk))
      if open > 0.35 { // open wide enough to see its tongue
        var inside = gc
        inside.clip(to: d)
        inside.fill(Path(ellipseIn: CGRect(x: mouth.x - w * 0.34, y: top + h * 0.55, width: w * 0.68, height: h * 0.7)),
                    with: .color(Self.coral))
      }
    case .thinking, .needsYou:
      let r: CGFloat = mood == .needsYou ? 0.026 : 0.017 // a small "o"
      gc.fill(Path(ellipseIn: CGRect(x: mouth.x - r, y: mouth.y - r, width: 2 * r, height: 2 * r)), with: .color(Self.mouthInk))
    case .done:
      var grin = Path() // an open, happy grin
      grin.move(to: CGPoint(x: mouth.x - 0.05, y: mouth.y - 0.015))
      grin.addQuadCurve(to: CGPoint(x: mouth.x + 0.05, y: mouth.y - 0.015), control: CGPoint(x: mouth.x, y: mouth.y + 0.075))
      grin.closeSubpath()
      gc.fill(grin, with: .color(Self.mouthInk))
    case .idle, .working:
      break // like the drawing: no mouth
    }
  }

  /// Where they're looking.
  private var look: CGPoint {
    switch mood {
    case .thinking: return CGPoint(x: 0.025, y: -0.025)
    case .working: return CGPoint(x: 0.03 * sin(t * 2 * .pi / 1.6), y: 0.008)
    case .listening: return CGPoint(x: 0, y: -0.008)
    default: return .zero
    }
  }

  /// 1 = open, ~0 = shut. A quick blink every few seconds.
  private var blink: CGFloat {
    let period = 3.7 + phase * 0.4
    let into = (t + phase * 1.3).truncatingRemainder(dividingBy: period)
    guard into < 0.16 else { return 1 }
    return CGFloat(max(0.08, abs(into - 0.08) / 0.08))
  }
}
