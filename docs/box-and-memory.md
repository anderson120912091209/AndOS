# Relay's box and memory

**Where Relay is going:** bots that live in the notch. You talk to one, it goes off and works on its own
computer (the box), and it comes back to the notch with a result or a card to approve. Over time it
remembers you, so you never have to manage its context yourself.

The design follows the architecture we observed in Grok Bot (see `RE-NOTES.md` and the REA ledger in
`.context/grokbot/FINDINGS.md`). This is an original implementation on Anthropic's own primitives. No Grok Bot
code, prompts or endpoints are used.

---

## 1. The box: where the work happens

One computer per user, which every bot shares. Today it is a Docker container on your Mac; later it moves to
the cloud, using the same image and the same API.

| Part | What it is | Grok Bot's equivalent |
|---|---|---|
| Screen | Xvfb + openbox, 1280×800 | the cloud VM's desktop |
| Browser | Chromium as user `relay`; sign-ins persist in the `relay-box-profile` volume | "browser sessions persist" |
| Workspace | `/home/agent` as user `agent`, persisted in `relay-box-home`; bash, python3, node, git, curl, jq… | "files and terminal persist" |
| Hands (`boxd`) | token-gated HTTP daemon on 7070: run a command, read/write a file, screenshot, mouse/keyboard | the box's exec/computer service |
| Live view | noVNC, watch-only until you take over | VNC viewer + "Take control" |

**The brain stays outside, the hands work inside.** The agent loop runs in the worker. The worker holds the
model credentials and your connector tokens, and the box never sees them. A web page that tries to
prompt-inject the agent can only reach what the box holds.

**Inside the box, the shell can't reach your sign-ins** (each point verified live on 2026-10-25):
- The browser runs as `relay` and owns the profile (mode 700).
- The agent's shell runs as `agent` and has nothing of Relay's in its environment.
- iptables owner-match rules reject `agent` → the CDP ports (9222/9223), raw VNC (5900) and the viewer
  (6080). They also reject your Mac (`host.docker.internal`, where Relay's server holds your tokens),
  private networks, other containers, and the cloud metadata address. DNS and the internet still work.
- A managed Chromium policy blocks `devtools://*` and `view-source:`, the password and cookie settings
  pages, and saving passwords and cards. Pressing F12 or choosing "Inspect" shows "DevTools not
  allowed", so a click can't open a cookie viewer. (`DeveloperToolsAvailability: 2` is *not* used:
  it also refuses the worker's own CDP attach to pages.)
- boxd's token arrives in a root-written file that only `agent` can read; boxd deletes the file once
  read. After startup, only the init process (tini) still runs as root. No program can raise
  privileges: there are no setuid files, and the box runs with `no-new-privileges`.
- **When you have the box, the agent is gone.** X11 lets any program on the screen read keystrokes,
  so before any takeover the server stops every `agent` process and the worker's CDP door, and refuses
  the takeover if it can't. When you hand the box back, the clipboard is cleared and both return
  (`apps/box/agentctl`). The Box window's Look mode is view-only.
- The page reader (`read_page`) never shows the model what's typed into password, one-time-code or
  card fields.

The browser can still read `/home/agent` (group access), so uploads and downloads work.

**Later, in the cloud:** the box hibernates when idle and wakes on demand. Its disk is kept as versioned
snapshots in object storage, the way Grok Bot's SandBoxStore manifest works. The worker doesn't change,
because it only ever speaks the boxd API.

## 2. The tools: why the bot can take on any task

The bot uses tools the model was trained on, so it doesn't depend on Relay-specific tricks:

| Need | Tool | Executes on |
|---|---|---|
| Run anything (scripts, data, file conversion, APIs) | `bash` (`bash_20250124`) | boxd `/exec`, one persistent shell per job |
| Read, create and edit files | `str_replace_based_edit_tool` (`text_editor_20250728`) | boxd `/files/*`, confined to `/home/agent` |
| Any app on the desktop, visual checks | `computer_toolset_20260801` (screenshot, click, type, scroll, zoom…) | boxd `/screenshot`, `/input` (xdotool) |
| Websites, fast and text-first | today: Relay's CDP tools; next: `browser_toolset_20260801` | the box's Chromium |
| Facts and news | `web_search`, `web_fetch` | Anthropic |
| Remembering you | `memory` (`memory_20250818`) | Relay server (§3) |
| Anything that reaches other people | `send_email`, `create_calendar_event` → Proposal card | worker → notch → you |
| Sign-ins and 2FA | `request_takeover` | Box window |

**Approval line:** anything that stays inside the box runs on its own. Anything that reaches another person
waits for your OK in the notch (`packages/shared/src/policy.ts`). Only one job drives the screen at a time:
boxd leases the desktop to one job and tells any other job the screen is busy.

## 3. Memory: five layers, like Grok Bot's

| # | Layer | What it holds | How Relay does it |
|---|---|---|---|
| 1 | **Transcript** (what you see) | every message, step and card in a bot's thread | an append-only log on the server, with a sequence number per entry. The Mac keeps a copy of only the latest entries and fetches older pages on demand. |
| 2 | **Context window** (what the model sees) | the working conversation for the current job/thread | kept separate from the transcript. **Background compaction** (Anthropic beta `compact-2026-09-04`): at ~70% of the input budget, a summary is requested in the background while the bot keeps working, and swapped in when it arrives. There's no pause, and recent turns keep their thinking. |
| 3 | **Long-term memory** (what the bot knows) | who you are, your preferences, what it learned | per-bot files: `/memories/profile.md`, `/memories/log/<date>.md`, topic files. The bot reaches them through Anthropic's `memory` tool (view / create / str_replace / insert / delete / rename), backed by the Relay server's store. Only what it reads enters the context. |
| 4 | **Shared memory** | facts every bot should know | later: promote a bot's memory to the shared set after you review it (write / forget), plus a short digest that's rebuilt when the shared set changes |
| 5 | **Raw history, still readable** | the exact past | a `read_transcript` tool lets the bot look up its own old turns after compaction. The summary can lose detail, but the log never does. |

This split is why nobody has to compact by hand. The context window is just a moving view over a log that is
never lost, plus the memory files the bot chooses to read.

## 4. Pausing for you: one card, two flavors (agreed by denver-02 and denver-a2, 2026-10-25)

When a bot needs you, the notch shows one card. The buttons stay the same and only the verb changes.

| Flavor | When | Approve | Revise | Reject |
|---|---|---|---|---|
| **Send** (`proposal.kind: 'send'`, today's Proposal) | a draft is ready to go to someone | the frozen action runs as a commit job, with no model in the loop | resume with your feedback | discard the draft |
| **Continue** (`proposal.kind: 'checkpoint'`) | mid-run on the screen, at Send / Submit / Pay | a **resume** job: the same conversation continues past that step | resume with "not quite — <feedback>; adjust, then continue" | the task ends |

A sign-in takeover uses the same resume path: `needs_input`, you sign in, then a resume job continues.
Today the agent starts over after a sign-in and loses what it had already done.

So does a run that loses its worker (a crash, or a reload after a code edit). A task left `running`
with no live worker is re-queued as a resume job and continues from its last logged turn, instead of
being stuck or failed. This is one mechanism for checkpoints, takeovers and orphans; there's no
separate "fail stale tasks at startup" path.

**What makes resume work:** each task keeps a server-side **conversation log**, the exact Anthropic
messages appended turn by turn. A resume job reloads it and appends one message ("approved — go
ahead" / "signed in — continue" / your feedback). The rules:
- **Never edit the log**, only append to it. Claude's preserved thinking rejects history that changed
  under its earlier thinking blocks. Old screenshots are cleared server-side by context editing
  (`clear_tool_uses`), never trimmed out of the log.
- **Freeze `system` and `tools` per task**, saved with the log. A resume must send the same bytes, so
  tool availability that changes in between, like the box waking or sleeping, can't change the tool list.
- The log lives on disk per task, not in `tasks.json`, so `/api/tasks` polls stay small.
- Screenshots on a checkpoint card are an opaque `shotRef`. The worker uploads the PNG, and the notch
  fetches `GET /api/tasks/:id/shot/:ref` (fenced) when the card opens.

Who owns what: denver-a2 owns the shared types (`proposal.kind`, the checkpoint preview, the task
states) and the notch card. denver-02 owns the worker, boxd and the log/resume internals. Neither
touches store/task until both have signed off the state machine.

## 5. Real file outputs: a file to keep vs a thing to view (agreed by denver-02 and denver-56, 2026-10-25)

So "make me slides / a chart / a short animation" ends in something you can open, not a wall of text. Two
separate paths, because they have different attack surfaces:

### A file to keep — `deliver_file`
The agent builds a file on the box with `bash` (the toolkit is installed: python-pptx, python-docx, openpyxl,
matplotlib, reportlab, pillow, ffmpeg, pandoc, poppler — §1). To hand it over:

1. `deliver_file(path, name)` (worker tool) calls boxd `POST /files/read {session, path}` → `{name, size, data(base64), thumb?}`.
   *(boxd side built + verified 2026-10-25; the worker tool is TODO, and waits only for the user to pause testing.)*
2. The worker POSTs the bytes to `POST /api/worker/:id/file` (a worker route: no Origin; a sandbox caller needs the bearer).
3. The server stores them on disk per task (`.data/files/<task>/<ref>`) and puts a `FileRef` on `TaskResult.files`.
   `tasks.json` holds only the metadata, so polls stay small.
4. The notch shows a file row inside the answer card ("做好了 5 頁簡報" with the file under it). The Mac fetches
   `GET /api/tasks/:id/file/:ref` lazily when the card opens.

**`FileRef { ref, name, mime, size, sha256, thumb? }`.**

**The model never sees the bytes.** `deliver_file` returns only `{ref, name}` to the model; the file goes box → server → you.

**The server decides everything about the file, never the model** (denver-56's lane):
- `name` → basename only: no `/ \ ..`, no control chars, no leading dot, ≤120 chars.
- `mime` from an allowlist, checked by extension **and magic bytes**, not by what the agent claims: pptx docx xlsx
  pdf png jpg gif webp mp4 mov csv md txt. Refuse apps/scripts/installers/archives/shortcuts
  (`.app .command .sh .scpt .pkg .dmg .zip .webloc .terminal …`) and **HTML** (opened locally it runs JS from a
  `file://` origin).
- `sha256` computed from the bytes the server actually received; any hash the box sends is ignored. The Mac
  verifies its download against it, and re-deliveries dedupe.
- ≤25 MB per file (matches boxd), plus a per-task file cap.
- `GET …/file/:ref`: fenced, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`.
- The Mac saves into a Relay-owned folder and sets the `com.apple.quarantine` xattr, so Gatekeeper treats it as a
  download; Open works only for allowlisted types.
- `thumb?`: made **in the box** (poppler first page, ffmpeg poster, pillow downscale; null for pptx — no renderer).
  The server still treats it as untrusted: a real PNG by magic bytes, ≤512 KB, ≤1024 px long side, served
  `image/png` with nosniff, else dropped.

Files hang off the result, not the run's control flow, so this does **not** wait on the resume state machine (§4).

### A thing to view in-app — `visualize` (later, §7-6)
Interactive output (a three.js / d3 / chart page the agent writes) is **not** a deliverable file — opened from disk,
its JS runs from `file://`. It renders inside Relay's own viewer instead, never via Finder. That viewer is its own
attack surface (agent-written JS inside Relay), so it must be a sandboxed `WKWebView`: `loadHTMLString` with no
`file://` base, no `WKScriptMessageHandler` (no native bridge), outside navigation blocked or handed to the browser
on a tap, three.js/d3 bundled locally (not fetched), and a CSP that forbids remote script and fetch. Ownership
(denver-42's reader vs a new viewer) to be agreed before anyone builds it.

## 6. Build order

1. **Box as a full computer**: boxd + the box image + bash / editor / computer tools in the worker. *(built and verified live; the running box still has to be swapped to the new image)*
2. **Bots and transcripts**: bot identity (denver-61's agent characters) plus the per-bot transcript log and the notch's copy.
3. **Memory**: the memory tool backend on the server, plus background compaction in the driver loop.
4. **Browser toolset**: implement `browser_toolset_20260801` over the box's CDP, replacing Relay's custom browser tools.
5. **Cloud box**: the same image on a cloud VM, with hibernate/wake and snapshots.
6. **Shared memory** with review in the notch.
