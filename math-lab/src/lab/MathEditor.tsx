import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { flatten, typeset, type Experience, type Measurer } from "../engine";
import { toLatex } from "../engine/latex";
import {
  acceptSuggestion,
  backspace,
  deleteForward,
  displayTree,
  insertLatex,
  jumpToSlot,
  keepLetters,
  moveLeft,
  moveRight,
  moveToRowEdge,
  moveVertically,
  setCursor,
  typeText,
} from "../editor/commands";
import { caretFor, cursorAt } from "../editor/geometry";
import type { EditorState } from "../editor/model";
import { suggest } from "../editor/suggest";
import { BoxOutlines, Paint, viewBoxFor } from "./MathView";
import { SuggestionList } from "./SuggestionList";

interface Props {
  state: EditorState;
  onChange: (next: EditorState) => void;
  onUndo: () => void;
  onRedo: () => void;
  experience: Experience;
  measurer: Measurer;
  fontSizePx: number;
  display: boolean;
  showBoxes: boolean;
}

/**
 * A structural math editor. Keystrokes go to a hidden textarea (so any keyboard layout and
 * the clipboard work), become commands on the editor state, and the result is laid out by
 * the engine and drawn as SVG with a caret on top.
 */
export function MathEditor({ state, onChange, onUndo, onRedo, experience, measurer, fontSizePx, display, showBoxes }: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const shown = useMemo(() => displayTree(state), [state]);
  const scene = useMemo(
    () => flatten(typeset(shown.root, { experience, measurer, fontSizePx, display })),
    [shown, experience, measurer, fontSizePx, display],
  );
  const caret = caretFor(shown.root, shown.cursor, scene, fontSizePx);
  const viewBox = viewBoxFor(scene, fontSizePx);

  const suggestions = useMemo(() => (state.pending.trim().length >= 2 ? suggest(state.pending) : []), [state.pending]);
  const popupOpen = focused && suggestions.length > 0 && dismissedFor !== state.pending;
  const anchor = shown.pendingIds[0] ? scene.regions.find((region) => region.id === shown.pendingIds[0]) : undefined;
  useEffect(() => setHighlight(0), [state.pending]);
  useEffect(() => inputRef.current?.focus(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (modifier || event.altKey) return; // copy and paste arrive as their own events

    if (popupOpen) {
      const pick = suggestions[highlight];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && pick) {
        event.preventDefault();
        onChange(acceptSuggestion(state, pick.entry));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedFor(state.pending);
        return;
      }
    }

    const commands: Record<string, () => EditorState> = {
      ArrowLeft: () => moveLeft(state),
      ArrowRight: () => moveRight(state),
      ArrowUp: () => moveVertically(state, "up"),
      ArrowDown: () => moveVertically(state, "down"),
      Home: () => moveToRowEdge(state, "start"),
      End: () => moveToRowEdge(state, "end"),
      Backspace: () => backspace(state),
      Delete: () => deleteForward(state),
      Tab: () => jumpToSlot(state, event.shiftKey ? "previous" : "next"),
      Enter: () => setCursor(state, state.cursor),
      Escape: () => keepLetters(state),
    };
    const command = commands[event.key];
    if (command) {
      event.preventDefault();
      onChange(command());
    }
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const text = event.currentTarget.value;
    event.currentTarget.value = "";
    if (text) onChange(typeText(state, text));
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    onChange(/[\\^_{}]/.test(text) ? insertLatex(state, text) : typeText(state, text));
  };

  const onCopy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    event.clipboardData.setData("text/plain", toLatex(state.root));
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    const matrix = svgRef.current?.getScreenCTM();
    if (matrix) {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      onChange(setCursor(state, cursorAt(state.root, scene, point.x, point.y)));
    }
    inputRef.current?.focus();
  };

  const caretWidth = Math.max(1.5, fontSizePx / 22);
  const empty = state.root.children.length === 0 && !state.pending;

  return (
    <div className={focused ? "math-editor focused" : "math-editor"} onMouseDown={() => inputRef.current?.focus()}>
      <div className="editor-scroll">
        <svg
          ref={svgRef}
          width={viewBox.width}
          height={viewBox.height}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          onPointerDown={onPointerDown}
        >
          {showBoxes && <BoxOutlines regions={scene.regions} fontSizePx={fontSizePx} />}
          {scene.items.map((item, i) => (
            <Paint key={i} item={item} />
          ))}
          {focused && caret && (
            <rect
              key={`${state.cursor.row}:${state.cursor.index}:${state.pending}`}
              className="caret"
              x={caret.x - caretWidth / 2}
              y={caret.top}
              width={caretWidth}
              height={caret.bottom - caret.top}
              rx={caretWidth / 2}
            />
          )}
        </svg>
        {empty && <span className="editor-hint">Start typing: try “sqrt”, “pi”, “sum”, “alpha”, or / for a fraction</span>}
        {popupOpen && anchor && (
          <SuggestionList
            suggestions={suggestions}
            highlight={highlight}
            onHighlight={setHighlight}
            onPick={(entry) => onChange(acceptSuggestion(state, entry))}
            experience={experience}
            measurer={measurer}
            style={{ left: anchor.x - viewBox.x, top: anchor.y + anchor.depth - viewBox.y + fontSizePx * 0.3 }}
          />
        )}
      </div>
      <textarea
        ref={inputRef}
        className="editor-input"
        aria-label="Math input"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onInput={onInput}
        onPaste={onPaste}
        onCopy={onCopy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  );
}
