// Small things main.ts leans on: a log file you can send when something's wrong, settings that
// survive a restart, and Relay's dictation cleanup — the very code the Mac app bundles
// (apps/mac/scripts/scribe-entry.ts), so both write the same text from the same words.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dictate } from '../../mac/scripts/scribe-entry.js';
import type { ModelId } from './models.js';
import type { Script } from './whisper.js';

export class Log {
  readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'relay.log');
  }

  line(text: string): void {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    try {
      // Keep it small enough to send: past 2 MB, the old half moves aside.
      if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > 2_000_000) {
        renameSync(this.file, `${this.file}.old`);
      }
      appendFileSync(this.file, `${stamp}  ${text}\n`);
    } catch {
      /* a log that can't be written mustn't stop dictation */
    }
    if (!process.env.RELAY_QUIET) console.log(text);
  }
}

export interface Settings {
  model: ModelId;
  /** Hindi in English letters (Hinglish, the default) or in Devanagari */
  script: Script;
  /** the first-run "hold Ctrl + Win and talk" has been shown */
  welcomed: boolean;
}

const DEFAULTS: Settings = { model: 'fast', script: 'latin', welcomed: false };

export class SettingsFile {
  private readonly file: string;
  value: Settings;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
    try {
      this.value = { ...DEFAULTS, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>) };
    } catch {
      this.value = { ...DEFAULTS };
    }
  }

  update(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    } catch {
      /* best effort */
    }
  }
}

/** What Whisper heard, cleaned up the way Relay always does — punctuation kept, fillers gone. */
export function clean(heard: string): string {
  // Whisper punctuates on its own, so "period" stays a word, not a full stop.
  return dictate(heard, { punctuated: true });
}
