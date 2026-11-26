import type { Experience } from "../experience";
import { INTER, SANS_MATH } from "./fonts";

/**
 * Made for screens and learners: an upright sans, generous spacing, larger scripts, and
 * meaning carried by colour instead of boxes.
 */
export const airy: Experience = {
  id: "airy",
  name: "Airy",
  blurb: "Screen first: upright sans, roomy spacing, larger scripts, roles told apart by colour.",
  fonts: {
    default: { family: INTER, weight: 420 },
    operator: { family: SANS_MATH },
    relation: { family: SANS_MATH },
    fence: { family: SANS_MATH },
    largeOp: { family: SANS_MATH },
    constant: { family: SANS_MATH },
  },
  colors: {
    ink: "#0f172a",
    background: "#fbfaf7",
    variable: "#0f766e",
    greek: "#0f766e",
    function: "#7c3aed",
    constant: "#be185d",
    operator: "#64748b",
    relation: "#64748b",
    fence: "#94a3b8",
  },
  axisHeight: 0.3,
  scale: { script: 0.8, scriptScript: 0.68, largeOp: 1.35, integral: 1.7 },
  scripts: { mode: "shifted", supShift: 0.48, subShift: 0.26, gap: 0.2, space: 0.08 },
  fraction: { rule: 0.05, gap: 0.2, pad: 0.16, roundCaps: true },
  radical: { stroke: 0.05, gap: 0.16, slant: 0.1, pad: 0.1 },
  delimiters: { mode: "drawn", autoGrow: true, stroke: 0.045, width: 0.3, overshoot: 0.12, gap: 0.08 },
  accents: { stroke: 0.05, gap: 0.1 },
  spacing: { mode: "tex", scale: 1.6, uniformGap: 0.12, operatorGap: 0.3, relationGap: 0.4 },
  matrix: { columnGap: 1, rowGap: 0.4 },
  chips: {
    enabled: false,
    roles: ["variable", "number", "function", "greek"],
    padX: 0.16,
    padY: 0.12,
    radius: 0.3,
    minSize: 1.05,
    centerInk: true,
    fills: { variable: "#dff3ef", number: "#eef0f2", function: "#ede7fb", greek: "#dff3ef" },
  },
  lineBreak: { mode: "before-operator", indent: "relation", lineGap: 0.6 },
};
