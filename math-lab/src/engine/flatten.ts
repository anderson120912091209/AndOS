import type { Box, Paint } from "./layout";

export type SceneItem = Paint & { x: number; y: number };

/** A laid-out model node, in absolute coordinates: `(x, y)` is the left end of its baseline. */
export interface Region {
  id: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  /** How many boxes enclose it, for colouring nested outlines. */
  nesting: number;
}

/** Absolute paint operations plus hit regions. The origin is the left end of the root baseline. */
export interface Scene {
  width: number;
  height: number;
  depth: number;
  items: SceneItem[];
  regions: Region[];
}

export function flatten(root: Box): Scene {
  const items: SceneItem[] = [];
  const regions: Region[] = [];
  const visit = (box: Box, x: number, y: number, nesting: number) => {
    if (box.source) {
      regions.push({ ...box.source, x, y, width: box.width, height: box.height, depth: box.depth, nesting });
    }
    for (const placed of box.items) {
      const px = x + placed.x;
      const py = y + placed.y;
      if (placed.item.type === "box") visit(placed.item.box, px, py, nesting + 1);
      else items.push({ ...placed.item, x: px, y: py });
    }
  };
  visit(root, 0, 0, 0);
  return { width: root.width, height: root.height, depth: root.depth, items, regions };
}
