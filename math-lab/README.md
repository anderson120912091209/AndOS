# Math Lab

A structural math editor you type in plain words (no LaTeX), on top of a layout engine whose
every typesetting rule is a live control. The same formula is set side by side by different
*experiences*.

Type `sqrt`, `pi`, `sum`, `alpha`, `union`, `matrix`… and pick from the suggestions; `/` makes
a fraction from what you just typed, `^` and `_` open scripts, brackets grow with their
contents, `<=` `->` `+-` become ≤ → ±, and Tab walks the empty slots. LaTeX is written for
you underneath, and pasted LaTeX is understood.

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # engine tests (no browser needed)
pnpm typecheck
```

Open the lab on a formula with `?latex=…`; add `&experience=classic` to edit in another
experience, `&boxes=1` to show boxes, `&size=48` to change the size.

## How it works

```
keys ─commands─▶ editor state ─┐
LaTeX ─parse─▶ math model ─────┴─layout(experience, measurer)─▶ boxes ─flatten─▶ scene ─▶ SVG
                    └─toLatex─▶ LaTeX
```

- **Editor** (`src/editor/`): a cursor that lives inside the tree, and pure commands
  (`commands.ts`) that turn keystrokes into new states, which also makes undo trivial.
  Letters being typed stay *pending* (underlined) while they could still spell a keyword;
  `suggest.ts` ranks the catalog (`catalog.ts`) against them, and `policy.ts` decides when a
  finished word becomes its symbol without asking. `geometry.ts` places the caret and maps
  clicks to cursor positions using the boxes the layout already computed.

- **Model** (`src/engine/ast.ts`): a tree of typed nodes (atom, row, frac, sqrt, scripts,
  fenced, accent, matrix…). Atoms carry a TeX spacing class (ord, bin, rel…) and a role
  (variable, number, function…), so an experience can style meaning, not just glyphs.
- **Layout** (`src/engine/layout.ts`): TeX's box model. Every node becomes a box with a width,
  a height above the baseline and a depth below it. It's a pure function: fonts come in through
  a `Measurer` (a canvas in the lab, an approximation in tests) and every visual decision comes
  from the `Experience`.
- **Stretchy marks** (`src/engine/glyphs.ts`): radicals, delimiters and accents are parametric
  SVG paths computed for the exact box they cover, instead of a font's few fixed sizes.
- **Experiences** (`src/engine/experiences/`): plain data. `classic` follows TeX, `chips` draws
  symbols as tokens with brackets that grow on their own, `airy` is a roomy screen-first sans.
  Copy one, change it, and add it to `experiences/index.ts`.
- **Spacing** (`src/engine/spacing.ts`): TeX-style experiences space atoms by class pair,
  after binary-operator demotion (the `−` in `−x` is unary); `uniform` uses one gap.
- **Line breaking** (`src/engine/linebreak.ts`): greedy, at operators, with continuation lines
  aligned under the first relation.

## Fonts

STIX Two (Text and Math), Inter and Noto Sans Math, all under the SIL Open Font License,
installed from Fontsource. The two math fonts are registered in `src/lab/fonts.ts` because
their packages declare them for Latin characters only.

## Not yet

- Selection: no shift-arrow selection, so copy takes the whole formula.
- Embedding: the editor edits one formula. A document would host it as an inline node.
- Only the top-level row wraps. Breaking inside groups and fractions is left out.
- Accents are drawn rather than taken from the font, and big operators are scaled glyphs.
