import { describe, expect, it } from "vitest";
import type { Experience } from "./experience";
import { chips, classic } from "./experiences";
import { flatten, type SceneItem } from "./flatten";
import { approximateMeasurer } from "./measure";
import { parseLatex } from "./parse";
import { demoteBinaries } from "./spacing";
import { typeset } from "./typeset";

const SIZE = 20;

function scene(latex: string, experience: Experience = classic, maxWidth?: number) {
  const { root } = parseLatex(latex);
  return flatten(typeset(root, { experience, measurer: approximateMeasurer, fontSizePx: SIZE, maxWidth }));
}

function glyph(items: SceneItem[], text: string) {
  const found = items.find((item) => item.type === "glyph" && item.text === text);
  if (!found) throw new Error(`no glyph ${text}`);
  return found;
}

describe("typeset", () => {
  it("stacks a fraction's numerator above the axis and denominator below", () => {
    const { items } = scene("\\frac{a}{b}");
    const bar = items.find((item) => item.type === "rect");
    expect(bar).toBeDefined();
    expect(glyph(items, "a").y).toBeLessThan(bar!.y);
    expect(glyph(items, "b").y).toBeGreaterThan(bar!.y);
    // Both parts are centred over the same bar.
    expect(glyph(items, "a").x).toBeCloseTo(glyph(items, "b").x);
  });

  it("raises superscripts and drops subscripts, at a smaller size", () => {
    const { items } = scene("x^2_i");
    const base = glyph(items, "x");
    const sup = glyph(items, "2");
    const sub = glyph(items, "i");
    expect(sup.y).toBeLessThan(base.y);
    expect(sub.y).toBeGreaterThan(base.y);
    expect(sup.type === "glyph" && sup.font.sizePx).toBeCloseTo(SIZE * classic.scale.script);
  });

  it("stacks centred scripts in one column beside the base", () => {
    const { items } = scene("x^2_3", chips);
    expect(glyph(items, "2").x).toBeCloseTo(glyph(items, "3").x);
    expect(glyph(items, "2").y).toBeLessThan(glyph(items, "3").y);
  });

  it("keeps a big operator's scripts at its corners even when scripts are centred", () => {
    const { items } = scene("\\int_a^b", chips);
    expect(glyph(items, "a").y - glyph(items, "b").y).toBeGreaterThan(SIZE);
  });

  it("puts display-style limits above and below a sum", () => {
    const { items } = scene("\\sum_{n=0}^{N}");
    const sum = glyph(items, "∑");
    expect(glyph(items, "N").y).toBeLessThan(sum.y);
    expect(glyph(items, "n").y).toBeGreaterThan(sum.y);
  });

  it("draws a radical over its body", () => {
    const { items, regions } = scene("\\sqrt{x}");
    expect(items.some((item) => item.type === "path")).toBe(true);
    const root = regions.find((region) => region.kind === "sqrt")!;
    const body = regions.find((region) => region.kind === "atom")!;
    expect(root.height).toBeGreaterThan(body.height);
    expect(body.x).toBeGreaterThan(root.x);
  });

  it("grows delimiters to cover their content", () => {
    const { regions } = scene("\\left(\\frac{a}{b}\\right)", chips);
    const fenced = regions.find((region) => region.kind === "fenced")!;
    const frac = regions.find((region) => region.kind === "frac")!;
    expect(fenced.height).toBeGreaterThanOrEqual(frac.height);
    expect(fenced.depth).toBeGreaterThanOrEqual(frac.depth);
  });

  it("gives every chip at one size the same band, whatever the glyph", () => {
    const { items } = scene("x f g", chips);
    const bands = items.filter((item) => item.type === "rect").map((item) => item.type === "rect" && [item.y, item.height]);
    expect(bands).toHaveLength(3);
    expect(new Set(bands.map((band) => JSON.stringify(band))).size).toBe(1);
  });

  it("centres matrix cells in their column and shares each row's baseline", () => {
    const { items } = scene("\\begin{matrix} 1 & 222 \\\\ 333 & 4 \\end{matrix}");
    const digit = 0.55 * SIZE; // the approximate measurer's digit width
    expect(glyph(items, "1").y).toBeCloseTo(glyph(items, "222").y);
    expect(glyph(items, "1").x + digit / 2).toBeCloseTo(glyph(items, "333").x + (3 * digit) / 2);
  });
});

describe("binary demotion", () => {
  it("turns a leading or post-relation minus into an ordinary atom", () => {
    expect(demoteBinaries(["bin", "ord"])).toEqual(["ord", "ord"]);
    expect(demoteBinaries(["ord", "rel", "bin", "ord"])).toEqual(["ord", "rel", "ord", "ord"]);
    expect(demoteBinaries(["open", "bin", "ord", "close"])).toEqual(["open", "ord", "ord", "close"]);
  });

  it("keeps a binary operator between two operands", () => {
    expect(demoteBinaries(["ord", "bin", "ord"])).toEqual(["ord", "bin", "ord"]);
  });

  it("demotes an operator with nothing after it", () => {
    expect(demoteBinaries(["ord", "bin", "rel", "ord"])).toEqual(["ord", "ord", "rel", "ord"]);
    expect(demoteBinaries(["ord", "bin"])).toEqual(["ord", "ord"]);
  });

  it("ignores explicit spaces when looking for neighbours", () => {
    expect(demoteBinaries(["rel", null, "bin", "ord"])).toEqual(["rel", null, "ord", "ord"]);
  });
});

describe("line breaking", () => {
  const long = "y = a + b + c + d + e + f + g + h";

  it("leaves a row alone when it fits", () => {
    const lines = scene(long, chips).regions.filter((region) => region.kind === "row");
    expect(lines).toHaveLength(1);
  });

  it("breaks before operators and lines them up under the relation", () => {
    const { items } = scene(long, chips, 200);
    const pluses = items.filter((item) => item.type === "glyph" && item.text === "+");
    const lineStarts = new Set(pluses.map((plus) => Math.round(plus.y)));
    expect(lineStarts.size).toBeGreaterThan(1);
    // Every line after the first starts with a "+" at the same x as the "=".
    const equals = glyph(items, "=");
    const firstOnEachLine = [...lineStarts]
      .map((y) => pluses.filter((plus) => Math.round(plus.y) === y).sort((p, q) => p.x - q.x)[0]!)
      .filter((plus) => Math.round(plus.y) !== Math.round(equals.y));
    for (const plus of firstOnEachLine) expect(plus.x).toBeCloseTo(equals.x, 0);
  });
});
