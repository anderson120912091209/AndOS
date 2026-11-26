// Relay's dictation cleanup for the Mac app to run on its own, with no server. It's the server's
// very code path for a held Fn — routeIntent pinned to dictation (apps/server/src/index.ts) —
// which build.sh bundles into the dictation edition as scribe.js, and LocalScribe.swift runs in
// JavaScriptCore. One copy of the code, so the download writes exactly what the dev setup pastes.
import { routeIntent } from '../../../packages/shared/src/intent.js';
import type { ScreenContext } from '../../../packages/shared/src/task.js';

export function dictate(utterance: string, context: ScreenContext = {}): string {
  return routeIntent(utterance, context, { classify: () => 'dictation' }).cleanedText ?? '';
}
