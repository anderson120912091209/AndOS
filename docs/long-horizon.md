# Long tasks and real outputs: what Grok Bot does, and what Relay needs

The question is how Grok Bot keeps going on long, many-step jobs and produces slides, animations and apps, not
just text, while Relay's agent stalls.

**The short answer is the harness, not the model.** Grok Bot runs on Cursor's agent stack. That stack plans,
splits work across sub-agents, survives failures, summarizes in the background, saves what worked as skills,
and gives the model output formats the app renders. Relay's agent is a single model loop with a 12-step cap
that ends the first time it needs anything.

Sources:
- REA on Grok Bot 0.75.8 (`app.asar` sha256 7d6fe1a4…, evidence `ev_a4ee6cc5…`): tool names, data shapes, config
  defaults and renderer modules only. No prompts or code were taken.
- Grok Bot's public docs: [overview](https://docs.x.ai/grok-bot/overview),
  [skills & routines](https://docs.x.ai/grok-bot/skills-routines-and-automations),
  [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101), and a third-party
  [deep dive](https://flaviocopes.com/grok-bot/).

## What Grok Bot has (observed)

| Mechanism | Evidence | What it buys |
|---|---|---|
| **155 tools** | The agent's tool catalog: Shell, **AwaitShell**, Computer, WebFetch, plus mail, calendar, Slack, iMessage, meetings (JoinMeeting, RespondInMeeting), phone calls, purchases (RequestVirtualCard), MCP and plugins, mobile (iOS/Android) | It rarely meets a task it has no tool for. Long commands run in the background (AwaitShell). |
| **A visible task list** | Tools CreateTask / ReadTask / UpdateTask / UpdateState. `GrokBotTask {title, state, note, done_at}`. `KeepGrokBotTaskList {is_awaiting_user, has_background_work, turn_end, finished_work}` | The plan lives outside the model's memory and is reconciled every turn. You see progress. |
| **Sub-agents** with their own context | Tools CheckSubagent / MessageSubagent / StopSubagent / WakeParent. `SubagentStart {task, subagent_model, is_parallel_worker}`, `SubagentStop {summary, tool_call_count, modified_files}`, `SubagentAwait {timeout_ms}` (complete or still_running, plus a transcript_path). `CustomSubagent {tools, model, prompt, is_background}`. Config `local_subagent_limits.maxRunning = 32` | Big jobs split into chunks, each in a fresh context, in parallel or in the background. The parent only reads summaries, so its context stays small. |
| **Delegation to a coding harness** | Tool CloudAgent, `GrokBotCloudAgentWatcher {durable, wakes}`. Docs: the bot "prepares a clean task for a new coding agent" (Cursor Cloud Agents) | Building things (apps, decks-as-code, animations) goes to a harness built for long builds, and the bot is woken when it's done. |
| **Outputs the app renders** | Tools Visualize / EditCanvas / WriteCanvasAsset / WriteDocument / SaveToLibrary. A canvas is `{render_bundle_gzip, data_json, assets}`, and `CanvasDiagnostics {diagnostics, save_state}` reports errors back. The renderer ships a presentation view, a **three.js runtime (679 KB)**, a d3 runtime, about 25 Mermaid diagram types, documents, PDF and XLSX. MCP Apps (`html, meta_json`) | The model writes structured content or small programs against runtimes that are already there. When it breaks, the compile diagnostics go back to it, so it fixes and retries. That's how slides and animations work reliably. |
| **Asking you without ending the job** | Tools RequestUserForm / SendToUser / Offer*. `SubmitUserForm {values, save_to_vault}`. `PlanChoice {label, description}`. `TurnFinished {awaiting_user_response}` | It pauses mid-task for a form or a choice, then carries on in the same conversation. |
| **Durability** | `TranscriptWatchTurnFailed {code, summary}`. A stall watchdog (`nal_stall_detector`: 20 s advisory, 30 s fail). Retry config. `maxTurns: null` (no fixed cap). Loop detection (exists, off by default). The dune-reliability outbox | Turns run on the server and box, so a closed laptop changes nothing. Stalls are caught and retried, and nothing is capped at a small step count. |
| **Context management** | `client_speculative_summarization_config` (70% ± 5%). ReadTranscript / SearchTranscripts | Long runs never hit the wall, and old detail is still searchable. |
| **Skills** | Tools Skill / UpdateSkill / **ProposeSkills**. Docs: a skill records *when to use it, inputs and access, the steps, how to validate, what to return, what needs approval*. Workflow: one-time task → corrected → saved skill → routine | A job that worked once becomes a recipe. Next time it's reliable instead of improvised. |
| **A review agent** | Docs: "a separate review agent checks proposed actions and can allow, block, or escalate to you". Transcript entry kind `auto-review-approval` | Autonomy without every step needing you. |

## What Relay's agent has today (`apps/worker/src/claude.ts`)

- **A hard step cap:** 12 steps, or 80 with the computer, then it fails with "stopped after N steps".
- **One loop per job.** Any pause (a proposal, a sign-in, a question) *ends* the run, and nothing resumes it.
  After a sign-in it starts over.
- **"Don't stop to ask questions"** is in the prompt, because it can't ask and come back.
- **`max_tokens` 16000 and no streaming.** A long document or file written through a tool fails with "the answer
  ran out of room".
- **`effort: 'medium'`**, Opus 5.5's default. Anthropic recommends `high`/`xhigh` for long agentic work.
- **Everything in one context.** There are no sub-agents and no compaction yet, so screenshots and file reads
  pile up.
- **No plan, no skills, no review agent.**
- **No way to hand you a file.** A deck the agent builds on the box stays on the box. Answers render as text,
  lists or cards (denver-15's shaped answers), with nothing interactive.
- **A worker restart kills the run** (orphaned tasks).

## The plan, in order of impact, on Anthropic's primitives

1. **Durable runs.** This is the memory phase already agreed in `docs/box-and-memory.md` §4.
   - A conversation log per task, with resume jobs for approvals, sign-ins and orphaned runs.
   - Streaming, with `max_tokens` ~64K and `eager_input_streaming` on client tools.
   - Retries plus a stall watchdog.
   - Replace the 12/80 step cap with a **task budget** (`task-budgets-2026-03-13`), a generous safety ceiling,
     and loop detection.
   - Effort `high` for agent runs.
   - Background compaction (`compact-2026-09-04`).
2. **Plan + ask.**
   - An `update_plan` tool (a task list the notch shows live, reconciled every turn).
   - An `ask_user` tool (a question or form card in the notch; your answer resumes the same conversation).
     Remove "don't ask questions" from the prompt.
3. **Hand you real files.** *(box half built 2026-10-25, relay-browser:next)*
   - ✅ The box toolkit is installed: python-pptx, python-docx, openpyxl, matplotlib, reportlab, pillow, ffmpeg,
     pandoc, poppler. Verified live: the box made a real .pptx, a chart PNG and an MP4.
   - ✅ boxd `/files/read` hands a finished file's bytes out (≤25 MB, workspace-confined, straight to the server,
     never into the model's context). Delivery round-trip verified byte-for-byte.
   - TODO (worker, when the user isn't testing): a `deliver_file` tool (box → server → a notch file card:
     Open / Save / Show in Finder). Server artifact route + the Mac card are denver-56's lane.
4. **Sub-agents.** A `delegate` tool runs a sub-loop in a fresh context, with the box tools and a brief. It returns
   a summary and its files, and several can run in parallel. The parent's context stays small, so long jobs
   finish. This is our own harness, like Grok Bot's SubagentStart/Await.
5. **Skills.**
   - SKILL.md recipes in Grok Bot's six-part shape, kept per user on the box. Only each skill's description sits
     in context, and the model reads the full file when it's relevant.
   - After a run that worked, it proposes "save this as a skill?" in the notch.
   - Routines (scheduled runs) come later.
6. **Interactive outputs.** A `visualize` tool: the agent writes an HTML/JS page (with three.js, d3 and chart
   libraries available offline on the box). It checks the page itself by opening it on the box's screen and
   screenshotting, the same feedback loop as Grok Bot's canvas diagnostics. Relay shows it in the notch reader
   or its own window.
7. **A review agent** for risky actions: `allowOnScreen()` plus a small reviewer model that allows, blocks or
   asks you.
8. **Later:** hand big *build* jobs to a dedicated long-build harness, the way Grok Bot uses Cursor Cloud Agents.
   Options are Anthropic Managed Agents (hosted sandbox, multi-agent, rubric-graded "outcomes") or the Claude Agent
   SDK in its own sandbox with a scoped key. Never give the box your main credentials.
