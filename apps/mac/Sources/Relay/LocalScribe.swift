import Foundation
import JavaScriptCore

/// Relay's dictation cleanup, run on this Mac: fillers out, spoken punctuation in ("new line",
/// "換行"), laid out for where you're typing. It's the server's own code for a held Fn
/// (packages/shared, bundled into the app as scribe.js by build.sh), run in the JavaScript engine
/// macOS ships, so the dictation edition writes exactly what the dev setup pastes, with no server.
@MainActor
enum LocalScribe {
  /// `RelayScribe.dictate(utterance, context)`, or nil if the bundle is missing or won't load.
  private static let dictate: JSValue? = {
    guard let url = Bundle.main.url(forResource: "scribe", withExtension: "js"),
          let source = try? String(contentsOf: url, encoding: .utf8),
          let js = JSContext()
    else {
      Log.app.error("scribe.js missing — pasting Whisper's text as it is")
      return nil
    }
    js.exceptionHandler = { _, error in
      Log.app.error("scribe: \(error?.toString() ?? "unknown error", privacy: .public)")
    }
    js.evaluateScript(source)
    guard let fn = js.objectForKeyedSubscript("RelayScribe")?.objectForKeyedSubscript("dictate"), !fn.isUndefined else {
      return nil
    }
    return fn // a JSValue keeps its context alive
  }()

  /// The text to paste for `utterance`, laid out for `target`. If the cleanup can't run, the
  /// words go in as Whisper heard them, so dictation never breaks over it.
  static func clean(_ utterance: String, appName: String?, target: [String: String]?) -> String {
    // The same context RelayClient sends the server for a dictation.
    var context: [String: Any] = ["appName": appName ?? "", "timeZone": TimeZone.current.identifier, "punctuated": true]
    if let target { context["target"] = target }
    guard let out = dictate?.call(withArguments: [utterance, context]), out.isString else { return utterance }
    return out.toString()
  }
}
