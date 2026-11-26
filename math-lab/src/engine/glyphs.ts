/**
 * Parametric shapes for marks that must stretch with their content. A font glyph comes in
 * a handful of sizes; a path is computed for the exact box, so a delimiter can hug a
 * fraction of any height and a radical's bar can span any width.
 *
 * Every function returns an SVG path in local px coordinates, y pointing down.
 */
import type { AccentKind } from "./ast";

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

type Shape = "paren" | "bracket" | "brace" | "angle" | "floor" | "ceil" | "bar" | "dbar" | "slash";

const SHAPES: Record<string, { shape: Shape; mirrored: boolean }> = {
  "(": { shape: "paren", mirrored: false },
  ")": { shape: "paren", mirrored: true },
  "[": { shape: "bracket", mirrored: false },
  "]": { shape: "bracket", mirrored: true },
  "{": { shape: "brace", mirrored: false },
  "}": { shape: "brace", mirrored: true },
  "⟨": { shape: "angle", mirrored: false },
  "⟩": { shape: "angle", mirrored: true },
  "⌊": { shape: "floor", mirrored: false },
  "⌋": { shape: "floor", mirrored: true },
  "⌈": { shape: "ceil", mirrored: false },
  "⌉": { shape: "ceil", mirrored: true },
  "|": { shape: "bar", mirrored: false },
  "‖": { shape: "dbar", mirrored: false },
  "/": { shape: "slash", mirrored: false },
};

export function canDrawDelimiter(glyph: string): boolean {
  return glyph in SHAPES;
}

/**
 * A delimiter filling a `width` × `height` box whose origin is its top-left corner.
 * Closing glyphs are the mirror image of their opening partner. Strokes are inset by half
 * their width so they never poke outside the box.
 */
export function delimiterPath(glyph: string, width: number, height: number, stroke: number): string | null {
  const spec = SHAPES[glyph];
  if (!spec) return null;
  const inset = stroke / 2;
  const X = (x: number) => fmt(spec.mirrored ? width - x : x);
  const Y = fmt;
  const outer = width - inset; // the open side, where the arms end
  const inner = inset; // the closed side, where the spine runs
  const top = inset;
  const bottom = height - inset;
  const mid = height / 2;

  switch (spec.shape) {
    case "paren": {
      // Curved ends joined by a straight spine once the paren is tall enough to need one.
      const reach = Math.min((bottom - top) / 2, (outer - inner) * 2.6);
      const pull = outer - (outer - inner) * 0.62;
      return [
        `M ${X(outer)} ${Y(top)}`,
        `C ${X(pull)} ${Y(top + reach * 0.22)} ${X(inner)} ${Y(top + reach * 0.55)} ${X(inner)} ${Y(top + reach)}`,
        `L ${X(inner)} ${Y(bottom - reach)}`,
        `C ${X(inner)} ${Y(bottom - reach * 0.55)} ${X(pull)} ${Y(bottom - reach * 0.22)} ${X(outer)} ${Y(bottom)}`,
      ].join(" ");
    }
    case "bracket":
      return `M ${X(outer)} ${Y(top)} L ${X(inner)} ${Y(top)} L ${X(inner)} ${Y(bottom)} L ${X(outer)} ${Y(bottom)}`;
    case "brace": {
      const spine = (outer + inner) / 2;
      const curl = Math.min((outer - inner) * 0.9, (mid - top) * 0.3);
      return [
        `M ${X(outer)} ${Y(top)}`,
        `Q ${X(spine)} ${Y(top)} ${X(spine)} ${Y(top + curl)}`,
        `L ${X(spine)} ${Y(mid - curl)}`,
        `Q ${X(spine)} ${Y(mid)} ${X(inner)} ${Y(mid)}`,
        `Q ${X(spine)} ${Y(mid)} ${X(spine)} ${Y(mid + curl)}`,
        `L ${X(spine)} ${Y(bottom - curl)}`,
        `Q ${X(spine)} ${Y(bottom)} ${X(outer)} ${Y(bottom)}`,
      ].join(" ");
    }
    case "angle":
      return `M ${X(outer)} ${Y(top)} L ${X(inner)} ${Y(mid)} L ${X(outer)} ${Y(bottom)}`;
    case "floor":
      return `M ${X(inner)} ${Y(top)} L ${X(inner)} ${Y(bottom)} L ${X(outer)} ${Y(bottom)}`;
    case "ceil":
      return `M ${X(outer)} ${Y(top)} L ${X(inner)} ${Y(top)} L ${X(inner)} ${Y(bottom)}`;
    case "bar":
      return `M ${X(width / 2)} ${Y(top)} L ${X(width / 2)} ${Y(bottom)}`;
    case "dbar":
      return `M ${X(width * 0.3)} ${Y(top)} L ${X(width * 0.3)} ${Y(bottom)} M ${X(width * 0.7)} ${Y(top)} L ${X(width * 0.7)} ${Y(bottom)}`;
    case "slash":
      return `M ${X(outer)} ${Y(top)} L ${X(inner)} ${Y(bottom)}`;
  }
}

/**
 * A radical sign plus its bar, with the origin at the sign's left edge on the baseline.
 * The hook keeps a fixed size (relative to `em`) however tall the radical grows; only the
 * long stroke stretches, so tall roots stay elegant instead of becoming giant ticks.
 *
 * @param signWidth horizontal room for the sign, up to where the bar starts
 * @param top y of the bar (negative: above the baseline)
 * @param bottom y of the bottom of the V
 * @param barEnd x where the bar stops
 */
export function radicalPath(signWidth: number, top: number, bottom: number, barEnd: number, em: number): string {
  const { veeX, hookTop } = radicalHook(signWidth, top, bottom, em);
  return [
    `M 0 ${fmt(hookTop + 0.1 * em)}`,
    `L ${fmt(veeX * 0.42)} ${fmt(hookTop)}`,
    `L ${fmt(veeX)} ${fmt(bottom)}`,
    `L ${fmt(signWidth)} ${fmt(top)}`,
    `L ${fmt(barEnd)} ${fmt(top)}`,
  ].join(" ");
}

/** Where the radical's hook sits, so an index can nestle into its crook. */
export function radicalHook(signWidth: number, top: number, bottom: number, em: number) {
  const veeX = Math.min(0.38 * em, signWidth * 0.62);
  const hookTop = bottom - Math.min(0.55 * em, (bottom - top) * 0.55);
  return { veeX, hookTop };
}

/** Accent marks in a `width` × `height` box, origin top-left. Dots are filled, the rest stroked. */
export function accentPath(kind: AccentKind, width: number, height: number): { d: string; filled: boolean } {
  const w = width;
  const h = height;
  switch (kind) {
    case "hat":
      return { d: `M 0 ${fmt(h)} L ${fmt(w / 2)} 0 L ${fmt(w)} ${fmt(h)}`, filled: false };
    case "bar":
      return { d: `M 0 ${fmt(h / 2)} L ${fmt(w)} ${fmt(h / 2)}`, filled: false };
    case "vec": {
      const y = h / 2;
      const head = Math.min(h * 0.9, w * 0.35);
      return {
        d: `M 0 ${fmt(y)} L ${fmt(w)} ${fmt(y)} M ${fmt(w - head)} ${fmt(y - head * 0.6)} L ${fmt(w)} ${fmt(y)} L ${fmt(w - head)} ${fmt(y + head * 0.6)}`,
        filled: false,
      };
    }
    case "tilde":
      return {
        d: `M 0 ${fmt(h * 0.8)} C ${fmt(w * 0.3)} ${fmt(-h * 0.2)} ${fmt(w * 0.7)} ${fmt(h * 1.2)} ${fmt(w)} ${fmt(h * 0.2)}`,
        filled: false,
      };
    case "dot":
      return { d: circle(w / 2, h / 2, h / 2), filled: true };
    case "ddot": {
      const r = h / 2;
      return { d: `${circle(w / 2 - r * 1.8, r, r)} ${circle(w / 2 + r * 1.8, r, r)}`, filled: true };
    }
  }
}

function circle(cx: number, cy: number, r: number): string {
  return `M ${fmt(cx - r)} ${fmt(cy)} a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0 a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0 Z`;
}
