import type { AtomClass } from "./ast";
import type { Experience } from "./experience";

/** TeX's math unit: 18mu = 1em. */
export const MU = 1 / 18;
export const THIN = 3 * MU;
export const MEDIUM = 4 * MU;
export const THICK = 5 * MU;

const BINARY_BREAKERS: ReadonlySet<AtomClass> = new Set(["bin", "op", "rel", "open", "punct"]);
const BINARY_ENDERS: ReadonlySet<AtomClass> = new Set(["rel", "close", "punct"]);

/**
 * A binary operator needs something on both sides. TeX demotes it to an ordinary atom
 * when it opens a list or follows another operator, relation, opener or punctuation
 * (the "−" in "−x" or "= −3"), and when a relation, closer or punctuation follows it.
 * Without this, a unary minus would get binary spacing on both sides.
 */
export function demoteBinaries(classes: (AtomClass | null)[]): (AtomClass | null)[] {
  const out = [...classes];
  let prev: AtomClass | null = null;
  let prevIndex = -1;
  for (let i = 0; i < out.length; i++) {
    const cls = out[i];
    if (cls === null || cls === undefined) continue;
    if (cls === "bin" && (prev === null || BINARY_BREAKERS.has(prev))) out[i] = "ord";
    if (BINARY_ENDERS.has(cls) && prev === "bin") out[prevIndex] = "ord";
    prev = out[i] ?? null;
    prevIndex = i;
  }
  if (prev === "bin") out[prevIndex] = "ord";
  return out;
}

/**
 * Space, in em, between two adjacent atoms in a TeX-style experience, before the
 * experience's `spacing.scale` is applied. Binary demotion has already run, so `left`
 * and `right` are never an impossible pairing such as bin–bin.
 *
 * `inScript` is true at script and scriptscript sizes, where TeX keeps superscripts
 * compact by dropping the spaces it only uses at text size.
 */
export function texSpace(left: AtomClass, right: AtomClass, inScript: boolean): number {
  const code = TEX_TABLE[left][CLASS_ORDER.indexOf(right)];
  switch (code) {
    case "1":
      return THIN;
    case "t":
      return inScript ? 0 : THIN;
    case "m":
      return inScript ? 0 : MEDIUM;
    case "k":
      return inScript ? 0 : THICK;
    default:
      return 0;
  }
}

const CLASS_ORDER: AtomClass[] = ["ord", "op", "bin", "rel", "open", "close", "punct", "inner"];

/**
 * The TeXbook's spacing table (ch. 18), one row per left class, one column per right class
 * in `CLASS_ORDER`: 0 none, 1 thin always, t/m/k thin/medium/thick outside scripts only,
 * * a pairing binary demotion makes impossible.
 */
const TEX_TABLE: Record<AtomClass, string> = {
  ord: "01mk000t",
  op: "11*k000t",
  bin: "mm**m**m",
  rel: "kk*0k00k",
  open: "00*00000",
  close: "01mk000t",
  punct: "tt*ttttt",
  inner: "t1mkt0tt",
};

/** A single gap, opened up around operators and relations. Used by the chip experience. */
export function uniformSpace(left: AtomClass, right: AtomClass, exp: Experience, level: number): number {
  const shrink = level > 0 ? 0.6 : 1;
  const { uniformGap, operatorGap, relationGap } = exp.spacing;
  if (left === "rel" || right === "rel") return relationGap * shrink;
  if (left === "bin" || right === "bin") return operatorGap * shrink;
  if (left === "punct") return operatorGap * shrink;
  if (left === "open" || right === "close" || right === "punct") return 0;
  return uniformGap * shrink;
}

/** Space in em between two atoms at the given script level, per the experience's rule. */
export function spaceBetween(left: AtomClass, right: AtomClass, level: number, exp: Experience): number {
  if (exp.spacing.mode === "uniform") return uniformSpace(left, right, exp, level);
  return texSpace(left, right, level > 0) * exp.spacing.scale;
}
