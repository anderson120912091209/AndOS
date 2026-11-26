/**
 * The math model the engine lays out. It is structural (a tree of typed nodes), not a
 * LaTeX string, so an experience can style a variable differently from a number or a
 * function name, and a future editor can put a cursor between any two children.
 */

/** Spacing classes, after TeX's atom types (The TeXbook, ch. 17). */
export type AtomClass = "ord" | "op" | "bin" | "rel" | "open" | "close" | "punct" | "inner";

/** What an atom means. Experiences choose fonts, colours and chips by role. */
export type Role =
  | "variable"
  | "number"
  | "function"
  | "greek"
  | "constant"
  | "operator"
  | "relation"
  | "punctuation"
  | "fence"
  | "largeOp"
  | "text"
  | "error";

export type AccentKind = "hat" | "bar" | "vec" | "tilde" | "dot" | "ddot";

/** Font overrides requested by the source, e.g. `\mathbf` or `\mathrm`. */
export type Variant = "bold" | "upright" | "italic";

export interface RowNode {
  kind: "row";
  id: string;
  children: MathNode[];
}

export interface AtomNode {
  kind: "atom";
  id: string;
  text: string;
  cls: AtomClass;
  role: Role;
  variant?: Variant;
  /** ∑, ∫ and friends: drawn larger in display style and centred on the math axis. */
  largeOp?: boolean;
  /** Scripts go above/below instead of beside (∑, lim) when laid out in display style. */
  limits?: boolean;
  /** Letters still being typed in the editor, drawn underlined until they settle. */
  pending?: boolean;
}

export interface FracNode {
  kind: "frac";
  id: string;
  num: MathNode;
  den: MathNode;
}

export interface SqrtNode {
  kind: "sqrt";
  id: string;
  body: MathNode;
  index?: MathNode;
}

export interface ScriptsNode {
  kind: "scripts";
  id: string;
  base: MathNode;
  sup?: MathNode;
  sub?: MathNode;
}

/** `\left( … \right)`: delimiters that grow with their content. `"."` means none. */
/**
 * Scripts attached to whatever precedes them in a row. This is how the editor stores `x²`:
 * as `x` followed by a superscript, so the cursor can sit between a base and its exponent.
 * Layout pairs it with the previous node.
 */
export interface SupSubNode {
  kind: "supsub";
  id: string;
  sup?: RowNode;
  sub?: RowNode;
}

export interface FencedNode {
  kind: "fenced";
  id: string;
  open: string;
  close: string;
  body: MathNode;
  /** Created from plain brackets by an experience that grows them; spaced like an ordinary atom. */
  auto?: boolean;
}

export interface AccentNode {
  kind: "accent";
  id: string;
  accent: AccentKind;
  base: MathNode;
}

export interface MatrixNode {
  kind: "matrix";
  id: string;
  rows: MathNode[][];
  open: string;
  close: string;
  columnAlign: "center" | "left";
}

export interface TextNode {
  kind: "text";
  id: string;
  text: string;
}

export interface SpaceNode {
  kind: "space";
  id: string;
  /** Width in em of the current size; negative values pull neighbours together. */
  em: number;
}

export type MathNode =
  | RowNode
  | AtomNode
  | FracNode
  | SqrtNode
  | ScriptsNode
  | SupSubNode
  | FencedNode
  | AccentNode
  | MatrixNode
  | TextNode
  | SpaceNode;

/**
 * The class a node presents to its neighbours for spacing. Compound nodes follow TeX:
 * fractions and `\left…\right` groups are "inner", a scripted atom keeps its base's class,
 * and explicit spaces take no part (they return null).
 */
export function spacingClass(node: MathNode): AtomClass | null {
  switch (node.kind) {
    case "atom":
      return node.cls;
    case "scripts":
      return spacingClass(node.base) ?? "ord";
    case "frac":
      return "inner";
    case "fenced":
      // TeX makes \left…\right "inner", which is why `\sin\left(x\right)` gets an extra space.
      // Brackets an experience grows on its own keep tight spacing, so `f(x)` stays `f(x)`.
      return node.auto ? "ord" : "inner";
    case "space":
    case "supsub":
      return null;
    default:
      return "ord";
  }
}

/** Visits every node depth-first, parents before children. */
export function walk(node: MathNode, visit: (node: MathNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) walk(child, visit);
}

export function childrenOf(node: MathNode): MathNode[] {
  switch (node.kind) {
    case "row":
      return node.children;
    case "frac":
      return [node.num, node.den];
    case "sqrt":
      return node.index ? [node.index, node.body] : [node.body];
    case "scripts":
      return [node.base, ...(node.sup ? [node.sup] : []), ...(node.sub ? [node.sub] : [])];
    case "supsub":
      return [...(node.sub ? [node.sub] : []), ...(node.sup ? [node.sup] : [])];
    case "fenced":
    case "accent":
      return [node.kind === "fenced" ? node.body : node.base];
    case "matrix":
      return node.rows.flat();
    default:
      return [];
  }
}
