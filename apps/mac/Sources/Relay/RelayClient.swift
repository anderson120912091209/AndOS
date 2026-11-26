import Foundation

/// Posts an utterance to the same Relay server the web HUD uses, so routing, the queue,
/// and agent dispatch all stay in one place. The Mac app is just a native front end.
enum RelayClient {
  // 127.0.0.1, not localhost: the server listens on IPv4, and "localhost" tries ::1 first.
  static let base = URL(string: ProcessInfo.processInfo.environment["RELAY_SERVER"] ?? "http://127.0.0.1:8787")!

  struct Routed {
    let kind: String // "dictation" | "command" | "agent"
    let title: String
    let summary: String // cleaned text (dictation) or a short result line
    let reason: String
    /// the server's task id — agent tasks are followed by id until they come back
    let taskId: String?
    /// agent requests: what "this" was, in a few words — “Q3 numbers”, #design
    let pointerChip: String?
    /// agent requests: which of Relay's agents took it (packages/shared/src/agents.ts)
    let agent: String?
  }

  /// `forceKind` pins the server's routing: "dictation" (Fn) always writes; "agent"
  /// (Fn+Control) always dispatches to a worker. Omit to let the router decide.
  /// `target` is where the words will land (see TypingTarget) — the server lays the text out for it.
  /// `pointer` is what "this" is in AI mode (see AgentPointer).
  static func submit(
    _ utterance: String, appName: String?, forceKind: String? = nil, target: [String: String]? = nil,
    pointer: [String: String]? = nil, completion: @escaping (Routed?) -> Void
  ) {
    var req = URLRequest(url: base.appendingPathComponent("api/tasks"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.timeoutInterval = 10
    var context: [String: Any] = [
      "appName": appName ?? "",
      "capturedAt": Date().timeIntervalSince1970 * 1000,
      // so "tomorrow at 3" means your 3 o'clock, wherever the agent runs
      "timeZone": TimeZone.current.identifier,
      // Whisper and Apple Speech both punctuate, so "period" is a word, not a full stop
      "punctuated": true,
    ]
    if let target { context["target"] = target }
    for (key, value) in pointer ?? [:] { context[key] = value } // url, windowTitle, selectionText
    var body: [String: Any] = ["utterance": utterance, "context": context]
    if let forceKind { body["forceKind"] = forceKind }
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)

    URLSession.shared.dataTask(with: req) { data, _, _ in
      guard
        let data,
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let intent = obj["intent"] as? [String: Any],
        let kind = intent["kind"] as? String
      else {
        DispatchQueue.main.async { completion(nil) }
        return
      }
      let task = obj["task"] as? [String: Any]
      let result = task?["result"] as? [String: Any]
      let summary = (result?["summary"] as? String)
        ?? (intent["cleanedText"] as? String)
        ?? utterance
      let routed = Routed(
        kind: kind,
        title: (intent["title"] as? String) ?? utterance,
        summary: summary,
        reason: (intent["reason"] as? String) ?? "",
        taskId: task?["id"] as? String,
        pointerChip: intent["pointerChip"] as? String,
        agent: (task?["agent"] as? String) ?? (intent["agent"] as? String)
      )
      DispatchQueue.main.async { completion(routed) }
    }.resume()
  }
}
