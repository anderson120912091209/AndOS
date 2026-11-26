// Fast, deterministic transcript cleanup — the "scribe" half of Relay.
//
// A real engine (whisper.cpp) gives us raw words. Good dictation is mostly what
// happens *after* the words: dropping fillers, honoring spoken punctuation
// ("new line", "period"), and fixing capitalization/spacing. This is pure and
// cheap so it can run on every interim result without latency.

const FILLERS: RegExp[] = [
  /\b(?:um+|uh+|erm+|uhh+|hmm+|mhm+|like,)\b/gi,
  /\b(?:you know|i mean|sort of|kind of)\b/gi,
];

// Ordered: longer phrases first so "new paragraph" wins over "new".
const SPOKEN_PUNCTUATION: [RegExp, string][] = [
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
  [/\bopen paren(?:thesis)?\b/gi, '('],
  [/\bclose paren(?:thesis)?\b/gi, ')'],
  [/\bexclamation (?:mark|point)\b/gi, '!'],
  [/\bquestion mark\b/gi, '?'],
  [/\bperiod\b/gi, '.'],
  [/\bfull stop\b/gi, '.'],
  [/\bcomma\b/gi, ','],
  [/\bcolon\b/gi, ':'],
  [/\bsemicolon\b/gi, ';'],
  [/\bdash\b/gi, ' - '],
  [/\bellipsis\b/gi, '…'],
];

function stripFillers(text: string): string {
  let out = text;
  for (const f of FILLERS) out = out.replace(f, '');
  return out;
}

function applySpokenPunctuation(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SPOKEN_PUNCTUATION) out = out.replace(pattern, replacement);
  return out;
}

/** Collapse whitespace and tuck punctuation against the preceding word. */
function normalizeSpacing(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1') // " ." -> "."
    .replace(/([,.;:!?])(?=[^\s)\]])/g, '$1 ') // ensure a space after sentence punctuation
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/[ \t]*\n[ \t]*/g, '\n') // trim around newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Capitalize the first alphabetic character of each sentence. */
function capitalizeSentences(text: string): string {
  return text.replace(/(^|[.!?]\s+|\n+)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

export interface CleanOptions {
  /** when false, leaves fillers in (useful for verbatim modes) */
  removeFillers?: boolean;
  /** when false, "period" etc. stay as literal words */
  spokenPunctuation?: boolean;
  capitalize?: boolean;
  /**
   * The speech engine already punctuated and cased the text (Whisper, Apple Speech). Then
   * "period", "new line" and "kind of" are just words ("the trial period", "a new line of
   * products"), and "3.5" or "a@b.com" must keep their dots — so only pure fillers go, and
   * "new line" / "new paragraph" (換行 / 換段) count only when said as a sentence of their own.
   */
  punctuated?: boolean;
}

const PURE_FILLER = /(^|\s)(?:um+|uh+|erm+|uhh+|hmm+|mhm+)[,.]?(?=\s|$)/gi;
const SPOKEN_BREAK = /(^|[.!?。！？]\s*)(new paragraph|next paragraph|new line|換段|下一段|新段落|換行|下一行)[.!?。！？]?\s*/gi;

/** Gentle cleanup for text a punctuating engine produced. */
function cleanPunctuated(raw: string): string {
  return raw
    .replace(PURE_FILLER, '$1')
    .replace(SPOKEN_BREAK, (_m, lead: string, cmd: string) =>
      lead + (/paragraph|段/i.test(cmd) ? '\n\n' : '\n'),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,，])/g, '$1') // "think , we" → "think, we" after a filler goes
    .replace(/([,，])(?:\s*[,，])+/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/(^|\n)([,，]\s*)?(\p{Ll})/gu, (_m, lead: string, _comma: string, ch: string) => lead + ch.toUpperCase());
}

/**
 * Turn a raw transcript into insert-ready text. Idempotent-ish: running it twice
 * on clean text should not corrupt it.
 */
export function cleanTranscript(raw: string, opts: CleanOptions = {}): string {
  if (opts.punctuated) return cleanPunctuated(raw ?? '');
  const { removeFillers = true, spokenPunctuation = true, capitalize = true } = opts;
  let t = raw ?? '';
  if (removeFillers) t = stripFillers(t);
  if (spokenPunctuation) t = applySpokenPunctuation(t);
  t = normalizeSpacing(t);
  if (capitalize) t = capitalizeSentences(t);
  return t;
}
