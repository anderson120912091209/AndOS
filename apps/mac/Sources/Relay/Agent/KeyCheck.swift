import Foundation

/// Asks Anthropic whether a pasted key works before Relay saves it, so a typo or a revoked key
/// shows up in the notch right away instead of on your next request. Listing models is free.
/// (Raw HTTP: there's no official Anthropic SDK for Swift.)
enum KeyCheck {
  enum Verdict: Equatable {
    case accepted
    case rejected
    /// couldn't ask (offline, Anthropic down) — the key's format is right, so it's saved anyway
    case unverified
  }

  static func claude(_ key: String) async -> Verdict {
    var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/models?limit=1")!)
    req.setValue(key, forHTTPHeaderField: "x-api-key")
    req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
    req.timeoutInterval = 8
    guard let (_, response) = try? await URLSession.shared.data(for: req) else { return .unverified }
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200: return .accepted
    case 401, 403: return .rejected
    default: return .unverified
    }
  }
}
