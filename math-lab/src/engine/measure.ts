/** A font family stack plus style, as chosen by an experience for some role. */
export interface FontFace {
  /** CSS font-family list, e.g. `"STIX Two Text", serif`. */
  family: string;
  italic?: boolean;
  weight?: number;
}

export interface FontSpec extends FontFace {
  sizePx: number;
}

/**
 * Ink metrics of a run of text, in px. `ascent`/`descent` are the inked extents above and
 * below the baseline (not the font's line metrics), which is what stacking needs.
 */
export interface InkMetrics {
  /** Advance width: where the next glyph starts. */
  width: number;
  ascent: number;
  descent: number;
  /** How far the ink overhangs the advance on the right; slanted letters need it for scripts. */
  italicCorrection: number;
}

/**
 * The engine's only window onto real fonts. The lab measures with a canvas; tests use
 * `approximateMeasurer`, so layout stays a pure function that runs anywhere.
 */
export interface Measurer {
  measure(text: string, font: FontSpec): InkMetrics;
}

export function cssFont(font: FontSpec): string {
  return `${font.italic ? "italic " : ""}${font.weight ?? 400} ${font.sizePx}px ${font.family}`;
}

const NARROW = new Set([..."il.,;:!|'′()[]"]);
const WIDE = new Set([..."mwMW∑∏∫"]);
const TALL = /[A-Zbdfhklt0-9∑∏∫√()[\]{}|/]/;
const DEEP = /[gjpqyf,;∑∏∫()[\]{}|/]/;

/**
 * Deterministic stand-in metrics for tests and non-browser use: rough em-based widths,
 * cap-height ascent for tall glyphs and x-height for the rest.
 */
export const approximateMeasurer: Measurer = {
  measure(text, font) {
    const em = font.sizePx;
    let width = 0;
    for (const ch of text) width += (NARROW.has(ch) ? 0.3 : WIDE.has(ch) ? 0.8 : 0.55) * em;
    const ascent = (TALL.test(text) ? 0.7 : 0.46) * em;
    const descent = DEEP.test(text) ? 0.2 * em : 0;
    const italicCorrection = font.italic ? 0.06 * em : 0;
    return { width, ascent, descent, italicCorrection };
  },
};
