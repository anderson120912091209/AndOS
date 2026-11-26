// Where the words are going decides how they should look.
//
// Relay knows *where* you're typing — the app, the web page's host, and the focused field's
// role and label (Gmail's compose box is a multi-line field labelled "Message Body") — but
// never what's already in it. From that we pick a Surface and lay the dictated text out the
// way that surface expects: an email gets its greeting, paragraphs, lists and sign-off on
// their own lines; a search box or subject line gets one clean line.
//
// Deterministic and local on purpose: no added latency, unit-tested, predictable. Works for
// English, Chinese, and both mixed. A language-model polish can slot in later.

export interface TypingTarget {
  /** the app you're typing into, e.g. "company.thebrowser.dia", "com.apple.mail" */
  bundleId?: string;
  /** the web page's host when that app is a browser, e.g. "mail.google.com" */
  host?: string;
  /** the focused field's accessibility role: AXTextArea is multi-line; AXTextField / AXComboBox are one line */
  role?: string;
  /** e.g. "AXSearchField" */
  subrole?: string;
  /** the field's accessible name, e.g. "Message Body", "Subject", "Search mail" */
  label?: string;
}

/** The kinds of place Relay lays text out for. */
export type Surface = 'email' | 'chat' | 'document' | 'field' | 'general';

// --- Where are you typing? ----------------------------------------------------

const EMAIL_APPS = new Set([
  'com.apple.mail', 'com.microsoft.Outlook', 'com.readdle.SparkDesktop', 'com.readdle.smartemail-Mac',
  'com.superhuman.electron', 'com.mimestream.Mimestream', 'com.freron.MailMate', 'io.canarymail.mac',
  'org.mozilla.thunderbird', 'it.bloop.airmail2',
]);
const EMAIL_HOSTS = [
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com',
  'mail.proton.me', 'app.fastmail.com', 'app.hey.com', 'mail.zoho.com', 'mail.qq.com', 'mail.163.com',
  'mail.superhuman.com',
];
const CHAT_APPS = new Set([
  'com.tinyspeck.slackmacgap', 'com.apple.MobileSMS', 'jp.naver.line.mac', 'com.tencent.xinWeChat',
  'com.hnc.Discord', 'com.microsoft.teams2', 'net.whatsapp.WhatsApp', 'ru.keepcoder.Telegram',
  'com.facebook.archon', 'org.whispersystems.signal-desktop',
]);
const CHAT_HOSTS = [
  'app.slack.com', 'discord.com', 'web.whatsapp.com', 'teams.microsoft.com', 'teams.live.com',
  'web.telegram.org', 'www.messenger.com', 'chat.google.com',
];
const DOCUMENT_APPS = new Set([
  'com.apple.Notes', 'notion.id', 'md.obsidian', 'com.microsoft.Word', 'com.apple.iWork.Pages',
  'net.shinyfrog.bear', 'com.lukilabs.lukiapp', 'com.apple.TextEdit', 'com.ulyssesapp.mac',
]);
const DOCUMENT_HOSTS = ['docs.google.com', 'notion.so', 'github.com', 'linear.app', 'craft.do', 'hackmd.io'];

const ONE_LINE_ROLES = new Set(['AXTextField', 'AXComboBox', 'AXSearchField']);
/** To, Cc, Subject, search boxes… (English and Chinese UI labels) */
const ONE_LINE_LABEL = /^(?:(?:to|cc|bcc|from|subject|search|find|title)\b|收件|副本|密件|寄件|主旨|主題|标题|標題|搜尋|搜索)/i;
const EMAIL_BODY_LABEL = /message body|郵件內文|郵件正文|邮件正文|內文|正文/i;

function onHost(host: string | undefined, hosts: string[]): boolean {
  return !!host && hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Decide what kind of place the focused field is. Unknown places get 'general' (left as-is). */
export function detectSurface(target?: TypingTarget): Surface {
  if (!target) return 'general';
  const label = target.label?.trim() ?? '';
  const app = target.bundleId ?? '';

  // A one-line box — search, subject, To:, a URL bar — wants one line, whatever the app.
  if (ONE_LINE_ROLES.has(target.role ?? '') || target.subrole === 'AXSearchField' || ONE_LINE_LABEL.test(label)) {
    return 'field';
  }
  if (EMAIL_BODY_LABEL.test(label) || EMAIL_APPS.has(app)) return 'email';
  // On a webmail site, an unlabelled field is the body; a labelled one (chat, search) isn't.
  if (onHost(target.host, EMAIL_HOSTS)) return label ? 'general' : 'email';
  if (CHAT_APPS.has(app) || onHost(target.host, CHAT_HOSTS)) return 'chat';
  if (DOCUMENT_APPS.has(app) || onHost(target.host, DOCUMENT_HOSTS)) return 'document';
  return 'general';
}

/** Lay `text` out for `surface`. Text for an unknown place is returned unchanged. */
export function layoutText(text: string, surface: Surface): string {
  switch (surface) {
    case 'email':
      return layoutEmail(text);
    case 'field':
      return oneLine(text);
    case 'document':
      return layoutDocument(text);
    default:
      return text;
  }
}

// --- Sentences ----------------------------------------------------------------

const CJK = /[　-〿㐀-鿿＀-￯]/;
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|a\.m|p\.m|U\.S|Inc|Ltd|Co|No|approx)\.$/i;

/** Split into sentences, keeping their punctuation. "Dr. Lee" and "3.5" stay whole. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const cjkEnd = '。！？'.includes(ch);
    if (!cjkEnd && !'.!?'.includes(ch)) continue;
    let j = i + 1;
    while (j < text.length && '.!?。！？"\'”’」』)）'.includes(text[j]!)) j++;
    if (!cjkEnd && j < text.length && !/\s/.test(text[j]!)) continue; // 3.5, example.com
    const piece = text.slice(start, j).trim();
    if (!cjkEnd && ch === '.' && ABBREVIATION.test(piece)) continue;
    if (piece) out.push(piece);
    start = j;
    i = j - 1;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Join sentences into a paragraph: a space between Latin sentences, none after CJK punctuation. */
function joinSentences(sentences: string[]): string {
  let out = '';
  for (const s of sentences) {
    if (!out) out = s;
    else out += CJK.test(out[out.length - 1]!) ? s : ` ${s}`;
  }
  return out;
}

function capitalizeFirst(s: string): string {
  return s.replace(/^([^\p{L}]*)(\p{Ll})/u, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

// --- Single-line fields -----------------------------------------------------------

/** One line, no full stop at the end: "best ramen in Taipei." → "best ramen in Taipei". */
export function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim().replace(/(?<![.])[.。]$/, '');
}

// --- Lists --------------------------------------------------------------------

const ORDINAL_EN =
  /^(?:and\s+)?(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|fifth(?:ly)?|finally|lastly|number (?:one|two|three|four|five))\b[,:]?\s*/i;
const ORDINAL_ZH = /^(第[一二三四五六七八九十]+(?:點|个|個)?|首先|其次|再來|再来|再者|最後|最后)[，,、：:]?\s*/u;
const LIST_OPENERS = /^(?:first(?:ly)?|number one|第一|首先)$/i;
const LIST_CLOSERS = /^(?:finally|lastly|最後|最后)$/i;
/** "I have two comments." / "以下幾點。" — a sentence that announces the list gets a colon. */
const LIST_CUE =
  /\b(?:two|three|four|five|a few|several|couple|following|some)\b|\b(?:questions|comments|things|points|items|issues|updates|steps|reasons|notes|changes)\b|[兩两三四五幾几]|以下|下列|問題|问题|事項|事项|重點|重点/i;

function ordinalOf(sentence: string): { marker: string; rest: string } | null {
  const m = ORDINAL_EN.exec(sentence) ?? ORDINAL_ZH.exec(sentence);
  if (!m || !m[1]) return null;
  const rest = sentence.slice(m[0].length).trim();
  return rest ? { marker: m[1], rest } : null;
}

type Block = { kind: 'para'; sentences: string[] } | { kind: 'list'; items: string[] };

/** Turn "First, … Second, … Finally, …" (or 第一…第二…) into a numbered list block. */
function extractLists(sentences: string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let i = 0;
  while (i < sentences.length) {
    const first = ordinalOf(sentences[i]!);
    const second = i + 1 < sentences.length ? ordinalOf(sentences[i + 1]!) : null;
    if (first && second && LIST_OPENERS.test(first.marker.trim())) {
      const items: string[] = [];
      while (i < sentences.length) {
        const o = ordinalOf(sentences[i]!);
        if (!o) break;
        items.push(capitalizeFirst(o.rest));
        i++;
        if (LIST_CLOSERS.test(o.marker.trim())) break;
      }
      // "…two comments." → "…two comments:" so the list reads as following from it.
      const lead = para[para.length - 1];
      if (lead && LIST_CUE.test(lead)) para[para.length - 1] = lead.replace(/\.$/, ':').replace(/。$/, '：');
      if (para.length) blocks.push({ kind: 'para', sentences: para });
      blocks.push({ kind: 'list', items });
      para = [];
      continue;
    }
    para.push(sentences[i]!);
    i++;
  }
  if (para.length) blocks.push({ kind: 'para', sentences: para });
  return blocks;
}

function renderBlocks(blocks: Block[]): string[] {
  return blocks.map((b) =>
    b.kind === 'list' ? b.items.map((item, n) => `${n + 1}. ${item}`).join('\n') : joinSentences(b.sentences),
  );
}

// --- Documents (notes, docs, issues) --------------------------------------------

function layoutDocument(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((chunk) => renderBlocks(extractLists(splitSentences(chunk))).join('\n\n'))
    .join('\n\n');
}

// --- Email --------------------------------------------------------------------

const GREETING_EN = new RegExp(
  '^((?:[Hh]i|[Hh]ello|[Hh]ey|[Hh]iya|[Dd]ear|[Gg]reetings|[Gg]ood (?:morning|afternoon|evening)|[Mm]orning)' +
    '(?: (?:there|all|everyone|team|folks|guys))?' +
    "(?: (?:[A-Z][\\w.'’-]*|\\p{Script=Han}{1,4})(?: (?:and|or|&) (?:[A-Z][\\w.'’-]*|\\p{Script=Han}{1,4})| [A-Z][\\w.'’-]*){0,3})?)" +
    '\\s*([,，:：!！.。])\\s*',
  'u',
);
const GREETING_ZH =
  /^((?:[\p{Script=Han}A-Za-z ]{0,10}?(?:您好|你好|大家好|各位好))|(?:嗨|哈囉|哈喽|嘿|親愛的|亲爱的)\s*[\p{Script=Han}A-Za-z ]{0,10}?)\s*([，,：:！!。.])\s*/u;

/** "Hi John, thanks for…" → { greeting: "Hi John,", rest: "Thanks for…" } */
export function splitGreeting(text: string): { greeting: string; rest: string } | null {
  const m = GREETING_EN.exec(text) ?? GREETING_ZH.exec(text);
  if (!m || !m[1] || !m[2]) return null;
  const words = m[1].trim();
  const cjk = CJK.test(words) || CJK.test(m[2]);
  let mark = m[2];
  if ('.。'.includes(mark)) mark = cjk ? '，' : ',';
  return { greeting: words + mark, rest: capitalizeFirst(text.slice(m[0].length)) };
}

const CLOSING_EN =
  /^(?:best|best regards|kind regards|warm regards|warmest regards|regards|cheers|thanks|thank you|thanks again|many thanks|thanks so much|thank you so much|sincerely|yours sincerely|sincerely yours|yours truly|respectfully|warmly|all the best|best wishes|talk soon|take care)$/i;
const CLOSING_ZH = /^(?:謝謝|谢谢|謝謝您|谢谢您|感謝|感谢|多謝|多谢|祝好|祝順心|祝顺心|順頌商祺|顺颂商祺|敬祝\s*商祺|此致敬禮|此致敬礼|敬上|祝一切順利|祝一切顺利)$/;
const NAME = /^(?:[A-Z][\w'’-]*(?: [A-Z][\w'’-]*){0,2}|\p{Script=Han}{2,4})$/u;

function bare(s: string): string {
  return s.replace(/[\s,，.。!！:：]+$/u, '').trim();
}
function isClosing(s: string): boolean {
  const b = bare(s);
  return CLOSING_EN.test(b) || CLOSING_ZH.test(b);
}
/** "再麻煩您了，謝謝。" — a closing sentence that ends on a sign-off word. */
function endsWithClosing(s: string): boolean {
  const lastClause = bare(s).split(/[,，]/).pop() ?? '';
  return isClosing(lastClause);
}
function isName(s: string): boolean {
  const b = bare(s);
  return NAME.test(b) && !isClosing(b);
}
/** "Best" → "Best,"; "Thanks!" stays; Chinese keeps its own punctuation. */
function closingLine(s: string, hasName: boolean): string {
  const b = bare(s);
  const tail = s.trim().slice(b.length).trim();
  if (CJK.test(b)) return b + (tail.replace(/^[,，]$/, '') || (hasName ? '，' : '！'));
  return capitalizeFirst(b) + (tail.startsWith('!') ? '!' : ',');
}

interface SignOff {
  body: string[];
  closing?: string;
  name?: string;
}

/** Peel "Best, Anderson." / "Thanks!" / "謝謝。Anderson" off the end of an email. */
export function splitSignOff(sentences: string[]): SignOff {
  const s = [...sentences];
  const last = s[s.length - 1];
  if (!last) return { body: s };

  // "…can sync, best, Anderson." — Whisper sometimes runs the sign-off into the last sentence.
  const merged = /^(.*?[^,，])[,，]\s*([^,，]+?)[,，]?\s+([^,，]+?)[.。!！]?$/u.exec(last);
  if (merged && isClosing(merged[2]!) && isName(merged[3]!) && merged[1]!.split(' ').length > 2) {
    s[s.length - 1] = `${merged[1]}.`;
    return { body: s, closing: closingLine(merged[2]!, true), name: bare(merged[3]!) };
  }
  // "Best, Anderson." / "謝謝，Anderson"
  const withName = /^(.+?)[,，!！.。]?\s*([A-Z][\w'’-]*(?: [A-Z][\w'’-]*){0,2}|\p{Script=Han}{2,4})[.。!！]?$/u.exec(last);
  if (withName && isClosing(withName[1]!) && isName(withName[2]!)) {
    return { body: s.slice(0, -1), closing: closingLine(withName[1]!, true), name: bare(withName[2]!) };
  }
  // "Thanks. Anderson." / "謝謝。Anderson" / "再麻煩您了，謝謝。Anderson"
  const prev = s[s.length - 2];
  if (prev && isName(last) && (isClosing(prev) || endsWithClosing(prev))) {
    const closing = isClosing(prev) ? closingLine(prev, true) : prev.trim();
    return { body: s.slice(0, -2), closing, name: bare(last) };
  }
  // "Thanks!" on its own
  if (isClosing(last)) return { body: s.slice(0, -1), closing: closingLine(last, false) };
  return { body: s };
}

const OPENER = /^(?:i hope (?:this|you|all|your|everything)|hope (?:you|all|this|your|everything)|i trust (?:this|you)|希望您|希望你|希望一切|近來可好|最近好嗎)/i;
const TRANSITION =
  /^(?:also|additionally|separately|on (?:another|a separate|a different) note|by the way|in addition|besides|moreover|one more thing|另外|此外|還有|还有|順帶一提|顺带一提|順便|顺便|再者)(?=[\s,，、:：]|$)/i;
const CLOSING_LINE =
  /^(?:let me know|please let me know|looking forward|i look forward|thanks in advance|thank you (?:so much |very much )?for|thanks (?:so much |a lot )?for|feel free|happy to|if you have any questions|please don't hesitate|hope to hear|talk soon|期待|如有任何|如有問題|有任何問題|再麻煩|麻煩您|謝謝您的|感謝您的|敬請)/i;

/**
 * In a long stretch of an email with no other cue to break on, start a new paragraph once the
 * current one holds three sentences and a few lines of text — short notes stay one block.
 */
function breakLongParagraph(_sentence: string, sentencesSoFar: number, charsSoFar: number): boolean {
  return sentencesSoFar >= 3 && charsSoFar >= 180;
}

/** Group body sentences into paragraphs at the natural seams of an email. */
function emailParagraphs(sentences: string[]): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  let closingStarted = false;
  sentences.forEach((sentence, i) => {
    const opener = i === 1 && OPENER.test(sentences[0]!); // "I hope you're well." stands alone
    const transition = TRANSITION.test(sentence);
    const closing = !closingStarted && i > 0 && CLOSING_LINE.test(sentence);
    const long = current.length > 0 && breakLongParagraph(sentence, current.length, joinSentences(current).length);
    if (current.length && (opener || transition || closing || long)) {
      paragraphs.push(current);
      current = [];
    }
    if (closing) closingStarted = true;
    current.push(sentence);
  });
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

/**
 * Email layout:
 *
 *   Hi John,
 *
 *   Thanks for the update. I reviewed the deck and have two comments:
 *
 *   1. The pricing slide is outdated.
 *   2. We need the Q3 numbers.
 *
 *   Let me know when you can sync.
 *
 *   Best,
 *   Anderson
 */
export function layoutEmail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const greeting = splitGreeting(trimmed);
  const bodyText = greeting ? greeting.rest : trimmed;

  // Paragraph breaks you asked for ("new paragraph") are kept; everything else is decided here.
  const chunks = bodyText.split(/\n{2,}/).map(splitSentences);
  const lastChunk = chunks.pop() ?? [];
  const signOff = splitSignOff(lastChunk);
  chunks.push(signOff.body);

  const parts: string[] = [];
  if (greeting) parts.push(greeting.greeting);
  for (const chunk of chunks) {
    for (const block of extractLists(chunk)) {
      if (block.kind === 'list') parts.push(...renderBlocks([block]));
      else parts.push(...emailParagraphs(block.sentences).map(joinSentences));
    }
  }
  if (signOff.closing) parts.push(signOff.name ? `${signOff.closing}\n${signOff.name}` : signOff.closing);
  return parts.filter((p) => p.trim()).join('\n\n');
}
