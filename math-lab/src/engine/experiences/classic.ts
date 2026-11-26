import type { Experience } from "../experience";
import { STIX_MATH, STIX_TEXT } from "./fonts";

/** What a printed paper does: TeX's rules, an italic serif, nothing print couldn't show. */
export const classic: Experience = {
  id: "classic",
  name: "Classic",
  blurb: "TeX's rules: italic variables, scripts on shifted baselines, spacing by atom class.",
  fonts: {
    default: { family: STIX_TEXT },
    variable: { family: STIX_TEXT, italic: true },
    greek: { family: STIX_TEXT, italic: true },
    operator: { family: STIX_MATH },
    relation: { family: STIX_MATH },
    fence: { family: STIX_MATH },
    largeOp: { family: STIX_MATH },
    constant: { family: STIX_MATH },
  },
  colors: { ink: "#1c1c1e", background: "#ffffff" },
  axisHeight: 0.25,
  scale: { script: 0.7, scriptScript: 0.5, largeOp: 1.45, integral: 2 },
  scripts: { mode: "shifted", supShift: 0.4, subShift: 0.18, gap: 0.16, space: 0.05 },
  fraction: { rule: 0.045, gap: 0.12, pad: 0.12, roundCaps: false },
  radical: { stroke: 0.045, gap: 0.12, slant: 0.14, pad: 0.06 },
  delimiters: { mode: "auto", autoGrow: false, stroke: 0.05, width: 0.34, overshoot: 0.06, gap: 0.04 },
  accents: { stroke: 0.045, gap: 0.08 },
  spacing: { mode: "tex", scale: 1, uniformGap: 0.08, operatorGap: 0.22, relationGap: 0.28 },
  matrix: { columnGap: 0.9, rowGap: 0.25 },
  chips: {
    enabled: false,
    roles: ["variable", "number", "function", "greek"],
    padX: 0.14,
    padY: 0.1,
    radius: 0.16,
    minSize: 1,
    centerInk: true,
    fills: { variable: "#e8eefc", number: "#f1f1f3", function: "#fcefe3", greek: "#efe9fc" },
  },
  lineBreak: { mode: "before-operator", indent: "relation", lineGap: 0.45 },
};
