/**
 * The suggestion engine: ranks catalog entries against the letters being typed, and tells
 * the editor whether those letters could still grow into a keyword.
 */
import { CATALOG, type CatalogEntry } from "./catalog";

export interface Suggestion {
  entry: CatalogEntry;
  /** The keyword that matched, to show the user why. */
  keyword: string;
  score: number;
  exact: boolean;
}

const lower = (text: string) => text.toLowerCase();

/** Every proper prefix of every keyword ("s", "sq", "sqr" for "sqrt"), lower-cased. */
const PROPER_PREFIXES = new Set<string>();
/** Every keyword, lower-cased. */
const KEYWORDS = new Set<string>();
for (const entry of CATALOG) {
  for (const keyword of entry.keywords) {
    const k = lower(keyword);
    KEYWORDS.add(k);
    for (let i = 1; i < k.length; i++) PROPER_PREFIXES.add(k.slice(0, i));
  }
}

/** Whether `text` is a keyword or the start of one, so it is worth waiting for more letters. */
export function canExtend(text: string): boolean {
  const k = lower(text);
  return KEYWORDS.has(k) || PROPER_PREFIXES.has(k);
}

/** Whether no longer keyword starts with `text`: "sqrt" is unique, "sin" is not ("sinh"). */
export function isUnique(text: string): boolean {
  return !PROPER_PREFIXES.has(lower(text));
}

/** The best entry with a keyword equal to `text`; same case wins over case-insensitive. */
export function exactMatch(text: string): CatalogEntry | undefined {
  let best: CatalogEntry | undefined;
  let bestScore = -1;
  for (const entry of CATALOG) {
    for (const keyword of entry.keywords) {
      if (lower(keyword) !== lower(text)) continue;
      const score = (keyword === text ? 100 : 0) + entry.weight;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
  }
  return best;
}

/**
 * Ranks the catalog for what has been typed. A keyword that equals the text beats one that
 * starts with it, which beats one with a later word that starts with it ("root" in "cube
 * root"), which beats letters found in order ("sqt" in "sqrt"). Weight breaks ties, so
 * the common choice comes first.
 */
export function suggest(text: string, limit = 7): Suggestion[] {
  const typed = text.trim();
  const q = lower(typed);
  if (!q) return [];
  const ranked: Suggestion[] = [];
  for (const entry of CATALOG) {
    let best: Suggestion | undefined;
    for (const keyword of entry.keywords) {
      const k = lower(keyword);
      let score = 0;
      if (k === q) score = keyword === typed ? 1050 : 1000;
      else if (k.startsWith(q)) score = 700 - (k.length - q.length) * 3;
      else if (k.split(" ").some((word) => word.startsWith(q))) score = 450 - (k.length - q.length);
      else if (q.length >= 3 && isSubsequence(q, k)) score = 150 - (k.length - q.length);
      if (score > 0 && (!best || score > best.score)) best = { entry, keyword, score, exact: k === q };
    }
    if (best) ranked.push({ ...best, score: best.score + best.entry.weight * 12 });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) if (ch === needle[i]) i++;
  return i === needle.length;
}
