import type { Role } from "./ast";
import type { FontFace } from "./measure";

/** `shifted`: TeX-style baseline shifts. `centered`: scripts stack on the base's midline. */
export type ScriptMode = "shifted" | "centered";
/** `font`: scale the font's glyph. `drawn`: parametric SVG. `auto`: glyph while small, drawn when tall. */
export type DelimiterMode = "font" | "drawn" | "auto";
/** `tex`: class-pair spacing table. `uniform`: one gap, wider around operators and relations. */
export type SpacingMode = "tex" | "uniform";
export type BreakMode = "before-operator" | "after-operator";

/**
 * A typesetting experience: every decision the layout engine defers. Lengths are in em of
 * the size they are used at, so a script inherits the same proportions at its smaller size.
 */
export interface Experience {
  id: string;
  name: string;
  blurb: string;
  /** Fonts by role; roles without an entry use `default`. */
  fonts: { default: FontFace } & Partial<Record<Role, FontFace>>;
  colors: { ink: string; background: string } & Partial<Record<Role, string>>;
  /** Height of the math axis: the line fractions, operators and delimiters centre on. */
  axisHeight: number;
  scale: {
    /** Size of first-level scripts relative to their base. */
    script: number;
    /** Size of second-level scripts (and deeper) relative to the base. */
    scriptScript: number;
    /** Display-style size of ∑ ∏ ⋃ … relative to the base. */
    largeOp: number;
    /** Display-style size of ∫ ∮ … relative to the base. */
    integral: number;
  };
  scripts: {
    mode: ScriptMode;
    /** Minimum raise of a superscript baseline (shifted mode). */
    supShift: number;
    /** Minimum drop of a subscript baseline (shifted mode). */
    subShift: number;
    /** Shifted: minimum gap between sup and sub. Centered: gap from the midline. */
    gap: number;
    /** Space after the scripts. */
    space: number;
  };
  fraction: { rule: number; gap: number; pad: number; roundCaps: boolean };
  radical: {
    stroke: number;
    /** Clearance between the body and the bar. */
    gap: number;
    /** Extra sign width per em of height: taller radicals lean more. */
    slant: number;
    pad: number;
  };
  delimiters: {
    mode: DelimiterMode;
    /** Grow plain ( ) [ ] { } with their content, as if every pair were `\left … \right`. */
    autoGrow: boolean;
    stroke: number;
    /** Base width of a drawn delimiter; it widens slowly as it grows taller. */
    width: number;
    /** How far a delimiter reaches past its content, above and below. */
    overshoot: number;
    gap: number;
  };
  accents: { stroke: number; gap: number };
  spacing: {
    mode: SpacingMode;
    /** Multiplier on the TeX thin/medium/thick spaces. */
    scale: number;
    uniformGap: number;
    operatorGap: number;
    relationGap: number;
  };
  matrix: { columnGap: number; rowGap: number };
  chips: {
    enabled: boolean;
    /** Roles that get a chip; the rest are set as plain glyphs. */
    roles: Role[];
    padX: number;
    padY: number;
    radius: number;
    minSize: number;
    /** Centre each glyph's ink in its chip (optical) instead of sharing one baseline. */
    centerInk: boolean;
    fills: Partial<Record<Role, string>>;
  };
  lineBreak: {
    mode: BreakMode;
    /** `relation`: continuation lines align under the first relation; a number is a fixed indent in em. */
    indent: "relation" | number;
    lineGap: number;
  };
}
