import Foundation

/// A moment on Relay's computer that needs you — a sign-in, a 2FA code — or just a look at it.
/// The server side is apps/server/src/box/routes.ts; the Box window shows the box's screen.
struct BoxTakeover: Equatable {
  /// the server's takeover id; nil when you're only looking at Relay's computer
  var id: String?
  /// what you're asked to do — the window's title ("Sign in to Gmail")
  var reason: String
  /// the site or service ("Gmail", or an id like "gmail"), for the badge
  var service: String?
  /// the viewer page, when whoever asked has it already; otherwise the window asks the server
  var viewerURL: URL?

  /// Nothing asked of you: Relay's computer, to watch it work or lend a hand.
  static let look = BoxTakeover(id: nil, reason: "Relay’s computer", service: "box", viewerURL: nil)

  /// The server's takeover reply (`{ id, reason, service?, viewerUrl }`).
  init?(json obj: [String: Any]) {
    guard let id = obj["id"] as? String, let reason = obj["reason"] as? String else { return nil }
    self.init(id: id, reason: reason, service: obj["service"] as? String,
              viewerURL: (obj["viewerUrl"] as? String).flatMap(URL.init(string:)))
  }

  init(id: String?, reason: String, service: String?, viewerURL: URL?) {
    self.id = id
    self.reason = reason
    self.service = service
    self.viewerURL = viewerURL
  }
}

/// What the Box window is showing.
@MainActor
final class BoxModel: ObservableObject {
  enum Phase: Equatable {
    /// asking the server for the screen, starting the box if it's off
    case starting
    /// the viewer is connecting (or reconnecting) to the box's screen
    case connecting
    case live
    case failed(String)
  }

  @Published var takeover = BoxTakeover.look
  @Published var phase: Phase = .starting
  /// Take Over pressed, waiting on the server
  @Published var takingOver = false

  /// Just watching: the screen is view-only. You can only type into the box during a takeover,
  /// while Relay's agent is stopped — nothing it runs can see what you type.
  var watching: Bool { takeover.id == nil }
}

/// The Relay server's box API.
enum BoxAPI {
  struct Failure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
  }

  private static func call(
    _ method: String, _ path: String, body: [String: String]? = nil, timeout: TimeInterval = 10
  ) async throws -> ([String: Any], Int) {
    var req = URLRequest(url: RelayClient.base.appendingPathComponent(path))
    req.httpMethod = method
    req.timeoutInterval = timeout
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: req)
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    return (obj, (response as? HTTPURLResponse)?.statusCode ?? 0)
  }

  /// The viewer for the box's screen — starting the box first if it's off, which can take a few
  /// seconds (the server answers once the screen does).
  static func viewerURL() async throws -> URL {
    do {
      let (now, status) = try await call("GET", "api/box")
      if status == 200, let raw = now["viewerUrl"] as? String, let url = URL(string: raw) { return url }
      let (started, code) = try await call("POST", "api/box/start", timeout: 45)
      if code == 200, let raw = started["viewerUrl"] as? String, let url = URL(string: raw) { return url }
      throw Failure(message: (started["error"] as? String) ?? "Relay’s computer didn’t start.")
    } catch let failure as Failure {
      throw failure
    } catch {
      throw Failure(message: "Relay’s server isn’t answering — start it with pnpm dev.")
    }
  }

  /// You'd like to use Relay's computer yourself: a takeover of your own, so the agent stops first.
  static func takeOver(reason: String) async throws -> BoxTakeover {
    let (obj, status) = try await call("POST", "api/box/takeover", body: ["reason": reason, "service": "box"], timeout: 45)
    guard status == 200, let takeover = BoxTakeover(json: obj) else {
      throw Failure(message: (obj["error"] as? String) ?? "Relay’s computer didn’t hand over.")
    }
    return takeover
  }

  /// Hand the box back (`done`) or decline — the task waiting on it hears either way.
  static func finish(_ id: String, done: Bool) async {
    _ = try? await call("POST", "api/box/takeover/\(id)/\(done ? "done" : "cancel")")
  }
}
