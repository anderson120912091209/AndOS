import os

/// Unified-log channel for diagnostics. Never logs what you said — only timing, language,
/// and permission state. Read it with (note `/usr/bin/log`: zsh has its own `log` builtin):
///   /usr/bin/log show --last 10m --predicate 'subsystem == "com.relay.mac"'
enum Log {
  static let app = Logger(subsystem: "com.relay.mac", category: "app")
}
