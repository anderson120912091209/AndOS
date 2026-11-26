import type { RowNode } from "./ast";
import type { Box, LayoutContext, Placed, RowEntry } from "./layout";
import { em, hlist, rowEntries } from "./layout";

/**
 * Breaks a top-level row into lines no wider than `maxWidth` (in px), greedily: each line
 * takes as much as fits, then breaks at the last legal point. Legal points sit next to a
 * binary operator or relation, on the side the experience chooses, and the space at a
 * break is dropped. Only the outermost row breaks; fractions, radicals and groups never split.
 */
export function breakLines(row: RowNode, c: LayoutContext, maxWidth: number): Box {
  const entries = rowEntries(row.children, c);
  const source = { id: row.id, kind: row.kind };
  if (lineWidth(entries) <= maxWidth || entries.length < 2) return hlist(entries, source);

  const { mode, lineGap } = c.exp.lineBreak;
  const isOperator = (entry: RowEntry | undefined) => entry?.cls === "bin" || entry?.cls === "rel";
  const canBreakBefore = (i: number) =>
    mode === "before-operator" ? isOperator(entries[i]) : isOperator(entries[i - 1]);
  const indent = continuationIndent(entries, c, maxWidth);

  const lines: RowEntry[][] = [];
  let line: RowEntry[] = [];
  let breakPoints: number[] = []; // positions in `line` we may break before
  entries.forEach((entry, i) => {
    if (line.length > 0 && canBreakBefore(i)) breakPoints.push(line.length);
    line.push(entry);
    while (lineWidth(line) > maxWidth - (lines.length > 0 ? indent : 0)) {
      const at = breakPoints.filter((p) => p > 0 && p < line.length).at(-1);
      if (at === undefined) break; // nothing legal to break at: let this line overflow
      lines.push(line.slice(0, at));
      line = line.slice(at);
      breakPoints = breakPoints.filter((p) => p > at).map((p) => p - at);
    }
  });
  lines.push(line);

  const boxes = lines.map((entriesOfLine) =>
    hlist(entriesOfLine.map((entry, i) => ({ box: entry.box, space: i === 0 ? 0 : entry.space }))),
  );
  const items: Placed[] = [];
  let y = 0;
  let width = 0;
  boxes.forEach((box, k) => {
    const previous = boxes[k - 1];
    if (previous) y += previous.depth + em(c, lineGap) + box.height;
    const x = k === 0 ? 0 : indent;
    items.push({ x, y, item: { type: "box", box } });
    width = Math.max(width, x + box.width);
  });
  return { width, height: boxes[0]?.height ?? 0, depth: y + (boxes.at(-1)?.depth ?? 0), items, source };
}

function lineWidth(line: RowEntry[]): number {
  return line.reduce((width, entry, i) => width + (i === 0 ? 0 : entry.space) + entry.box.width, 0);
}

/**
 * Where continuation lines start. Aligned to the first relation, a broken equation reads
 * as a column of operators under the `=`; a fixed indent is the fallback when there is
 * no relation or aligning would leave too little room.
 */
function continuationIndent(entries: RowEntry[], c: LayoutContext, maxWidth: number): number {
  const { indent, mode } = c.exp.lineBreak;
  const fallback = em(c, typeof indent === "number" ? indent : 1);
  if (indent !== "relation") return fallback;
  let x = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    x += i === 0 ? 0 : entry.space;
    if (entry.cls === "rel") {
      const aligned = mode === "before-operator" ? x : x + entry.box.width + (entries[i + 1]?.space ?? 0);
      return aligned < maxWidth * 0.6 ? aligned : fallback;
    }
    x += entry.box.width;
  }
  return fallback;
}
