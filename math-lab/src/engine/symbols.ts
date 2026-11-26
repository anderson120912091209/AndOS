import type { AccentKind, AtomClass, Role } from "./ast";

export interface SymbolDef {
  text: string;
  cls: AtomClass;
  role: Role;
  largeOp?: boolean;
  limits?: boolean;
}

const sym = (text: string, cls: AtomClass, role: Role, extra: Partial<SymbolDef> = {}): SymbolDef => ({
  text,
  cls,
  role,
  ...extra,
});
const bin = (text: string) => sym(text, "bin", "operator");
const rel = (text: string) => sym(text, "rel", "relation");
const ord = (text: string, role: Role = "constant") => sym(text, "ord", role);

export const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ",
  upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
  Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

/** Command name (without the backslash) to symbol. */
export const COMMAND_SYMBOLS: Record<string, SymbolDef> = {
  // binary operators
  pm: bin("±"), mp: bin("∓"), times: bin("×"), div: bin("÷"), cdot: bin("⋅"), ast: bin("∗"),
  star: bin("⋆"), circ: bin("∘"), bullet: bin("∙"), oplus: bin("⊕"), otimes: bin("⊗"),
  cup: bin("∪"), cap: bin("∩"), setminus: bin("∖"), wedge: bin("∧"), vee: bin("∨"),
  // relations
  leq: rel("≤"), le: rel("≤"), geq: rel("≥"), ge: rel("≥"), neq: rel("≠"), ne: rel("≠"),
  approx: rel("≈"), equiv: rel("≡"), sim: rel("∼"), simeq: rel("≃"), cong: rel("≅"),
  propto: rel("∝"), ll: rel("≪"), gg: rel("≫"), in: rel("∈"), notin: rel("∉"), ni: rel("∋"),
  subset: rel("⊂"), supset: rel("⊃"), subseteq: rel("⊆"), supseteq: rel("⊇"),
  to: rel("→"), rightarrow: rel("→"), leftarrow: rel("←"), gets: rel("←"),
  Rightarrow: rel("⇒"), Leftarrow: rel("⇐"), Leftrightarrow: rel("⇔"), iff: rel("⟺"),
  implies: rel("⟹"), leftrightarrow: rel("↔"), mapsto: rel("↦"), perp: rel("⊥"),
  parallel: rel("∥"), mid: rel("∣"),
  // ordinary symbols
  infty: ord("∞"), partial: ord("∂"), nabla: ord("∇"), forall: ord("∀"), exists: ord("∃"),
  emptyset: ord("∅"), hbar: ord("ħ"), ell: ord("ℓ", "variable"), prime: ord("′", "operator"),
  angle: ord("∠"), triangle: ord("△"), neg: ord("¬", "operator"), vdots: ord("⋮", "punctuation"),
  aleph: ord("ℵ"), nexists: ord("∄"), degree: ord("°"), therefore: rel("∴"), because: rel("∵"),
  ldots: sym("…", "inner", "punctuation"), dots: sym("…", "inner", "punctuation"),
  cdots: sym("⋯", "inner", "punctuation"), ddots: sym("⋱", "inner", "punctuation"),
  // large operators
  sum: sym("∑", "op", "largeOp", { largeOp: true, limits: true }),
  prod: sym("∏", "op", "largeOp", { largeOp: true, limits: true }),
  coprod: sym("∐", "op", "largeOp", { largeOp: true, limits: true }),
  bigcup: sym("⋃", "op", "largeOp", { largeOp: true, limits: true }),
  bigcap: sym("⋂", "op", "largeOp", { largeOp: true, limits: true }),
  int: sym("∫", "op", "largeOp", { largeOp: true }),
  iint: sym("∬", "op", "largeOp", { largeOp: true }),
  iiint: sym("∭", "op", "largeOp", { largeOp: true }),
  oint: sym("∮", "op", "largeOp", { largeOp: true }),
  // fences used as ordinary symbols (outside \left … \right)
  langle: sym("⟨", "open", "fence"), rangle: sym("⟩", "close", "fence"),
  lfloor: sym("⌊", "open", "fence"), rfloor: sym("⌋", "close", "fence"),
  lceil: sym("⌈", "open", "fence"), rceil: sym("⌉", "close", "fence"),
  lbrace: sym("{", "open", "fence"), rbrace: sym("}", "close", "fence"),
  vert: sym("|", "ord", "fence"), Vert: sym("‖", "ord", "fence"),
};

/** Upright function names that take scripts beside them. */
export const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh",
  "tanh", "log", "ln", "lg", "exp", "det", "dim", "ker", "deg", "arg", "gcd", "hom", "Pr",
]);

/** Upright function names whose scripts go underneath in display style. */
export const LIMIT_FUNCTIONS = new Set(["lim", "limsup", "liminf", "max", "min", "sup", "inf"]);

/** Single characters typed directly. Letters and digits are handled by the parser. */
export const CHAR_SYMBOLS: Record<string, SymbolDef> = {
  "+": bin("+"),
  "-": bin("−"),
  "*": bin("∗"),
  "/": sym("/", "ord", "operator"),
  "=": rel("="),
  "<": rel("<"),
  ">": rel(">"),
  ":": rel(":"),
  ",": sym(",", "punct", "punctuation"),
  ";": sym(";", "punct", "punctuation"),
  "!": sym("!", "close", "operator"),
  "?": sym("?", "close", "punctuation"),
  "(": sym("(", "open", "fence"),
  ")": sym(")", "close", "fence"),
  "[": sym("[", "open", "fence"),
  "]": sym("]", "close", "fence"),
  "|": sym("|", "ord", "fence"),
  ".": sym(".", "ord", "punctuation"),
};

/** Delimiters accepted after `\left` / `\right`, mapped to the glyph they draw. */
export const DELIMITERS: Record<string, string> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", ".": ".", "/": "/",
  "\\{": "{", "\\}": "}", "\\lbrace": "{", "\\rbrace": "}", "\\|": "‖", "\\Vert": "‖",
  "\\vert": "|", "\\langle": "⟨", "\\rangle": "⟩", "\\lfloor": "⌊", "\\rfloor": "⌋",
  "\\lceil": "⌈", "\\rceil": "⌉",
};

export const ACCENTS: Record<string, AccentKind> = {
  hat: "hat", widehat: "hat", bar: "bar", overline: "bar", vec: "vec",
  overrightarrow: "vec", tilde: "tilde", widetilde: "tilde", dot: "dot", ddot: "ddot",
};

/** Explicit spacing commands, in em. 18mu = 1em, as in TeX. */
export const SPACES: Record<string, number> = {
  ",": 3 / 18, ":": 4 / 18, ">": 4 / 18, ";": 5 / 18, "!": -3 / 18, " ": 1 / 3,
  quad: 1, qquad: 2, thinspace: 3 / 18, enspace: 0.5,
};

/** Matrix-like environments and the fences they draw. */
export const ENVIRONMENTS: Record<string, { open: string; close: string; align: "center" | "left" }> = {
  matrix: { open: ".", close: ".", align: "center" },
  pmatrix: { open: "(", close: ")", align: "center" },
  bmatrix: { open: "[", close: "]", align: "center" },
  Bmatrix: { open: "{", close: "}", align: "center" },
  vmatrix: { open: "|", close: "|", align: "center" },
  Vmatrix: { open: "‖", close: "‖", align: "center" },
  cases: { open: "{", close: ".", align: "left" },
};

const DOUBLE_STRUCK_EXCEPTIONS: Record<string, string> = {
  C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ",
};
const SCRIPT_EXCEPTIONS: Record<string, string> = {
  B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ",
};

/** Maps a capital letter to its Unicode double-struck (`\mathbb`) form. */
export function doubleStruck(ch: string): string {
  const exception = DOUBLE_STRUCK_EXCEPTIONS[ch];
  if (exception) return exception;
  if (!/^[A-Z]$/.test(ch)) return ch;
  return String.fromCodePoint(0x1d538 + ch.charCodeAt(0) - 65);
}

/** Maps a capital letter to its Unicode script (`\mathcal`) form. */
export function scriptLetter(ch: string): string {
  const exception = SCRIPT_EXCEPTIONS[ch];
  if (exception) return exception;
  if (!/^[A-Z]$/.test(ch)) return ch;
  return String.fromCodePoint(0x1d49c + ch.charCodeAt(0) - 65);
}

export function isUpperGreek(text: string): boolean {
  return /^[Α-Ω]$/.test(text);
}

const BY_GLYPH = new Map<string, SymbolDef>();
for (const def of Object.values(COMMAND_SYMBOLS)) if (!BY_GLYPH.has(def.text)) BY_GLYPH.set(def.text, def);

/** Classifies a character typed as Unicode (e.g. "π" or "≤") instead of as a command. */
export function symbolForGlyph(ch: string): SymbolDef | undefined {
  const known = BY_GLYPH.get(ch);
  if (known) return known;
  if (Object.values(GREEK).includes(ch)) return sym(ch, "ord", "greek");
  return undefined;
}
