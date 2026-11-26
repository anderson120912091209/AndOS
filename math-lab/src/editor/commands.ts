/**
 * Editing commands: pure functions from one editor state to the next. Each works on a
 * private copy of the tree, so the UI can keep every state for undo.
 *
 * The keyboard is the whole interface. Letters may become symbols (see `policy.ts`);
 * `/` makes a fraction from what precedes it; `^` and `_` open scripts; brackets open
 * groups that grow with their contents; `<=`, `->`, `+-` and friends merge into ≤ → ±.
 */
import type { MathNode, RowNode, SupSubNode } from "../engine/ast";
import { parseLatex } from "../engine/parse";
import { CHAR_SYMBOLS, symbolForGlyph, type SymbolDef } from "../engine/symbols";
import type { CatalogEntry, Template } from "./catalog";
import {
  atom,
  buildIndex,
  editableRow,
  firstEmptySlot,
  newId,
  row,
  slotsOf,
  variable,
  type Cursor,
  type EditorState,
  type RowPlace,
  type TreeIndex,
} from "./model";
import { shouldAutoConvert, type ConversionContext } from "./policy";
import { canExtend, exactMatch, isUnique } from "./suggest";

export interface EditOptions {
  /** Overrides the conversion policy, e.g. in tests. */
  autoConvert?: (typed: string, match: CatalogEntry, context: ConversionContext) => boolean;
}

type Options = Required<EditOptions>;

const resolveOptions = (options: EditOptions = {}): Options => ({
  autoConvert: options.autoConvert ?? shouldAutoConvert,
});

/** A mutable working copy of a state. */
class Draft {
  root: RowNode;
  cursor: Cursor;
  pending: string;
  revert?: EditorState;
  index: TreeIndex;

  constructor(state: EditorState) {
    this.root = structuredClone(state.root);
    this.cursor = { ...state.cursor };
    this.pending = state.pending;
    this.index = buildIndex(this.root);
    if (!this.index.rows.has(this.cursor.row)) this.cursor = { row: this.root.id, index: this.root.children.length };
  }

  reindex(): void {
    this.index = buildIndex(this.root);
  }

  place(rowId = this.cursor.row): RowPlace {
    const place = this.index.rows.get(rowId);
    if (!place) throw new Error(`No row ${rowId}`);
    return place;
  }

  get row(): RowNode {
    return this.place().row;
  }

  snapshot(): EditorState {
    return { root: structuredClone(this.root), cursor: { ...this.cursor }, pending: this.pending };
  }

  /** Any edit after a conversion means Backspace should delete, not undo the conversion. */
  touch(): void {
    this.revert = undefined;
  }

  insert(nodes: MathNode[]): void {
    this.touch();
    this.row.children.splice(this.cursor.index, 0, ...nodes);
    this.cursor = { row: this.cursor.row, index: this.cursor.index + nodes.length };
    this.reindex();
  }

  moveTo(target: RowNode | string, index: number): void {
    this.cursor = { row: typeof target === "string" ? target : target.id, index };
  }
}

function edit(state: EditorState, change: (draft: Draft) => void): EditorState {
  const draft = new Draft(state);
  change(draft);
  prune(draft);
  const next: EditorState = { root: draft.root, cursor: draft.cursor, pending: draft.pending };
  if (draft.revert) next.revert = draft.revert;
  return next;
}

// ── Typing ─────────────────────────────────────────────────────────────────

export function typeText(state: EditorState, text: string, options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    for (const ch of text) typeChar(d, ch, o);
  });
}

function typeChar(d: Draft, ch: string, o: Options): void {
  if (/^[A-Za-z]$/.test(ch)) return typeLetter(d, ch, o);
  if (ch === " ") return typeSpace(d, o);
  if (ch === "\n" || ch === "\t") return;
  resolvePending(d, o);
  if (/^[0-9.]$/.test(ch)) return typeDigit(d, ch);
  switch (ch) {
    case "/":
      return makeFraction(d);
    case "^":
      return makeScript(d, "sup");
    case "_":
      return makeScript(d, "sub");
    case "(":
      return openFence(d, "(", ")");
    case "[":
      return openFence(d, "[", "]");
    case "{":
      return openFence(d, "{", "}");
    case ")":
    case "]":
    case "}":
      return closeFence(d, ch);
    case "|":
      return typeBar(d);
    case "'":
      return d.insert([atom("′", "ord", "operator")]);
    default:
      return typeSymbol(d, ch);
  }
}

/**
 * Letters collect as `pending` while they could still spell a keyword. When the next
 * letter can't continue any keyword, the word so far either converts (if the policy says
 * so) or its oldest letter settles as a variable, and the new letter is tried again.
 */
function typeLetter(d: Draft, letter: string, o: Options): void {
  const candidate = d.pending + letter;
  if (canExtend(candidate)) {
    d.touch();
    d.pending = candidate;
    const match = exactMatch(candidate);
    if (match && isUnique(candidate) && o.autoConvert(candidate, match, { unique: true, finished: false })) {
      convert(d, match);
    }
    return;
  }
  if (d.pending) {
    const typed = d.pending.trim();
    const match = typed ? exactMatch(typed) : undefined;
    if (match && o.autoConvert(typed, match, { unique: isUnique(typed), finished: true })) convert(d, match);
    else commitPending(d, 1);
    typeLetter(d, letter, o);
    return;
  }
  d.insert([variable(letter)]);
}

/** Settles the first `count` pending characters as variables (spaces just vanish). */
function commitPending(d: Draft, count: number): void {
  const letters = [...d.pending.slice(0, count)].filter((ch) => ch !== " ");
  d.pending = d.pending.slice(count);
  if (letters.length > 0) d.insert(letters.map(variable));
  else d.touch();
}

/** Ends the word being typed: convert it if the policy agrees, else keep its letters. Returns whether it converted. */
function resolvePending(d: Draft, o: Options): boolean {
  const typed = d.pending.trim();
  if (!typed) {
    d.pending = "";
    return false;
  }
  const match = exactMatch(typed);
  if (match && o.autoConvert(typed, match, { unique: isUnique(typed), finished: true })) {
    convert(d, match);
    return true;
  }
  commitPending(d, d.pending.length);
  return false;
}

function convert(d: Draft, entry: CatalogEntry): void {
  const before = d.snapshot();
  d.pending = "";
  insertTemplate(d, entry.build());
  d.revert = before;
}

function insertTemplate(d: Draft, template: Template): void {
  d.insert(template.nodes);
  const empty = firstEmptySlot(template.nodes);
  const target = template.cursor ?? (empty ? { row: empty.id, index: 0 } : undefined);
  if (target) d.cursor = { ...target };
}

/** A space can continue a phrase ("square root"); otherwise it ends the word and steps out of a script. */
function typeSpace(d: Draft, o: Options): void {
  if (d.pending && canExtend(d.pending + " ")) {
    d.touch();
    d.pending += " ";
    return;
  }
  // A space that turned a word into a symbol has done its job; it doesn't also step out.
  if (resolvePending(d, o)) return;
  const place = d.place();
  if (place.owner?.kind === "supsub" && d.cursor.index === place.row.children.length) {
    d.touch();
    d.moveTo(place.ownerRow!, place.ownerIndex + 1);
  }
}

function typeDigit(d: Draft, digit: string): void {
  d.touch();
  const previous = d.row.children[d.cursor.index - 1];
  if (previous?.kind === "atom" && previous.role === "number" && !(digit === "." && previous.text.includes("."))) {
    previous.text += digit;
    return;
  }
  d.insert([atom(digit, "ord", "number")]);
}

/** Characters whose meaning differs from what they look like in LaTeX source. */
const TYPED: Record<string, SymbolDef> = {
  "*": { text: "⋅", cls: "bin", role: "operator" },
  "~": { text: "∼", cls: "rel", role: "relation" },
};

/** Two symbols typed in a row that merge into one, keyed by the glyphs involved. */
const LIGATURES: Record<string, string> = {
  "<=": "≤",
  ">=": "≥",
  "!=": "≠",
  "−>": "→",
  "<−": "←",
  "=>": "⇒",
  "≤>": "⇔",
  "←>": "↔",
  "+−": "±",
  "−+": "∓",
  "∼=": "≈",
  "==": "≡",
  "<<": "≪",
  ">>": "≫",
};

function typeSymbol(d: Draft, ch: string): void {
  const def: SymbolDef = TYPED[ch] ?? CHAR_SYMBOLS[ch] ?? symbolForGlyph(ch) ?? { text: ch, cls: "ord", role: "constant" };
  const previous = d.row.children[d.cursor.index - 1];
  const merged = previous?.kind === "atom" ? LIGATURES[previous.text + def.text] : undefined;
  if (merged && previous?.kind === "atom") {
    const symbol = symbolForGlyph(merged);
    if (symbol) {
      d.touch();
      Object.assign(previous, { text: symbol.text, cls: symbol.cls, role: symbol.role });
      return;
    }
  }
  // `x^2+1`: an operator right after a lone number in a script leaves the script first.
  if ((def.cls === "bin" || def.cls === "rel" || def.cls === "punct") && scriptHoldsLoneNumber(d)) {
    const place = d.place();
    d.moveTo(place.ownerRow!, place.ownerIndex + 1);
  }
  d.insert([atom(def.text, def.cls, def.role)]);
}

function scriptHoldsLoneNumber(d: Draft): boolean {
  const place = d.place();
  const only = place.row.children[0];
  return (
    place.owner?.kind === "supsub" &&
    place.row.children.length === 1 &&
    d.cursor.index === 1 &&
    only?.kind === "atom" &&
    only.role === "number"
  );
}

/** What `/` takes as its numerator: the run of operands before the cursor, stopping at operators. */
function isOperand(node: MathNode): boolean {
  if (node.kind === "space") return false;
  if (node.kind !== "atom") return true;
  return node.cls === "ord" || node.cls === "close" || node.cls === "inner" || node.role === "function";
}

function makeFraction(d: Draft): void {
  d.touch();
  const children = d.row.children;
  const end = d.cursor.index;
  let start = end;
  while (start > 0 && isOperand(children[start - 1]!)) start--;
  // Scripts stay with their base: if the base isn't part of the run, neither are its scripts.
  while (start < end && children[start]!.kind === "supsub") start++;
  const numerator = row(children.splice(start, end - start));
  const denominator = row();
  children.splice(start, 0, { kind: "frac", id: newId(), num: numerator, den: denominator });
  d.reindex();
  d.moveTo(numerator.children.length > 0 ? denominator : numerator, 0);
}

function makeScript(d: Draft, which: "sup" | "sub"): void {
  d.touch();
  const place = d.place();
  // Already at the end of a script: `^` and `_` hop between a base's two scripts.
  if (place.owner?.kind === "supsub" && d.cursor.index === place.row.children.length) {
    const owner = place.owner;
    if (owner[which] !== place.row) {
      const target = (owner[which] ??= row());
      d.reindex();
      d.moveTo(target, target.children.length);
      return;
    }
    if (place.row.children.length === 0) return;
  }
  const previous = d.row.children[d.cursor.index - 1];
  if (previous?.kind === "supsub") {
    const target = (previous[which] ??= row());
    d.reindex();
    d.moveTo(target, target.children.length);
    return;
  }
  const slot = row();
  const scripts: SupSubNode = which === "sup" ? { kind: "supsub", id: newId(), sup: slot } : { kind: "supsub", id: newId(), sub: slot };
  d.insert([scripts]);
  d.moveTo(slot, 0);
}

function openFence(d: Draft, open: string, close: string): void {
  const body = row();
  d.insert([{ kind: "fenced", id: newId(), open, close, body, auto: true }]);
  d.moveTo(body, 0);
}

/** A closing bracket steps out of the group it closes, through any scripts it ends; else it's a plain glyph. */
function closeFence(d: Draft, ch: string): void {
  let place = d.place();
  let index = d.cursor.index;
  while (place.owner && index === place.row.children.length) {
    if (place.owner.kind === "fenced") {
      d.touch();
      d.moveTo(place.ownerRow!, place.ownerIndex + 1);
      return;
    }
    index = place.ownerIndex + 1;
    place = d.place(place.ownerRow!.id);
  }
  const def = CHAR_SYMBOLS[ch]!;
  d.insert([atom(def.text, def.cls, def.role)]);
}

function typeBar(d: Draft): void {
  const place = d.place();
  const owner = place.owner;
  if (owner?.kind === "fenced" && owner.close === "|" && place.row.children.length > 0 && d.cursor.index === place.row.children.length) {
    d.touch();
    d.moveTo(place.ownerRow!, place.ownerIndex + 1);
    return;
  }
  openFence(d, "|", "|");
}

// ── Suggestions ────────────────────────────────────────────────────────────

/** Inserts a suggestion the user picked, replacing the letters being typed. */
export function acceptSuggestion(state: EditorState, entry: CatalogEntry): EditorState {
  return edit(state, (d) => convert(d, entry));
}

/** Keeps the letters being typed as plain variables (Escape). */
export function keepLetters(state: EditorState): EditorState {
  return edit(state, (d) => commitPending(d, d.pending.length));
}

/** Inserts LaTeX at the cursor, e.g. from the clipboard. */
export function insertLatex(state: EditorState, latex: string, options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.insert(editableRow(parseLatex(latex).root).children);
  });
}

// ── Deleting ───────────────────────────────────────────────────────────────

export function backspace(state: EditorState): EditorState {
  // Right after letters became a symbol, Backspace brings the letters back.
  if (state.revert) return state.revert;
  return edit(state, (d) => {
    d.touch();
    if (d.pending) {
      d.pending = d.pending.slice(0, -1);
      return;
    }
    const children = d.row.children;
    const i = d.cursor.index;
    if (i > 0) {
      const previous = children[i - 1]!;
      if (previous.kind === "atom" && previous.role === "number" && previous.text.length > 1) {
        previous.text = previous.text.slice(0, -1);
        return;
      }
      const slots = slotsOf(previous);
      if (previous.kind === "atom" || slots.every((slot) => slot.children.length === 0)) {
        children.splice(i - 1, 1);
        d.reindex();
        d.moveTo(d.cursor.row, i - 1);
        // Taking a letter off a function name reopens the word, so its suggestions return.
        if (previous.kind === "atom" && previous.role === "function" && /^[A-Za-z]{2,}$/.test(previous.text)) {
          d.pending = previous.text.slice(0, -1);
        }
        return;
      }
      const last = slots.at(-1)!;
      d.moveTo(last, last.children.length);
      return;
    }
    const place = d.place();
    if (!place.owner) return;
    const owner = place.owner;
    const ownerRow = place.ownerRow!;
    const slots = slotsOf(owner);
    if (slots.every((slot) => slot.children.length === 0)) {
      ownerRow.children.splice(place.ownerIndex, 1);
      d.reindex();
      d.moveTo(ownerRow, place.ownerIndex);
      return;
    }
    if (place.slot > 0) {
      const previousSlot = slots[place.slot - 1]!;
      d.moveTo(previousSlot, previousSlot.children.length);
      return;
    }
    if (owner.kind === "matrix") {
      d.moveTo(ownerRow, place.ownerIndex);
      return;
    }
    // At the very start of a structure that still holds something: dissolve it, keep the contents.
    ownerRow.children.splice(place.ownerIndex, 1, ...slots.flatMap((slot) => slot.children));
    d.reindex();
    d.moveTo(ownerRow, place.ownerIndex);
  });
}

export function deleteForward(state: EditorState): EditorState {
  return edit(state, (d) => {
    d.touch();
    const children = d.row.children;
    const next = children[d.cursor.index];
    if (!next || d.pending) return;
    const slots = slotsOf(next);
    if (next.kind === "atom" || slots.every((slot) => slot.children.length === 0)) {
      children.splice(d.cursor.index, 1);
      d.reindex();
      return;
    }
    d.moveTo(slots[0]!, 0);
  });
}

// ── Moving ─────────────────────────────────────────────────────────────────

export function moveRight(state: EditorState, options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.touch();
    const next = d.row.children[d.cursor.index];
    if (next) {
      const first = slotsOf(next)[0];
      if (first) d.moveTo(first, 0);
      else d.moveTo(d.cursor.row, d.cursor.index + 1);
      return;
    }
    const place = d.place();
    if (!place.owner) return;
    const following = slotsOf(place.owner)[place.slot + 1];
    if (following) d.moveTo(following, 0);
    else d.moveTo(place.ownerRow!, place.ownerIndex + 1);
  });
}

export function moveLeft(state: EditorState, options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.touch();
    const previous = d.row.children[d.cursor.index - 1];
    if (previous) {
      const last = slotsOf(previous).at(-1);
      if (last) d.moveTo(last, last.children.length);
      else d.moveTo(d.cursor.row, d.cursor.index - 1);
      return;
    }
    const place = d.place();
    if (!place.owner) return;
    const preceding = slotsOf(place.owner)[place.slot - 1];
    if (preceding) d.moveTo(preceding, preceding.children.length);
    else d.moveTo(place.ownerRow!, place.ownerIndex);
  });
}

/** Up and down move between stacked slots: numerator and denominator, scripts, matrix rows. */
export function moveVertically(state: EditorState, direction: "up" | "down", options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.touch();
    let place = d.place();
    let ratio = place.row.children.length > 0 ? d.cursor.index / place.row.children.length : 0;
    while (place.owner) {
      const target = verticalNeighbour(place, direction);
      if (target) {
        d.moveTo(target, Math.round(ratio * target.children.length));
        return;
      }
      const ownerRow = place.ownerRow!;
      ratio = ownerRow.children.length > 0 ? (place.ownerIndex + 0.5) / ownerRow.children.length : 0;
      place = d.place(ownerRow.id);
    }
  });
}

function verticalNeighbour(place: RowPlace, direction: "up" | "down"): RowNode | undefined {
  const owner = place.owner!;
  const here = place.row;
  const pick = (from: MathNode | undefined, to: MathNode | undefined) =>
    from === here && to?.kind === "row" ? to : undefined;
  switch (owner.kind) {
    case "frac":
      return direction === "down" ? pick(owner.num, owner.den) : pick(owner.den, owner.num);
    case "supsub":
      return direction === "down" ? pick(owner.sup, owner.sub) : pick(owner.sub, owner.sup);
    case "sqrt":
      return direction === "down" ? pick(owner.index, owner.body) : pick(owner.body, owner.index);
    case "matrix": {
      const r = owner.rows.findIndex((cells) => cells.includes(here));
      const c = owner.rows[r]?.indexOf(here) ?? -1;
      const target = owner.rows[r + (direction === "down" ? 1 : -1)]?.[c];
      return target?.kind === "row" ? target : undefined;
    }
    default:
      return undefined;
  }
}

export function moveToRowEdge(state: EditorState, edge: "start" | "end", options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.touch();
    d.moveTo(d.cursor.row, edge === "start" ? 0 : d.row.children.length);
  });
}

/** Tab: the next empty slot (or the end of the formula when none is left); Shift-Tab goes back. */
export function jumpToSlot(state: EditorState, direction: "next" | "previous", options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.touch();
    const keys = new Map<string, number[]>();
    const empties: RowNode[] = [];
    const visit = (current: RowNode, key: number[]) => {
      keys.set(current.id, key);
      if (current.children.length === 0 && current !== d.root) empties.push(current);
      current.children.forEach((child, i) => slotsOf(child).forEach((slot, k) => visit(slot, [...key, i, k])));
    };
    visit(d.root, []);
    const here = [...(keys.get(d.cursor.row) ?? []), d.cursor.index];
    const candidates = empties.filter((slot) => slot.id !== d.cursor.row);
    const ordered = candidates.sort((a, b) => compareKeys(keys.get(a.id)!, keys.get(b.id)!));
    const target =
      direction === "next"
        ? ordered.find((slot) => compareKeys(keys.get(slot.id)!, here) > 0)
        : ordered.reverse().find((slot) => compareKeys(keys.get(slot.id)!, here) < 0);
    if (target) d.moveTo(target, 0);
    else d.moveTo(d.root, direction === "next" ? d.root.children.length : 0);
  });
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function setCursor(state: EditorState, cursor: Cursor, options?: EditOptions): EditorState {
  const o = resolveOptions(options);
  return edit(state, (d) => {
    resolvePending(d, o);
    d.touch();
    if (d.index.rows.has(cursor.row)) d.cursor = { ...cursor };
  });
}

// ── Housekeeping ───────────────────────────────────────────────────────────

/**
 * Removes scripts left empty once the cursor is elsewhere: an abandoned `^`, or the unused
 * upper limit of a ∑ whose lower limit was filled in.
 */
function prune(d: Draft): void {
  const holdsCursor = (slot: RowNode | undefined) => {
    if (!slot) return false;
    let rowId: string | undefined = d.cursor.row;
    while (rowId) {
      if (rowId === slot.id) return true;
      rowId = d.index.rows.get(rowId)?.ownerRow?.id;
    }
    return false;
  };
  const isBlank = (slot: RowNode | undefined) => !slot || slot.children.length === 0;
  let changed = false;
  const visit = (current: RowNode) => {
    for (let i = current.children.length - 1; i >= 0; i--) {
      const child = current.children[i]!;
      for (const slot of slotsOf(child)) visit(slot);
      // Leave scripts alone while the cursor is in either of them: Tab may be on its way.
      if (child.kind !== "supsub" || holdsCursor(child.sup) || holdsCursor(child.sub)) continue;
      if (child.sub && isBlank(child.sub) && !isBlank(child.sup)) {
        delete child.sub;
        changed = true;
      }
      if (child.sup && isBlank(child.sup) && !isBlank(child.sub)) {
        delete child.sup;
        changed = true;
      }
      if (isBlank(child.sup) && isBlank(child.sub)) {
        current.children.splice(i, 1);
        if (current.id === d.cursor.row && d.cursor.index > i) d.cursor = { row: d.cursor.row, index: d.cursor.index - 1 };
        changed = true;
      }
    }
  };
  visit(d.root);
  if (changed) d.reindex();
}

/** The tree as it should look, with the letters being typed shown at the cursor. */
export function displayTree(state: EditorState): { root: RowNode; cursor: Cursor; pendingIds: string[] } {
  if (!state.pending) return { root: state.root, cursor: state.cursor, pendingIds: [] };
  const root = structuredClone(state.root);
  const place = buildIndex(root).rows.get(state.cursor.row);
  if (!place) return { root: state.root, cursor: state.cursor, pendingIds: [] };
  const nodes: MathNode[] = [...state.pending].map((ch, i) =>
    ch === " "
      ? { kind: "space", id: `pending-${i}`, em: 0.3 }
      : { kind: "atom", id: `pending-${i}`, text: ch, cls: "ord", role: "variable", pending: true },
  );
  place.row.children.splice(state.cursor.index, 0, ...nodes);
  return {
    root,
    cursor: { row: state.cursor.row, index: state.cursor.index + nodes.length },
    pendingIds: nodes.map((node) => node.id),
  };
}
