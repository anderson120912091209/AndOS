/**
 * Everything you can ask for by name instead of writing LaTeX: symbols, functions and
 * structures with empty slots. Keywords are plain words ("square root", "union",
 * "less than or equal"); a few short forms (sqrt, int) are there for people who know them.
 */
import type { AccentKind, AtomClass, MathNode, Role } from "../engine/ast";
import { FUNCTIONS, GREEK, LIMIT_FUNCTIONS } from "../engine/symbols";
import { atom, newId, row, type Cursor } from "./model";

export type Group =
  | "structure"
  | "calculus"
  | "big operator"
  | "greek"
  | "function"
  | "relation"
  | "arrow"
  | "operator"
  | "set"
  | "logic"
  | "symbol"
  | "accent";

/** What an entry inserts, and optionally where the cursor goes (else: the first empty slot). */
export interface Template {
  nodes: MathNode[];
  cursor?: Cursor;
}

export interface CatalogEntry {
  id: string;
  /** What the entry is, in words; shown in the suggestion list. */
  label: string;
  /** What you can type to find it. Matching ignores case unless the case tells two apart (delta, Delta). */
  keywords: string[];
  group: Group;
  /** How often people want it, 1–10; breaks ties between equally good matches. */
  weight: number;
  build: () => Template;
}

const entries: CatalogEntry[] = [];

function add(id: string, label: string, keywords: string[], group: Group, weight: number, build: () => Template) {
  entries.push({ id, label, keywords, group, weight, build });
}

function symbol(id: string, glyph: string, cls: AtomClass, role: Role, label: string, keywords: string[], group: Group, weight = 5) {
  add(id, label, keywords, group, weight, () => ({ nodes: [atom(glyph, cls, role)] }));
}

const slot = () => row();

// ── Structures ─────────────────────────────────────────────────────────────
add("fraction", "fraction", ["frac", "fraction", "over", "divided by"], "structure", 9, () => ({
  nodes: [{ kind: "frac", id: newId(), num: slot(), den: slot() }],
}));
add("sqrt", "square root", ["sqrt", "square root", "root", "radical"], "structure", 10, () => ({
  nodes: [{ kind: "sqrt", id: newId(), body: slot() }],
}));
add("cbrt", "cube root", ["cube root", "cbrt", "third root"], "structure", 6, () => ({
  nodes: [{ kind: "sqrt", id: newId(), body: slot(), index: row([atom("3", "ord", "number")]) }],
}));
add("nroot", "nth root", ["nth root", "nroot", "root of degree"], "structure", 5, () => ({
  nodes: [{ kind: "sqrt", id: newId(), body: slot(), index: slot() }],
}));
const fenced = (open: string, close: string) => () => ({
  nodes: [{ kind: "fenced" as const, id: newId(), open, close, body: slot(), auto: true }],
});
add("abs", "absolute value", ["abs", "absolute value", "modulus"], "structure", 8, fenced("|", "|"));
add("norm", "norm", ["norm", "magnitude"], "structure", 6, fenced("‖", "‖"));
add("floor", "floor", ["floor", "round down"], "structure", 5, fenced("⌊", "⌋"));
add("ceil", "ceiling", ["ceil", "ceiling", "round up"], "structure", 5, fenced("⌈", "⌉"));
add("angles", "angle brackets", ["angle brackets", "inner product", "expectation brackets"], "structure", 4, fenced("⟨", "⟩"));

const grid = (rows: number, columns: number) =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => slot()));
add("matrix", "matrix", ["matrix", "pmatrix", "2x2 matrix"], "structure", 8, () => ({
  nodes: [{ kind: "matrix", id: newId(), rows: grid(2, 2), open: "(", close: ")", columnAlign: "center" }],
}));
add("bmatrix", "matrix in square brackets", ["bmatrix", "bracket matrix", "square matrix"], "structure", 5, () => ({
  nodes: [{ kind: "matrix", id: newId(), rows: grid(2, 2), open: "[", close: "]", columnAlign: "center" }],
}));
add("determinant", "determinant", ["determinant", "vmatrix"], "structure", 5, () => ({
  nodes: [{ kind: "matrix", id: newId(), rows: grid(2, 2), open: "|", close: "|", columnAlign: "center" }],
}));
add("vector", "column vector", ["vector", "column vector", "colvec"], "structure", 6, () => ({
  nodes: [{ kind: "matrix", id: newId(), rows: grid(2, 1), open: "(", close: ")", columnAlign: "center" }],
}));
add("cases", "cases (piecewise)", ["cases", "piecewise", "conditions"], "structure", 7, () => ({
  nodes: [{ kind: "matrix", id: newId(), rows: grid(2, 2), open: "{", close: ".", columnAlign: "left" }],
}));
add("exp-power", "e to the power", ["e to the", "exponential power", "e power"], "structure", 5, () => ({
  nodes: [atom("e", "ord", "variable"), { kind: "supsub", id: newId(), sup: slot() }],
}));

// ── Calculus ───────────────────────────────────────────────────────────────
const bigOp = (glyph: string, limits: boolean, withSup: boolean) => () => {
  const scripts: MathNode = withSup
    ? { kind: "supsub", id: newId(), sub: slot(), sup: slot() }
    : { kind: "supsub", id: newId(), sub: slot() };
  return { nodes: [atom(glyph, "op", "largeOp", { largeOp: true, limits }), scripts] };
};
add("sum", "sum", ["sum", "summation", "series", "sigma sum"], "big operator", 9, bigOp("∑", true, true));
add("prod", "product", ["prod", "product", "pi product"], "big operator", 6, bigOp("∏", true, true));
add("coprod", "coproduct", ["coprod", "coproduct"], "big operator", 2, bigOp("∐", true, true));
add("bigcup", "union over", ["big union", "bigcup", "union over"], "big operator", 4, bigOp("⋃", true, true));
add("bigcap", "intersection over", ["big intersection", "bigcap", "intersection over"], "big operator", 4, bigOp("⋂", true, true));
add("int", "integral", ["int", "integral", "integrate"], "calculus", 9, bigOp("∫", false, true));
add("iint", "double integral", ["double integral", "iint"], "calculus", 5, bigOp("∬", false, false));
add("iiint", "triple integral", ["triple integral", "iiint"], "calculus", 4, bigOp("∭", false, false));
add("oint", "contour integral", ["contour integral", "oint", "line integral"], "calculus", 4, bigOp("∮", false, false));
add("lim", "limit", ["lim", "limit"], "calculus", 9, () => ({
  nodes: [atom("lim", "op", "function", { limits: true }), { kind: "supsub", id: newId(), sub: slot() }],
}));
add("derivative", "derivative d/dx", ["derivative", "ddx", "d by dx", "differentiate"], "calculus", 7, () => ({
  nodes: [{ kind: "frac", id: newId(), num: row([atom("d", "ord", "variable")]), den: row([atom("d", "ord", "variable"), atom("x", "ord", "variable")]) }],
}));
add("partial-derivative", "partial derivative", ["partial derivative", "pdx", "partial by"], "calculus", 6, () => {
  const den = row([atom("∂", "ord", "constant")]);
  return {
    nodes: [{ kind: "frac", id: newId(), num: row([atom("∂", "ord", "constant")]), den }],
    cursor: { row: den.id, index: 1 },
  };
});
symbol("partial", "∂", "ord", "constant", "partial", ["partial", "curly d", "del"], "calculus", 7);
symbol("nabla", "∇", "ord", "constant", "nabla (gradient)", ["nabla", "gradient", "grad"], "calculus", 6);
symbol("infinity", "∞", "ord", "constant", "infinity", ["infinity", "infty", "inf"], "symbol", 9);

// ── Greek ──────────────────────────────────────────────────────────────────
const COMMON_GREEK = new Set(["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "sigma", "phi", "omega", "Delta", "Sigma", "Omega"]);
for (const [name, glyph] of Object.entries(GREEK)) {
  const spoken = name.startsWith("var") ? [name, `var ${name.slice(3)}`] : [name];
  add(`greek-${name}`, `${glyph} ${name}`, spoken, "greek", COMMON_GREEK.has(name) ? 7 : 4, () => ({
    nodes: [atom(glyph, "ord", "greek")],
  }));
}

// ── Functions ──────────────────────────────────────────────────────────────
const FUNCTION_WORDS: Record<string, string[]> = {
  sin: ["sine"], cos: ["cosine"], tan: ["tangent"], cot: ["cotangent"], sec: ["secant"], csc: ["cosecant"],
  arcsin: ["arc sine", "inverse sine"], arccos: ["arc cosine", "inverse cosine"], arctan: ["arc tangent", "inverse tangent"],
  sinh: ["hyperbolic sine"], cosh: ["hyperbolic cosine"], tanh: ["hyperbolic tangent"],
  log: ["logarithm"], ln: ["natural log", "natural logarithm"], exp: ["exponential"], det: [], max: ["maximum"],
  min: ["minimum"], sup: ["supremum"], inf: ["infimum"], gcd: ["greatest common divisor"], deg: [], arg: ["argument"],
};
const COMMON_FUNCTIONS = new Set(["sin", "cos", "tan", "log", "ln", "exp", "max", "min"]);
for (const name of [...FUNCTIONS, ...LIMIT_FUNCTIONS]) {
  if (name === "lim") continue; // the limit template above inserts it with its subscript
  const limits = LIMIT_FUNCTIONS.has(name);
  add(`fn-${name}`, `${name} function`, [name, ...(FUNCTION_WORDS[name] ?? [])], "function", COMMON_FUNCTIONS.has(name) ? 7 : 4, () => ({
    nodes: [atom(name, "op", "function", limits ? { limits } : {})],
  }));
}
add("log-base", "logarithm with base", ["log base", "logb"], "function", 5, () => ({
  nodes: [atom("log", "op", "function"), { kind: "supsub", id: newId(), sub: slot() }],
}));

// ── Relations, arrows, operators, sets, logic ─────────────────────────────
const rel = (id: string, glyph: string, label: string, keywords: string[], weight = 5, group: Group = "relation") =>
  symbol(id, glyph, "rel", "relation", label, keywords, group, weight);
const bin = (id: string, glyph: string, label: string, keywords: string[], weight = 5, group: Group = "operator") =>
  symbol(id, glyph, "bin", "operator", label, keywords, group, weight);

rel("leq", "≤", "less than or equal", ["leq", "less than or equal", "at most"], 8);
rel("geq", "≥", "greater than or equal", ["geq", "greater than or equal", "at least"], 8);
rel("neq", "≠", "not equal", ["neq", "not equal", "ne"], 8);
rel("approx", "≈", "approximately equal", ["approx", "approximately"], 7);
rel("equiv", "≡", "equivalent / identical", ["equiv", "equivalent", "identical", "congruent mod"], 5);
rel("sim", "∼", "similar / distributed as", ["sim", "similar", "distributed as", "tilde relation"], 4);
rel("cong", "≅", "congruent", ["cong", "congruent", "isomorphic"], 4);
rel("propto", "∝", "proportional to", ["propto", "proportional"], 5);
rel("ll", "≪", "much less than", ["much less", "ll"], 3);
rel("gg", "≫", "much greater than", ["much greater", "gg"], 3);
rel("in", "∈", "element of", ["in", "element of", "belongs to", "member of"], 7, "set");
rel("notin", "∉", "not an element of", ["notin", "not in", "not element"], 5, "set");
rel("subset", "⊂", "subset", ["subset", "proper subset"], 6, "set");
rel("subseteq", "⊆", "subset or equal", ["subseteq", "subset or equal", "subset equal"], 6, "set");
rel("supset", "⊃", "superset", ["supset", "superset"], 4, "set");
rel("supseteq", "⊇", "superset or equal", ["supseteq", "superset or equal"], 4, "set");
rel("perp", "⊥", "perpendicular", ["perp", "perpendicular", "orthogonal"], 4);
rel("parallel", "∥", "parallel", ["parallel"], 4);
rel("divides", "∣", "divides", ["divides", "mid"], 3);
rel("to", "→", "right arrow (tends to)", ["to", "arrow", "right arrow", "tends to", "goes to"], 7, "arrow");
rel("gets", "←", "left arrow", ["left arrow", "gets"], 4, "arrow");
rel("mapsto", "↦", "maps to", ["maps to", "mapsto"], 5, "arrow");
rel("implies", "⇒", "implies", ["implies", "then", "rightarrow double"], 7, "logic");
rel("impliedby", "⇐", "is implied by", ["implied by", "impliedby"], 3, "logic");
rel("iff", "⇔", "if and only if", ["iff", "if and only if", "equivalent to"], 6, "logic");
rel("therefore", "∴", "therefore", ["therefore", "hence"], 4, "logic");
rel("because", "∵", "because", ["because", "since"], 3, "logic");

bin("times", "×", "times (cross)", ["times", "cross", "multiply"], 8);
bin("cdot", "⋅", "dot (multiply)", ["cdot", "dot product", "centre dot", "center dot"], 7);
bin("div", "÷", "divide sign", ["div", "divide sign", "obelus"], 4);
bin("pm", "±", "plus or minus", ["pm", "plus minus", "plus or minus"], 8);
bin("mp", "∓", "minus or plus", ["mp", "minus plus", "minus or plus"], 3);
bin("circ", "∘", "compose", ["circ", "compose", "composition", "ring operator"], 5);
bin("oplus", "⊕", "direct sum (xor)", ["oplus", "direct sum", "xor"], 4);
bin("otimes", "⊗", "tensor product", ["otimes", "tensor", "tensor product"], 4);
bin("cup", "∪", "union", ["union", "cup"], 7, "set");
bin("cap", "∩", "intersection", ["intersection", "cap", "intersect"], 7, "set");
bin("setminus", "∖", "set difference", ["setminus", "set minus", "set difference", "without"], 4, "set");
bin("and", "∧", "and (wedge)", ["and", "wedge", "logical and"], 5, "logic");
bin("or", "∨", "or (vee)", ["or", "vee", "logical or"], 5, "logic");

symbol("not", "¬", "ord", "operator", "not", ["not", "negation", "neg"], "logic", 4);
symbol("forall", "∀", "ord", "constant", "for all", ["forall", "for all", "for every", "for each"], "logic", 7);
symbol("exists", "∃", "ord", "constant", "there exists", ["exists", "there exists", "there is"], "logic", 7);
symbol("nexists", "∄", "ord", "constant", "there is no", ["not exists", "there is no", "nexists"], "logic", 3);
symbol("emptyset", "∅", "ord", "constant", "empty set", ["empty set", "emptyset", "null set"], "set", 6);
symbol("reals", "ℝ", "ord", "constant", "real numbers", ["reals", "real numbers", "RR"], "set", 7);
symbol("naturals", "ℕ", "ord", "constant", "natural numbers", ["naturals", "natural numbers", "NN"], "set", 6);
symbol("integers", "ℤ", "ord", "constant", "integers", ["integers", "whole numbers", "ZZ"], "set", 6);
symbol("rationals", "ℚ", "ord", "constant", "rational numbers", ["rationals", "rational numbers", "QQ"], "set", 5);
symbol("complexes", "ℂ", "ord", "constant", "complex numbers", ["complexes", "complex numbers", "CC"], "set", 5);
symbol("hbar", "ħ", "ord", "constant", "h-bar (reduced Planck)", ["hbar", "h bar", "reduced planck"], "symbol", 5);
symbol("ell", "ℓ", "ord", "variable", "script l", ["ell", "script l"], "symbol", 4);
symbol("aleph", "ℵ", "ord", "constant", "aleph", ["aleph"], "symbol", 3);
symbol("degree", "°", "ord", "constant", "degrees", ["degree", "degrees"], "symbol", 6);
symbol("angle", "∠", "ord", "constant", "angle", ["angle"], "symbol", 4);
symbol("triangle", "△", "ord", "constant", "triangle", ["triangle"], "symbol", 4);
symbol("dots", "…", "inner", "punctuation", "dots (and so on)", ["dots", "ellipsis", "and so on", "ldots"], "symbol", 7);
symbol("cdots", "⋯", "inner", "punctuation", "centred dots", ["cdots", "centred dots", "centered dots", "middle dots"], "symbol", 5);
symbol("vdots", "⋮", "ord", "punctuation", "vertical dots", ["vdots", "vertical dots"], "symbol", 4);
symbol("ddots", "⋱", "inner", "punctuation", "diagonal dots", ["ddots", "diagonal dots"], "symbol", 4);

// ── Accents ────────────────────────────────────────────────────────────────
const accent = (id: string, kind: AccentKind, label: string, keywords: string[], weight: number) =>
  add(id, label, keywords, "accent", weight, () => ({ nodes: [{ kind: "accent", id: newId(), accent: kind, base: slot() }] }));
accent("vec", "vec", "vector arrow", ["vec", "vector arrow", "arrow over"], 7);
accent("hat", "hat", "hat (unit vector)", ["hat", "unit vector", "circumflex"], 6);
accent("bar", "bar", "bar (mean, conjugate)", ["bar", "overline", "mean", "conjugate"], 6);
accent("tilde", "tilde", "tilde", ["tilde accent", "tilde", "wave over"], 4);
accent("dot", "dot", "dot (time derivative)", ["dot accent", "time derivative", "dot over"], 5);
accent("ddot", "ddot", "double dot", ["ddot", "double dot", "second time derivative"], 4);

export const CATALOG: readonly CatalogEntry[] = entries;
