import "@fontsource/stix-two-text/400.css";
import "@fontsource/stix-two-text/400-italic.css";
import "@fontsource/stix-two-text/700.css";
import "@fontsource-variable/inter/wght.css";
import notoMathUrl from "@fontsource/noto-sans-math/files/noto-sans-math-latin-400-normal.woff2?url";
import stixMathUrl from "@fontsource/stix-two-math/files/stix-two-math-latin-400-normal.woff2?url";
import { useEffect, useState } from "react";

/**
 * Fontsource ships these two math fonts complete but declares them for Latin only, so a
 * browser would never reach for them to draw ∑ or √. Registering the files ourselves,
 * without a unicode-range, makes every glyph available.
 */
const MATH_FACES = [
  new FontFace("Lab STIX Two Math", `url(${stixMathUrl}) format("woff2")`),
  new FontFace("Lab Noto Sans Math", `url(${notoMathUrl}) format("woff2")`),
];
for (const face of MATH_FACES) document.fonts.add(face);

/** Covers the Latin, Greek and symbol subsets, so each one gets fetched. */
const SAMPLE = "AHxgfαΨ∑∫√(){}[]±≤∞∂∇0123456789";
const TEXT_FACES = [
  `400 32px "STIX Two Text"`,
  `italic 400 32px "STIX Two Text"`,
  `700 32px "STIX Two Text"`,
  `420 32px "Inter Variable"`,
  `500 32px "Inter Variable"`,
];

/**
 * Counts font loads. Canvas measurements taken before a font arrives describe its
 * fallback, so layout keys its measurer on this number and measures again when it changes.
 */
export function useFontEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let live = true;
    const bump = () => {
      if (live) setEpoch((n) => n + 1);
    };
    void Promise.allSettled([
      ...MATH_FACES.map((face) => face.load()),
      ...TEXT_FACES.map((font) => document.fonts.load(font, SAMPLE)),
    ]).then(bump);
    document.fonts.addEventListener("loadingdone", bump);
    return () => {
      live = false;
      document.fonts.removeEventListener("loadingdone", bump);
    };
  }, []);
  return epoch;
}
