import { describe, expect, it } from "vitest";
import { chips } from "../engine/experiences";
import { flatten } from "../engine/flatten";
import { toLatex } from "../engine/latex";
import { approximateMeasurer } from "../engine/measure";
import { typeset } from "../engine/typeset";
import { CATALOG } from "./catalog";
import {
  acceptSuggestion,
  backspace,
  displayTree,
  insertLatex,
  jumpToSlot,
  keepLetters,
  moveLeft,
  moveRight,
  moveVertically,
  typeText,
  type EditOptions,
} from "./commands";
import { caretFor, cursorAt } from "./geometry";
import { createEditor, type EditorState } from "./model";
import { canExtend, isUnique, suggest } from "./suggest";

/** Converts every exact keyword, so these tests don't depend on the real policy. */
const EAGER: EditOptions = { autoConvert: () => true };
const NEVER: EditOptions = { autoConvert: () => false };

const type = (text: string, options = EAGER, state: EditorState = createEditor()) => typeText(state, text, options);
/** The LaTeX of the tree, after settling any letters still being typed. */
const latex = (state: EditorState) => toLatex(keepLetters(state).root);
const entry = (id: string) => CATALOG.find((e) => e.id === id)!;

describe("typing", () => {
  it("builds scripts, leaving a lone-number exponent at the next operator", () => {
    expect(latex(type("x^2+1"))).toBe("x^2 + 1");
    expect(latex(type("x^10+1"))).toBe("x^{10} + 1");
    expect(latex(type("x^n+1", NEVER))).toBe("x^{n + 1}");
    expect(latex(type("e^-x"))).toBe("e^{-x}");
  });

  it("turns / into a fraction over the operand before it", () => {
    expect(latex(type("1/2"))).toBe("\\frac{1}{2}");
    expect(latex(type("2x/3"))).toBe("\\frac{2x}{3}");
    expect(latex(type("a+b/c"))).toBe("a + \\frac{b}{c}");
    expect(latex(type("(a+b)/2"))).toBe("\\frac{(a + b)}{2}");
  });

  it("merges typed operator pairs", () => {
    expect(latex(type("a<=b"))).toBe("a \\leq b");
    expect(latex(type("x->0"))).toBe("x \\to 0");
    expect(latex(type("a+-b"))).toBe("a \\pm b");
    expect(latex(type("p<=>q"))).toBe("p \\Leftrightarrow q");
  });

  it("converts a keyword as soon as nothing longer could be meant", () => {
    const state = type("sqrt");
    expect(state.pending).toBe("");
    expect(latex(type("x", EAGER, state))).toBe("\\sqrt{x}");
    expect(latex(type("alpha+1"))).toBe("\\alpha + 1");
  });

  it("waits while a longer keyword is possible, then converts when the word ends", () => {
    const state = type("sin");
    expect(state.pending).toBe("sin");
    expect(latex(type("x", EAGER, state))).toBe("\\sin x");
    expect(latex(type("pi r^2"))).toBe("\\pi r^2");
  });

  it("keeps letters as variables when the policy declines", () => {
    expect(latex(type("sqrtx", NEVER))).toBe("sqrtx");
    expect(latex(type("xy"))).toBe("xy");
  });

  it("reads multi-word phrases", () => {
    expect(latex(type("square root x"))).toBe("\\sqrt{x}");
    expect(latex(type("a less than or equal b"))).toBe("a \\leq b");
  });

  it("fills a template's slots in order with Tab", () => {
    let state = type("sum n=0");
    state = jumpToSlot(state, "next", EAGER);
    state = type("N", EAGER, state);
    state = jumpToSlot(state, "next", EAGER);
    state = type("a_n", EAGER, state);
    expect(latex(state)).toBe("\\sum_{n = 0}^N a_n");
  });

  it("lets ^ and _ reach a template's existing scripts instead of nesting", () => {
    expect(latex(type("lim_x->0 f"))).toBe("\\lim_{x \\to 0} f");
  });

  it("inserts a suggestion the user picks", () => {
    let state = type("matr", NEVER);
    state = acceptSuggestion(state, entry("matrix"));
    for (const cell of ["a", "b", "c", "d"]) {
      state = type(cell, NEVER, state);
      state = jumpToSlot(state, "next", NEVER);
    }
    expect(latex(state)).toBe("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
  });

  it("inserts pasted LaTeX at the cursor", () => {
    expect(latex(insertLatex(type("y="), "\\frac{a}{b}"))).toBe("y = \\frac{a}{b}");
  });
});

describe("deleting", () => {
  it("undoes a conversion with the next Backspace", () => {
    const state = backspace(type("sqrt"));
    expect(state.pending).toBe("sqrt");
    expect(state.root.children).toHaveLength(0);
  });

  it("walks back through a fraction, then removes it once empty", () => {
    let state = type("1/2");
    for (let i = 0; i < 3; i++) state = backspace(state);
    expect(latex(state)).toBe("\\frac{}{}");
    state = backspace(state);
    expect(state.root.children).toHaveLength(0);
  });

  it("dissolves a script from its start, keeping what it held", () => {
    const state = backspace(moveLeft(type("x^2"), EAGER));
    expect(latex(state)).toBe("x2");
  });

  it("reopens a function name so it can become something else", () => {
    const state = backspace(type("sin("));
    expect(latex(state)).toBe("\\sin");
    expect(backspace(state).pending).toBe("si");
  });

  it("drops a script that was opened and abandoned", () => {
    expect(latex(moveRight(type("x^"), EAGER))).toBe("x");
  });
});

describe("moving", () => {
  it("enters and leaves structures with the arrow keys", () => {
    const inDenominator = type("1/2");
    const after = moveRight(inDenominator, EAGER);
    expect(after.cursor).toEqual({ row: after.root.id, index: 1 });
    const back = moveLeft(after, EAGER);
    expect(back.cursor).toEqual(inDenominator.cursor);
    const up = moveVertically(back, "up", EAGER);
    expect(up.cursor.row).not.toBe(back.cursor.row);
    expect(latex(type("0", EAGER, up))).toBe("\\frac{10}{2}");
  });
});

describe("suggestions", () => {
  it("ranks the likeliest symbol first", () => {
    expect(suggest("sq")[0]?.entry.id).toBe("sqrt");
    expect(suggest("square r")[0]?.entry.id).toBe("sqrt");
    expect(suggest("in")[0]?.entry.id).toBe("in");
    expect(suggest("in").map((s) => s.entry.id)).toEqual(expect.arrayContaining(["int", "infinity"]));
  });

  it("tells capital Greek from lowercase by case", () => {
    expect(suggest("Delta")[0]?.entry.id).toBe("greek-Delta");
    expect(suggest("delta")[0]?.entry.id).toBe("greek-delta");
  });

  it("knows when a word could still grow", () => {
    expect(canExtend("sqr")).toBe(true);
    expect(canExtend("xq")).toBe(false);
    expect(isUnique("sqrt")).toBe(true);
    expect(isUnique("sin")).toBe(false);
  });
});

describe("normal form", () => {
  it("round-trips LaTeX through the editor", () => {
    for (const source of [
      "f(x) = \\sqrt{\\frac{2x+4}{\\sin x - 3}}",
      "\\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!}(x-a)^n",
      "|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}",
      "\\vec{F} = m\\vec{a}, \\quad \\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx",
    ]) {
      const once = toLatex(createEditor(source).root);
      expect(toLatex(createEditor(once).root)).toBe(once);
    }
  });

  it("shows letters being typed at the cursor", () => {
    const shown = displayTree(type("x+sq"));
    expect(shown.pendingIds).toHaveLength(2);
    expect(shown.root.children.map((n) => (n.kind === "atom" ? n.text : n.kind))).toEqual(["x", "+", "s", "q"]);
  });
});

describe("geometry", () => {
  const layoutOf = (state: EditorState) =>
    flatten(typeset(state.root, { experience: chips, measurer: approximateMeasurer, fontSizePx: 20 }));

  it("puts the caret at the end of what was typed", () => {
    const state = type("x+1");
    const scene = layoutOf(state);
    const caret = caretFor(state.root, state.cursor, scene, 20)!;
    const last = scene.regions.find((r) => r.kind === "atom" && r.id === state.root.children[2]!.id)!;
    expect(caret.x).toBeCloseTo(last.x + last.width);
  });

  it("maps a click inside a denominator to that row", () => {
    const state = moveRight(type("1/2"), EAGER);
    const scene = layoutOf(state);
    const frac = state.root.children[0]!;
    if (frac.kind !== "frac") throw new Error("expected a fraction");
    const den = scene.regions.find((r) => r.id === frac.den.id)!;
    const cursor = cursorAt(state.root, scene, den.x + den.width - 1, den.y);
    expect(cursor.row).toBe(frac.den.id);
  });
});
