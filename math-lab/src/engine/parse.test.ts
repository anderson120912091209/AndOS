import { describe, expect, it } from "vitest";
import type { MathNode } from "./ast";
import { parseLatex } from "./parse";

const children = (latex: string) => parseLatex(latex).root.children;
const texts = (latex: string) => children(latex).map((node) => (node.kind === "atom" ? node.text : node.kind));
const only = (latex: string): MathNode => {
  const nodes = children(latex);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
};

describe("parseLatex", () => {
  it("splits letters, numbers and operators into atoms", () => {
    expect(texts("2x+4.5=y")).toEqual(["2", "x", "+", "4.5", "=", "y"]);
  });

  it("classifies atoms for spacing and styling", () => {
    const [two, x, plus, , equals] = children("2x+4=y");
    expect(two).toMatchObject({ role: "number", cls: "ord" });
    expect(x).toMatchObject({ role: "variable", cls: "ord" });
    expect(plus).toMatchObject({ role: "operator", cls: "bin", text: "+" });
    expect(equals).toMatchObject({ role: "relation", cls: "rel" });
  });

  it("binds scripts and primes to the item before them", () => {
    const node = only("f'^2_n");
    expect(node.kind).toBe("scripts");
    if (node.kind !== "scripts") return;
    expect(node.base).toMatchObject({ kind: "atom", text: "f" });
    expect(node.sub).toMatchObject({ kind: "atom", text: "n" });
    expect(node.sup?.kind).toBe("row");
  });

  it("reads one token per bare argument, as TeX does", () => {
    const node = only("\\frac12");
    expect(node).toMatchObject({ kind: "frac", num: { text: "1" }, den: { text: "2" } });
  });

  it("parses radicals with an optional index", () => {
    expect(only("\\sqrt[3]{x}")).toMatchObject({ kind: "sqrt", index: { text: "3" }, body: { text: "x" } });
  });

  it("parses growing delimiters", () => {
    expect(only("\\left( \\frac{a}{b} \\right]")).toMatchObject({ kind: "fenced", open: "(", close: "]" });
  });

  it("parses matrices row by row", () => {
    const node = only("\\begin{pmatrix} a & b \\\\ c & d \\\\ \\end{pmatrix}");
    expect(node.kind).toBe("matrix");
    if (node.kind !== "matrix") return;
    expect(node.rows.map((row) => row.length)).toEqual([2, 2]);
    expect([node.open, node.close]).toEqual(["(", ")"]);
  });

  it("knows functions, large operators and limits", () => {
    const [sum, , lim] = children("\\sum x \\lim");
    expect(sum).toMatchObject({ kind: "atom", text: "∑", largeOp: true, limits: true });
    expect(lim).toMatchObject({ kind: "atom", text: "lim", role: "function", limits: true });
  });

  it("keeps going after mistakes and reports them", () => {
    const result = parseLatex("\\frac{1}{2 + \\foo");
    expect(result.root.children).toHaveLength(1);
    expect(result.issues.map((issue) => issue.message)).toEqual(["Unknown command \\foo", "Missing }"]);
  });
});
