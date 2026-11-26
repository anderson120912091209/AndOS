import type { CatalogEntry } from "./catalog";

export interface ConversionContext {
  /**
   * No longer keyword starts with what was typed, so waiting cannot change the answer:
   * true for "sqrt" or "alpha", false for "sin" (could become "sinh") or "pi" ("piecewise").
   */
  unique: boolean;
  /**
   * The word is finished: the user just typed something that cannot continue it, such as
   * a space, digit, operator, bracket or a letter no keyword continues with.
   */
  finished: boolean;
}

/**
 * Whether letters just typed turn into `match` by themselves, without the user picking it
 * from the suggestion list (Enter or Tab always works). Called with the exact text typed,
 * e.g. "sqrt", "pi", "in", "to" or "Delta", whenever it equals one of `match`'s keywords.
 *
 * Returning false keeps the letters as variables: `in` stays i·n, unless the user picks ∈.
 */
export function shouldAutoConvert(typed: string, match: CatalogEntry, context: ConversionContext): boolean {
  // TODO(human): decide when typed letters become a symbol without asking.
  return false;
}
