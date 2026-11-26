import { useMemo, type CSSProperties } from "react";
import { flatten, typeset, type Experience, type Measurer } from "../engine";
import type { CatalogEntry } from "../editor/catalog";
import { row } from "../editor/model";
import type { Suggestion } from "../editor/suggest";
import { Paint, viewBoxFor } from "./MathView";

interface Props {
  suggestions: Suggestion[];
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (entry: CatalogEntry) => void;
  experience: Experience;
  measurer: Measurer;
  style: CSSProperties;
}

/** The suggestion popup: each row previews what it would insert, set by the current experience. */
export function SuggestionList({ suggestions, highlight, onHighlight, onPick, experience, measurer, style }: Props) {
  return (
    // Keep focus in the editor's input while clicking a suggestion.
    <div className="suggestions" style={style} onMouseDown={(event) => event.preventDefault()}>
      {suggestions.map((suggestion, i) => (
        <button
          key={suggestion.entry.id}
          type="button"
          className={i === highlight ? "on" : undefined}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => onPick(suggestion.entry)}
        >
          <Preview entry={suggestion.entry} experience={experience} measurer={measurer} />
          <span className="label">{suggestion.entry.label}</span>
          <span className="keyword">{suggestion.keyword}</span>
        </button>
      ))}
      <footer>
        <kbd>↑</kbd>
        <kbd>↓</kbd> choose · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> keep letters
      </footer>
    </div>
  );
}

const PREVIEW_SIZE = 17;

function Preview({ entry, experience, measurer }: { entry: CatalogEntry; experience: Experience; measurer: Measurer }) {
  const scene = useMemo(
    () => flatten(typeset(row(entry.build().nodes), { experience, measurer, fontSizePx: PREVIEW_SIZE, display: false })),
    [entry, experience, measurer],
  );
  const box = viewBoxFor(scene, PREVIEW_SIZE);
  return (
    <span className="preview">
      <svg width={box.width} height={box.height} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}>
        {scene.items.map((item, i) => (
          <Paint key={i} item={item} />
        ))}
      </svg>
    </span>
  );
}
