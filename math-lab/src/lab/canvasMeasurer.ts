import { cssFont, type InkMetrics, type Measurer } from "../engine";

/** Measures real fonts with a 2D canvas, the same text engine the SVG output is drawn with. */
export function createCanvasMeasurer(): Measurer {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  const cache = new Map<string, InkMetrics>();
  return {
    measure(text, font) {
      const key = `${cssFont(font)}|${text}`;
      const cached = cache.get(key);
      if (cached) return cached;
      context.font = cssFont(font);
      const metrics = context.measureText(text);
      const ink: InkMetrics = {
        width: metrics.width,
        ascent: metrics.actualBoundingBoxAscent,
        descent: metrics.actualBoundingBoxDescent,
        italicCorrection: Math.max(0, metrics.actualBoundingBoxRight - metrics.width),
      };
      cache.set(key, ink);
      return ink;
    },
  };
}
