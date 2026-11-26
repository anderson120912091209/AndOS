import Foundation

/// An agent task as the notch sees it — the slice of the server's Task JSON (packages/shared
/// task.ts + proposal.ts) needed to show "working", "ready for your OK", and how it ended.
struct AgentTicket: Decodable, Equatable, Identifiable {
  let id: String
  let kind: String
  let title: String
  let utterance: String
  let status: String
  let updatedAt: Double
  let proposal: Proposal?
  let result: Result?
  let error: String?
  /// Set while the agent waits for you to sign in on the box browser (status needs_input).
  var takeover: Takeover? = nil
  /// What you were looking at when you asked — re-sent if the request has to run again.
  var context: Context? = nil
  /// Which of Relay's agents took it (packages/shared agents.ts) — the character the notch shows.
  var agent: String? = nil
  /// When you asked (ms since 1970) — how long it's been going, in the stack.
  var createdAt: Double? = nil
  /// What it's done so far, oldest first — the newest is "what it's doing now", in the stack.
  var steps: [Step]? = nil

  struct Takeover: Decodable, Equatable {
    let id: String
    let reason: String
    let service: String
    var url: String? = nil
  }

  /// One line of the server's step log (packages/shared task.ts). Lenient on purpose: a step
  /// that's missing a field mustn't stop the whole ticket from decoding.
  struct Step: Decodable, Equatable {
    var type: String? = nil // "think" | "act" | "tool" | "observe" | "note" | "result"
    var text: String? = nil
  }

  struct Context: Codable, Equatable {
    var appName: String?
    var url: String?
    var windowTitle: String?
    var selectionText: String?
    var timeZone: String?
  }

  struct Proposal: Decodable, Equatable {
    let id: String
    let verb: String
    let summary: String
    let preview: Preview
    let decision: Decision?
    let committedAt: Double?
  }

  /// One shape for every artifact kind; `kind` says which fields are filled in.
  struct Preview: Decodable, Equatable {
    let kind: String // "email" | "event" | "note"
    var to: [String]? = nil
    var cc: [String]? = nil
    var subject: String? = nil
    var body: String? = nil
    var title: String? = nil
    var start: String? = nil
    var end: String? = nil
    var location: String? = nil
    var attendees: [String]? = nil
    var notes: String? = nil
  }

  struct Decision: Decodable, Equatable {
    let verdict: String // "approve" | "reject" | "revise"
  }

  struct Result: Decodable, Equatable {
    let summary: String
    let artifacts: [Artifact]?
    /// Something to set up before this can work ("Set up Claude") — shown as one button.
    var setup: Setup? = nil
    /// The answer, shaped for the notch (packages/shared answer.ts); `summary` is its plain text.
    var answer: Answer? = nil
    /// Where it goes: "chin" | "card" | "reader" (answer.ts placeFor).
    var place: String? = nil

    struct Setup: Decodable, Equatable, Hashable {
      let connection: String // "claude" | "gmail" | "fathom"
      let label: String
    }

    struct Artifact: Decodable, Equatable, Hashable {
      let label: String
      let value: String
    }
  }

  /// What the agent handed back: the conclusion first, at most one block, what you might say next.
  struct Answer: Decodable, Equatable {
    let tone: String // "answer" | "done" | "needs_you"
    let headline: String
    var basis: String? = nil
    var block: Block? = nil
    var note: String? = nil
    var followups: [String]? = nil
  }

  /// One shape for every block kind, like Preview; `kind` says which fields are filled in.
  struct Block: Decodable, Equatable {
    let kind: String // "text" | "list" | "facts" | "compare" | "choice" | "doc"
    var body: String? = nil // text
    var items: [Item]? = nil // list
    var more: String? = nil // list
    var rows: [Row]? = nil // facts (value), compare (values)
    var columns: [String]? = nil // compare
    var pick: Int? = nil // compare
    var options: [Option]? = nil // choice
    var recommended: Int? = nil // choice
    var title: String? = nil // doc
    var markdown: String? = nil // doc
  }

  struct Item: Decodable, Equatable {
    let title: String
    var sub: String? = nil
    var detail: String? = nil
    var tag: String? = nil
    var tone: String? = nil // "amber" | "red" | "green"
  }

  struct Row: Decodable, Equatable {
    let label: String
    var value: String? = nil
    var values: [String]? = nil
  }

  struct Option: Decodable, Equatable {
    let label: String
    var note: String? = nil
  }

  // MARK: - What the notch cares about

  var isAgent: Bool { kind == "agent" }
  var isFinished: Bool { ["done", "failed", "canceled"].contains(status) }

  /// A draft is sitting there waiting for a button press.
  var awaitingYou: Bool { status == "awaiting_approval" && proposal != nil }

  /// The agent is off doing the work (not counting the moment after you pressed Send).
  var working: Bool { ["queued", "claimed", "running"].contains(status) }

  /// You approved it and the worker is performing the side effect.
  var committing: Bool { working && proposal?.decision?.verdict == "approve" }
  var revising: Bool { working && proposal?.decision?.verdict == "revise" }

  /// Finished, but only because something isn't set up yet.
  var needsSetup: AgentTicket.Result.Setup? { status == "done" ? result?.setup : nil }

  /// The agent is paused waiting for you to sign in on the box.
  var awaitingTakeover: Takeover? { status == "needs_input" ? takeover : nil }

  /// What it found or did, shaped for the notch — once it's done, and not a draft for your OK.
  var answer: Answer? { status == "done" && proposal == nil ? result?.answer : nil }

  /// Where its answer lives: "chin", "card" or "reader".
  var placement: String { result?.place ?? "card" }

  /// Waiting on you: a draft to approve, or a sign-in only you can do.
  var needsYou: Bool { awaitingYou || awaitingTakeover != nil }

  /// What it's doing right now, in one line: its latest action, else its latest thought. The
  /// bookkeeping notes ("Claimed by worker.") aren't progress.
  var progress: String? {
    let log = (steps ?? []).reversed()
    let said = { (s: Step) in !(s.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    let step = log.first { ["act", "tool", "observe"].contains($0.type ?? "") && said($0) }
      ?? log.first { $0.type == "think" && said($0) }
    guard let text = step?.text else { return nil }
    return text.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) }
  }
}

/// What the server pushes over /ws.
struct TaskEvent: Decodable {
  let type: String // "snapshot" | "created" | "updated"
  let tasks: [AgentTicket]?
  let task: AgentTicket?
}
