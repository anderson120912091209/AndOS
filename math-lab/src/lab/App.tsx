import { useEffect, useMemo, useState } from "react";
import { EXPERIENCES, flatten, typeset, type Experience } from "../engine";
import { toLatex } from "../engine/latex";
import { createEditor, type EditorState } from "../editor/model";
import { createCanvasMeasurer } from "./canvasMeasurer";
import { ExperienceControls } from "./Controls";
import { useFontEpoch } from "./fonts";
import { MathEditor } from "./MathEditor";
import { MathView } from "./MathView";
import { PRESETS } from "./presets";

/** `?latex=…&boxes=1&size=48` opens the lab on a given formula, so an experiment is a link. */
const initial = new URLSearchParams(window.location.search);

interface History {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

const HISTORY_LIMIT = 300;

export function App() {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: createEditor(initial.get("latex") ?? PRESETS[0]?.latex ?? ""),
    future: [],
  }));
  const [experiences, setExperiences] = useState<Experience[]>(EXPERIENCES);
  const [editorExperienceId, setEditorExperienceId] = useState(initial.get("experience") ?? "chips");
  const [fontSize, setFontSize] = useState(Number(initial.get("size")) || 36);
  const [display, setDisplay] = useState(true);
  const [showBoxes, setShowBoxes] = useState(initial.get("boxes") === "1");
  const [copied, setCopied] = useState(false);

  const fontEpoch = useFontEpoch();
  // A fresh measurer per font load, so nothing measured against a fallback font survives.
  const measurer = useMemo(() => createCanvasMeasurer(), [fontEpoch]);
  const editor = history.present;
  const latex = useMemo(() => toLatex(editor.root), [editor.root]);

  const change = (next: EditorState) =>
    setHistory((h) => (next === h.present ? h : { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] }));
  const undo = () =>
    setHistory((h) => (h.past.length === 0 ? h : { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] }));
  const redo = () =>
    setHistory((h) => (h.future.length === 0 ? h : { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) }));

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("latex", latex);
    window.history.replaceState(null, "", url);
  }, [latex]);

  const editorExperience = experiences.find((e) => e.id === editorExperienceId) ?? experiences[0]!;
  const others = useMemo(() => experiences.filter((e) => e.id !== editorExperience.id), [experiences, editorExperience.id]);
  const comparisons = useMemo(
    () =>
      others.map((experience) => ({
        experience,
        scene: flatten(typeset(editor.root, { experience, measurer, fontSizePx: Math.round(fontSize * 0.8), display })),
      })),
    [others, editor.root, measurer, fontSize, display],
  );

  const replaceExperience = (next: Experience) =>
    setExperiences((all) => all.map((experience) => (experience.id === next.id ? next : experience)));
  const resetExperience = (id: string) => {
    const original = EXPERIENCES.find((experience) => experience.id === id);
    if (original) replaceExperience(original);
  };
  const copyLatex = async () => {
    await navigator.clipboard.writeText(latex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="lab">
      <header className="topbar">
        <div className="title">
          <h1>Math Lab</h1>
          <p>Type math in plain words. No LaTeX needed: it is written for you.</p>
        </div>
        <div className="globals">
          <label>
            Size <input type="range" min={18} max={72} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
            <output>{fontSize}px</output>
          </label>
          <div className="segmented">
            <button type="button" className={display ? "on" : undefined} onClick={() => setDisplay(true)}>
              Display
            </button>
            <button type="button" className={display ? undefined : "on"} onClick={() => setDisplay(false)}>
              Inline
            </button>
          </div>
          <label>
            <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} /> Boxes
          </label>
        </div>
      </header>

      <aside className="source">
        <h3>How to type</h3>
        <dl className="keys">
          <dt>words</dt>
          <dd>sqrt, pi, sum, int, lim, alpha, infinity, union, matrix, cases… then Enter</dd>
          <dt>/</dt>
          <dd>fraction over what you just typed</dd>
          <dt>^ _</dt>
          <dd>superscript, subscript (space leaves them)</dd>
          <dt>( [ {'{'} |</dt>
          <dd>brackets that grow with their contents</dd>
          <dt>{'<= >= != -> => +-'}</dt>
          <dd>≤ ≥ ≠ → ⇒ ±</dd>
          <dt>Tab</dt>
          <dd>next empty slot</dd>
          <dt>⌘Z ⌘C ⌘V</dt>
          <dd>undo, copy as LaTeX, paste LaTeX</dd>
        </dl>
        <h3>Start from</h3>
        <ul className="presets">
          {PRESETS.map((preset) => (
            <li key={preset.name}>
              <button type="button" onClick={() => change(createEditor(preset.latex))}>
                {preset.name}
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => change(createEditor())}>
              Empty
            </button>
          </li>
        </ul>
      </aside>

      <main className="panes">
        <section className="pane active editor-pane">
          <header>
            <h2>Editor</h2>
            <div className="segmented">
              {experiences.map((experience) => (
                <button
                  key={experience.id}
                  type="button"
                  className={experience.id === editorExperience.id ? "on" : undefined}
                  onClick={() => setEditorExperienceId(experience.id)}
                >
                  {experience.name}
                </button>
              ))}
            </div>
          </header>
          <MathEditor
            state={editor}
            onChange={change}
            onUndo={undo}
            onRedo={redo}
            experience={editorExperience}
            measurer={measurer}
            fontSizePx={fontSize}
            display={display}
            showBoxes={showBoxes}
          />
          <div className="latex-out">
            <code>{latex || " "}</code>
            <button type="button" onClick={copyLatex} disabled={!latex}>
              {copied ? "Copied" : "Copy LaTeX"}
            </button>
          </div>
        </section>

        <h3 className="section-title">The same formula, other experiences</h3>
        {comparisons.map(({ experience, scene }) => (
          <section key={experience.id} className="pane" onClick={() => setEditorExperienceId(experience.id)}>
            <header>
              <h2>{experience.name}</h2>
              <p>{experience.blurb}</p>
            </header>
            <MathView scene={scene} background={experience.colors.background} fontSizePx={Math.round(fontSize * 0.8)} showBoxes={showBoxes} />
          </section>
        ))}
      </main>

      <aside className="tuning">
        <ExperienceControls
          experience={editorExperience}
          onChange={replaceExperience}
          onReset={() => resetExperience(editorExperience.id)}
        />
      </aside>
    </div>
  );
}
