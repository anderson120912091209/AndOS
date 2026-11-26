// Who does the work for one job.
//
//   RELAY_DRIVER=claude-code                → Claude Code on your own Claude plan (claude-code.ts)
//   RELAY_DRIVER=codex                      → Codex on your own ChatGPT plan (codex.ts)
//                                             — both first, so a key in Connections never spends API credit
//   your Claude key (Connections → Claude)  → the real agent, with that key
//   RELAY_DRIVER=claude + a key in the env  → the real agent (servers, CI)
//   RELAY_DRIVER=simulated                  → the canned simulation (tests, demos)
//   nothing                                 → say so plainly, and do nothing
//
// Decided per job, like the other connections, so adding a key in the Mac app makes the
// very next Fn+Control request real — no restart.

import Anthropic from '@anthropic-ai/sdk';
import type { ConnectionCredential, Task } from '@relay/shared';
import { ClaudeDriver } from './claude.js';
import { ClaudeCodeDriver } from './claude-code.js';
import { CodexDriver } from './codex.js';
import type { AgentDriver, Outcome } from './driver.js';
import { SimulatedDriver } from './simulated.js';

export const NOT_CONNECTED = "Claude isn't set up yet — set it up and Relay will run this right away. Nothing was drafted or sent.";

/** No model to work with: say so, and offer the one button that fixes it. */
export class NotConnectedDriver implements AgentDriver {
  readonly name = 'not connected';

  async run(_task: Task): Promise<Outcome> {
    return { type: 'done', result: { summary: NOT_CONNECTED, setup: { connection: 'claude', label: 'Set up Claude' } } };
  }

  async revise(task: Task): Promise<Outcome> {
    return this.run(task);
  }
}

/** The Claude key, when the user connected one. Typed loosely until every server sends it. */
function claudeKey(credentials: ConnectionCredential[]): string | undefined {
  for (const c of credentials as unknown as { kind?: string; apiKey?: unknown }[]) {
    if (c.kind === 'anthropic' && typeof c.apiKey === 'string' && c.apiKey) return c.apiKey;
  }
  return undefined;
}

const simulated = new SimulatedDriver();
let fromEnv: AgentDriver | undefined;
let claudePlan: AgentDriver | undefined;
let chatgptPlan: AgentDriver | undefined;

export function driverFor(credentials: ConnectionCredential[], env: NodeJS.ProcessEnv = process.env): AgentDriver {
  if (env.RELAY_DRIVER === 'simulated') return simulated;
  if (env.RELAY_DRIVER === 'claude-code') return (claudePlan ??= new ClaudeCodeDriver());
  if (env.RELAY_DRIVER === 'codex') return (chatgptPlan ??= new CodexDriver());
  const key = claudeKey(credentials);
  if (key) return new ClaudeDriver(new Anthropic({ apiKey: key }).beta.messages);
  if (env.RELAY_DRIVER === 'claude') {
    try {
      fromEnv ??= new ClaudeDriver();
      return fromEnv;
    } catch (err) {
      console.warn(`[worker] RELAY_DRIVER=claude but no usable credentials: ${err instanceof Error ? err.message : err}`);
    }
  }
  return new NotConnectedDriver();
}
