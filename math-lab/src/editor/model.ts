/**
 * The editor's view of the math model: a cursor that lives inside the tree, and the
 * normal form the editor keeps every formula in.
 *
 * Normal form: every place a cursor can go is a row (a fraction's numerator, a radical's
 * body, a script, a bracket's contents, a matrix cell), scripts are `supsub` nodes that
 * follow their base, and brackets are `fenced` groups, so they always grow to fit.
 */
import type { AtomClass, AtomNode, MathNode, Role, RowNode, SupSubNode } from "../engine/ast";
import { parseLatex } from "../engine/parse";

/** A position between two children of a row. */
export interface Cursor {
  row: string;
  index: number;
}

export interface EditorState {
  root: RowNode;
  cursor: Cursor;
  /** Letters typed at the cursor that may still become a symbol; not yet part of the tree. */
  pending: string;
  /** What Backspace restores right after letters were converted into a symbol. */
  revert?: EditorState;
}

let counter = 0;

export function newId(): string {
  return `e${(++counter).toString(36)}`;
}

export function row(children: MathNode[] = []): RowNode {
  return { kind: "row", id: newId(), children };
}

export function atom(text: string, cls: AtomClass, role: Role, extra: Partial<AtomNode> = {}): AtomNode {
  return { kind: "atom", id: newId(), text, cls, role, ...extra };
}

export function variable(letter: string): AtomNode {
  return atom(letter, "ord", "variable");
}

/** The rows a node holds, in the order the cursor visits them. */
export function slotsOf(node: MathNode): RowNode[] {
  const rows = (...nodes: (MathNode | undefined)[]) => nodes.filter((n): n is RowNode => n?.kind === "row");
  switch (node.kind) {
    case "frac":
      return rows(node.num, node.den);
    case "sqrt":
      return rows(node.index, node.body);
    case "supsub":
      return rows(node.sub, node.sup);
    case "fenced":
      return rows(node.body);
    case "accent":
      return rows(node.base);
    case "matrix":
      return rows(...node.rows.flat());
    default:
      return [];
  }
}

/** Where a row sits: which node holds it, as which slot, and where that node is. */
export interface RowPlace {
  row: RowNode;
  owner?: MathNode;
  ownerRow?: RowNode;
  ownerIndex: number;
  slot: number;
}

export interface NodePlace {
  node: MathNode;
  row: RowNode;
  index: number;
}

export interface TreeIndex {
  rows: Map<string, RowPlace>;
  nodes: Map<string, NodePlace>;
}

export function buildIndex(root: RowNode): TreeIndex {
  const rows = new Map<string, RowPlace>();
  const nodes = new Map<string, NodePlace>();
  const visit = (row: RowNode, place: RowPlace) => {
    rows.set(row.id, place);
    row.children.forEach((child, index) => {
      nodes.set(child.id, { node: child, row, index });
      slotsOf(child).forEach((slot, k) => visit(slot, { row: slot, owner: child, ownerRow: row, ownerIndex: index, slot: k }));
    });
  };
  visit(root, { row: root, ownerIndex: -1, slot: -1 });
  return { rows, nodes };
}

/** The first empty slot inside `nodes`, in cursor order: where a template wants you to type next. */
export function firstEmptySlot(nodes: MathNode[]): RowNode | undefined {
  for (const node of nodes) {
    for (const slot of slotsOf(node)) {
      if (slot.children.length === 0) return slot;
      const inner = firstEmptySlot(slot.children);
      if (inner) return inner;
    }
  }
  return undefined;
}

export function createEditor(latex = ""): EditorState {
  const root = latex ? editableRow(parseLatex(latex).root) : row();
  return { root, cursor: { row: root.id, index: root.children.length }, pending: "" };
}

/**
 * Brings any parsed tree into normal form, with fresh ids. Braced groups dissolve into their
 * row, scripts detach from their base, and plain brackets pair up into fenced groups.
 */
export function editableRow(input: MathNode): RowNode {
  const children = input.kind === "row" ? input.children : [input];
  const flat: MathNode[] = [];
  for (const child of children) {
    if (child.kind === "scripts") {
      flat.push(editableBase(child.base));
      const scripts: SupSubNode = { kind: "supsub", id: newId() };
      if (child.sub) scripts.sub = editableRow(child.sub);
      if (child.sup) scripts.sup = editableRow(child.sup);
      flat.push(scripts);
    } else if (child.kind === "row") {
      flat.push(...editableRow(child).children);
    } else {
      flat.push(editableNode(child));
    }
  }
  return row(pairBrackets(flat));
}

/** A script's base must stay one node; a braced group becomes an invisible fenced group. */
function editableBase(base: MathNode): MathNode {
  if (base.kind !== "row") return editableNode(base);
  if (base.children.length === 1 && base.children[0]!.kind !== "scripts") return editableNode(base.children[0]!);
  return { kind: "fenced", id: newId(), open: ".", close: ".", body: editableRow(base), auto: true };
}

function editableNode(node: MathNode): MathNode {
  switch (node.kind) {
    case "atom":
    case "text":
    case "space":
      return { ...node, id: newId() };
    case "frac":
      return { kind: "frac", id: newId(), num: editableRow(node.num), den: editableRow(node.den) };
    case "sqrt": {
      const sqrt: MathNode = { kind: "sqrt", id: newId(), body: editableRow(node.body) };
      if (node.index) sqrt.index = editableRow(node.index);
      return sqrt;
    }
    case "fenced":
      return { ...node, id: newId(), body: editableRow(node.body) };
    case "accent":
      return { ...node, id: newId(), base: editableRow(node.base) };
    case "matrix":
      return { ...node, id: newId(), rows: node.rows.map((cells) => cells.map((cell) => editableRow(cell))) };
    case "supsub": {
      const scripts: SupSubNode = { kind: "supsub", id: newId() };
      if (node.sub) scripts.sub = editableRow(node.sub);
      if (node.sup) scripts.sup = editableRow(node.sup);
      return scripts;
    }
    case "scripts":
    case "row":
      return editableBase(node.kind === "row" ? node : row([node]));
  }
}

/** Pairs plain opening and closing brackets in a row into fenced groups, innermost first. */
function pairBrackets(children: MathNode[]): MathNode[] {
  const out: MathNode[] = [];
  const openers: number[] = [];
  for (const child of children) {
    const isFence = child.kind === "atom" && child.role === "fence";
    if (isFence && child.cls === "close" && openers.length > 0) {
      const at = openers.pop()!;
      const opener = out[at] as AtomNode;
      const body = out.splice(at + 1);
      out.pop();
      out.push({ kind: "fenced", id: newId(), open: opener.text, close: child.text, body: row(body), auto: true });
      continue;
    }
    if (isFence && child.cls === "open") openers.push(out.length);
    out.push(child);
  }
  return out;
}
