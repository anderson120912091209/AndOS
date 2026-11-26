import type { MathNode } from "./ast";
import type { Experience } from "./experience";
import type { Box, LayoutContext } from "./layout";
import { layoutNode } from "./layout";
import { breakLines } from "./linebreak";
import type { Measurer } from "./measure";

export interface TypesetOptions {
  experience: Experience;
  measurer: Measurer;
  fontSizePx: number;
  /** Display style (an equation on its own line) or text style (inside a sentence). Defaults to display. */
  display?: boolean;
  /** Break the top-level row into lines no wider than this, in px. */
  maxWidth?: number;
}

/** Lays out a whole expression. */
export function typeset(root: MathNode, options: TypesetOptions): Box {
  const context: LayoutContext = {
    exp: options.experience,
    measurer: options.measurer,
    basePx: options.fontSizePx,
    level: 0,
    display: options.display ?? true,
  };
  if (options.maxWidth !== undefined && root.kind === "row") return breakLines(root, context, options.maxWidth);
  return layoutNode(root, context);
}
