# How Grok Bot does real jobs, and what Piko should build

REA pass 3, 2026-10-26. This pass picks up where the denver notes stop (`RE-NOTES.md`,
`docs/long-horizon.md`, `.context/grokbot/FINDINGS.md`). Those covered the box, takeover, memory and the
long-task tricks. This pass asks one question: **what turns a chat model into something that finishes
real-world jobs?**

## Boundary

The pass records observable architecture only:
- tool **names**;
- protocol message, field and enum **names**;
- RPC method **names**;
- the vendor's public docs.

It does not read or reproduce application logic, prompts or endpoints. The extracted bundle copy was deleted
after the pass. Piko is an original implementation.

## Sources

- **Grok Bot 0.75.8**, `app.asar` sha256 `7d6fe1a4…` (the same build as the denver long-horizon pass).
  - REA `extract-artifact`, evidence `ev_8e0c1641…`.
  - 1040 files inventoried.
  - From the protocol module: 287 messages, 111 enums and 496 RPC methods, read as names only.
- **Public docs:** [overview](https://docs.x.ai/grok-bot/overview) and
  [skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations).

## 1. The harness is a durable loop that runs off the box

- `GrokBotAgentHarnessKind` has two values: **`BOX`** and **`TEMPORAL`**.
- The client also carries `temporal_harness_mode`, `supportsTemporalHarness`, `createGrokBotTemporalAgent`,
  `restoreTemporalAgentRouting`, and a `GrokBotBoxHarnessMigrationPass`.
- **Reading (inferred, server side not visible):**
  - Grok Bot is moving the agent loop *out* of the box and onto **durable workflows**, very likely
    [Temporal](https://temporal.io) (MIT).
  - On a durable workflow, the loop survives crashes, deploys and a closed laptop.
  - It can wait days for an approval, and it wakes on timers or signals.
  - The box becomes the hands only.
- **Durability shapes:**
  - `GrokBotTurnSettlement {turn_id, outcome, settled_at_ms}`.
  - `GrokBotCloudAgentWatcher {agent_id, kind: LAUNCH|REPLY|WATCH, durable, registered_at_ms, wakes}` is a
    registration that wakes the bot when something it delegated replies.

## 2. The task lifecycle

**Shapes:**
- `GrokBotTask {id, title, state, note, created_at_ms, done_at_ms, seen_done_at_ms}`, where
  `GrokBotTaskState` is `WORKING`, `NEEDS_INPUT` or `DONE`.
- `GrokBotTaskListTurnEnd` is `FINISHED`, `STOPPED` or `SUPERSEDED`. A new user message supersedes the running
  turn instead of queueing behind it.
- `GrokBotTaskListFinishedWork {title, is_failed}`, and `KeepGrokBotTaskList`, which reconciles the plan every
  turn.
- `GrokBotAgentTask {id, name, description, status, unread_preview, pinned_at_ms, subagent_ids, …}`. This is
  the job inbox, with unread previews and pins.
- `GrokBotTurnFailureCode`: `INTERNAL`, `TIMEOUT`, `USAGE_LIMIT`, `RATE_LIMIT`, `TEAM_POLICY_UNAVAILABLE`,
  `UNPAID_INVOICE`, `PROVIDER_CONTENT_BLOCKED`, `BOX_UPDATING`. Each failure has a name, so the UI can say what
  happened.

**Reading:** a job is a **task with a state machine and an unread flag**, not a chat message. "Done" stays
unread until the user has seen it.

## 3. 155 tools, grouped by the job they serve

| Tools | Group | Examples |
|---|---|---|
| 20 | Hands: box, shell, browser, files | `Shell`, `AwaitShell`, `Computer`, `BrowserSecureFill`, `FillCredential`, `CopyToBox`, `ReportSiteBlocked` |
| 20 | Accounts, credentials, MCP, plugins | `Vault`, `RequestOnePasswordConnect`, `AddMcpServer`, `InstallPlugin` |
| 19 | Messaging | `SendIMessage`, `SearchIMessages`, `SetUpSlack`, `ReactToSlackMessage`, `SetUpMicrosoftTeams`, `CreateChannel` |
| 18 | Memory, skills, self-improvement | `RecallMemory`, `UpdateMemory`, `SearchTranscripts`, `ProposeSkills`, `ProposeRuleChange`, `UpdateRoutine` |
| 14 | Sub-agents and delegation | `CheckSubagent`, `MessageSubagent`, `WakeParent`, `CloudAgent`, `SendToAgent`, `CreateAgent` |
| 12 | Meetings and **phone calls** | `JoinMeeting`, `RespondInMeeting`, `ReadMeetingTranscript`, `place_phone_call`, `FindContacts` |
| 12 | The user's phone and Mac | `IOSWriteReminders`, `MobileWriteCalendar`, `MobileSetAlarm`, `DeviceGetLocation`, `AndroidReadNotifications` |
| 10 | Email: **its own inbox** and yours | `ClaimEmailInbox`, `SendEmail`, `ReadEmailThread`, `ReadEmailAttachment` |
| 10 | Rich outputs | `Visualize`, `EditCanvas`, `WriteDocument`, `SaveToLibrary` |
| 8 | Ask and deliver | `SendToUser`, `RequestUserForm`, `Offer*` |
| 7 | Plan and state | `CreateTask`, `UpdateTask`, `UpdateState`, `ProposeCarryOver` |
| 5 | Shopping, places, money | `ProductSearch`, `PlacesSearch`, `RequestVirtualCard`, `WeatherForecast` |

**Reading:**
- Only about 20 of the 155 tools are "computer" tools.
- Most of them give the bot **its own identity and channels in the world**:
  - an email address it owns (`GrokBotEmailInbox {email, domain, assigned}`, plus sending windows, limits,
    suppressions and dead letters);
  - a voice on the phone;
  - a seat in meetings;
  - presence in Slack and Teams.
- That is the difference between "can browse" and "can finish the job". The booking confirmation arrives in
  *its* inbox, and it can call the restaurant.

## 4. Governance: how it stays safe while acting

- **Per-tool permission:** `GrokBotToolPermission` is `ALWAYS_ALLOW`, `NEEDS_APPROVAL` or `BLOCKED`, with
  per-MCP-tool and per-connector variants (`GrokBotConnectorAlwaysAllow`).
- **An auto-review agent with user rules:**
  - `GrokBotAutoReviewApproval`, resolved as `APPROVED`, `DENIED` or `ALWAYS`.
  - `GrokBotUserAutoReviewInstructions` and `GrokBotAutoReviewRuleSave` hold the user's rules.
  - The docs describe a review agent that allows, blocks or escalates.
- **Money:**
  - `RequestVirtualCard` → `GrokBotVirtualCardApproval`.
  - `BeginGrokBotSpendApproval` → `FinishGrokBotSpendApprovalAssertion`, a cryptographic user assertion. It
    matches the native `sand-webauthn-signer` helper that the denver pass found.
  - Stripe Link payment methods, and card-from-photo OCR.
- **Network:** `GrokBotEgressPolicy` and `GrokBotAllowedTcpDestination`.
- **The docs' rule:** "Require approval for sending, purchasing, deleting, publishing, or changing production
  systems."

## 5. Asking and delivering

- **`RequestUserForm`** pauses for a form mid-task.
  - Answers can be saved to the vault (`GrokBotUserFormVaultEntry`) so the bot never asks twice.
  - Dismissal can be `DISMISSED` or `ESCALATED`.
- **`SendToUser`** is the explicit channel back to the user. The docs mention voice memos and drafts to approve.
- **Notifications** go per platform (`MACOS`, `WINDOWS`, `LINUX`, `IOS`, `ANDROID`), and `NotifySandAgentTurnFinished`
  fires when a turn ends.
- **Proactive suggestions:** `GrokBotAgentSuggestion {title, detail, prompt}` is a one-tap prompt the bot
  offers.

## 6. Routines and automations

- **Shape:** `GrokBotAgentRoutine {name, trigger_description, trigger_presentation_json, schedule, is_enabled,
  next_run_at_ms, run_as_user_id, …}`.
- **Triggers:**
  - a schedule;
  - events (Slack, GitHub);
  - webhooks (`CreateAutomationWebhookApiKey`);
  - client presence (`GrokBotClientPresenceTrigger`);
  - box hand-back (`GrokBotBoxHandBackTrigger`).
- **Limits from the docs:**
  - 50 routines per bot;
  - the last 20 run records are kept;
  - routines run at least 5 minutes apart;
  - they run while the laptop is closed.
- **The progression is deliberate:** a one-time task → a reliable **skill** (six parts) → a **routine**. Skills
  can also be taught by demonstration ("Teach a task", recording up to 10 minutes).

## 7. Group rooms: turn-taking with permission to stay quiet

- **Shapes:** `RequestGrokBotRoomMemberTurn` → `DeliverGrokBotRoomMemberTurnResult`, with outcome `SENT`, `PASS`,
  `SKIPPED`, `TIMEOUT`, `CANCELLED` or `ERROR`. There are also group-chat canvases and documents.
- **Reading:** in a group, each bot gets a *turn* for a new message and may **pass**. The decision whether to
  speak is part of the protocol, not an afterthought. This maps directly onto LINE group chats.

## 8. Box lifecycle

- **Shapes:**
  - `GrokBotSessionBoxPodState`;
  - `AdminHibernateGrokBotSessionBox`;
  - `GrokBotBoxIntentAction`: `NONE`, `IN_FLIGHT`, `PRETHAW`, `REFUSED`;
  - `GrokBotBoxHandoff`;
  - `GrokBotBoxDiskPressureLevel`.
- **Reading:** boxes hibernate when idle and are **pre-thawed** when a user is likely to need one. The client
  presence trigger fires when the app opens, so the wake-up time is hidden.

## 9. What Piko should build

The model is the brain. Everything above is **harness**, and that's what makes it "do real jobs".

| Grok Bot mechanism | Piko version | When |
|---|---|---|
| Durable loop (`TEMPORAL` harness) | Piko's agent loop as a durable workflow. Each model call and each tool call is a retryable step. Waits for approvals and forms as long as needed | v1 core |
| Task state machine plus unread flag | `WORKING` / `NEEDS_INPUT` / `DONE`, each mapped to a LINE card. Done stays unread until opened in LIFF. A new message supersedes the running turn | v1 core |
| Trained hands | Anthropic's `browser_toolset_20260801` on Browserbase, code execution for files and slides, web search and fetch | v1 core |
| Per-tool permission plus review agent | A tool policy table (allow / approval / blocked), LINE approval cards with an 「一律允許」 button, and a small reviewer model for the gray zone | v1 |
| `RequestUserForm` plus vault save | A LIFF form mid-task. Answers saved to the user's profile so Piko never asks twice | v1 |
| Its own email inbox | `piko-<id>@<our domain>` for booking confirmations and receipts. Piko reads them itself | v1.5 |
| `place_phone_call` | Phone calls to Taiwanese restaurants and clinics, many of which only take bookings by phone. A voice agent with zh-TW speech. The biggest Taiwan-specific unlock | v2 |
| Room turns with PASS | In LINE groups: on @mention or a reply, Piko takes a turn and may pass | v1 (job C) |
| Routines (schedule, event, webhook) | Durable schedules per user, in Asia/Taipei time | v1 (job D) |
| Skills (six parts) plus ProposeSkills | After a job succeeds: 「要我記住這個做法嗎？」 → a saved skill → can become a routine | v1.5 |
| Pre-thaw on presence | When a LINE message arrives, warm the user's browser session before the plan needs it | v1.5 |
| Virtual cards plus spend assertion | Out of scope for the beta. The user pays during takeover | later |

## Unverified

- That the `TEMPORAL` harness means temporal.io. The naming is strong evidence, but the server side isn't visible.
- How the auto-reviewer decides. Only its inputs and resolutions are visible.
- The phone-call stack behind `place_phone_call`.
