// The dictation edition's cleanup, checked where it actually runs: scribe.js in the JavaScript
// engine macOS ships (JavaScriptCore), against the server's own TypeScript for the same words.
// The test suite runs it on a fresh bundle; scripts/release.sh runs it on the shipped one:
//   tsx scripts/scribe-check.ts dist/Relay.app/Contents/Resources/scribe.js
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { dictate } from './scribe-entry.js';

export const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';

/** What people say, and where: plain speech, a wake word, Chinese, an email, a one-line field, a chat. */
export const PHRASES: [string, Record<string, unknown>][] = [
  ['um so I think we should ship it period new paragraph thanks everyone', { punctuated: true }],
  ['Relay, write this down comma please', { punctuated: true }],
  ['我們明天開會。換行 記得帶電腦。', { punctuated: true, target: { bundleId: 'com.apple.Notes', role: 'AXTextArea' } }],
  ["hi Sam, thanks for the notes. I'll send the deck tomorrow. best, Anderson.", { punctuated: true, target: { bundleId: 'com.apple.mail', role: 'AXTextArea' } }],
  ['quarterly report draft.', { punctuated: true, target: { bundleId: 'com.apple.mail', role: 'AXTextField', label: 'Subject' } }],
  ['sounds good, see you at 3.', { punctuated: true, target: { bundleId: 'com.tinyspeck.slackmacgap', role: 'AXTextArea' } }],
  ['', { punctuated: true }],
];

/** scribe.js exactly as build.sh makes it (the same esbuild options). */
export function bundleScribe(): string {
  const out = buildSync({
    entryPoints: [new URL('./scribe-entry.ts', import.meta.url).pathname],
    bundle: true,
    format: 'iife',
    globalName: 'RelayScribe',
    target: 'safari16',
    write: false,
    logLevel: 'warning',
  });
  return out.outputFiles[0]!.text;
}

/** Each phrase as the app would paste it (the bundle in JavaScriptCore), and as the server would. */
export function compare(bundle: string): { got: string[]; want: string[] } {
  const run = `${bundle};\nprint(JSON.stringify(${JSON.stringify(PHRASES)}.map(function (p) { return RelayScribe.dictate(p[0], p[1]); })));`;
  const got = JSON.parse(execFileSync(JSC, ['-e', run], { encoding: 'utf8' })) as string[];
  return { got, want: PHRASES.map(([text, context]) => dictate(text, context)) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const file = process.argv[2];
  if (!file || !existsSync(file)) throw new Error('usage: tsx scripts/scribe-check.ts <path to scribe.js>');
  const { got, want } = compare(readFileSync(file, 'utf8'));
  const wrong = want.flatMap((w, i) => (got[i] === w ? [] : [`  “${PHRASES[i]![0]}”\n    server: ${JSON.stringify(w)}\n    app:    ${JSON.stringify(got[i])}`]));
  if (wrong.length) {
    console.error(`✗ scribe.js writes differently from the server:\n${wrong.join('\n')}`);
    process.exit(1);
  }
  console.log(`  scribe.js writes exactly what the server does (${PHRASES.length} phrases, in JavaScriptCore)`);
}
