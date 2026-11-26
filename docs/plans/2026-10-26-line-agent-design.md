# LINE agent for Taiwan: v1 design (draft)

Status: draft, 2026-10-26. Product: **Piko 來福**, a LINE agent that brings a Grok-Bot-class assistant to Taiwan's
older generation (長輩).

## 0. What we're building and how we'll know it works

This is an agent on the level of Grok Bot, built for Taiwanese users, and LINE is its main interface. You hand
it a job in a chat. It works on its own computer and comes back when it's done or when it needs you. It
remembers you.

v1 ships all four jobs at full strength. The point of the beta is to learn which of them LINE users actually
use, and then to move resources toward those (§6).

| Job | Example | What it needs |
|---|---|---|
| **A. Research and deliverables** | 「幫我比較三家日本自由行方案，做成簡報」 | a container (bash, files), web search/fetch, file delivery |
| **B. Web errands** | 「幫我訂週六晚上 7 點 4 位的餐廳」 | a real browser that keeps the user's sign-ins, takeover, approval before submitting |
| **C. Group helper** | 群組裡「@小幫手 整理剛剛討論的重點跟分工」 | group triggers, group memory, privacy rules |
| **D. Routines** | 「每天早上 8 點給我今天的天氣跟行程」 | a scheduler and a push budget |

Measurement ships in v1 as part of the product, not as a later add-on.

Not in v1:
- Desktop (non-browser) computer use.
- Paying inside the bot. The bot stops before the payment step, and the user pays during takeover.
- Channels other than LINE.

## 1. Architecture: Piko's own durable harness (decided 2026-10-26)

Grok Bot's harness mode `TEMPORAL` (see `docs/research/2026-10-26-grokbot-real-jobs.md`) showed where its
capability lives: in a loop it owns. Piko owns its loop too. Managed Agents is out as the brain because it can't
run Anthropic's trained browser tool, and because Piko's mechanics (task states, superseding, forms, approvals)
have to live inside the loop.

```
LINE ──webhook──▶ gateway (apps/piko/src/gateway.ts)
                   │ checks the signature, answers LINE at once
                   │ new message → start a task;  reply / button tap → signal the waiting task
                   ▼
           Temporal: one durable workflow per task (src/workflows.ts)
             think   = one Claude turn (activity). The full response is saved to the task log;
                       the workflow only sees the decision.
             act     = tools: server (web_search, web_fetch), harness (memory), conversation
                       (ask_user, request_approval, send_update, update_plan)
             wait    = for an answer or a tap, up to 3 days, surviving any restart
             deliver = a reply token if one is fresh (free), otherwise a push (billed, at most once)
                   ▼
           hands (next): a remote Linux box per user (bash, files, browser) + Browserbase
```

What's in place:
- **Task states:** `WORKING`, `NEEDS_INPUT` and `DONE`.
- **The reply-token relay:** a reply token is kept until it is used. While a slow turn runs, a 「收到了…」 note goes out
  at 45 s, so a long job costs one push.
- **Idempotent activities:** a retry never calls Claude twice for one turn, and never sends the same LINE message
  twice.
- **Verified:** a task started in one set of processes was finished by a brand-new set after a full stop.

Billing is our Anthropic API key, never a personal subscription.

## 2. The LINE surface

**Inbound.**

| LINE event | What we do |
|---|---|
| text | Send it to the front desk. In groups, only when the bot is mentioned (`mention.mentionees[].isSelf`) or the message quotes the bot (`quotedMessageId`). |
| audio (voice message) | Fetch the content, run speech-to-text (zh-TW with English code-switching), then treat it as text. |
| image, file | Fetch the content, upload it with the Files API, and add it to the task's session as a resource. |
| location | Pass it on as structured context. |
| postback | Button taps: approve / revise / cancel / show progress / done with takeover. |
| follow, join, memberJoined | Send an onboarding message. When the bot joins a group, it posts a short privacy notice. |

**Outbound rules.**
- **Reply first.** A reply token works once and must be used within one minute, and replies are free. In 1:1
  chats, start the loading animation (5–60 s) while the front desk works.
- **Push at most once per task:** when the task finishes, or when it needs the user (an approval, a takeover, a
  question). Each routine run pushes its result.
  - Everything else is pulled by the user. A 「看進度」 button posts back, and the postback carries a fresh
    reply token.
- **Format.**
  - Plain text, because LINE shows markdown literally.
  - At most 5,000 characters per message and 5 messages per call.
  - Long answers, files and previews go to a LIFF page link.
  - Charts and slide thumbnails go out as image messages.
- **Cards (Flex).**
  - Ticket: 收到 + 看進度.
  - Approval: 批准 / 修改 / 取消, with a preview link.
  - Takeover: 開啟畫面.
  - Result: a summary + 打開.

**The LIFF / LINE MINI App** (one web app, `apps/line-liff`):
- **Task page:** progress, the agent's plan, outputs and file downloads.
- **Takeover:** Browserbase Live View for sign-in, 2FA, CAPTCHA and the final payment step. Tapping 完成
  resumes the browser loop.
- **Approval preview:** the exact email, form or order the agent wants to send.
- **我的記憶:** see, edit or delete what the bot remembers. Routines and settings live here too.

LIFF is being merged into LINE MINI App, so the app should be buildable so that it can be registered as either.

## 3. Tasks, memory, privacy

- **One task = one Temporal workflow**, like a work ticket, with its own log and cost record.
  - While a task is open, the user's messages and button taps go to it.
  - After it finishes, the next message starts a new task, which carries a short note of the last few exchanges.
- **Our transcript** is what the user saw in LINE. The model's context is the task log on disk (`src/store.ts`),
  which moves to Postgres before real users.
- **Memory, one directory per scope**, behind Claude's `memory` tool:
  - `user:<lineUserId>`: used only in that user's 1:1 tasks. Built.
  - `group:<groupId>`: used only in that group's tasks.
  - `tw-knowledge`: read-only Taiwan know-how (sites, forms, holidays, transit) that we curate.
  - **A group task never sees a member's personal memory.** Otherwise private facts get said out loud in the
    group.
- **Sign-ins never go through chat.** The bot never asks for a password in LINE; signing in happens only in
  takeover. Secrets for our own tools stay in the worker's environment and never enter the model's context.
- **「刪除我的資料」** deletes everything we hold for that user:
  - memory directories;
  - task logs and Temporal histories;
  - Browserbase Contexts;
  - transcripts;
  - files.
- **Group summaries need recent group messages.** The setting is off by default. A group turns it on, the bot
  posts that it's on, and we keep only a rolling window (about 48 h).

## 4. The hands (job B)

- Each user gets one Browserbase Context. Shared group logins come later.
- `browser_task({goal, startUrl?})` is a custom tool. It runs a browser loop: the tool runner,
  `claude-opus-5-5`, default effort.
  - **URL policy:** http(s) only, and log every navigation.
  - **The `confirm` callable** covers purchases, submissions, sends and account changes. It sends a LINE
    approval card with a screenshot and waits for the tap. One approval covers one exact action on one page.
  - **Takeover.** The loop calls `request_takeover(reason)`, which pushes a takeover card. LIFF opens Live
    View; the user taps 完成; the loop re-reads the page and carries on.
  - It returns a short summary plus artifacts (screenshots, downloads) to the brain.
- **The spike must check:**
  - whether Taiwanese sites need a Taiwan IP or proxy;
  - whether Live View is usable on a phone inside LINE's webview (typing a password into a remote browser);
  - how long a Context lives.

## 5. Routines (job D)

Routines use our own scheduler: a Postgres table `{owner, cron, tz: Asia/Taipei, prompt, budget, lastRun}`.
When a routine fires, it opens a task the same way a user message would, and pushes the result.

The front desk turns natural language (「每天早上 8 點…」) into a routine and confirms it with a card.

Routines are per user and have to be cheap to list, pause and edit from LIFF. Temporal Schedules provide durable
per-user timers for them.

## 6. Market validation

The question: for each job (A–D), and each use case inside it, do users start it, does it finish, do they come
back, and what does it cost us?

- **Every task gets three tags** (`packages/line-core/src/usecases.ts`):
  - **`job`:** research, errand, group, routine or chat. This list is fixed. Each job maps to a cost center:
    container hours, browser minutes, group features, scheduler runs.
  - **`useCase`:** a key from a seed list, or `other`.
  - **`intent`:** a one-line summary of the request with no personal data, written by the front desk. A weekly
    job clusters these, so use cases the seed list missed still show up.
- **Events** go to PostHog from the gateway. LIFF pages use PostHog web analytics.
  - `message_received`;
  - `task_opened {job, useCase, surface: dm|group, modality: text|voice|image|file}`;
  - `approval_requested` / `approval_decided`;
  - `takeover_started` / `takeover_finished`;
  - `task_finished {outcome: done|failed|abandoned|cancelled, durationS, costUsd, pushes}`;
  - `feedback {up|down}`, from a quick reply after each result;
  - `routine_created` / `routine_fired`;
  - `user_deleted`.
- **A weekly scorecard per job and use case:**
  - active users;
  - tasks per user per week;
  - finish rate;
  - share of 👍;
  - D7/D30 retention by first job;
  - cost per finished task.
- **Running the beta:**
  - invite-only, with an invite code on the first message;
  - 50–200 users;
  - a daily budget per user;
  - five user interviews a week.

## 7. Cost and limits during the beta

- **Model:** `claude-opus-5-5` on every route, tuned by effort: `low` at the front desk, `high` in the brain,
  default in the browser loop. Add a cheaper model only after measurement shows the route keeps its quality.
- **Caps:**
  - Per task: a token budget tracked from each turn's usage, with a default cap that an approval can raise.
  - Per user: a daily cap across tasks, browser minutes and pushes.
- **LINE plan:** 高用量, NT$1,400 for 6,000 messages from 2026-11-01, then NT$0.2 dropping to NT$0.15 per extra
  message. With push-once, pushes ≈ tasks + routine runs.
- **Hosting:**
  - The gateway runs in Tokyo, close to LINE's platform and to Taiwan.
  - Postgres.
  - Object storage for files.

## 8. Repo layout

Relay owns the root files (`package.json`, and `pnpm-workspace.yaml` with `apps/*` and `packages/*`), and it is
not on `main` yet. This product lives only in prefixed folders, so it joins Relay's workspace globs without any
change to the root files:

- `apps/piko`: gateway, Temporal worker, harness (`src/workflows.ts`, `src/activities.ts`, `src/agent/`),
  LINE rendering (`src/line/`), and dev tools (`pnpm chat` is the offline LINE; `pnpm dev` is the real channel).
- `apps/piko-liff` (later): the LIFF / MINI App web app.
- `packages/piko-core`: shared types for tasks, use cases and analytics events.

## 9. Build order

1. **Spike (1–2 days).**
   - A LINE OA with a Messaging API channel, and a webhook that echoes.
   - One durable task end to end. ✅ Done: LINE → task → question → approval → result, surviving a restart.
   - The Browserbase driver with a Context, and Live View inside a LIFF page on a phone.
   - One Taiwanese site (e.g. inline, 高鐵) through it.
2. **Front desk + job A.** Tasks, ticket and result cards, file delivery through LIFF, push-once. Analytics
   events from day one.
3. **Job B.** `browser_task`, takeover, and `confirm` → approval cards.
4. **Job C.** Group triggers, group memory, summary mode.
5. **Job D.** The scheduler and routine cards.
6. **Beta.**
   - Invites and budgets.
   - 我的記憶 and delete-my-data.
   - A privacy policy.
   - The weekly scorecard.

## 10. Open questions and risks

- **LINE itself** plans an OA AI Agent Platform (Q1 2027) and AI for group chats. Keep identity and memory in our
  backend, so LINE stays just one channel.
- **Running Temporal.** Today it's the dev server on a Mac. Before the beta, move to Temporal Cloud or a
  self-hosted cluster next to the gateway in Tokyo.
- **Browserbase:**
  - Taiwan geolocation;
  - Live View on a phone;
  - Context lifetime;
  - cost per minute.
- **Speech-to-text** for zh-TW voice messages: Mandarin with English code-switching now, 台語 later.
- **Trust and compliance:**
  - OA verification (認證帳號);
  - LINE's policy on AI bots and group summaries;
  - a privacy notice under Taiwan's PDPA.
