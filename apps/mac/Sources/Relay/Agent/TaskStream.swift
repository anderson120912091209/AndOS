import Foundation

/// Live view of the server's task queue over its WebSocket (/ws), plus the one call the
/// notch makes back: answering a proposal. Reconnects on its own, so the notch survives
/// the server restarting.
@MainActor
final class TaskStream {
  var onSnapshot: (([AgentTicket]) -> Void)?
  var onTicket: ((AgentTicket) -> Void)?

  private let base: URL
  private var socket: URLSessionWebSocketTask?
  private var retry = 0
  private var stopped = false

  init(base: URL = RelayClient.base) {
    self.base = base
  }

  func start() {
    stopped = false
    connect()
  }

  func stop() {
    stopped = true
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
  }

  private func connect() {
    guard !stopped, var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    parts.path = "/ws"
    guard let url = parts.url else { return }
    let task = URLSession.shared.webSocketTask(with: url)
    socket = task
    task.resume()
    receive(on: task)
  }

  private func receive(on task: URLSessionWebSocketTask) {
    task.receive { [weak self] outcome in
      Task { @MainActor in
        guard let self, self.socket === task else { return }
        switch outcome {
        case let .success(message):
          self.retry = 0
          self.handle(message)
          self.receive(on: task)
        case .failure:
          self.reconnect()
        }
      }
    }
  }

  private func handle(_ message: URLSessionWebSocketTask.Message) {
    let data: Data?
    switch message {
    case let .string(text): data = text.data(using: .utf8)
    case let .data(bytes): data = bytes
    @unknown default: data = nil
    }
    guard let data else { return }
    do {
      let event = try JSONDecoder().decode(TaskEvent.self, from: data)
      if event.type == "snapshot", let tasks = event.tasks {
        onSnapshot?(tasks.filter(\.isAgent))
      } else if let ticket = event.task, ticket.isAgent {
        onTicket?(ticket)
      }
    } catch {
      Log.app.error("task stream: undecodable event — \(error.localizedDescription, privacy: .public)")
    }
  }

  private func reconnect() {
    socket = nil
    guard !stopped else { return }
    retry = min(retry + 1, 6)
    let delay = 0.5 * Double(retry)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
  }

  // MARK: - Running a request again

  /// Dispatch `utterance` to the agent — again after setting something up, or carrying on from an
  /// earlier answer (`followUpOf`: that task's id). Returns the new task id.
  func dispatch(_ utterance: String, context: AgentTicket.Context?, followUpOf: String? = nil) async -> String? {
    var body: [String: Any] = ["utterance": utterance, "forceKind": "agent"]
    if let followUpOf { body["followUpOf"] = followUpOf }
    if let context, let data = try? JSONEncoder().encode(context), let obj = try? JSONSerialization.jsonObject(with: data) {
      body["context"] = obj
    }
    let (data, ok) = await send("POST", "api/tasks", body)
    guard ok, let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return (obj["task"] as? [String: Any])?["id"] as? String
  }

  // MARK: - Connections

  /// Whether a connection is live now — for noticing when a sign-in elsewhere finished.
  func isConnected(_ id: String) async -> Bool {
    let (data, ok) = await send("GET", "api/connections", nil)
    guard ok, let data, let obj = try? JSONSerialization.jsonObject(with: data) else { return false }
    let list = (obj as? [String: Any])?["connections"] as? [[String: Any]] ?? obj as? [[String: Any]] ?? []
    return list.contains { $0["id"] as? String == id && $0["state"] as? String == "connected" }
  }

  enum KeyOutcome: Equatable { case saved, rejected(String) }

  /// Save a pasted API key for `id` through the server, which keeps it in the Keychain.
  func saveKey(_ apiKey: String, for id: String) async -> KeyOutcome {
    let (start, ok) = await send("POST", "api/connections/\(id)/connect", ["returnTo": "mac"])
    guard ok, let start,
      let obj = try? JSONSerialization.jsonObject(with: start) as? [String: Any],
      let raw = obj["authUrl"] as? String,
      let state = URLComponents(string: raw)?.queryItems?.first(where: { $0.name == "state" })?.value
    else { return .rejected("Relay's server didn't answer — is it running?") }
    let (reply, saved) = await send("POST", "api/connections/key", ["state": state, "apiKey": apiKey])
    if saved { return .saved }
    let why = reply.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"] as? String
    return .rejected(why ?? "That key wasn't saved — try again.")
  }

  private func send(_ method: String, _ path: String, _ body: [String: Any]?) async -> (Data?, Bool) {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.httpMethod = method
    req.timeoutInterval = 10
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    guard let (data, response) = try? await URLSession.shared.data(for: req) else { return (nil, false) }
    return (data, (response as? HTTPURLResponse)?.statusCode == 200)
  }

  // MARK: - Answering a proposal

  /// approve / reject / revise. The proposal id pins the decision to the draft you saw —
  /// if the agent has replaced it meanwhile, the server refuses (409) instead of sending.
  func decide(
    _ ticketID: String,
    proposalID: String,
    verdict: String,
    feedback: String? = nil,
    done: @escaping @MainActor (Bool) -> Void = { _ in }
  ) {
    var req = URLRequest(url: base.appendingPathComponent("api/tasks/\(ticketID)/decision"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.timeoutInterval = 10
    var body: [String: Any] = ["proposalId": proposalID, "verdict": verdict]
    if let feedback { body["feedback"] = feedback }
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: req) { _, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
      Task { @MainActor in done(ok) }
    }.resume()
  }
}
