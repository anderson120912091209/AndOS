import type { Experience } from "../experience";
import { INTER, SANS_MATH } from "./fonts";

/**
 * Structure first: every variable, number and function is a token you could tap, drag or
 * rename; brackets always fit what they hold; scripts stack beside their base.
 */
export const chips: Experience = {
  id: "chips",
  name: "Chips",
  blurb: "Structure first: symbols are tokens, brackets grow on their own, scripts stack on the midline.",
  fonts: {
    default: { family: INTER, weight: 500 },
    operator: { family: SANS_MATH },
    relation: { family: SANS_MATH },
    fence: { family: SANS_MATH },
    largeOp: { family: SANS_MATH },
    constant: { family: SANS_MATH },
    text: { family: INTER },
  },
  colors: {
    ink: "#1f2430",
    background: "#ffffff",
    variable: "#1d4ed8",
    function: "#b45309",
    greek: "#6d28d9",
    operator: "#475569",
    relation: "#475569",
    fence: "#64748b",
  },
  axisHeight: 0.28,
  scale: { script: 0.72, scriptScript: 0.6, largeOp: 1.3, integral: 1.6 },
  scripts: { mode: "centered", supShift: 0.4, subShift: 0.2, gap: 0.04, space: 0.06 },
  fraction: { rule: 0.06, gap: 0.16, pad: 0.1, roundCaps: true },
  radical: { stroke: 0.065, gap: 0.14, slant: 0.12, pad: 0.1 },
  delimiters: { mode: "drawn", autoGrow: true, stroke: 0.065, width: 0.3, overshoot: 0.1, gap: 0.06 },
  accents: { stroke: 0.06, gap: 0.08 },
  spacing: { mode: "uniform", scale: 1, uniformGap: 0.1, operatorGap: 0.26, relationGap: 0.36 },
  matrix: { columnGap: 0.6, rowGap: 0.3 },
  chips: {
    enabled: true,
    roles: ["variable", "number", "function", "greek"],
    padX: 0.16,
    padY: 0.12,
    radius: 0.24,
    minSize: 1.05,
    centerInk: true,
    fills: { variable: "#e3ebff", number: "#eef1f5", function: "#fdecd8", greek: "#eee7ff" },
  },
  lineBreak: { mode: "before-operator", indent: "relation", lineGap: 0.5 },
};
