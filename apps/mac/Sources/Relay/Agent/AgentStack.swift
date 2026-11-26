import SwiftUI

// Many jobs at once, without turning the notch into a dashboard. The notch has one job — tell
// you when something needs you — so everything else is a glance and, if you want it, a peek:
//
// - the glance, resting beside the notch: who's working (their characters, stacked, one per
//   job) and how much waits for you (a count). Progress never pops anything up.
// - the stack — tap the glance: one row per job. What needs you first, then who's working and
//   on which step, then answers that came back while you were elsewhere. Tap a row to open it.
// - everything else — history, every step — is in the Command Center: "All ↗".

/// Sizes for the glance and the stack.
enum AgentStackLayout {
  /// the stacked characters beside the notch
  static let avatar: CGFloat = 20
  /// how far each one tucks under the one in front of it
  static let overlap: CGFloat = 8
  static let maxAvatars = 3
  static let row: CGFloat = 46
  static let maxRows = 5
  static let footer: CGFloat = 34

  /// Each ear fits the stacked characters (and "+2"), or a count — never narrower than the
  /// plain ear, so one job looks exactly as it always has.
  static func earWidth(_ g: AgentNotchState.Glance) -> CGFloat {
    let shown = min(g.working.count, maxAvatars)
    let stack = shown == 0 ? avatar : avatar + CGFloat(shown - 1) * (avatar - overlap)
    let more: CGFloat = g.working.count > maxAvatars ? 18 : 0
    var w = max(AgentLayout.ear, stack + more + 14)
    if g.waiting + g.unread > 0 { w = max(w, AgentLayout.badgeEar) }
    return w
  }

  /// Below the notch: a little air, the rows (at most `maxRows`), the footer.
  static func height(rows: Int) -> CGFloat {
    6 + CGFloat(min(rows, maxRows)) * row + footer
  }
}

/// Who's working, at a glance: their characters overlapping, the newest in front; "+2" for the rest.
struct StackedAgents: View {
  var agents: [String?]
  /// renders hold them still; nil = they hop along
  var time: TimeInterval?

  var body: some View {
    HStack(spacing: 3) {
      HStack(spacing: -AgentStackLayout.overlap) {
        ForEach(Array(agents.prefix(AgentStackLayout.maxAvatars).enumerated()), id: \.offset) { i, agent in
          // each a beat apart in renders, so they don't all hop in step
          AgentCharacter(agent: AgentID(agent), mood: .working, size: AgentStackLayout.avatar,
                         time: time.map { $0 + Double(i) * 0.31 })
            .zIndex(Double(-i)) // the newest (first) sits in front
        }
      }
      if agents.count > AgentStackLayout.maxAvatars {
        Text("+\(agents.count - AgentStackLayout.maxAvatars)")
          .font(.system(size: 10.5, weight: .bold, design: .rounded))
          .foregroundStyle(.white.opacity(0.7))
      }
    }
  }
}

/// The stack, opened from the glance: one row per job, what needs you on top.
struct AgentStackCard: View {
  @ObservedObject var state: AgentNotchState
  var actions: AgentActions

  var body: some View {
    let rows = state.stackRows
    VStack(spacing: 0) {
      Color.clear.frame(height: state.notchTopInset + 6)
      ForEach(rows.prefix(AgentStackLayout.maxRows)) { t in
        Button { actions.openTicket(t.id) } label: { AgentStackRow(ticket: t, still: state.stillTime) }
          .buttonStyle(.plain)
      }
      footer(more: rows.count - AgentStackLayout.maxRows)
    }
  }

  /// "+2 more", and the way to everything else.
  private func footer(more: Int) -> some View {
    HStack(spacing: 6) {
      if more > 0 {
        Text("+\(more) more")
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(.white.opacity(0.4))
      }
      Spacer(minLength: 0)
      Button(action: actions.showAll) {
        HStack(spacing: 4) {
          Text("All").font(.system(size: 11.5, weight: .semibold))
          Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .bold))
        }
        .foregroundStyle(.white.opacity(0.6))
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(.white.opacity(0.08)))
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, AgentLayout.pad)
    .frame(height: AgentStackLayout.footer)
  }
}

/// One job: who · what it is · where it's at.
struct AgentStackRow: View {
  let ticket: AgentTicket
  /// renders hold the character and the clock still; nil = live
  var still: TimeInterval?

  var body: some View {
    HStack(spacing: 10) {
      AgentCharacter(agent: AgentID(ticket.agent), mood: mood, size: 22, time: still)
      VStack(alignment: .leading, spacing: 2) {
        Text(headline)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(.white.opacity(0.92))
          .lineLimit(1)
          .truncationMode(.tail)
        status
          .font(.system(size: 11, weight: .medium))
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 6)
      trailing
    }
    .padding(.horizontal, AgentLayout.pad)
    .frame(height: AgentStackLayout.row)
    .contentShape(Rectangle())
  }

  /// It's waiting on you: a draft, a sign-in, or a question it came back with.
  private var asksYou: Bool { ticket.needsYou || ticket.answer?.tone == "needs_you" }

  private var mood: AgentMood {
    if asksYou { return .needsYou }
    if ticket.working { return .working }
    return ticket.status == "done" ? .done : .idle
  }

  /// The first line: what it is — the draft, the sign-in, the answer, or the job you asked for.
  private var headline: String {
    if ticket.awaitingYou, let p = ticket.proposal { return p.summary }
    if let k = ticket.awaitingTakeover { return k.reason }
    if let a = ticket.answer { return a.headline }
    return ticket.title
  }

  /// The second line: where it's at. Working shows the step it's on — that's the progress.
  @ViewBuilder private var status: some View {
    if ticket.awaitingYou {
      Text("Needs your OK").foregroundStyle(AgentLayout.amber)
    } else if ticket.awaitingTakeover != nil {
      Text("Needs you to sign in on Relay’s computer").foregroundStyle(AgentLayout.amber)
    } else if ticket.answer?.tone == "needs_you" {
      Text("Needs your answer").foregroundStyle(AgentLayout.amber)
    } else if ticket.working {
      Text(ticket.progress ?? "Starting…").foregroundStyle(.white.opacity(0.55))
    } else if ticket.status == "failed" {
      Text("Couldn’t finish — \(ticket.error ?? "unknown error")").foregroundStyle(AgentLayout.amber)
    } else {
      HStack(spacing: 0) {
        Text("Done").foregroundStyle(AgentLayout.green)
        if let basis = ticket.answer?.basis, !basis.isEmpty {
          Text(" · \(basis)").foregroundStyle(.white.opacity(0.45))
        }
      }
    }
  }

  @ViewBuilder private var trailing: some View {
    if asksYou {
      Text("Open")
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(.black)
        .padding(.horizontal, 10)
        .padding(.vertical, 3.5)
        .background(Capsule().fill(AgentLayout.amber))
    } else if ticket.working {
      Elapsed(since: ticket.createdAt, now: still == nil ? nil : ticket.updatedAt)
    } else {
      Image(systemName: "chevron.right")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(.white.opacity(0.35))
    }
  }
}

/// How long a job has been going — "0:42", "12:05", "1:02:10" — ticking while live.
struct Elapsed: View {
  /// when it started (ms since 1970)
  var since: Double?
  /// a fixed "now" for renders (ms since 1970); nil = the clock
  var now: Double?

  var body: some View {
    if let since {
      if let now {
        label(now - since)
      } else {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
          label(timeline.date.timeIntervalSince1970 * 1000 - since)
        }
      }
    }
  }

  private func label(_ ms: Double) -> some View {
    let s = max(0, Int(ms / 1000))
    let text = s >= 3600
      ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
      : String(format: "%d:%02d", s / 60, s % 60)
    return Text(text)
      .font(.system(size: 11, weight: .medium).monospacedDigit())
      .foregroundStyle(.white.opacity(0.45))
  }
}
