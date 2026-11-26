import AppKit
import AuthenticationServices
import SwiftUI

/// The Connections window's state: what's connected, what's signing in, what just went wrong.
/// The truth lives in the Relay server (tokens in your Keychain); this mirrors it.
@MainActor
final class ConnectionsModel: ObservableObject {
  struct Item: Identifiable, Equatable, Decodable {
    let id: String
    let name: String
    let blurb: String
    let example: String
    let state: State
    var account: String?
    var tools: [String]?
    var note: String?
    var needsKey: Bool?
    /// "box": signed in on Relay's computer — Sign In opens the Box window, not a sign-in sheet
    var via: String?

    enum State: String, Decodable { case connected, available, soon, broken }

    var onBox: Bool { via == "box" }
  }

  /// A line under a row: "You cancelled", "Fathom didn't answer". Fades on its own.
  struct Note: Equatable {
    var text: String
    var warn: Bool
  }

  @Published private(set) var items: [Item] = []
  @Published private(set) var loaded = false
  @Published private(set) var serverDown = false
  @Published private(set) var signingIn: String?
  @Published private(set) var notes: [String: Note] = [:]
  /// The row that just connected, for a moment of green.
  @Published private(set) var justConnected: String?
  /// Gmail's one-time "bring your Google key" panel.
  @Published var showsGoogleKey = false

  /// Tell the notch (and anyone else) that something connected.
  var onConnected: ((_ id: String, _ name: String) -> Void)?
  /// Where the sign-in sheet attaches.
  weak var window: NSWindow?

  private let signIn = SignInSession()

  var available: [Item] { items.filter { $0.state != .soon } }
  var upcoming: [Item] { items.filter { $0.state == .soon } }

  /// Dev renders (RELAY_RENDER_SHOTS): show a given state without a server.
  func stage(_ items: [Item], notes: [String: Note] = [:], googleKey: Bool = false) {
    self.items = items
    self.notes = notes
    showsGoogleKey = googleKey
    loaded = true
  }

  func refresh() async {
    do {
      let list: [Item] = try await ConnectionsAPI.list()
      withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) {
        items = list
        serverDown = false
        loaded = true
      }
    } catch {
      withAnimation(.easeOut(duration: 0.2)) {
        serverDown = true
        loaded = true
      }
    }
  }

  func connect(_ item: Item, clientId: String? = nil, clientSecret: String? = nil) {
    guard signingIn == nil else { return }
    if item.needsKey == true, clientId == nil {
      withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) { showsGoogleKey = true }
      return
    }
    say(nil, on: item.id)
    withAnimation(.easeOut(duration: 0.2)) { signingIn = item.id }
    Task {
      do {
        switch try await ConnectionsAPI.connect(item.id, clientId: clientId, clientSecret: clientSecret) {
        case let .signIn(url):
          signIn.start(url, anchor: window) { [weak self] result in
            Task { @MainActor in await self?.signedIn(item, result) }
          }
        case let .takeover(takeover):
          // You sign in on Relay's computer, in the Box window; this row waits for you there.
          BoxController.shared.show(takeover) { [weak self] done in
            Task { @MainActor in await self?.signedInOnBox(item, done: done) }
          }
        }
      } catch ConnectionsAPI.Failure.needsKey {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.86)) {
          signingIn = nil
          showsGoogleKey = true
        }
      } catch {
        withAnimation(.easeOut(duration: 0.2)) { signingIn = nil }
        say(Note(text: error.localizedDescription, warn: true), on: item.id)
      }
    }
  }

  func disconnect(_ item: Item) {
    Task {
      do {
        try await ConnectionsAPI.disconnect(item.id)
        await refresh()
        let text = item.onBox
          ? "Signed out. Relay’s computer forgot your \(item.name) sign-in."
          : "Disconnected. Relay can’t see \(item.name) any more."
        say(Note(text: text, warn: false), on: item.id)
      } catch {
        say(Note(text: error.localizedDescription, warn: true), on: item.id)
      }
    }
  }

  /// Back from the Box window. The row's truth is the box's own sign-in (the server checks its
  /// browser), so after Done it either turns green or says it can't see you signed in yet.
  private func signedInOnBox(_ item: Item, done: Bool) async {
    withAnimation(.easeOut(duration: 0.2)) { signingIn = nil }
    guard done else {
      return say(Note(text: "Not now — nothing changed.", warn: false), on: item.id)
    }
    // The box takes a moment to hand itself back to Relay after a takeover; look a few times.
    for attempt in 0..<8 {
      if attempt > 0 { try? await Task.sleep(nanoseconds: 700_000_000) }
      await refresh()
      if items.first(where: { $0.id == item.id })?.state == .connected { break }
    }
    guard items.first(where: { $0.id == item.id })?.state == .connected else {
      return say(Note(text: "Relay’s computer isn’t signed in to \(item.name) yet — try again when you’re ready.", warn: true), on: item.id)
    }
    withAnimation(.easeOut(duration: 0.25)) { justConnected = item.id }
    onConnected?(item.id, item.name)
    try? await Task.sleep(nanoseconds: 1_600_000_000)
    withAnimation(.easeOut(duration: 0.6)) { if justConnected == item.id { justConnected = nil } }
  }

  private func signedIn(_ item: Item, _ result: SignInSession.Outcome) async {
    withAnimation(.easeOut(duration: 0.2)) { signingIn = nil }
    switch result {
    case .connected:
      withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { showsGoogleKey = false }
      await refresh()
      withAnimation(.easeOut(duration: 0.25)) { justConnected = item.id }
      onConnected?(item.id, item.name)
      try? await Task.sleep(nanoseconds: 1_600_000_000)
      withAnimation(.easeOut(duration: 0.6)) { if justConnected == item.id { justConnected = nil } }
    case .cancelled:
      say(Note(text: "Sign-in cancelled — nothing was connected.", warn: false), on: item.id)
    case let .failed(why):
      await refresh()
      say(Note(text: "\(item.name) didn’t connect: \(why)", warn: true), on: item.id)
    }
  }

  private func say(_ note: Note?, on id: String) {
    withAnimation(.easeOut(duration: 0.2)) { notes[id] = note }
    guard let note else { return }
    Task {
      try? await Task.sleep(nanoseconds: note.warn ? 9_000_000_000 : 4_500_000_000)
      withAnimation(.easeOut(duration: 0.4)) { if notes[id] == note { notes[id] = nil } }
    }
  }
}

/// The Relay server's Connections API (apps/server/src/connections/routes.ts).
enum ConnectionsAPI {
  enum Failure: LocalizedError {
    case needsKey
    case server(String)
    var errorDescription: String? {
      switch self {
      case .needsKey: return "Needs your Google key first."
      case let .server(message): return message
      }
    }
  }

  private static func request(
    _ method: String, _ path: String, body: [String: String]? = nil, timeout: TimeInterval = 20
  ) async throws -> (Data, Int) {
    var req = URLRequest(url: RelayClient.base.appendingPathComponent(path))
    req.httpMethod = method
    req.timeoutInterval = timeout
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: req)
    return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
  }

  static func list() async throws -> [ConnectionsModel.Item] {
    struct Body: Decodable { let connections: [ConnectionsModel.Item] }
    let (data, status) = try await request("GET", "api/connections")
    guard status == 200 else { throw Failure.server("Relay’s server said \(status)") }
    return try JSONDecoder().decode(Body.self, from: data).connections
  }

  /// How a connection starts: a sign-in sheet (OAuth, a key page), or Relay's computer.
  enum Start {
    case signIn(URL)
    case takeover(BoxTakeover)
  }

  static func connect(_ id: String, clientId: String?, clientSecret: String?) async throws -> Start {
    var body = ["returnTo": "mac"]
    if let clientId, let clientSecret {
      body["clientId"] = clientId
      body["clientSecret"] = clientSecret
    }
    // A site on Relay's computer may have to start the box first — give it time.
    let (data, status) = try await request("POST", "api/connections/\(id)/connect", body: body, timeout: 45)
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    if status == 409, obj?["error"] as? String == "needs-key" { throw Failure.needsKey }
    if status == 200, let raw = obj?["takeover"] as? [String: Any], let takeover = BoxTakeover(json: raw) {
      return .takeover(takeover)
    }
    guard status == 200, let raw = obj?["authUrl"] as? String, let url = URL(string: raw) else {
      throw Failure.server((obj?["error"] as? String) ?? "Relay’s server isn’t answering")
    }
    return .signIn(url)
  }

  static func disconnect(_ id: String) async throws {
    let (data, status) = try await request("DELETE", "api/connections/\(id)")
    guard status == 200 else {
      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw Failure.server((obj?["error"] as? String) ?? "That didn’t work — try again.")
    }
  }
}

/// The system sign-in sheet (ASWebAuthenticationSession). The service sends you back to the
/// Relay server, which finishes the sign-in and hands the sheet `relay://connected`, closing it.
final class SignInSession: NSObject, ASWebAuthenticationPresentationContextProviding {
  enum Outcome {
    case connected
    case cancelled
    case failed(String)
  }

  private var session: ASWebAuthenticationSession?
  private weak var anchor: NSWindow?

  @MainActor
  func start(_ url: URL, anchor: NSWindow?, completion: @escaping (Outcome) -> Void) {
    self.anchor = anchor
    let finish: (URL?, Error?) -> Void = { [weak self] callback, error in
      self?.session = nil
      if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
        return completion(.cancelled)
      }
      guard let callback, let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
        return completion(.failed(error?.localizedDescription ?? "the sign-in didn’t come back"))
      }
      let problem = parts.queryItems?.first { $0.name == "error" }?.value
      switch problem {
      case nil: completion(.connected)
      case "cancelled": completion(.cancelled)
      case let why?: completion(.failed(why))
      }
    }
    let s: ASWebAuthenticationSession
    if #available(macOS 14.4, *) {
      s = ASWebAuthenticationSession(url: url, callback: .customScheme("relay"), completionHandler: finish)
    } else {
      s = ASWebAuthenticationSession(url: url, callbackURLScheme: "relay", completionHandler: finish)
    }
    s.presentationContextProvider = self
    s.prefersEphemeralWebBrowserSession = false // you may already be signed in
    session = s
    s.start()
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { anchor ?? NSApp.keyWindow ?? NSWindow() }
  }
}
