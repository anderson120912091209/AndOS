/**
 * Writes the math model back out as LaTeX, so a formula built without typing any LaTeX
 * can still be pasted into a paper, Overleaf or a chat. `parseLatex(toLatex(x))` gives
 * back the same structure.
 */
import type { AtomNode, MathNode, MatrixNode } from "./ast";
import {
  CHAR_SYMBOLS,
  COMMAND_SYMBOLS,
  ENVIRONMENTS,
  FUNCTIONS,
  GREEK,
  LIMIT_FUNCTIONS,
  SPACES,
  doubleStruck,
  scriptLetter,
} from "./symbols";

/** Glyphs typed as plain characters: "−" was typed as "-". */
const PLAIN = new Map<string, string>();
for (const [typed, def] of Object.entries(CHAR_SYMBOLS)) if (!PLAIN.has(def.text)) PLAIN.set(def.text, typed);
PLAIN.set("{", "\\{");
PLAIN.set("}", "\\}");
PLAIN.set("‖", "\\|");
PLAIN.set("′", "'");

/** Glyph to command name; the first name in the tables wins (`\leq`, not `\le`). */
const COMMANDS = new Map<string, string>();
for (const [name, glyph] of Object.entries(GREEK)) COMMANDS.set(glyph, name);
for (const [name, def] of Object.entries(COMMAND_SYMBOLS)) if (!COMMANDS.has(def.text)) COMMANDS.set(def.text, name);

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FROM_DOUBLE_STRUCK = new Map([...LETTERS].map((letter) => [doubleStruck(letter), letter]));
const FROM_SCRIPT = new Map([...LETTERS].map((letter) => [scriptLetter(letter), letter]));

const DELIMITER_LATEX: Record<string, string> = {
  "{": "\\{", "}": "\\}", "‖": "\\|", "⟨": "\\langle", "⟩": "\\rangle",
  "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil",
};

export function toLatex(node: MathNode): string {
  switch (node.kind) {
    case "row":
      return join(node.children);
    case "atom":
      return atomLatex(node);
    case "frac":
      return `\\frac{${toLatex(node.num)}}{${toLatex(node.den)}}`;
    case "sqrt":
      return node.index && !isEmpty(node.index)
        ? `\\sqrt[${toLatex(node.index)}]{${toLatex(node.body)}}`
        : `\\sqrt{${toLatex(node.body)}}`;
    case "scripts":
      return `${argument(node.base)}${scripts(node.sub, node.sup)}`;
    case "supsub":
      return scripts(node.sub, node.sup);
    case "fenced":
      // Brackets the editor grew by itself only need \left…\right when something tall is inside.
      if (node.auto && !isTall(node.body)) return `${plainDelimiter(node.open)}${toLatex(node.body)}${plainDelimiter(node.close)}`;
      return `\\left${delimiter(node.open)} ${toLatex(node.body)} \\right${delimiter(node.close)}`;
    case "accent": {
      const wide = node.base.kind !== "atom";
      const name = { hat: wide ? "widehat" : "hat", bar: wide ? "overline" : "bar", vec: "vec", tilde: wide ? "widetilde" : "tilde", dot: "dot", ddot: "ddot" }[node.accent];
      return `\\${name}{${toLatex(node.base)}}`;
    }
    case "matrix":
      return matrixLatex(node);
    case "text":
      return `\\text{${node.text}}`;
    case "space":
      return spaceLatex(node.em);
  }
}

function isEmpty(node: MathNode | undefined): boolean {
  return !node || (node.kind === "row" && node.children.length === 0);
}

function scripts(sub: MathNode | undefined, sup: MathNode | undefined): string {
  return `${isEmpty(sub) ? "" : `_${argument(sub!)}`}${isEmpty(sup) ? "" : `^${argument(sup!)}`}`;
}

/** A script or base: one character stands alone, anything longer is braced. */
function argument(node: MathNode): string {
  const latex = toLatex(node);
  return [...latex].length === 1 ? latex : `{${latex}}`;
}

function delimiter(glyph: string): string {
  return DELIMITER_LATEX[glyph] ?? glyph;
}

/** A delimiter written without \left/\right: "." is no delimiter at all. */
function plainDelimiter(glyph: string): string {
  return glyph === "." ? "" : delimiter(glyph);
}

/** Whether a node holds something that makes plain brackets look too small: a fraction, matrix or big operator. */
function isTall(node: MathNode): boolean {
  switch (node.kind) {
    case "frac":
    case "matrix":
      return true;
    case "atom":
      return Boolean(node.largeOp);
    case "row":
      return node.children.some(isTall);
    case "scripts":
      return isTall(node.base) || (!!node.sup && isTall(node.sup)) || (!!node.sub && isTall(node.sub));
    case "supsub":
      return (!!node.sup && isTall(node.sup)) || (!!node.sub && isTall(node.sub));
    case "sqrt":
    case "fenced":
      return isTall(node.body);
    case "accent":
      return isTall(node.base);
    default:
      return false;
  }
}

function atomLatex(atom: AtomNode): string {
  const { text } = atom;
  let core: string;
  if (atom.role === "function") {
    core = FUNCTIONS.has(text) || LIMIT_FUNCTIONS.has(text) ? `\\${text}` : `\\operatorname{${text}}`;
  } else if (/^[A-Za-z0-9.]+$/.test(text)) {
    core = text;
  } else if (PLAIN.has(text)) {
    core = PLAIN.get(text)!;
  } else if (COMMANDS.has(text)) {
    core = `\\${COMMANDS.get(text)}`;
  } else if (FROM_DOUBLE_STRUCK.has(text)) {
    return `\\mathbb{${FROM_DOUBLE_STRUCK.get(text)}}`;
  } else if (FROM_SCRIPT.has(text)) {
    return `\\mathcal{${FROM_SCRIPT.get(text)}}`;
  } else if (/^′+$/.test(text)) {
    core = "'".repeat(text.length);
  } else {
    core = text;
  }
  if (atom.variant === "bold") return `\\mathbf{${core}}`;
  if (atom.variant === "upright" && atom.role === "variable") return `\\mathrm{${core}}`;
  return core;
}

function matrixLatex(node: MatrixNode): string {
  const env =
    Object.entries(ENVIRONMENTS).find(
      ([, e]) => e.open === node.open && e.close === node.close && e.align === node.columnAlign,
    )?.[0] ?? "matrix";
  const rows = node.rows.map((row) => row.map(toLatex).join(" & ")).join(" \\\\ ");
  return `\\begin{${env}} ${rows} \\end{${env}}`;
}

function spaceLatex(em: number): string {
  let best = "quad";
  for (const [name, width] of Object.entries(SPACES)) {
    if (Math.abs(width - em) < Math.abs((SPACES[best] ?? 1) - em)) best = name;
  }
  return /^[a-z]+$/.test(best) ? `\\${best} ` : `\\${best}`;
}

/**
 * Joins a row's pieces: relations and binary operators get spaces for readability, and a
 * command name never runs into a following letter (`\alpha x`, not `\alphax`).
 */
function join(children: MathNode[]): string {
  let out = "";
  let afterScripts = false;
  for (const child of children) {
    let piece = toLatex(child);
    if (!piece) continue;
    if (child.kind === "atom" && (child.cls === "rel" || child.cls === "bin") && out) piece = ` ${piece} `;
    const commandBefore = /\\[A-Za-z]+$/.test(out) && /^[A-Za-z0-9]/.test(piece);
    // `\sum_{n=0}^N a_n` reads better than `\sum_{n=0}^Na_n`, though both are valid.
    if (commandBefore || (afterScripts && /^[A-Za-z\\]/.test(piece))) out += " ";
    out += piece;
    afterScripts = child.kind === "supsub" || child.kind === "scripts";
  }
  return out.replace(/ {2,}/g, " ").trim();
}
