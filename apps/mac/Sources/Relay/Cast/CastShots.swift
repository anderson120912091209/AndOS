import AppKit
import SwiftUI

/// Render the cast — every agent in every mood, big and at notch size — offscreen
/// (part of RELAY_RENDER_SHOTS=<dir>).
@MainActor
func renderCastShots(to dir: String) {
  func save<V: View>(_ name: String, _ view: V) {
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let img = renderer.nsImage, let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
          let png = bmp.representation(using: .png, properties: [:])
    else { return print("render failed: \(name)") }
    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    print("rendered \(name)")
  }

  let moods: [(AgentMood, String, TimeInterval)] = [
    (.idle, "idle", 0.2), (.listening, "listening", 0.25), (.thinking, "thinking", 0.4),
    (.working, "working", 0.17), (.done, "done", 0.27), (.needsYou, "needs you", 0.21),
  ]

  // The sheet: one row per agent, one column per mood, plus each at notch size.
  save("cast-sheet.png", VStack(alignment: .leading, spacing: 18) {
    HStack(spacing: 0) {
      Text("").frame(width: 92, alignment: .leading)
      ForEach(moods, id: \.1) { _, label, _ in
        Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.45)).frame(width: 96)
      }
      Text("notch").font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.45)).frame(width: 60)
    }
    ForEach(AgentID.allCases, id: \.self) { agent in
      HStack(spacing: 0) {
        Text(agent.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).frame(width: 92, alignment: .leading)
        ForEach(moods, id: \.1) { mood, _, t in
          AgentCharacter(agent: agent, mood: mood, size: 72, time: t).frame(width: 96)
        }
        AgentCharacter(agent: agent, mood: .idle, size: 22, time: 0.2).frame(width: 60)
      }
    }
  }
  .padding(28)
  .background(Color.black))

  // In the notch: Relay listening in the ear, and a hand-off chin.
  let notchW: CGFloat = 185
  save("cast-notch.png", VStack(spacing: 28) {
    ZStack(alignment: .top) {
      Rectangle().fill(Color.white.opacity(0.18)).frame(height: 32)
      HStack(spacing: 0) {
        AgentCharacter(agent: .relay, mood: .listening, size: 24, time: 0.25).frame(width: 40, height: 32)
        Spacer().frame(width: notchW)
        LiveMeterStill().frame(width: 40, height: 32)
      }
      .background(NotchShape(bottomRadius: 8).fill(Color.black))
    }
    .frame(width: 420, height: 40)
    ZStack(alignment: .top) {
      Rectangle().fill(Color.white.opacity(0.18)).frame(height: 32)
      VStack(spacing: 0) {
        Color.clear.frame(height: 32)
        HStack(spacing: 8) {
          AgentCharacter(agent: .scout, mood: .working, size: 22, time: 0.17)
          Text("Scout’s on it — comparing CRM pricing").font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.92))
        }
        .padding(.horizontal, 16)
        .frame(height: 30)
      }
      .background(NotchShape(bottomRadius: 16).fill(Color.black))
    }
    .frame(width: 420, height: 70)
  }
  .padding(24)
  .background(LinearGradient(colors: [Color(red: 0.05, green: 0.1, blue: 0.22), Color(red: 0.16, green: 0.28, blue: 0.47)],
                             startPoint: .top, endPoint: .bottom)))
}

/// A still of the level meter's bars, for the notch render.
private struct LiveMeterStill: View {
  var body: some View {
    HStack(spacing: 2.5) {
      ForEach([0.35, 0.8, 0.55, 1.0, 0.45], id: \.self) { h in
        Capsule().fill(Color(red: 0.35, green: 0.78, blue: 0.98)).frame(width: 2.5, height: 14 * h)
      }
    }
  }
}
