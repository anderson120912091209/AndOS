import AppKit
import SwiftUI

/// Render the Connections window's states to PNGs, offscreen (RELAY_RENDER_SHOTS=<dir>).
@MainActor
func renderConnectionsShots(to dir: String) {
  typealias Item = ConnectionsModel.Item
  let claude = Item(id: "claude", name: "Claude", blurb: "The AI behind Fn + Control. Uses your Anthropic API key.",
                    example: "“Summarize this page and draft a reply.”", state: .available)
  let claudeOn = Item(id: "claude", name: "Claude", blurb: claude.blurb, example: claude.example, state: .connected,
                      account: "API key …7Q2x")
  let gmail = Item(id: "gmail", name: "Gmail", blurb: "Search and read your mail, draft replies.",
                   example: "“Go through my inbox and draft replies to anything urgent.”", state: .available, via: "box")
  let gmailKey = Item(id: "gmail", name: "Gmail", blurb: gmail.blurb, example: gmail.example, state: .available, needsKey: true)
  let fathom = Item(id: "fathom", name: "Fathom", blurb: "Search your calls, transcripts and summaries.",
                    example: "“What did we decide in my last call with Acme?”", state: .available)
  let slack = Item(id: "slack", name: "Slack", blurb: "Search messages and catch up on threads.",
                   example: "“Catch me up on #design since yesterday.”", state: .available, via: "box")
  let notion = Item(id: "notion", name: "Notion", blurb: "Search and read your pages.",
                    example: "“Find the launch plan and summarize the open questions.”", state: .available, via: "box")
  let linear = Item(id: "linear", name: "Linear", blurb: "Look up issues and projects.",
                    example: "“What’s blocking the REL milestone?”", state: .available, via: "box")
  let fathomOn = Item(id: fathom.id, name: fathom.name, blurb: fathom.blurb, example: fathom.example, state: .connected,
                      tools: ["search_calls", "get_call", "get_transcript", "get_summary", "list_speakers", "resolve_link"])
  let gmailOn = Item(id: gmail.id, name: gmail.name, blurb: gmail.blurb, example: gmail.example, state: .connected,
                     account: "anderson@gmail.com", via: "box")
  let slackOn = Item(id: slack.id, name: slack.name, blurb: slack.blurb, example: slack.example, state: .connected, via: "box")
  let onBox = [gmail, slack, notion, linear]

  func make(_ name: String, height: CGFloat, _ configure: (ConnectionsModel) -> Void) {
    let model = ConnectionsModel()
    configure(model)
    let content = ConnectionsContent(model: model)
      .padding(.horizontal, 32)
      .padding(.top, 26)
      .padding(.bottom, 28)
      .frame(width: ConnectionsLayout.size.width, height: height, alignment: .top)
      .background(Color.black)
      .foregroundStyle(.white)
      .environment(\.colorScheme, .dark)
      .environment(\.offscreenRender, true)
    let renderer = ImageRenderer(content: content)
    renderer.scale = 2
    guard let img = renderer.nsImage, let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
          let png = bmp.representation(using: .png, properties: [:])
    else { return print("render failed: \(name)") }
    try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
    print("rendered \(name)")
  }

  make("connections-first.png", height: 600) { $0.stage(onBox) }
  make("connections-dev.png", height: 640) { $0.stage([claude, gmailKey, fathom, slack]) }
  make("connections-gmail-key.png", height: 960) { $0.stage([claudeOn, gmailKey, fathomOn], googleKey: true) }
  make("connections-connected.png", height: 720) {
    $0.stage([claudeOn, gmailOn, slackOn, notion, linear], notes: ["gmail": .init(text: "Gmail is connected — try it from the notch.", warn: false)])
  }
}
