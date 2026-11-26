import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { Region, Scene, SceneItem } from "../engine";

interface Props {
  scene: Scene;
  background: string;
  /** Font size, used to scale padding and overlay strokes. */
  fontSizePx: number;
  showBoxes: boolean;
  /** Draws the wrap width as a guide, in px from the left edge of the math. */
  guideX?: number;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The scene plus half an em of margin; the origin stays on the root baseline. */
export function viewBoxFor(scene: Scene, fontSizePx: number, guideX?: number): ViewBox {
  const pad = fontSizePx * 0.5;
  const right = Math.max(scene.width, guideX ?? 0);
  return { x: -pad, y: -scene.height - pad, width: right + 2 * pad, height: scene.height + scene.depth + 2 * pad };
}

/** Renders a laid-out scene as SVG, with optional box outlines and a hover inspector. */
export function MathView({ scene, background, fontSizePx, showBoxes, guideX }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<Region | null>(null);
  const viewBox = viewBoxFor(scene, fontSizePx, guideX);
  // Innermost first, so hovering picks the most specific box under the pointer.
  const byArea = useMemo(
    () =>
      scene.regions
        .filter((region) => region.width > 0)
        .sort((a, b) => a.width * (a.height + a.depth) - b.width * (b.height + b.depth)),
    [scene],
  );

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const hit = byArea.find(
      (r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y - r.height && p.y <= r.y + r.depth,
    );
    setHovered(hit ?? null);
  };

  return (
    <div className="math-view">
      <div className="math-scroll">
        <svg
          ref={svgRef}
          width={viewBox.width}
          height={viewBox.height}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHovered(null)}
        >
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill={background} />
          {guideX !== undefined && (
            <line
              className="guide"
              x1={guideX}
              x2={guideX}
              y1={viewBox.y}
              y2={viewBox.y + viewBox.height}
              strokeWidth={Math.max(1, fontSizePx / 30)}
            />
          )}
          {showBoxes && <BoxOutlines regions={scene.regions} fontSizePx={fontSizePx} />}
          {scene.items.map((item, i) => (
            <Paint key={i} item={item} />
          ))}
          {hovered && (
            <rect
              className="hover"
              x={hovered.x}
              y={hovered.y - hovered.height}
              width={hovered.width}
              height={hovered.height + hovered.depth}
              strokeWidth={Math.max(1, fontSizePx / 24)}
            />
          )}
        </svg>
      </div>
      <p className="inspector">{hovered ? describe(hovered, fontSizePx) : "Hover the math to inspect a box."}</p>
    </div>
  );
}

export function Paint({ item }: { item: SceneItem }) {
  switch (item.type) {
    case "glyph":
      return (
        <text
          x={item.x}
          y={item.y}
          fontFamily={item.font.family}
          fontSize={item.font.sizePx}
          fontStyle={item.font.italic ? "italic" : "normal"}
          fontWeight={item.font.weight ?? 400}
          fill={item.color}
          style={{ whiteSpace: "pre" }}
        >
          {item.text}
        </text>
      );
    case "rect":
      return (
        <rect
          x={item.x}
          y={item.y}
          width={item.width}
          height={item.height}
          rx={item.radius}
          fill={item.fill}
          stroke={item.stroke}
          strokeWidth={item.strokeWidth}
          strokeDasharray={item.dashed ? "3 2" : undefined}
          opacity={item.dashed ? 0.45 : 1}
        />
      );
    case "path":
      return (
        <path
          d={item.d}
          transform={`translate(${item.x} ${item.y})`}
          fill={item.fill ?? "none"}
          stroke={item.stroke}
          strokeWidth={item.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

/** Each model node's box, coloured by depth, with its baseline. */
export function BoxOutlines({ regions, fontSizePx }: { regions: Region[]; fontSizePx: number }) {
  const strokeWidth = Math.max(0.5, fontSizePx / 60);
  return (
    <g className="boxes">
      {regions.map((r) => {
        const hue = (r.nesting * 47) % 360;
        return (
          <g key={`${r.id}-${r.x}-${r.y}`}>
            <rect
              x={r.x}
              y={r.y - r.height}
              width={r.width}
              height={r.height + r.depth}
              fill={`hsl(${hue} 80% 60% / 0.06)`}
              stroke={`hsl(${hue} 70% 45% / 0.55)`}
              strokeWidth={strokeWidth}
            />
            <line
              x1={r.x}
              x2={r.x + r.width}
              y1={r.y}
              y2={r.y}
              stroke={`hsl(${hue} 70% 45% / 0.4)`}
              strokeWidth={strokeWidth}
              strokeDasharray="2 2"
            />
          </g>
        );
      })}
    </g>
  );
}

function describe(region: Region, fontSizePx: number): string {
  const inEm = (px: number) => `${(px / fontSizePx).toFixed(2)}em`;
  return `${region.kind} ${region.id} · width ${inEm(region.width)} · height ${inEm(region.height)} · depth ${inEm(region.depth)}`;
}
