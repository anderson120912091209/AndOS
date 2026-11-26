import AppKit
import SwiftUI

// How an agent's answer shows in the notch (packages/shared answer.ts). The agent hands back
// the conclusion first, at most one structured block, and what you might say next; the notch
// picks the container from the shape — one line under the notch (AnswerChin), a card
// (AnswerCard), or the reader for long writing (ReaderCard). Nothing is shrunk or cut off: a
// longer answer moves to a container that fits it.

enum AnswerLayout {
  /// The card grows with its answer up to here (under the notch), then its middle scrolls. Real
  /// answers — four clinics with hours, a caveat, three follow-ups — run to about this.
  static let cardMax: CGFloat = 440
  static let readerWidth: CGFloat = 640
  static let readerMax: CGFloat = 660
  static let readerRadius: CGFloat = 30
  static let pad: CGFloat = 18
  static let readerPad: CGFloat = 22
  static let eyebrow: CGFloat = 34
  static let chip: CGFloat = 26
  static let gap: CGFloat = 6
  static let red = Color(red: 1.0, green: 0.54, blue: 0.48)
}

extension AgentTicket.Answer {
  var needsYou: Bool { tone == "needs_you" }
  /// Something beyond the headline worth opening a card for.
  var hasMore: Bool { !(note ?? "").isEmpty || !(followups ?? []).isEmpty }

  var mood: AgentMood {
    needsYou ? .needsYou : .done
  }

  /// What the reader shows as its title, and the markdown under it.
  var readerTitle: String { block?.title ?? headline }
  var readerMarkdown: String { block?.markdown ?? block?.body ?? "" }
}

// MARK: - Sizes

/// Sizes worked out before drawing, so the panel can be placed (and morph) to the right size the
/// way AgentNotchState sizes the other forms. SwiftUI measures the very views it will draw — same
/// fonts, wrapping, CJK fallback and spacing — once per answer.
@MainActor
enum AnswerMetrics {
  private static var cache: [String: CGSize] = [:]

  private static func measure<V: View>(_ key: String, width: CGFloat?, _ view: () -> V) -> CGSize {
    if let hit = cache[key] { return hit }
    let host = NSHostingView(rootView: view().frame(width: width).fixedSize(horizontal: width == nil, vertical: true))
    let size = host.fittingSize
    if cache.count > 64 { cache.removeAll() }
    cache[key] = size
    return size
  }

  private static func key(_ t: AgentTicket, _ part: String) -> String { "\(part)|\(t.id)|\(t.updatedAt)" }

  static func chinWidth(_ t: AgentTicket, notch: CGFloat) -> CGFloat {
    let w = measure(key(t, "chin"), width: nil) { AnswerChinRow(ticket: t, still: 0) }.width
    return min(480, max(notch + 2 * AgentLayout.badgeEar, ceil(w)))
  }

  /// Everything under the notch inset, up to the cap; past it the card scrolls.
  static func cardHeight(_ t: AgentTicket) -> CGFloat { card(t).height }

  /// Whether the card's middle is taller than the room it gets (so it scrolls, and fades out).
  static func cardScrolls(_ t: AgentTicket) -> Bool { card(t).scrolls }

  private static func card(_ t: AgentTicket) -> (height: CGFloat, scrolls: Bool) {
    guard let a = t.answer else { return (150, false) }
    let w = AgentLayout.cardWidth
    let body = measure(key(t, "card-body"), width: w) { AnswerBody(answer: a, actions: AgentActions()) }.height
    let foot = measure(key(t, "card-foot"), width: w) { AnswerFooter(answer: a, actions: AgentActions()) }.height
    let all = AnswerLayout.eyebrow + ceil(body) + ceil(foot)
    return (min(all, AnswerLayout.cardMax), all > AnswerLayout.cardMax)
  }

  static func readerHeight(_ t: AgentTicket, available: CGFloat) -> CGFloat {
    guard let a = t.answer else { return 300 }
    let w = AnswerLayout.readerWidth
    let title = measure(key(t, "reader-title"), width: w) { ReaderTitle(answer: a) }.height
    let body = measure(key(t, "reader-body"), width: w) { ReaderBody(answer: a) }.height
    let chips = measure(key(t, "reader-chips"), width: w) { ReaderFollowUps(answer: a, actions: AgentActions()) }.height
    let all = AnswerLayout.eyebrow + title + 1 + body + chips
    return min(ceil(all), AnswerLayout.readerMax, max(320, available * 0.72))
  }
}

// MARK: - One line under the notch

/// "Relay · 這個月 Uber 花了 NT$3,420" — when the headline is the whole answer, this is all
/// there is. A bigger answer gets the same line with Open / Read, and opens from it.
struct AnswerChin: View {
  let ticket: AgentTicket
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions

  var body: some View {
    if let a = ticket.answer {
      Button(action: { opens(a) ? actions.open() : actions.dismiss() }) {
        VStack(spacing: 0) {
          Color.clear.frame(height: state.notchTopInset)
          AnswerChinRow(ticket: ticket, still: state.stillTime)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    }
  }

  /// A one-line answer with nothing more to it just goes away when you tap it.
  private func opens(_ a: AgentTicket.Answer) -> Bool {
    ticket.placement != "chin" || a.hasMore
  }
}

struct AnswerChinRow: View {
  let ticket: AgentTicket
  var still: TimeInterval?

  var body: some View {
    if let a = ticket.answer {
      HStack(spacing: 9) {
        AgentCharacter(agent: AgentID(ticket.agent), mood: a.mood, size: 22, time: still)
        if a.needsYou {
          Text("Needs you").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentLayout.amber)
        }
        Text(a.headline)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 4)
        trailing(a)
      }
      .padding(.horizontal, AgentLayout.pad)
      .frame(height: AgentLayout.chinRow)
    }
  }

  @ViewBuilder private func trailing(_ a: AgentTicket.Answer) -> some View {
    if ticket.placement == "chin" {
      if a.hasMore {
        Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.4))
      }
    } else {
      Text(ticket.placement == "reader" ? "Read" : "Open")
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(.black)
        .padding(.horizontal, 10)
        .padding(.vertical, 3.5)
        .background(Capsule().fill(a.needsYou ? AgentLayout.amber : .white.opacity(0.9)))
    }
  }
}

// MARK: - The card

/// Who did it · the conclusion · one block · what you might say next.
struct AnswerCard: View {
  let ticket: AgentTicket
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions

  var body: some View {
    if let a = ticket.answer {
      VStack(spacing: 0) {
        Color.clear.frame(height: state.notchTopInset)
        AnswerEyebrow(ticket: ticket, answer: a, state: state, actions: actions)
          .padding(.leading, AnswerLayout.pad)
        Scrolling(enabled: state.scrollableBody) { AnswerBody(answer: a, actions: actions) }
          .overlay(alignment: .bottom) {
            if AnswerMetrics.cardScrolls(ticket) {
              // there's more above the follow-ups: say so without a scroll bar
              LinearGradient(colors: [.black.opacity(0), .black], startPoint: .top, endPoint: .bottom)
                .frame(height: 24)
                .allowsHitTesting(false)
            }
          }
        // The follow-ups stay put under a long answer — the next step is never below the fold.
        AnswerFooter(answer: a, actions: actions)
      }
    }
  }
}

struct AnswerFooter: View {
  let answer: AgentTicket.Answer
  var actions: AgentActions

  var body: some View {
    FollowUps(followups: answer.followups ?? [], actions: actions)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, AnswerLayout.pad)
      .padding(.top, 12)
      .padding(.bottom, 15)
  }
}

/// Everything between the eyebrow and the follow-ups: the conclusion, the block, a note.
struct AnswerBody: View {
  let answer: AgentTicket.Answer
  var actions: AgentActions

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 8) {
        if answer.tone == "done" {
          Image(systemName: "checkmark")
            .font(.system(size: 10, weight: .heavy))
            .foregroundStyle(.black)
            .frame(width: 18, height: 18)
            .background(Circle().fill(AgentLayout.green))
            .padding(.top, 1)
        }
        Text(answer.headline)
          .font(.system(size: 15.5, weight: .semibold))
          .foregroundStyle(.white.opacity(0.96))
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, AnswerLayout.pad)
      .padding(.top, 7)
      .padding(.bottom, 12)

      if let b = answer.block { BlockView(block: b, actions: actions) }

      if let note = answer.note {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Image(systemName: "info.circle").font(.system(size: 10, weight: .semibold))
          Text(note).font(.system(size: 11.5)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.white.opacity(0.45))
        .padding(.horizontal, AnswerLayout.pad)
        .padding(.top, 10)
      }
      Color.clear.frame(height: 1)
    }
  }
}

/// "Relay · 讀完 40 封未讀            ⌃" — who did it, what it went through, and put it away.
struct AnswerEyebrow<Trailing: View>: View {
  let ticket: AgentTicket
  let answer: AgentTicket.Answer
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions
  var trailing: Trailing

  init(ticket: AgentTicket, answer: AgentTicket.Answer, state: AgentNotchState, actions: AgentActions,
       @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
    self.ticket = ticket
    self.answer = answer
    self.state = state
    self.actions = actions
    self.trailing = trailing()
  }

  var body: some View {
    let agent = AgentID(ticket.agent)
    HStack(spacing: 7) {
      AgentCharacter(agent: agent, mood: answer.mood, size: 20, time: state.stillTime)
      Text(agent.name).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
      if let basis = answer.basis {
        Text("·").foregroundStyle(.white.opacity(0.3))
        Text(basis).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
      }
      Spacer(minLength: 6)
      if answer.needsYou {
        HStack(spacing: 5) {
          Circle().fill(AgentLayout.amber).frame(width: 6, height: 6)
          Text("Needs you").foregroundStyle(AgentLayout.amber)
        }
        .padding(.trailing, 4)
      }
      trailing
      Button(action: actions.collapse) {
        Image(systemName: "chevron.up")
          .font(.system(size: 10.5, weight: .bold))
          .foregroundStyle(.white.opacity(0.55))
          .frame(width: 22, height: 22)
          .background(Circle().fill(.white.opacity(0.08)))
      }
      .buttonStyle(.plain)
      .help("Later — put it away")
    }
    .font(.system(size: 11.5, weight: .medium))
    .padding(.trailing, 14)
    .padding(.top, 8)
    .frame(height: AnswerLayout.eyebrow)
  }
}

/// Scrolls when it can; headless renders can't draw scroll views, so they clip instead.
struct Scrolling<Content: View>: View {
  var enabled: Bool
  @ViewBuilder var content: Content

  var body: some View {
    if enabled {
      // No text selection: selecting would make the panel key and pull focus from your app.
      ScrollView(.vertical, showsIndicators: false) { content }
    } else {
      content.frame(maxHeight: .infinity, alignment: .top).clipped()
    }
  }
}

// MARK: - Blocks

struct BlockView: View {
  let block: AgentTicket.Block
  var actions: AgentActions

  var body: some View {
    switch block.kind {
    case "text":
      Text(block.body ?? "")
        .font(.system(size: 12.5))
        .lineSpacing(3)
        .foregroundStyle(.white.opacity(0.86))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AnswerLayout.pad)
        .padding(.bottom, 6)
    case "list": ListBlock(items: block.items ?? [], more: block.more)
    case "facts": FactsBlock(rows: block.rows ?? [])
    case "compare": CompareBlock(columns: block.columns ?? [], rows: block.rows ?? [], pick: block.pick)
    case "choice": ChoiceBlock(options: block.options ?? [], recommended: block.recommended, actions: actions)
    default: EmptyView()
    }
  }
}

/// Emails to answer, results, steps: a monogram, the title and why, a coloured tag.
struct ListBlock: View {
  let items: [AgentTicket.Item]
  let more: String?

  static func rowHeight(_ item: AgentTicket.Item) -> CGFloat { item.detail == nil ? 40 : 48 }
  static let moreHeight: CGFloat = 33

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.offset) { n, item in
        row(item)
          .overlay(alignment: .top) { if n > 0 { hairline.padding(.horizontal, 10) } }
      }
      if let more {
        Text(more)
          .font(.system(size: 12))
          .foregroundStyle(.white.opacity(0.55))
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .frame(height: Self.moreHeight - 10)
          .padding(.top, 10)
          .overlay(alignment: .top) { hairline }
          .padding(.horizontal, 10)
      }
    }
    .padding(.horizontal, 8)
  }

  private func row(_ item: AgentTicket.Item) -> some View {
    HStack(spacing: 11) {
      Monogram(text: item.title)
      VStack(alignment: .leading, spacing: 2) {
        (Text(item.title).fontWeight(.semibold).foregroundColor(.white.opacity(0.96))
          + Text(item.sub.map { "  \($0)" } ?? "").foregroundColor(.white.opacity(0.55)))
          .font(.system(size: 13))
          .lineLimit(1)
        if let detail = item.detail {
          Text(detail).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
        }
      }
      Spacer(minLength: 6)
      if let tag = item.tag { TagPill(text: tag, tone: item.tone) }
    }
    .padding(.horizontal, 10)
    .frame(height: Self.rowHeight(item))
  }

  private var hairline: some View { Rectangle().fill(.white.opacity(0.08)).frame(height: 1) }
}

struct Monogram: View {
  let text: String

  private static let palette: [Color] = [
    Color(red: 0.31, green: 0.42, blue: 0.93), Color(red: 0.85, green: 0.40, blue: 0.55),
    Color(red: 0.39, green: 0.36, blue: 1.00), Color(red: 0.88, green: 0.53, blue: 0.29),
    Color(red: 0.25, green: 0.65, blue: 0.59), Color(red: 0.56, green: 0.42, blue: 0.91),
    Color(red: 0.79, green: 0.62, blue: 0.16),
  ]

  var body: some View {
    let hash = text.unicodeScalars.reduce(0) { $0 &* 31 &+ Int($1.value) }
    let color = Self.palette[Int(UInt(bitPattern: hash) % UInt(Self.palette.count))]
    Text(text.first.map { String($0).uppercased() } ?? "•")
      .font(.system(size: 12.5, weight: .semibold))
      .foregroundStyle(.white)
      .frame(width: 30, height: 30)
      .background(Circle().fill(color))
  }
}

struct TagPill: View {
  let text: String
  let tone: String?

  var body: some View {
    let color: Color
    switch tone {
    case "amber": color = AgentLayout.amber
    case "red": color = AnswerLayout.red
    case "green": color = AgentLayout.green
    default: color = .white.opacity(0.6)
    }
    return Text(text)
      .font(.system(size: 10.5, weight: .semibold))
      .foregroundStyle(color)
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 2.5)
      .background(Capsule().fill(color.opacity(tone == nil ? 0.12 : 0.14)))
  }
}

/// A booking, a receipt, what would be sent: label → value.
struct FactsBlock: View {
  let rows: [AgentTicket.Row]
  static let row: CGFloat = 18
  static let spacing: CGFloat = 8

  var body: some View {
    VStack(alignment: .leading, spacing: Self.spacing) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(r.label)
            .font(.system(size: 11.5))
            .foregroundStyle(.white.opacity(0.4))
            .lineLimit(1)
            .frame(width: 64, alignment: .leading)
          Text(r.value ?? "")
            .font(.system(size: 12.5))
            .foregroundStyle(.white.opacity(0.94))
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .frame(height: Self.row)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, AnswerLayout.pad)
    .padding(.bottom, 2)
  }
}

/// Options side by side, the recommended column lit.
struct CompareBlock: View {
  let columns: [String]
  let rows: [AgentTicket.Row]
  let pick: Int?
  static let header: CGFloat = 32
  static let row: CGFloat = 30

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        Color.clear.frame(height: Self.header)
        ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
          Text(r.label)
            .font(.system(size: 11))
            .foregroundStyle(.white.opacity(0.4))
            .lineLimit(1)
            .frame(height: Self.row, alignment: .leading)
        }
      }
      .frame(width: 50, alignment: .leading)
      ForEach(Array(columns.enumerated()), id: \.offset) { c, name in column(c, name) }
    }
    .padding(.leading, AnswerLayout.pad)
    .padding(.trailing, 12)
    .padding(.bottom, 6)
  }

  private func column(_ c: Int, _ name: String) -> some View {
    let picked = c == pick
    return VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 5) {
        Text(name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white.opacity(0.96)).lineLimit(1)
        if picked {
          Image(systemName: "checkmark.seal.fill").font(.system(size: 10.5)).foregroundStyle(AgentLayout.green)
        }
      }
      .frame(height: Self.header, alignment: .leading)
      ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
        let value = c < (r.values?.count ?? 0) ? r.values![c] : "—"
        Text(value)
          .font(.system(size: 12, weight: picked ? .semibold : .regular))
          .foregroundStyle(.white.opacity(picked ? 0.96 : 0.8))
          .lineLimit(1)
          .frame(height: Self.row, alignment: .leading)
      }
    }
    .padding(.horizontal, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      if picked {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(AgentLayout.green.opacity(0.07))
          .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(AgentLayout.green.opacity(0.34), lineWidth: 1))
      }
    }
  }
}

/// It needs you to decide: each option is a button, and tapping one answers it.
struct ChoiceBlock: View {
  let options: [AgentTicket.Option]
  let recommended: Int?
  var actions: AgentActions
  static let row: CGFloat = 44

  var body: some View {
    VStack(spacing: AnswerLayout.gap) {
      ForEach(Array(options.enumerated()), id: \.offset) { n, o in
        let rec = n == recommended
        Button(action: { actions.followUp(o.label) }) {
          HStack(spacing: 12) {
            Text(o.label).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(.white.opacity(0.96)).lineLimit(1)
            Spacer(minLength: 8)
            if let note = o.note {
              Text(note)
                .font(.system(size: 11.5, weight: rec ? .medium : .regular))
                .foregroundStyle(rec ? AgentLayout.blue : .white.opacity(0.4))
                .lineLimit(1)
            }
          }
          .padding(.horizontal, 14)
          .frame(height: Self.row)
          .background(RoundedRectangle(cornerRadius: 13, style: .continuous).fill(rec ? AgentLayout.blue.opacity(0.1) : .white.opacity(0.075)))
          .overlay {
            if rec { RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(AgentLayout.blue.opacity(0.5), lineWidth: 1) }
          }
          .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 12)
  }
}

// MARK: - What you might say next

/// The agent's suggested next requests, as buttons; tapping one asks it, carrying on from this
/// answer. The mic hint says you can just say something else.
struct FollowUps: View {
  let followups: [String]
  var actions: AgentActions

  var body: some View {
    FlowLayout(spacing: AnswerLayout.gap) {
      ForEach(Array(followups.enumerated()), id: \.offset) { _, f in
        Button(action: { actions.followUp(f) }) {
          HStack(spacing: 5) {
            Image(systemName: "arrow.turn.down.right").font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.38))
            Text(f).font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
          }
          .padding(.horizontal, 11)
          .frame(height: AnswerLayout.chip)
          .background(Capsule().fill(.white.opacity(0.075)))
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
      }
      HStack(spacing: 4) {
        Image(systemName: "mic.fill").font(.system(size: 9, weight: .semibold))
        Text("fn ⌃").font(.system(size: 11, weight: .semibold))
      }
      .foregroundStyle(.white.opacity(0.45))
      .padding(.horizontal, 9)
      .frame(height: AnswerLayout.chip)
      .overlay(Capsule().stroke(.white.opacity(0.13), lineWidth: 1))
      .help("Hold fn ⌃ and say what's next")
    }
  }
}

/// Lays its children out like words: left to right, wrapping onto a new line when full.
struct FlowLayout: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(ProposedViewSize(width: width, height: nil))
      if x > 0, x + s.width > width {
        x = 0
        y += line + spacing
        line = 0
      }
      x += s.width + spacing
      line = max(line, s.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: width.isFinite ? width : widest, height: y + line)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
      if x > bounds.minX, x + s.width > bounds.maxX {
        x = bounds.minX
        y += line + spacing
        line = 0
      }
      v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
      x += s.width + spacing
      line = max(line, s.height)
    }
  }
}

// MARK: - The reader

/// Long writing — a report, a plan — grows on from the card: read it here, keep it in an app.
struct ReaderCard: View {
  let ticket: AgentTicket
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions

  var body: some View {
    if let a = ticket.answer {
      VStack(spacing: 0) {
        Color.clear.frame(height: state.notchTopInset)
        AnswerEyebrow(ticket: ticket, answer: readingTime(a), state: state, actions: actions) {
          headerButton(state.copied ? "Copied" : "Copy", symbol: state.copied ? "checkmark" : "doc.on.doc", action: actions.copyAnswer)
          headerButton("Open in App", symbol: "arrow.up.forward.app", action: actions.openInApp)
            .padding(.trailing, 4)
        }
        .padding(.leading, AnswerLayout.readerPad)
        ReaderTitle(answer: a)
        Rectangle().fill(.white.opacity(0.08)).frame(height: 1)
        Scrolling(enabled: state.scrollableBody) { ReaderBody(answer: a) }
        ReaderFollowUps(answer: a, actions: actions)
      }
    }
  }

  /// The eyebrow under the reader says how long it is, when the agent didn't say what it read.
  private func readingTime(_ a: AgentTicket.Answer) -> AgentTicket.Answer {
    var a = a
    if a.basis == nil { a.basis = "\(Markdown.minutes(a.readerMarkdown)) min read" }
    return a
  }

  private func headerButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol).font(.system(size: 9.5, weight: .semibold))
        Text(title).font(.system(size: 11.5, weight: .medium))
      }
      .foregroundStyle(.white.opacity(0.8))
      .padding(.horizontal, 10)
      .frame(height: 24)
      .background(Capsule().fill(.white.opacity(0.08)))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
  }
}

struct ReaderTitle: View {
  let answer: AgentTicket.Answer

  var body: some View {
    Text(answer.readerTitle)
      .font(.system(size: 19, weight: .semibold))
      .foregroundStyle(.white.opacity(0.96))
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, AnswerLayout.readerPad)
      .padding(.top, 6)
      .padding(.bottom, 14)
  }
}

/// The conclusion in its box (when the title isn't already it), then the write-up.
struct ReaderBody: View {
  let answer: AgentTicket.Answer

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if answer.headline != answer.readerTitle {
        Text(answer.headline)
          .font(.system(size: 13.5, weight: .medium))
          .foregroundStyle(.white.opacity(0.96))
          .lineSpacing(3)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 14)
          .padding(.vertical, 11)
          .background(Callout())
          .padding(.bottom, 14)
      }
      MarkdownView(blocks: Markdown.blocks(answer.readerMarkdown))
    }
    .padding(.horizontal, AnswerLayout.readerPad)
    .padding(.vertical, 16)
  }
}

struct ReaderFollowUps: View {
  let answer: AgentTicket.Answer
  var actions: AgentActions

  var body: some View {
    FollowUps(followups: answer.followups ?? [], actions: actions)
      .padding(.horizontal, AnswerLayout.readerPad)
      .padding(.top, 6)
      .padding(.bottom, 18)
  }
}

/// The soft green box a conclusion (or a > quote) sits in.
struct Callout: View {
  var body: some View {
    RoundedRectangle(cornerRadius: 12, style: .continuous)
      .fill(AgentLayout.green.opacity(0.07))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(AgentLayout.green.opacity(0.22), lineWidth: 1))
  }
}

// MARK: - Markdown, block by block

/// Just enough Markdown for an agent's write-up: headings, paragraphs, lists, quotes, code,
/// tables and rules. Inline styling (bold, italics, code, links) is SwiftUI's own.
enum Markdown {
  enum Block: Hashable {
    case heading(Int, String)
    case paragraph(String)
    case item(String, marker: String, level: Int)
    case quote(String)
    case code(String)
    case table([[String]])
    case rule
  }

  static func blocks(_ markdown: String) -> [Block] {
    var out: [Block] = []
    var paragraph: [String] = []
    var table: [[String]] = []
    var code: [String]?

    func flush() {
      if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
      if !table.isEmpty { out.append(.table(table)) }
      table = []
    }

    for raw in markdown.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if var lines = code {
        if line.hasPrefix("```") {
          out.append(.code(lines.joined(separator: "\n")))
          code = nil
        } else {
          lines.append(raw)
          code = lines
        }
        continue
      }
      if line.hasPrefix("```") {
        flush()
        code = []
      } else if line.hasPrefix("|") {
        if !paragraph.isEmpty { flush() }
        let cells = line.split(separator: "|", omittingEmptySubsequences: false).dropFirst().dropLast()
          .map { $0.trimmingCharacters(in: .whitespaces) }
        if !cells.allSatisfy({ $0.range(of: #"^:?-{2,}:?$"#, options: .regularExpression) != nil }) { table.append(cells) }
      } else if line.isEmpty {
        flush()
      } else if let heading = heading(line) {
        flush()
        out.append(heading)
      } else if ["---", "***", "___"].contains(line) {
        flush()
        out.append(.rule)
      } else if line.hasPrefix(">") {
        flush()
        let text = String(line.drop(while: { $0 == ">" || $0 == " " }))
        if case let .quote(before)? = out.last {
          out[out.count - 1] = .quote(before + "\n" + text)
        } else {
          out.append(.quote(text))
        }
      } else if let item = item(raw) {
        flush()
        out.append(item)
      } else {
        if !table.isEmpty { flush() }
        paragraph.append(line)
      }
    }
    if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
    flush()
    return out
  }

  private static func heading(_ line: String) -> Block? {
    let hashes = line.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
    return .heading(hashes, String(line.dropFirst(hashes + 1)))
  }

  private static func item(_ raw: String) -> Block? {
    let indent = raw.prefix(while: { $0 == " " }).count
    let line = raw.dropFirst(indent)
    let level = min(indent / 2, 2)
    if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
      return .item(String(line.dropFirst(2)), marker: "•", level: level)
    }
    if let r = line.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
      return .item(String(line[r.upperBound...]), marker: String(line[r]).trimmingCharacters(in: .whitespaces), level: level)
    }
    return nil
  }

  /// Inline Markdown, styled by SwiftUI; plain text if it doesn't parse.
  static func inline(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
  }

  /// Reading time: ~400 Chinese characters or ~220 English words a minute.
  static func minutes(_ s: String) -> Int {
    let wide = s.unicodeScalars.filter { (0x2E80...0x9FFF).contains($0.value) || (0xAC00...0xD7A3).contains($0.value) }.count
    let words = s.split(whereSeparator: { $0.isWhitespace }).count
    return max(1, Int((Double(wide) / 400 + Double(words) / 220).rounded()))
  }
}

struct MarkdownView: View {
  let blocks: [Markdown.Block]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in view(b) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private func view(_ b: Markdown.Block) -> some View {
    switch b {
    case let .heading(level, s):
      Text(Markdown.inline(s))
        .font(.system(size: level <= 2 ? 15 : 13.5, weight: .semibold))
        .foregroundStyle(.white.opacity(0.96))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 14)
        .padding(.bottom, 4)
    case let .paragraph(s):
      Text(Markdown.inline(s))
        .font(.system(size: 13.5))
        .lineSpacing(4.5)
        .foregroundStyle(.white.opacity(0.84))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 4)
    case let .item(s, marker, level):
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        Text(marker).font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.4)).frame(width: 14, alignment: .trailing)
        Text(Markdown.inline(s))
          .font(.system(size: 13.5))
          .lineSpacing(3)
          .foregroundStyle(.white.opacity(0.84))
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.leading, CGFloat(level) * 14)
      .padding(.vertical, 2.5)
    case let .quote(s):
      Text(Markdown.inline(s))
        .font(.system(size: 13.5))
        .lineSpacing(3)
        .foregroundStyle(.white.opacity(0.92))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Callout())
        .padding(.vertical, 5)
    case let .code(s):
      Text(verbatim: s)
        .font(.system(size: 12, design: .monospaced))
        .foregroundStyle(.white.opacity(0.85))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.white.opacity(0.06)))
        .padding(.vertical, 4)
    case let .table(rows):
      Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 0) {
        ForEach(Array(rows.enumerated()), id: \.offset) { r, cells in
          GridRow {
            ForEach(Array(cells.enumerated()), id: \.offset) { c, cell in
              Text(Markdown.inline(cell))
                .font(.system(size: r == 0 ? 12.5 : (c == 0 ? 11.5 : 12.5), weight: r == 0 ? .semibold : .regular))
                .foregroundStyle(.white.opacity(r == 0 ? 0.96 : (c == 0 ? 0.45 : 0.82)))
                .lineLimit(1)
                .frame(maxWidth: c == 0 ? nil : .infinity, minHeight: 28, maxHeight: 28, alignment: .leading)
            }
          }
          // its own row: anything but a GridRow spans the grid (a modifier on the row would too)
          Rectangle().fill(.white.opacity(r == 0 ? 0.14 : 0.08)).frame(height: 1).gridCellUnsizedAxes(.horizontal)
        }
      }
      .padding(.vertical, 5)
    case .rule:
      Rectangle().fill(.white.opacity(0.08)).frame(height: 1).padding(.vertical, 8)
    }
  }
}
