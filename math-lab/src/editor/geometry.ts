/**
 * Where the caret goes and where a click lands, read off the laid-out scene. Every node's
 * box is a region keyed by its id, so the editor never measures the DOM itself.
 */
import type { MathNode, RowNode } from "../engine/ast";
import type { Region, Scene } from "../engine/flatten";
import { buildIndex, type Cursor } from "./model";

export interface Caret {
  x: number;
  top: number;
  bottom: number;
}

const right = (r: Region) => r.x + r.width;
const area = (r: Region) => r.width * (r.height + r.depth);

/** The x of the gap before child `index` of `row`. */
function gapX(row: RowNode, index: number, regions: Map<string, Region>): number | undefined {
  const before = row.children[index - 1];
  const after = row.children[index];
  const left = before && regions.get(before.id);
  const next = after && regions.get(after.id);
  // Between a base and its scripts the caret hugs the base; the scripts' region starts at the base.
  if (after?.kind === "supsub" && left) return right(left);
  if (left && next) return (right(left) + next.x) / 2;
  if (left) return right(left);
  if (next) return next.x;
  const own = regions.get(row.id);
  return own ? own.x + own.width / 2 : undefined;
}

export function caretFor(root: RowNode, cursor: Cursor, scene: Scene, fontSizePx: number): Caret | null {
  const regions = new Map(scene.regions.map((region) => [region.id, region]));
  const place = buildIndex(root).rows.get(cursor.row);
  if (!place) return null;
  const x = gapX(place.row, cursor.index, regions);
  if (x === undefined) return null;
  // As tall as the symbols beside it, so the caret shrinks inside a script.
  const neighbours = [place.row.children[cursor.index - 1], place.row.children[cursor.index]]
    .filter((node): node is MathNode => node !== undefined && node.kind === "atom")
    .map((node) => regions.get(node.id))
    .filter((region): region is Region => region !== undefined);
  const rowRegion = regions.get(place.row.id);
  const pool = neighbours.length > 0 ? neighbours : rowRegion ? [rowRegion] : [];
  if (pool.length === 0) return null;
  let top = Math.min(...pool.map((r) => r.y - r.height));
  let bottom = Math.max(...pool.map((r) => r.y + r.depth));
  const minimum = fontSizePx * 0.55;
  if (bottom - top < minimum) {
    const middle = (top + bottom) / 2;
    top = middle - minimum / 2;
    bottom = middle + minimum / 2;
  }
  return { x, top, bottom };
}

/** The cursor position a click at (x, y) means: the nearest gap in the innermost row under it. */
export function cursorAt(root: RowNode, scene: Scene, x: number, y: number): Cursor {
  const index = buildIndex(root);
  const regions = new Map(scene.regions.map((region) => [region.id, region]));
  const hits = scene.regions
    .filter((r) => (index.rows.has(r.id) || index.nodes.has(r.id)) && x >= r.x && x <= right(r) && y >= r.y - r.height && y <= r.y + r.depth)
    .sort((a, b) => area(a) - area(b));
  const hit = hits[0];
  const rowPlace = hit && index.rows.get(hit.id);
  if (!hit || rowPlace) {
    const target = rowPlace?.row ?? root;
    let best = target.children.length;
    let bestDistance = Infinity;
    for (let i = 0; i <= target.children.length; i++) {
      const gap = gapX(target, i, regions);
      if (gap !== undefined && Math.abs(gap - x) < bestDistance) {
        best = i;
        bestDistance = Math.abs(gap - x);
      }
    }
    return { row: target.id, index: best };
  }
  const node = index.nodes.get(hit.id)!;
  return { row: node.row.id, index: x < hit.x + hit.width / 2 ? node.index : node.index + 1 };
}
