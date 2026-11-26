# Our Bots: Grok-Bot-style agents on your own Claude and ChatGPT plans

**A bot is an engine you already pay for, plus Relay's body.**
- **The engine:** Claude Code on your Claude plan, or Codex on your ChatGPT plan.
- **The body:** the box, the notch, approvals and memory.

Relay doesn't rebuild a harness. It runs the best ones, the way Conductor does, and gives them hands that only
work in the box.

Grok Bot's reliability on long jobs comes from its harness (`docs/long-horizon.md`). Claude Code and Codex now
ship most of that harness themselves: compaction, sub-agents, a task list, skills, resumable sessions, and a
reviewer for permissions. What they don't have is what Grok Bot adds on top:
- a remote computer
- outputs the app renders
- asking you mid-task
- memory across conversations
- an app

That part is Relay's.

## What the others do (observed facts only)

| Product | Harness | How it uses your plan | Body |
|---|---|---|---|
| **Grok Bot** (REA, `docs/long-horizon.md`) | Cursor's agent stack: server-owned transcript, speculative summarization, 155 tools, sub-agents, canvas | n/a (xAI models) | hibernating cloud box |
| **Conductor** (this session's own process, `ps`) | the official CLIs, version-pinned in `~/Library/Application Support/com.conductor.app/agent-binaries/` (claude 2.1.284, codex 0.157.1) | the CLI's own login | git worktrees on your Mac |
| **Codync** ([github.com/leepokai/Codync](https://github.com/leepokai/Codync), Apache-2.0, read from source) | an ACP client: `claude-agent-acp` wraps the Agent SDK, `codex-acp` wraps app-server. Compaction at 75% or 200K with a keep-list; `MEMORY.md` per bot; a `team` MCP server between bots | the CLIs' logins; "never calls a provider's API with your login" | your own machine |
| **Reason** ([reasonmachines.com](https://reasonmachines.com), closed; public docs only) | "built on Pi": a `codemode` tool, tools loaded on demand, a stable prompt for caching | "connected subscriptions"; mechanism unconfirmed | a cloud computer per session (Blaxel) |

Conductor's launch of Claude Code is the reference shape:
```
claude --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio
       --disallowedTools AskUserQuestion --plugin-dir …/conductor-skill --max-turns 1000 --effort max --resume …
```
- **stream-json in and out:** one long-lived process per conversation.
- **`--permission-prompt-tool stdio`:** approvals arrive over the SDK control channel, which is how the app shows
  them.
- **`--disallowedTools AskUserQuestion`:** Conductor's own `mcp__conductor__AskUserQuestion` replaces it, so the
  question renders in Conductor's UI.

## What's built (2026-10-25, worker)

| File | What it does |
|---|---|
| `apps/worker/src/toolbox.ts` | One job's tools and the approval line in front of them. Holds the API agent's own tools (finish, drafts, browser, mail) with their schemas unchanged. Holds the box's `bash`, `str_replace_based_edit_tool` and `computer`, with the trained input shapes, carried out by the same `Workstation`. A call that ends the run (finish, send_email…) is never carried out: it becomes the job's Outcome, and the engine is stopped. |
| `apps/worker/src/claude-code.ts` | `ClaudeCodeDriver` (`RELAY_DRIVER=claude-code`). Runs the Agent SDK's bundled Claude Code runtime on your claude.ai login. The toolbox is an in-process MCP server, and every call passes `canUseTool` first. |
| `apps/worker/src/codex.ts` | `CodexDriver` (`RELAY_DRIVER=codex`). Runs `codex app-server` on your ChatGPT login. The toolbox is handed over as the thread's `dynamicTools`, and Codex calls each one back over the same pipe (`item/tool/call`). |
| `apps/worker/src/claude.ts` | Exports its prompts and tool functions for the engines. Behaviour is unchanged. |
| `packages/shared/src/policy.ts` | Adds the engine's own bookkeeping tools (task list, helper agents) as `auto`. |

**Verified live on your Claude Max plan, with real boxd:**
- A request in Chinese: it counted folders on the box, wrote `summary.md`, and returned a shaped notch answer
  (9 s).
- It found the mouse position through the `computer` tool (7 s).
- It drafted an email and stopped at the Send card (6 s).
- In spikes:
  - a plan
  - a helper agent working in the box in parallel
  - pausing mid-task on an `ask_user` tool, then carrying on
  - resuming a session by id
  - the plan's rate-limit window reported (`five_hour` 30%)

**Verified live on Codex:**
- A spike ran `uname -r` in the box through Relay's MCP tool, on your ChatGPT login.
- The driver's plumbing works against the real app server: the switch-off flags, the handshake, and the
  signed-out message.
- A full run needs Relay's own Codex sign-in (below).

**Tests:** 212 pass, including the scripted engines in `claude-code.test.ts` and `codex.test.ts`.

## Safety rules (each one is enforced in code)

1. **Only the official runtime, unmodified.**
   - Relay never reads, copies, stores or proxies the engines' tokens.
   - You sign in to Claude Code or Codex itself.
2. **No API key reaches an engine,** so nothing is charged to API credit (`engineEnv`, `codexEnv`).
3. **No hands on the Mac.**
   - Claude Code gets no built-in tools except `Agent`, `TaskCreate/Update/Get/List` and `WebSearch`.
     `toolAliases` sends a stray `Bash` to the box.
   - Codex has its shell, `unified_exec`, `view_image`, computer use, browser use, apps, plugins, hooks and
     memories switched off. It also gets a read-only sandbox and `approvalPolicy: never`, and every approval it
     asks for is declined. Codex keeps `apply_patch` and won't let it be removed.
   - Both run in an empty scratch folder (`~/.relay/engine`).
4. **None of your own setup comes along.**
   - Claude Code: `settingSources: []` and `strictMcpConfig`, so none of your hooks, plugins or CLAUDE.md.
   - Codex: its own `CODEX_HOME` (`~/.relay/codex`). This matters: your `~/.codex` loads `computer-use`,
     `node_repl`, `cua_repl`, `rea` and more, and an override can't switch them off.
5. **The same approval line for every engine** (`policy.ts`). Sending or scheduling is a notch card; nothing is
   sent by the bot.

## What the rules allow (as of 2026-10-25)

### Anthropic
- **Personal use is allowed today.**
  - Help Center, Oct 7 2026: "You can still use the Claude Agent SDK, claude -p, and third-party apps with your
    subscription limits."
  - The Legal page: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
    their own Claude subscription, including where a platform hosts Claude Code".
- **The conditions:**
  - the binary must not be modified
  - customers may not "pay for, resell, or intermediate Claude usage"
  - developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"
  - running Claude Code in your product requires the Commercial Terms
- **The limits assume "ordinary, individual usage".** Weekly limits target 24/7 background use.
- **For a product,** the Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products, including agents built on the Claude
  Agent SDK."
- **It has moved four times this year:**
  - January: the anti-spoofing crackdown
  - April: OpenClaw cut off
  - May: a separate Agent SDK credit announced
  - June: that change paused

Sources: code.claude.com/docs/en/legal-and-compliance, code.claude.com/docs/en/agent-sdk/overview, and the
support article "Use the Claude Agent SDK with your Claude plan".

### OpenAI
- **"Sign in with ChatGPT" plan usage covers open-source and locally hosted apps.** "If you're interested in
  offering it in a paid or remotely hosted app, complete the interest form"
  (developers.openai.com/siwc/token-sharing-open-source).
- **OpenAI recommends app-server for apps:** "a deep integration inside your own product: authentication,
  conversation history, approvals, and streamed agent events."

### What this means for Relay
- Running Relay on your own Mac with your own plans is fine.
- Shipping it to other people needs Anthropic's approval and OpenAI's form first.
- Keep the API-key path working. Never run a fleet of bots around the clock on a plan.

## How to turn it on

**Claude:**
1. Check the sign-in: `claude auth status` should show `"subscriptionType": "max"` (yours does).
2. Start the worker with `RELAY_DRIVER=claude-code`.
3. `RELAY_ENGINE_MODEL` overrides the model (default `opus`).

**Codex:**
1. Repair the CLI. The npm-global copy is missing its binary: run
   `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, or point `RELAY_CODEX_BIN` at a working binary.
2. Sign Relay in once: `CODEX_HOME=~/.relay/codex codex login`.
3. Start the worker with `RELAY_DRIVER=codex`.

**Debugging a run:** each run's session id is in its first step's `data.session`. To watch it in Claude Code,
run `claude --resume <id>` from `~/.relay/engine`.

## Next, in order

1. **Our Bots in the app** (Mac app and server; denver-56's lane):
   - pick an engine per bot, read per job the way the Claude key is today
   - status: `claude auth status --json` for the plan, and Codex `account/rateLimits/read` for usage %
   - the Codex sign-in inside Relay (`account/login/start` with `chatgptDeviceCode`, the code shown in the notch)
2. **Conversations:**
   - One live engine session per conversation: stream-json input for Claude Code, a thread for Codex.
   - Resume by id after a restart.
   - A follow-up continues the same session. That is Grok Bot's "transcript ≠ context", already provided by the
     engine.
3. **`ask_user` as a toolbox tool:**
   - The call simply waits until you answer in the notch. Both engines allow a tool to wait.
   - Codex also has `item/tool/requestUserInput`.
   - Then remove "don't stop to ask questions" from the prompt.
4. **`deliver_file` through the toolbox:** box → server → a notch file card (`docs/box-and-memory.md` §5).
5. **One plan view:** Claude Code's `TaskCreate`/`TaskUpdate` and Codex's `turn/plan/updated` feed the same live
   plan in the notch.
6. **The app window:** type a prompt, pick a bot, watch steps and plan, open files, see the box. The web
   `TaskFeed` and `VoiceHud` are the start.
7. **Later:**
   - Engines inside the box (the SDK's `spawnClaudeCodeProcess`, Codex on Linux) for work that keeps going with
     the Mac asleep.
   - ACP (Codync's route) to add more engines (Gemini, Goose…) behind one protocol.
