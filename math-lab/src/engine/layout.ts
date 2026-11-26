/**
 * The layout engine: turns the math model into TeX-style boxes with explicit geometry.
 *
 * Every box has a width, a height above its baseline and a depth below it. Children are
 * placed relative to the left end of the parent's baseline, with y pointing down (SVG's
 * convention), so a superscript has a negative y and a subscript a positive one.
 *
 * Nothing here touches the DOM. Fonts come in through the `Measurer`, and every visual
 * choice comes from the `Experience`, so the same tree can be set many different ways.
 */
import type {
  AccentNode,
  AtomClass,
  AtomNode,
  FracNode,
  MathNode,
  MatrixNode,
  Role,
  RowNode,
  ScriptsNode,
  SqrtNode,
  SupSubNode,
  TextNode,
} from "./ast";
import { spacingClass } from "./ast";
import type { Experience } from "./experience";
import { accentPath, canDrawDelimiter, delimiterPath, radicalHook, radicalPath } from "./glyphs";
import type { FontFace, FontSpec, InkMetrics, Measurer } from "./measure";
import { demoteBinaries, spaceBetween } from "./spacing";
import { isUpperGreek } from "./symbols";

/** What a box paints. Glyphs are positioned by their baseline-left point; rects and paths by their top-left. */
export type Paint =
  | { type: "glyph"; text: string; font: FontSpec; color: string }
  | {
      type: "rect";
      width: number;
      height: number;
      radius: number;
      fill: string;
      stroke?: string;
      strokeWidth?: number;
      dashed?: boolean;
    }
  | { type: "path"; d: string; stroke?: string; strokeWidth?: number; fill?: string };

export interface Placed {
  x: number;
  y: number;
  item: Paint | { type: "box"; box: Box };
}

export interface Box {
  width: number;
  /** Extent above the baseline. */
  height: number;
  /** Extent below the baseline. */
  depth: number;
  items: Placed[];
  /** Ink overhang of a slanted final glyph, so a superscript can clear it. */
  italicCorrection?: number;
  /** The model node this box draws, for hit-testing and the inspector. */
  source?: { id: string; kind: string };
}

/** 0 = text size, 1 = script, 2 = scriptscript (and anything deeper). */
export type Level = 0 | 1 | 2;

export interface LayoutContext {
  exp: Experience;
  measurer: Measurer;
  /** Font size in px at level 0. */
  basePx: number;
  level: Level;
  /** Display style: big operators grow, `\sum` and `\lim` take limits above and below. */
  display: boolean;
}

export interface RowEntry {
  node: MathNode;
  box: Box;
  cls: AtomClass | null;
  /** Space before this entry, in px. */
  space: number;
}

const INTEGRALS = new Set(["∫", "∬", "∭", "∮"]);

export function sizeOf(c: LayoutContext): number {
  const { script, scriptScript } = c.exp.scale;
  return c.basePx * (c.level === 0 ? 1 : c.level === 1 ? script : scriptScript);
}

/** Converts a length in em of the current size to px. */
export function em(c: LayoutContext, value: number): number {
  return value * sizeOf(c);
}

const smaller = (c: LayoutContext): LayoutContext => ({
  ...c,
  level: Math.min(2, c.level + 1) as Level,
  display: false,
});

const sourceOf = (node: MathNode) => ({ id: node.id, kind: node.kind });

const nest = (box: Box, x: number, y: number): Placed => ({ x, y, item: { type: "box", box } });

export function layoutNode(node: MathNode, c: LayoutContext): Box {
  switch (node.kind) {
    case "row":
      return layoutRow(node, c);
    case "atom":
      return layoutAtom(node, c);
    case "frac":
      return layoutFrac(node, c);
    case "sqrt":
      return layoutSqrt(node, c);
    case "scripts":
      return layoutScripts(node, c);
    case "supsub":
      // Scripts with nothing before them: give them an empty base to hang from.
      return layoutScripts(withBase(node, { kind: "row", id: `${node.id}~base`, children: [] }), c);
    case "fenced":
      return wrapInDelimiters(layoutNode(node.body, c), node.open, node.close, c, sourceOf(node));
    case "accent":
      return layoutAccent(node, c);
    case "matrix":
      return layoutMatrix(node, c);
    case "text":
      return layoutText(node, c);
    case "space":
      return { width: em(c, node.em), height: 0, depth: 0, items: [], source: sourceOf(node) };
  }
}

/** Places boxes side by side on a shared baseline. */
export function hlist(entries: { box: Box; space: number }[], source?: Box["source"]): Box {
  let x = 0;
  let height = 0;
  let depth = 0;
  const items: Placed[] = [];
  for (const { box, space } of entries) {
    x += space;
    items.push(nest(box, x, 0));
    x += box.width;
    height = Math.max(height, box.height);
    depth = Math.max(depth, box.depth);
  }
  return { width: x, height, depth, items, italicCorrection: entries.at(-1)?.box.italicCorrection, source };
}

/** Lays out a row's children and the space before each, after binary-operator demotion. */
export function rowEntries(children: MathNode[], c: LayoutContext): RowEntry[] {
  const nodes = attachScripts(c.exp.delimiters.autoGrow ? growBrackets(children) : children);
  const classes = demoteBinaries(nodes.map(spacingClass));
  let previous: AtomClass | null = null;
  return nodes.map((node, i) => {
    const cls = classes[i] ?? null;
    const space = cls && previous ? em(c, spaceBetween(previous, cls, c.level, c.exp)) : 0;
    if (cls) previous = cls;
    return { node, box: layoutNode(node, c), cls, space };
  });
}

function layoutRow(row: RowNode, c: LayoutContext): Box {
  if (row.children.length === 0) return emptySlot(c, sourceOf(row));
  return hlist(rowEntries(row.children, c), sourceOf(row));
}

/** An empty field (`x^{}`) stays visible as a dashed slot, where an editor would put the cursor. */
function emptySlot(c: LayoutContext, source: Box["source"]): Box {
  const width = em(c, 0.5);
  const height = em(c, 0.62);
  const top = -em(c, c.exp.axisHeight) - height / 2;
  const margin = em(c, 0.04);
  return {
    width: width + 2 * margin,
    height: -top,
    depth: Math.max(0, top + height),
    items: [
      {
        x: margin,
        y: top,
        item: {
          type: "rect",
          width,
          height,
          radius: em(c, 0.08),
          fill: "none",
          stroke: c.exp.colors.ink,
          strokeWidth: Math.max(0.75, em(c, 0.03)),
          dashed: true,
        },
      },
    ],
    source,
  };
}

/**
 * Pairs plain brackets typed as atoms, innermost first, and wraps each pair with its
 * contents so the brackets can grow. Any closer matches the nearest opener, so a
 * half-open interval like `[0, 1)` still pairs up.
 */
function growBrackets(children: MathNode[]): MathNode[] {
  const out: MathNode[] = [];
  const openers: number[] = [];
  for (const child of children) {
    const isFence = child.kind === "atom" && child.role === "fence";
    if (isFence && child.cls === "close" && openers.length > 0) {
      const at = openers.pop()!;
      const opener = out[at] as AtomNode;
      const body = out.splice(at + 1);
      out.pop();
      out.push({
        kind: "fenced",
        id: `${opener.id}~${child.id}`,
        open: opener.text,
        close: child.text,
        body: { kind: "row", id: `${opener.id}~body`, children: body },
        auto: true,
      });
      continue;
    }
    if (isFence && child.cls === "open") openers.push(out.length);
    out.push(child);
  }
  return out;
}

/** Pairs each editor-style `supsub` with the node before it, the base it decorates. */
function attachScripts(children: MathNode[]): MathNode[] {
  if (!children.some((child) => child.kind === "supsub")) return children;
  const out: MathNode[] = [];
  for (const child of children) {
    if (child.kind !== "supsub") {
      out.push(child);
      continue;
    }
    const previous = out.at(-1);
    const base = previous && previous.kind !== "space" && previous.kind !== "scripts" ? out.pop()! : undefined;
    out.push(withBase(child, base ?? { kind: "row", id: `${child.id}~base`, children: [] }));
  }
  return out;
}

function withBase(node: SupSubNode, base: MathNode): ScriptsNode {
  return { kind: "scripts", id: node.id, base, sup: node.sup, sub: node.sub };
}

function fontFor(atom: AtomNode, exp: Experience): FontFace {
  const face = exp.fonts[atom.role] ?? exp.fonts.default;
  let italic = face.italic ?? false;
  let weight = face.weight ?? 400;
  // Capital Greek is upright in TeX's convention, even where Latin letters are italic.
  if (atom.role === "greek" && isUpperGreek(atom.text)) italic = false;
  if (atom.variant === "upright") italic = false;
  if (atom.variant === "italic") italic = true;
  if (atom.variant === "bold") {
    italic = false;
    weight = 700;
  }
  return { family: face.family, italic, weight };
}

const colorFor = (role: Role, exp: Experience) => exp.colors[role] ?? exp.colors.ink;

function layoutAtom(atom: AtomNode, c: LayoutContext): Box {
  const face = fontFor(atom, c.exp);
  const font: FontSpec = { ...face, sizePx: sizeOf(c) * (atom.largeOp ? largeOpScale(atom, c) : 1) };
  const ink = c.measurer.measure(atom.text, font);
  const color = colorFor(atom.role, c.exp);
  const chips = c.exp.chips;
  if (chips.enabled && chips.roles.includes(atom.role) && !atom.pending) return chip(atom, font, ink, color, c);

  // Big operators centre on the math axis, the same line fraction bars and delimiters use.
  const y = atom.largeOp ? -em(c, c.exp.axisHeight) + (ink.ascent - ink.descent) / 2 : 0;
  const slanted = face.italic || INTEGRALS.has(atom.text);
  const items: Placed[] = [{ x: 0, y, item: { type: "glyph", text: atom.text, font, color } }];
  if (atom.pending) items.push(pendingUnderline(ink.width, Math.max(0, ink.descent + y), c));
  return {
    width: ink.width,
    height: Math.max(0, ink.ascent - y),
    depth: Math.max(0, ink.descent + y),
    items,
    italicCorrection: slanted ? ink.italicCorrection : 0,
    source: sourceOf(atom),
  };
}

/** The editor's mark for letters that may still become a symbol, like an input method's underline. */
function pendingUnderline(width: number, depth: number, c: LayoutContext): Placed {
  const thickness = Math.max(1, em(c, 0.05));
  return {
    x: 0,
    y: Math.max(depth, em(c, 0.12)) + em(c, 0.04),
    item: { type: "rect", width, height: thickness, radius: thickness / 2, fill: "#3b6fe0" },
  };
}

function largeOpScale(atom: AtomNode, c: LayoutContext): number {
  const target = INTEGRALS.has(atom.text) ? c.exp.scale.integral : c.exp.scale.largeOp;
  // In running text a big operator grows only a little, so it doesn't push lines apart.
  return c.display ? target : 1 + (target - 1) * 0.35;
}

/**
 * A glyph on a rounded token. Every chip at a size shares one band centred on the math
 * axis, so tokens line up with operators. Inside the band the glyph either keeps the
 * shared baseline or is centred by its own ink, which balances letters like `g` and `f`
 * from measurements instead of hand-tuned nudges.
 */
function chip(atom: AtomNode, font: FontSpec, ink: InkMetrics, color: string, c: LayoutContext): Box {
  const chips = c.exp.chips;
  const axis = em(c, c.exp.axisHeight);
  const capHeight = c.measurer.measure("H", font).ascent;
  const height = Math.max(em(c, chips.minSize), capHeight + 2 * em(c, chips.padY));
  const width = Math.max(em(c, chips.minSize), ink.width + 2 * em(c, chips.padX));
  const top = -axis - height / 2;
  const baseline = chips.centerInk ? -axis + (ink.ascent - ink.descent) / 2 : -axis + capHeight / 2;
  return {
    width,
    height: -top,
    depth: Math.max(0, top + height),
    items: [
      {
        x: 0,
        y: top,
        item: { type: "rect", width, height, radius: em(c, chips.radius), fill: chips.fills[atom.role] ?? "none" },
      },
      { x: (width - ink.width) / 2, y: baseline, item: { type: "glyph", text: atom.text, font, color } },
    ],
    source: sourceOf(atom),
  };
}

function layoutFrac(frac: FracNode, c: LayoutContext): Box {
  // In display style the parts drop to text style but keep their size; otherwise they shrink a level.
  const inner = c.display ? { ...c, display: false } : smaller(c);
  const num = layoutNode(frac.num, inner);
  const den = layoutNode(frac.den, inner);
  const { rule, gap, pad, roundCaps } = c.exp.fraction;
  const thickness = Math.max(0.75, em(c, rule));
  const clearance = em(c, gap);
  const axis = em(c, c.exp.axisHeight);
  const padding = em(c, pad);
  const width = Math.max(num.width, den.width) + 2 * padding;
  const numY = -(axis + thickness / 2 + clearance + num.depth);
  const denY = -axis + thickness / 2 + clearance + den.height;
  const inset = padding * 0.4;
  return {
    width,
    height: -numY + num.height,
    depth: denY + den.depth,
    items: [
      nest(num, (width - num.width) / 2, numY),
      {
        x: inset,
        y: -axis - thickness / 2,
        item: {
          type: "rect",
          width: width - 2 * inset,
          height: thickness,
          radius: roundCaps ? thickness / 2 : 0,
          fill: c.exp.colors.ink,
        },
      },
      nest(den, (width - den.width) / 2, denY),
    ],
    source: sourceOf(frac),
  };
}

function layoutSqrt(node: SqrtNode, c: LayoutContext): Box {
  const body = layoutNode(node.body, c);
  const { stroke, gap, slant, pad } = c.exp.radical;
  const size = sizeOf(c);
  const strokeWidth = Math.max(0.75, em(c, stroke));
  const padding = em(c, pad);
  const top = -(Math.max(body.height, em(c, 0.68)) + em(c, gap) + strokeWidth / 2);
  const bottom = Math.max(body.depth, em(c, 0.12)) + em(c, 0.06);
  const signWidth = em(c, 0.5) + slant * (bottom - top);
  const items: Placed[] = [];
  let shift = 0;
  let height = -top + strokeWidth / 2;

  if (node.index) {
    // The index nestles into the crook above the hook; a wide index pushes the sign right.
    const index = layoutNode(node.index, { ...c, level: 2, display: false });
    const { veeX, hookTop } = radicalHook(signWidth, top, bottom, size);
    const crookX = veeX * 0.7;
    const indexY = hookTop - em(c, 0.1) - index.depth;
    shift = Math.max(0, index.width - crookX);
    items.push(nest(index, shift + crookX - index.width, indexY));
    height = Math.max(height, index.height - indexY);
  }

  const barEnd = signWidth + padding + body.width + padding;
  items.push({
    x: shift,
    y: 0,
    item: { type: "path", d: radicalPath(signWidth, top, bottom, barEnd, size), stroke: c.exp.colors.ink, strokeWidth },
  });
  items.push(nest(body, shift + signWidth + padding, 0));
  return {
    width: shift + barEnd + em(c, 0.04),
    height,
    depth: bottom + strokeWidth / 2,
    items,
    source: sourceOf(node),
  };
}

function layoutScripts(node: ScriptsNode, c: LayoutContext): Box {
  const base = layoutNode(node.base, c);
  const scriptContext = smaller(c);
  const sup = node.sup ? layoutNode(node.sup, scriptContext) : undefined;
  const sub = node.sub ? layoutNode(node.sub, scriptContext) : undefined;
  const source = sourceOf(node);
  const largeOp = node.base.kind === "atom" && node.base.largeOp;
  if (node.base.kind === "atom" && node.base.limits && c.display) return limits(base, sup, sub, c, source);
  // A big operator's scripts belong at its top and bottom corners, whatever the experience's
  // mode: stacked on the midline of a tall ∫ they would collide.
  if (c.exp.scripts.mode === "centered" && !largeOp) return centeredScripts(base, sup, sub, c, source);
  // An integral leans, so its subscript tucks back under the slant.
  const subKern = largeOp ? (base.italicCorrection ?? 0) : 0;
  return shiftedScripts(base, sup, sub, c, scriptContext, source, subKern);
}

/**
 * TeX's placement (The TeXbook, appendix G, rules 18a–f, simplified): raise a superscript
 * at least `supShift` and enough to clear the base, drop a subscript likewise, and push
 * them apart when both are present.
 */
function shiftedScripts(
  base: Box,
  sup: Box | undefined,
  sub: Box | undefined,
  c: LayoutContext,
  scriptContext: LayoutContext,
  source: Box["source"],
  subKern = 0,
): Box {
  const p = c.exp.scripts;
  const italic = base.italicCorrection ?? 0;
  const raise = sup ? Math.max(em(c, p.supShift), base.height - em(scriptContext, 0.38), sup.depth + em(c, 0.12)) : 0;
  let drop = sub ? Math.max(em(c, p.subShift), base.depth + em(scriptContext, 0.05), sub.height - em(c, 0.36)) : 0;
  if (sup && sub) {
    const clearance = raise - sup.depth - (sub.height - drop);
    if (clearance < em(c, p.gap)) drop += em(c, p.gap) - clearance;
  }
  const items: Placed[] = [nest(base, 0, 0)];
  let width = base.width;
  if (sup) {
    items.push(nest(sup, base.width + italic, -raise));
    width = Math.max(width, base.width + italic + sup.width);
  }
  if (sub) {
    items.push(nest(sub, base.width - subKern, drop));
    width = Math.max(width, base.width - subKern + sub.width);
  }
  return {
    width: width + em(c, p.space),
    height: Math.max(base.height, sup ? raise + sup.height : 0, sub ? sub.height - drop : 0),
    depth: Math.max(base.depth, sub ? drop + sub.depth : 0, sup ? sup.depth - raise : 0),
    items,
    source,
  };
}

/** Scripts stacked on the base's vertical midline: the superscript above it, the subscript below. */
function centeredScripts(
  base: Box,
  sup: Box | undefined,
  sub: Box | undefined,
  c: LayoutContext,
  source: Box["source"],
): Box {
  const p = c.exp.scripts;
  const midline = (base.depth - base.height) / 2;
  const gap = em(c, p.gap);
  const x = base.width + em(c, 0.04);
  const items: Placed[] = [nest(base, 0, 0)];
  let { width, height, depth } = base;
  if (sup) {
    const y = midline - gap - sup.depth;
    items.push(nest(sup, x, y));
    height = Math.max(height, sup.height - y);
    width = Math.max(width, x + sup.width);
  }
  if (sub) {
    const y = midline + gap + sub.height;
    items.push(nest(sub, x, y));
    depth = Math.max(depth, y + sub.depth);
    width = Math.max(width, x + sub.width);
  }
  return { width: width + em(c, p.space), height, depth, items, source };
}

/** Limits centred above and below a display-style operator: ∑ with its range, lim with its approach. */
function limits(base: Box, sup: Box | undefined, sub: Box | undefined, c: LayoutContext, source: Box["source"]): Box {
  const gap = em(c, 0.14);
  const width = Math.max(base.width, sup?.width ?? 0, sub?.width ?? 0);
  const items: Placed[] = [nest(base, (width - base.width) / 2, 0)];
  let { height, depth } = base;
  if (sup) {
    const y = -(base.height + gap + sup.depth);
    items.push(nest(sup, (width - sup.width) / 2, y));
    height = sup.height - y;
  }
  if (sub) {
    const y = base.depth + gap + sub.height;
    items.push(nest(sub, (width - sub.width) / 2, y));
    depth = y + sub.depth;
  }
  return { width, height, depth, items, source };
}

/**
 * Surrounds a box with delimiters that cover it symmetrically about the math axis, so a
 * fraction's bar stays level with the centre of its parentheses.
 */
export function wrapInDelimiters(
  body: Box,
  open: string,
  close: string,
  c: LayoutContext,
  source?: Box["source"],
): Box {
  const axis = em(c, c.exp.axisHeight);
  const half = Math.max(body.height - axis, body.depth + axis) + em(c, c.exp.delimiters.overshoot);
  const left = delimiter(open, half, c);
  const right = delimiter(close, half, c);
  const gap = em(c, c.exp.delimiters.gap);
  return hlist(
    [
      { box: left, space: 0 },
      { box: body, space: left.width > 0 ? gap : 0 },
      { box: right, space: right.width > 0 ? gap : 0 },
    ],
    source,
  );
}

function delimiter(glyph: string, half: number, c: LayoutContext): Box {
  if (glyph === "." || glyph === "") return { width: 0, height: 0, depth: 0, items: [] };
  const d = c.exp.delimiters;
  const axis = em(c, c.exp.axisHeight);
  const total = 2 * half;
  const color = c.exp.colors.fence ?? c.exp.colors.ink;
  const drawn = canDrawDelimiter(glyph) && (d.mode === "drawn" || (d.mode === "auto" && total > em(c, 1.3)));
  if (drawn) {
    const width = em(c, d.width) * Math.min(2, 1 + 0.12 * Math.max(0, total / sizeOf(c) - 1));
    const strokeWidth = Math.max(0.75, em(c, d.stroke));
    const path = delimiterPath(glyph, width, total, strokeWidth);
    if (path) {
      return {
        width,
        height: axis + half,
        depth: half - axis,
        items: [{ x: 0, y: -axis - half, item: { type: "path", d: path, stroke: color, strokeWidth } }],
      };
    }
  }
  // The font's own glyph, scaled until its ink spans the height needed.
  const face = c.exp.fonts.fence ?? c.exp.fonts.default;
  const natural = c.measurer.measure(glyph, { ...face, sizePx: sizeOf(c) });
  const scale = Math.max(1, total / (natural.ascent + natural.descent || sizeOf(c)));
  const font: FontSpec = { ...face, sizePx: sizeOf(c) * scale };
  const ink = c.measurer.measure(glyph, font);
  const y = -axis + (ink.ascent - ink.descent) / 2;
  return {
    width: ink.width,
    height: ink.ascent - y,
    depth: ink.descent + y,
    items: [{ x: 0, y, item: { type: "glyph", text: glyph, font, color } }],
  };
}

const ACCENT_HEIGHT: Record<AccentNode["accent"], number> = {
  hat: 0.16,
  bar: 0.02,
  vec: 0.2,
  tilde: 0.12,
  dot: 0.1,
  ddot: 0.1,
};

function layoutAccent(node: AccentNode, c: LayoutContext): Box {
  const base = layoutNode(node.base, c);
  const { stroke, gap } = c.exp.accents;
  const strokeWidth = Math.max(0.75, em(c, stroke));
  // Over a single symbol the mark keeps a letter-sized width; over a group it spans the group.
  const single = node.base.kind === "atom";
  const width = single ? Math.min(Math.max(base.width * 0.8, em(c, 0.36)), em(c, 0.6)) : base.width;
  const markHeight = em(c, ACCENT_HEIGHT[node.accent]);
  // Slanted letters lean right at the top, so their accents follow.
  const skew = single ? (base.italicCorrection ?? 0) * 0.5 : 0;
  const top = -(base.height + em(c, gap) + markHeight);
  const { d, filled } = accentPath(node.accent, width, markHeight);
  const color = c.exp.colors.ink;
  return {
    width: base.width,
    height: -top + strokeWidth / 2,
    depth: base.depth,
    items: [
      nest(base, 0, 0),
      {
        x: (base.width - width) / 2 + skew,
        y: top,
        item: filled ? { type: "path", d, fill: color } : { type: "path", d, stroke: color, strokeWidth },
      },
    ],
    italicCorrection: base.italicCorrection,
    source: sourceOf(node),
  };
}

function layoutMatrix(node: MatrixNode, c: LayoutContext): Box {
  const cells = node.rows.map((row) => row.map((cell) => layoutNode(cell, { ...c, display: false })));
  const columns = Math.max(0, ...cells.map((row) => row.length));
  const columnWidths = Array.from({ length: columns }, (_, j) => Math.max(0, ...cells.map((row) => row[j]?.width ?? 0)));
  // A strut keeps short rows (all x-height letters) from collapsing together.
  const rowHeights = cells.map((row) => Math.max(em(c, 0.7), ...row.map((cell) => cell.height)));
  const rowDepths = cells.map((row) => Math.max(em(c, 0.25), ...row.map((cell) => cell.depth)));
  const columnGap = em(c, c.exp.matrix.columnGap);
  const rowGap = em(c, c.exp.matrix.rowGap);

  const baselines: number[] = [];
  let y = 0;
  rowHeights.forEach((height, i) => {
    if (i > 0) y += (rowDepths[i - 1] ?? 0) + rowGap + height;
    baselines.push(y);
  });
  const top = -(rowHeights[0] ?? 0);
  const bottom = y + (rowDepths.at(-1) ?? 0);
  // Centre the grid on the math axis, as TeX centres a matrix on the axis of the line.
  const shift = -em(c, c.exp.axisHeight) - (top + bottom) / 2;

  const items: Placed[] = [];
  let x = 0;
  for (let j = 0; j < columns; j++) {
    const columnWidth = columnWidths[j] ?? 0;
    cells.forEach((row, i) => {
      const cell = row[j];
      if (!cell) return;
      const dx = node.columnAlign === "left" ? 0 : (columnWidth - cell.width) / 2;
      items.push(nest(cell, x + dx, (baselines[i] ?? 0) + shift));
    });
    x += columnWidth + (j < columns - 1 ? columnGap : 0);
  }
  const grid: Box = { width: x, height: -(top + shift), depth: bottom + shift, items };
  return wrapInDelimiters(grid, node.open, node.close, c, sourceOf(node));
}

function layoutText(node: TextNode, c: LayoutContext): Box {
  const face = c.exp.fonts.text ?? c.exp.fonts.default;
  const font: FontSpec = { ...face, sizePx: sizeOf(c) };
  const ink = c.measurer.measure(node.text, font);
  return {
    width: ink.width,
    height: Math.max(0, ink.ascent),
    depth: Math.max(0, ink.descent),
    items: [{ x: 0, y: 0, item: { type: "glyph", text: node.text, font, color: c.exp.colors.text ?? c.exp.colors.ink } }],
    source: sourceOf(node),
  };
}
