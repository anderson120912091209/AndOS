import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JSC, bundleScribe, compare } from './scribe-check.js';

describe("the download's dictation", () => {
  // JavaScriptCore's shell comes with macOS; elsewhere there's no engine to check against.
  it.skipIf(!existsSync(JSC))("writes exactly what the server pastes, in the Mac's own JavaScript engine", () => {
    const { got, want } = compare(bundleScribe());
    expect(got).toEqual(want);
  });
});
