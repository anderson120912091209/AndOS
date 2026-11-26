/**
 * A forgiving parser for the subset of LaTeX math the lab needs: enough to type real
 * formulas quickly. It never throws. Mistakes become issues plus a best-effort tree, so
 * the preview keeps updating while you type.
 */
import type { AtomClass, AtomNode, MathNode, Role, RowNode, Variant } from "./ast";
import { walk } from "./ast";
import {
  ACCENTS,
  CHAR_SYMBOLS,
  COMMAND_SYMBOLS,
  DELIMITERS,
  ENVIRONMENTS,
  FUNCTIONS,
  GREEK,
  LIMIT_FUNCTIONS,
  SPACES,
  doubleStruck,
  scriptLetter,
  symbolForGlyph,
} from "./symbols";

export interface ParseIssue {
  message: string;
  /** Offset into the source. */
  at: number;
}

export interface ParseResult {
  root: RowNode;
  issues: ParseIssue[];
}

export function parseLatex(source: string): ParseResult {
  const parser = new Parser(source);
  const root = parser.parseRow("end");
  return { root, issues: parser.issues };
}

/** What ends the row being parsed. */
type Stop = "end" | "group" | "optional" | "cell" | "right";

const IGNORED = new Set(["displaystyle", "textstyle", "scriptstyle", "big", "Big", "bigg", "Bigg", "left."]);

class Parser {
  readonly issues: ParseIssue[] = [];
  private pos = 0;
  private count = 0;

  constructor(private readonly src: string) {}

  parseRow(stop: Stop): RowNode {
    const children: MathNode[] = [];
    for (;;) {
      this.skipSpace();
      if (this.atStop(stop)) break;
      const item = this.parseItem();
      if (item) children.push(this.parseScripts(item));
    }
    return { kind: "row", id: this.id(), children };
  }

  private id(): string {
    return `n${++this.count}`;
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  private skipSpace(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.pos++;
  }

  private issue(message: string, at = this.pos): void {
    this.issues.push({ message, at });
  }

  private atStop(stop: Stop): boolean {
    if (this.eof()) return true;
    switch (stop) {
      case "group":
        return this.peek() === "}";
      case "optional":
        return this.peek() === "]";
      case "cell":
        return this.peek() === "&" || this.startsWith("\\\\") || this.startsWith("\\end");
      case "right":
        return this.startsWith("\\right");
      case "end":
        return false;
    }
  }

  private atom(text: string, cls: AtomClass, role: Role, extra: { largeOp?: boolean; limits?: boolean; variant?: Variant } = {}): AtomNode {
    const node: AtomNode = { kind: "atom", id: this.id(), text, cls, role };
    if (extra.largeOp) node.largeOp = true;
    if (extra.limits) node.limits = true;
    if (extra.variant) node.variant = extra.variant;
    return node;
  }

  private emptyRow(): RowNode {
    return { kind: "row", id: this.id(), children: [] };
  }

  /** One item without its scripts. Returns undefined for input that produces nothing. */
  private parseItem(): MathNode | undefined {
    const start = this.pos;
    const ch = this.peek();
    if (ch === "{") {
      this.pos++;
      const row = this.parseRow("group");
      this.expect("}", start);
      return row;
    }
    if (ch === "}") {
      this.pos++;
      this.issue("Unmatched }", start);
      return undefined;
    }
    // A script with nothing before it gets an empty base, shown as a slot.
    if (ch === "^" || ch === "_") return this.emptyRow();
    if (ch === "&") {
      this.pos++;
      this.issue("& outside a matrix", start);
      return undefined;
    }
    if (ch === "~") {
      this.pos++;
      return { kind: "space", id: this.id(), em: 1 / 3 };
    }
    if (ch === "\\") return this.parseCommand();
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(this.peek(1)))) return this.parseNumber();
    if (/[a-zA-Z]/.test(ch)) {
      this.pos++;
      return this.atom(ch, "ord", "variable");
    }
    const glyph = String.fromCodePoint(this.src.codePointAt(this.pos) ?? 0xfffd);
    this.pos += glyph.length;
    const def = CHAR_SYMBOLS[glyph] ?? symbolForGlyph(glyph);
    if (def) return this.atom(def.text, def.cls, def.role, def);
    return this.atom(glyph, "ord", /\p{L}/u.test(glyph) ? "variable" : "constant");
  }

  private parseNumber(): AtomNode {
    const pattern = /\d*\.?\d+/y;
    pattern.lastIndex = this.pos;
    const text = pattern.exec(this.src)?.[0] ?? this.peek();
    this.pos += text.length;
    return this.atom(text, "ord", "number");
  }

  /** Attaches any `^`, `_`, primes and `\limits` that follow an item. */
  private parseScripts(base: MathNode): MathNode {
    let sup: MathNode | undefined;
    let sub: MathNode | undefined;
    let primes = "";
    for (;;) {
      this.skipSpace();
      const ch = this.peek();
      if (ch === "'") {
        this.pos++;
        primes += "′";
      } else if (ch === "^" || ch === "_") {
        const at = this.pos++;
        const argument = this.parseArgument(ch === "^" ? "superscript" : "subscript");
        if (ch === "^") {
          if (sup) this.issue("Double superscript", at);
          sup = argument;
        } else {
          if (sub) this.issue("Double subscript", at);
          sub = argument;
        }
      } else if (this.startsWith("\\limits") || this.startsWith("\\nolimits")) {
        const off = this.startsWith("\\nolimits");
        this.pos += off ? "\\nolimits".length : "\\limits".length;
        if (base.kind === "atom") base.limits = !off;
      } else {
        break;
      }
    }
    if (primes) {
      const prime = this.atom(primes, "ord", "operator");
      sup = sup ? { kind: "row", id: this.id(), children: [prime, ...(sup.kind === "row" ? sup.children : [sup])] } : prime;
    }
    if (!sup && !sub) return base;
    return { kind: "scripts", id: this.id(), base, sup, sub };
  }

  /** A braced group, or else a single token: `x^2`, `x^{10}` and `\frac12` all work. */
  private parseArgument(what: string): MathNode {
    this.skipSpace();
    const start = this.pos;
    const ch = this.peek();
    if (this.eof() || ch === "}" || ch === "&" || ch === "^" || ch === "_") {
      this.issue(`Missing ${what}`, start);
      return this.emptyRow();
    }
    if (ch === "{") {
      this.pos++;
      const row = this.parseRow("group");
      this.expect("}", start);
      return unwrap(row);
    }
    if (/[0-9]/.test(ch)) {
      this.pos++;
      return this.atom(ch, "ord", "number");
    }
    return this.parseItem() ?? this.emptyRow();
  }

  private expect(ch: string, openedAt: number): void {
    if (this.peek() === ch) this.pos++;
    else this.issue(`Missing ${ch}`, openedAt);
  }

  /** Reads `\name`, or a one-character control symbol such as `\,` or `\{`. Returns the name. */
  private readCommand(): string {
    const start = ++this.pos;
    if (/[a-zA-Z]/.test(this.peek())) {
      while (/[a-zA-Z]/.test(this.peek())) this.pos++;
    } else {
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  /** Raw text of a `{…}` argument, for `\text`, `\begin` and friends. */
  private readBraced(): string | undefined {
    this.skipSpace();
    if (this.peek() !== "{") {
      this.issue("Expected {");
      return undefined;
    }
    const start = ++this.pos;
    let depth = 1;
    while (!this.eof()) {
      const ch = this.src[this.pos++];
      if (ch === "\\") this.pos++;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return this.src.slice(start, this.pos - 1);
    }
    this.issue("Missing }", start - 1);
    return this.src.slice(start);
  }

  private parseCommand(): MathNode | undefined {
    const start = this.pos;
    const name = this.readCommand();
    const space = SPACES[name];
    if (space !== undefined) return { kind: "space", id: this.id(), em: space };
    if (name === "\\") {
      this.issue("Line breaks are only supported inside matrices", start);
      return undefined;
    }
    if (name === "{" || name === "}") return this.atom(name, name === "{" ? "open" : "close", "fence");
    if (name === "|") return this.atom("‖", "ord", "fence");
    if (name.length === 1 && "%$#&_".includes(name)) return this.atom(name, "ord", "constant");

    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac": {
        const num = this.parseArgument("numerator");
        const den = this.parseArgument("denominator");
        return { kind: "frac", id: this.id(), num, den };
      }
      case "sqrt": {
        this.skipSpace();
        let index: MathNode | undefined;
        if (this.peek() === "[") {
          const at = this.pos++;
          index = unwrap(this.parseRow("optional"));
          this.expect("]", at);
        }
        return { kind: "sqrt", id: this.id(), body: this.parseArgument("radicand"), index };
      }
      case "left":
        return this.parseLeftRight(start);
      case "right":
        this.issue("\\right without \\left", start);
        this.readDelimiter();
        return undefined;
      case "begin":
        return this.parseEnvironment(start);
      case "end":
        this.issue("\\end without \\begin", start);
        this.readBraced();
        return undefined;
      case "text":
      case "textrm":
      case "mbox":
        return { kind: "text", id: this.id(), text: this.readBraced() ?? "" };
      case "operatorname":
        return this.atom(this.readBraced() ?? "", "op", "function");
      case "mathrm":
      case "mathbf":
      case "mathit": {
        const argument = this.parseArgument(`\\${name} argument`);
        const variant: Variant = name === "mathbf" ? "bold" : name === "mathrm" ? "upright" : "italic";
        walk(argument, (node) => {
          if (node.kind === "atom") node.variant = variant;
        });
        return argument;
      }
      case "mathbb":
      case "mathcal": {
        const argument = this.parseArgument(`\\${name} argument`);
        const toLetter = name === "mathbb" ? doubleStruck : scriptLetter;
        walk(argument, (node) => {
          if (node.kind !== "atom") return;
          node.text = [...node.text].map(toLetter).join("");
          node.role = "constant";
          node.variant = "upright";
        });
        return argument;
      }
    }

    const accent = ACCENTS[name];
    if (accent) return { kind: "accent", id: this.id(), accent, base: this.parseArgument("accent base") };
    const greek = GREEK[name];
    if (greek) return this.atom(greek, "ord", "greek");
    const def = COMMAND_SYMBOLS[name];
    if (def) return this.atom(def.text, def.cls, def.role, def);
    if (FUNCTIONS.has(name)) return this.atom(name, "op", "function");
    if (LIMIT_FUNCTIONS.has(name)) return this.atom(name, "op", "function", { limits: true });
    if (IGNORED.has(name)) return undefined;
    this.issue(`Unknown command \\${name}`, start);
    return this.atom(`\\${name}`, "ord", "error");
  }

  private readDelimiter(): string | undefined {
    this.skipSpace();
    const start = this.pos;
    if (this.peek() === "\\") {
      const glyph = DELIMITERS[`\\${this.readCommand()}`];
      if (glyph) return glyph;
      this.issue("Unknown delimiter", start);
      return undefined;
    }
    const glyph = DELIMITERS[this.peek()];
    if (glyph) {
      this.pos++;
      return glyph;
    }
    this.issue("Missing delimiter", start);
    return undefined;
  }

  private parseLeftRight(start: number): MathNode {
    const open = this.readDelimiter() ?? ".";
    const body = this.parseRow("right");
    let close = ".";
    if (this.startsWith("\\right")) {
      this.pos += "\\right".length;
      close = this.readDelimiter() ?? ".";
    } else {
      this.issue("\\left without \\right", start);
    }
    return { kind: "fenced", id: this.id(), open, close, body };
  }

  private parseEnvironment(start: number): MathNode {
    const name = this.readBraced() ?? "";
    const env = ENVIRONMENTS[name];
    if (!env) this.issue(`Unknown environment ${name}`, start);
    const rows: MathNode[][] = [[]];
    for (;;) {
      rows.at(-1)?.push(unwrap(this.parseRow("cell")));
      if (this.peek() === "&") {
        this.pos++;
      } else if (this.startsWith("\\\\")) {
        this.pos += 2;
        rows.push([]);
      } else if (this.startsWith("\\end")) {
        this.pos += "\\end".length;
        const endName = this.readBraced();
        if (endName !== name) this.issue(`\\end{${endName ?? ""}} does not match \\begin{${name}}`, start);
        break;
      } else {
        this.issue(`Missing \\end{${name}}`, start);
        break;
      }
    }
    // A trailing \\ leaves an empty last row behind.
    const last = rows.at(-1);
    if (rows.length > 1 && last?.length === 1 && last[0]?.kind === "row" && last[0].children.length === 0) rows.pop();
    const { open, close, align } = env ?? { open: ".", close: ".", align: "center" as const };
    return { kind: "matrix", id: this.id(), rows, open, close, columnAlign: align };
  }
}

/** A one-child group is just its child; braces only group. */
function unwrap(row: RowNode): MathNode {
  return row.children.length === 1 && row.children[0] ? row.children[0] : row;
}
