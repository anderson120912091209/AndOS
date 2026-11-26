import Foundation

/// Post-processing for Whisper output.
///
/// Whisper writes Mandarin in Simplified characters with ASCII punctuation. For people who
/// write Traditional Chinese (zh-Hant, or Taiwan / Hong Kong / Macau), convert it with macOS's
/// built-in ICU transform, and use full-width punctuation inside Chinese text. English is
/// passed through untouched, including English words inside a Chinese sentence.
enum TextPolish {
  static let prefersTraditional: Bool = {
    for pref in Locale.preferredLanguages {
      let loc = Locale(identifier: pref)
      guard loc.language.languageCode?.identifier == "zh" else { continue }
      if loc.language.script?.identifier == "Hant" { return true }
      if let region = loc.region?.identifier, ["TW", "HK", "MO"].contains(region) { return true }
      return false
    }
    return false
  }()

  static func polish(_ raw: String, language: String?) -> String {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard language == "zh" || s.contains(where: isCJK) else { return s }
    if prefersTraditional, let converted = s.applyingTransform(StringTransform("Hans-Hant"), reverse: false) {
      s = converted
    }
    return fullWidthPunctuation(s)
  }

  /// Common phrases Whisper produces from silence or noise rather than speech.
  static func isLikelyHallucination(_ s: String) -> Bool {
    let key = s.lowercased().trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.whitespaces))
    let known: Set<String> = [
      "", "you", "thank you", "thanks for watching", "thank you for watching", "bye",
      "subtitles by the amara.org community", "字幕由amara.org社區提供", "字幕由amara.org社区提供",
      "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目", "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    ]
    return known.contains(key)
  }

  static func isCJK(_ c: Character) -> Bool {
    c.unicodeScalars.contains {
      (0x4E00...0x9FFF).contains($0.value) || (0x3400...0x4DBF).contains($0.value)
        || (0x3000...0x303F).contains($0.value) || (0xFF00...0xFFEF).contains($0.value)
    }
  }

  /// ASCII , ? ! : ; next to a Chinese character → full-width; "." after one → "。".
  static func fullWidthPunctuation(_ s: String) -> String {
    let map: [Character: Character] = [",": "，", "?": "？", "!": "！", ":": "：", ";": "；"]
    let chars = Array(s)
    var out = ""
    for (i, c) in chars.enumerated() {
      let prev: Character = i > 0 ? chars[i - 1] : " "
      let next: Character = i + 1 < chars.count ? chars[i + 1] : " "
      if let fw = map[c], isCJK(prev) || isCJK(next) {
        out.append(fw)
      } else if c == ".", isCJK(prev), !next.isNumber {
        out.append("。")
      } else {
        out.append(c)
      }
    }
    return out
  }
}
