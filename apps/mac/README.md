# Relay for Mac

A menu-bar app — the native front end to the Relay server. Hold a key, speak, and Relay
either types the text into whatever app you're in, or hands the request to the AI. Two
modes on one key:

- **Hold Fn** → dictate, in any language (English, Mandarin, or both in one sentence).
  The words are pasted into the focused app.
- **Hold Fn + Control** → *scribe*. The request is dispatched to the AI agent (the
  "do it for me" mode) and shows up in the Command Center.

Same backend as the web HUD; this is just the always-available native shell.

## Download (dictation edition)

The app for other people is the **dictation edition**: hold Fn to dictate, on-device. The AI
half (Fn+Control) isn't in it yet, so nothing it hears leaves the Mac. One universal app for
Apple silicon and Intel Macs, macOS 13 or later:

- **Apple silicon** dictates with Whisper on the GPU: any language.
- **Intel** dictates with SenseVoice on the CPU: Mandarin, English, Japanese, Korean and
  Cantonese, in a fraction of a second. Whisper on an Intel CPU takes seconds a sentence.

1. Open `Relay-<version>.dmg` and drag Relay onto Applications.
2. Open Relay. macOS says it can't check the app, because it isn't signed with an Apple
   Developer ID yet: open **System Settings → Privacy & Security**, scroll down to Security,
   click **Open Anyway** next to Relay, and confirm.
3. Setup asks for the microphone, and for Accessibility so Relay can paste where you're
   typing, then downloads the speech model once: ~574 MB on Apple silicon, ~240 MB on Intel.

## Releasing

```bash
cd apps/mac
./scripts/release.sh       # → dist/Relay-<version>.dmg and its .sha256
```

It builds the dictation edition (`RELAY_EDITION=dictation ./build.sh`): the AI half switched
off, and the server's dictation cleanup (`packages/shared`) bundled in as `scribe.js`, which
`LocalScribe.swift` runs in JavaScriptCore. So the download writes exactly what the dev setup
pastes, and the release stops if it doesn't (`scripts/scribe-check.ts`). With
`RELAY_SIGN_IDENTITY` (a Developer ID) and `RELAY_NOTARY_PROFILE` set, it also signs and
notarizes, so people can open it with a double-click.

## Build & run

```bash
cd apps/mac
./scripts/fetch-model.sh   # one time: the Whisper speech model (~570 MB)
./build.sh --open          # builds, then (re)starts Relay; the first build also compiles whisper.cpp (~20 s)
```

Speech runs locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (MIT),
statically linked with Metal; it detects the language by itself. `scripts/build-whisper.sh`
builds the libraries into `Vendor/`; the model lives in
`~/Library/Application Support/Relay/models/`. Without the model, Relay falls back to
Apple Speech in a single language.

Make sure the server is running (`pnpm dev` from the repo root) so routing and agent
dispatch work. If it isn't, plain dictation still pastes — only the AI mode needs it.

## Permissions

| Permission | Why | When |
|---|---|---|
| **Microphone** | To hear you while Fn is held | First time you dictate |
| **Accessibility** | To press ⌘V for you, so the text lands in the focused app | Prompted on launch · Menu › *Turn On Auto-Paste…* |
| **Speech Recognition** | Only for the Apple Speech fallback | If the Whisper model is missing |

Holding Fn works without Accessibility; only *pasting* needs it. Without it Relay leaves
the words on your clipboard and says so ("Copied — turn on Accessibility…"). The moment
you flip the switch, Relay notices — no relaunch.

**After every rebuild you approve Accessibility once more.** macOS ties the approval to the
app's code signature, and the default ad-hoc signature changes with each build; an old
approval goes stale while the switch still *looks* on. `build.sh` clears the stale entry
whenever the signature changes, so you get one clean prompt instead. To keep approvals
across rebuilds, sign with a stable identity: `RELAY_SIGN_IDENTITY="<identity>" ./build.sh`.
(That's a trade-off: anything able to use that identity could sign an app that inherits
Relay's approval. The ad-hoc default pins it to this exact build.)

## How to use

1. Put your cursor where you want text (any app).
2. **Hold Fn** and speak; **release** to finish. The text appears where your cursor is
   *when it's ready* — switch apps mid-sentence and it follows you (so does the icon in
   the notch).
3. For the AI to *do something* instead of just writing, **hold Fn + Control** and speak
   your request; release. The notch says what it understood ("On it — “Q3 numbers”"), the
   work happens in the background, and anything that would reach someone comes back to the
   notch as a draft for your OK.

## Connections — what the AI can work with

Open **Connections** from the menu (⌘,), from setup's last page, or by opening Relay.app
again once it's set up (the menu icon often hides behind the notch).

| Connection | What it gives the AI | What you do, once |
|---|---|---|
| **Gmail**, **Slack**, **Notion**, **Linear** | The site itself, in Relay's own browser — read, search, draft | Click **Sign In**: the **Box window** opens on the site's sign-in page on Relay's computer. Sign in as usual (⌘V pastes from your Mac, so your password manager works), press **Done** |
| **Claude** *(developer builds)* | The model that does the work | Paste an Anthropic API key — shipped Relay has the model built in |
| **Fathom**, Gmail over Google's API *(developer builds, `RELAY_DEV_CONNECTORS=1`)* | Calls and transcripts (official MCP server); Gmail via your own Google Cloud key | Click Connect and sign in; Gmail's guided key panel |

**Relay's computer** (the "box", `apps/box`) is a real Chromium on a virtual screen, in a
Docker container on this Mac. The agent works sites there; when one needs a person — a
password, a 2FA code — the notch says *"… needs you · Take over"* and the Box window hands
you that same screen. Done, or closing the window, hands it back and the agent carries on;
Not Now declines. A row shows *Signed in* when the box's browser has the site's session
(Relay checks cookie *names* over CDP, never values); **Sign Out** expires them there.
Watch the agent work any time from the menu: **Relay's Computer…**

The rules: the AI **reads on its own** and **asks before anything reaches someone** — sending,
posting and invites stay drafts in the notch. Developer-connector tokens live in your
**Keychain** (via the Relay server, `apps/server/src/connections/`) and the agent gets them
for one job at a time; box sign-ins live in the box's browser profile (a Docker volume on
this Mac). Only Relay on this Mac can use these APIs: other machines, other hosts and web
pages are refused.

### What "this" is

In AI mode Relay notes the page's address, the window's title and any text you've selected,
and turns it into an exact pointer (`packages/shared/src/pointer.ts`): a Slack link names the
thread, a Fathom link the call, a Docs or GitHub link the document; for Gmail, the open
thread's subject. So "reply to this" or "turn this call into tasks" works on that very thing.
Selected text is passed to the agent as material, never as instructions. Dictation never
reads any of this — only where you're typing.

### The Globe (🌐/Fn) key

macOS can give a quick *tap* of Fn its own job (System Settings › Keyboard › "Press 🌐 key
to": change input source, emoji, dictation). Relay only needs a *hold*, so when a tap has a
job it waits 0.24 s (`GlobeKey.holdThreshold`) before listening: taps — which were all
≤ 0.21 s when we measured ABC ⇄ 注音 switching — stay macOS's, holds are Relay's. The notch
twitches the instant Fn goes down, so it never feels laggy. With "Press 🌐 key to" → **Do
Nothing**, Relay starts instantly.

## Laid out for where you're typing

The same words should look different in an email, a chat, a document and a search box.
When you let go of Fn, Relay notes *where* you're typing — the app, the web page's host, and
the focused field's role and label — and the server lays the text out for that place
(`packages/shared/src/layout.ts`):

| Where | Example | What you get |
|---|---|---|
| **Email body** | Gmail / Outlook on the web (field "Message Body"), Mail, Outlook, Spark… | Greeting on its own line, paragraphs at natural seams ("Also,", the wrap-up), "first… second…" (第一…第二…) as a numbered list, sign-off and name on their own lines |
| **One-line field** | To, Subject, search boxes | One line, no full stop at the end |
| **Document** | Notes, Notion, Obsidian, Google Docs, GitHub | Spoken enumerations become numbered lists |
| **Chat / anything else** | Slack, LINE, WeChat, code editors… | Left as you said it |

Say "new paragraph" (換段) or "new line" (換行) as a sentence of their own to break wherever
you like. Whisper already punctuates, so words like "period" or "new line of products" are
kept as words.

**Only where, never what.** Relay reads accessibility metadata: the field's role, a text
box's own label ("Message Body", "Subject"), and the page's host — never the field's
contents, the page's text, a page's title, or the full URL. That goes to the local Relay
server only.

## How pasting works

Relay pastes the way you would — but carefully:

- **Waits for your hands.** ⌘V is sent only once Fn/Shift/Control/Option/⌘ are released, so
  it can't turn into ⇧⌘V.
- **Right key, any layout.** ⌘V goes to whichever key types "v" in your keyboard layout.
- **Knows it landed.** The text is offered lazily, so Relay sees the moment the target app
  reads it — a read receipt. No read within a second (no text field focused?) → the words
  stay on the clipboard and the notch says "Copied — press ⌘V".
- **Gives your clipboard back.** Whatever you had copied (text, images, files, app-private
  formats) is restored right after the paste — unless you copied something new meanwhile.
- **Polite.** Marked transient ([nspasteboard.org](http://nspasteboard.org)) so clipboard
  managers skip it, and current-host-only so it never syncs to your other devices.

## The notch HUD

- **Dictating:** the notch grows two small ears — the app you're in on the left, a live mic
  meter on the right — and stays as tall as the menu bar. ✓ when the paste lands.
- **Messages** (launch hint, clipboard fallback, AI hand-off): one line under the notch.
- Content is clipped to the black shape, so nothing shows outside it while it morphs. One
  set of springs (`Motion`) drives every change.
- The meter is drawn with Canvas on the display's clock (120 Hz on ProMotion); mic levels
  never re-render the SwiftUI tree. The microphone starts off the main thread, so the open
  animation isn't held up by audio hardware (~70 ms).

## Diagnostics

```bash
/usr/bin/log show --last 10m --predicate 'subsystem == "com.relay.mac"'
```

(`/usr/bin/log`, not `log`: zsh has a builtin of that name.) It logs permission state,
speech timing and language, and paste outcomes — never what you said.

Dev tools, no window or mic needed:

- `RELAY_RENDER_SHOTS=<dir>` — render every HUD state to PNGs and exit.
- `RELAY_TRANSCRIBE=a.wav,b.wav` — run the in-app Whisper engine on files and exit.

## Design notes / boundaries

- The Fn trigger is a **passive modifier monitor** (`NSEvent` `.flagsChanged`) — it sees
  only modifier-key state (Fn, Control), never the characters you type. Electron/Carbon
  hotkey APIs can't bind Fn at all, which is why VoiceOS/Wispr and this app use a native
  key monitor. (Confirmed via REA: VoiceOS registers no Electron `globalShortcut`.)
- Text insertion is **output only** (clipboard + ⌘V), the same mechanism Apple Dictation
  uses. Relay does not read your screen or the text in your apps — only where you're typing
  (see "Laid out for where you're typing"). While pasting it holds a copy of your clipboard in
  memory to put it back; it's never stored or sent anywhere.
- The HUD is a borderless, non-activating, always-on-top panel that ignores mouse events
  and follows you across Spaces (window level `screen-saver`).
