import type { Experience } from "../engine";

type Param =
  | { kind: "number"; path: string; label: string; min: number; max: number; step: number }
  | { kind: "choice"; path: string; label: string; options: string[] }
  | { kind: "toggle"; path: string; label: string };

const number = (path: string, label: string, min: number, max: number, step = 0.01): Param => ({
  kind: "number",
  path,
  label,
  min,
  max,
  step,
});
const choice = (path: string, label: string, options: string[]): Param => ({ kind: "choice", path, label, options });
const toggle = (path: string, label: string): Param => ({ kind: "toggle", path, label });

/** The knobs worth turning. Lengths are in em, so they hold at every size. */
const GROUPS: { title: string; params: Param[] }[] = [
  {
    title: "Scripts",
    params: [
      choice("scripts.mode", "Placement", ["shifted", "centered"]),
      number("scale.script", "Script size", 0.4, 1),
      number("scale.scriptScript", "Second-level size", 0.3, 1),
      number("scripts.supShift", "Superscript raise", 0, 1),
      number("scripts.subShift", "Subscript drop", 0, 0.8),
      number("scripts.gap", "Gap", 0, 0.5),
    ],
  },
  {
    title: "Spacing",
    params: [
      choice("spacing.mode", "Rule", ["tex", "uniform"]),
      number("spacing.scale", "TeX space scale", 0, 3, 0.05),
      number("spacing.uniformGap", "Uniform gap", 0, 0.6),
      number("spacing.operatorGap", "Around operators", 0, 1),
      number("spacing.relationGap", "Around relations", 0, 1),
    ],
  },
  {
    title: "Chips",
    params: [
      toggle("chips.enabled", "Draw symbols as chips"),
      toggle("chips.centerInk", "Centre each glyph's ink"),
      number("chips.padX", "Horizontal padding", 0, 0.5),
      number("chips.padY", "Vertical padding", 0, 0.5),
      number("chips.radius", "Corner radius", 0, 0.6),
      number("chips.minSize", "Minimum size", 0, 2),
    ],
  },
  {
    title: "Fractions",
    params: [
      number("fraction.rule", "Bar thickness", 0.01, 0.2, 0.005),
      number("fraction.gap", "Clearance", 0, 0.5),
      number("fraction.pad", "Overhang", 0, 0.5),
      toggle("fraction.roundCaps", "Rounded bar"),
    ],
  },
  {
    title: "Radicals",
    params: [
      number("radical.stroke", "Stroke", 0.01, 0.2, 0.005),
      number("radical.gap", "Clearance", 0, 0.5),
      number("radical.slant", "Slant", 0, 0.6),
    ],
  },
  {
    title: "Delimiters",
    params: [
      choice("delimiters.mode", "Rendering", ["auto", "drawn", "font"]),
      toggle("delimiters.autoGrow", "Grow plain ( ) [ ] { }"),
      number("delimiters.stroke", "Stroke", 0.01, 0.2, 0.005),
      number("delimiters.width", "Width", 0.1, 0.8),
      number("delimiters.overshoot", "Overshoot", 0, 0.5),
    ],
  },
  {
    title: "Big operators",
    params: [number("scale.largeOp", "∑ size", 1, 2.5, 0.05), number("scale.integral", "∫ size", 1, 3, 0.05)],
  },
  {
    title: "Lines",
    params: [
      number("axisHeight", "Math axis", 0, 0.6),
      choice("lineBreak.mode", "Break", ["before-operator", "after-operator"]),
      number("lineBreak.lineGap", "Line gap", 0, 1.5, 0.05),
    ],
  },
];

function getAt(target: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], target);
}

function setAt<T>(target: T, path: string, value: unknown): T {
  const copy = structuredClone(target);
  const keys = path.split(".");
  const last = keys.pop()!;
  let cursor = copy as Record<string, unknown>;
  for (const key of keys) cursor = cursor[key] as Record<string, unknown>;
  cursor[last] = value;
  return copy;
}

interface Props {
  experience: Experience;
  onChange: (next: Experience) => void;
  onReset: () => void;
}

export function ExperienceControls({ experience, onChange, onReset }: Props) {
  const update = (path: string, value: unknown) => onChange(setAt(experience, path, value));
  return (
    <div className="controls">
      <header>
        <h2>Tune “{experience.name}”</h2>
        <button type="button" onClick={onReset}>
          Reset
        </button>
      </header>
      {GROUPS.map((group) => (
        <fieldset key={group.title}>
          <legend>{group.title}</legend>
          {group.params.map((param) => (
            <ParamInput key={param.path} param={param} value={getAt(experience, param.path)} onChange={(v) => update(param.path, v)} />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function ParamInput({ param, value, onChange }: { param: Param; value: unknown; onChange: (value: unknown) => void }) {
  switch (param.kind) {
    case "number":
      return (
        <label className="param">
          <span>{param.label}</span>
          <input
            type="range"
            min={param.min}
            max={param.max}
            step={param.step}
            value={Number(value)}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <output>{Number(value).toFixed(param.step < 0.01 ? 3 : 2)}</output>
        </label>
      );
    case "choice":
      return (
        <div className="param">
          <span>{param.label}</span>
          <div className="segmented">
            {param.options.map((option) => (
              <button
                key={option}
                type="button"
                className={option === value ? "on" : undefined}
                onClick={() => onChange(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      );
    case "toggle":
      return (
        <label className="param toggle">
          <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
          <span>{param.label}</span>
        </label>
      );
  }
}
