# RE notes — observable stack facts

What informed Relay's architecture, and the boundary I held.

## Boundary

I used bundle inspection and one REA Mach-O pass to answer **"what is this built on,
and what open-source does it reuse?"** — standard tech due-diligence. I did **not**
decompile proprietary application bundles to extract or reproduce their source,
private endpoints, or assets. Relay is an original implementation; the only
third-party engine it's designed to adopt is whisper.cpp (MIT).

## What each app is (from `Info.plist` + bundle layout)

| App | Version | Stack | Tells |
|---|---|---|---|
| **Willow Voice** | 2.6.9 | **Native Swift** (min macOS 14) | Bundles `whisper.framework`, Sparkle (updates), Sentry + PostHog (telemetry), GoogleSignIn, Lottie, Alamofire. The only native app of the four. |
| **VoiceOS** | 0.1.38 | **Electron** (`com.voiceos.app`) | Standard Electron Helper layout; `app.asar`. |
| **Wispr Flow** | 1.6.774 | **Electron** (`com.electron.wispr-flow`) | Ships `ax-inspect*.mjs` — accessibility-tree inspection, i.e. how it reads the focused text field to insert dictation. |
| **Grok Bot** | 0.75.0 | **Electron** (`com.anysphere.sand`) | Bundle id = Anysphere (Cursor team). The agent/task half is a Chromium/Node stack. |

Architectural takeaways:
- Fast local dictation is a **native + on-device-model** problem (Willow's approach).
- Inserting text at the cursor is an **accessibility-API** problem (Wispr's `ax-inspect`).
- The "agent that does tasks" is **buildable with web tech** (all the agent-ish apps are Electron).
- So Relay splits exactly there: a native-capable dictation seam, a web UI, and a
  decoupled worker for agent tasks.

## REA confirmation: Willow's engine is whisper.cpp

Opened `whisper.framework/Versions/A/whisper` with REA (`open_binary` → `inspect_macho`):

- Mach-O universal (arm64 + x86_64), SHA-256 `170d1087…e1ce16`, 1,274 exports, 8 dylib deps.
- Exported symbols include `_whisper_backend_init`, `_whisper_backend_init_gpu`, and the
  full `_ggml_*` tensor op surface (`_ggml_add`, `_ggml_argsort`, …).
- Public headers shipped: `whisper.h`, `ggml.h`, `gguf.h`, `ggml-metal.h`, `ggml-cpu.h`,
  `ggml-blas.h`, `ggml-backend.h` — i.e. the whisper.cpp / ggml public API.
- Backends present: **Metal** and **CoreML** (`ggml-metal.h`, `COREML` strings) → GPU/ANE
  accelerated on Apple Silicon.

Conclusion: the high-quality on-device dictation Willow ships is the open-source
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) (MIT) running on Metal/CoreML.
Relay's planned dictation upgrade (replacing the Web Speech hook) targets the same
engine — a legitimate reuse, grounded in evidence rather than guesswork. The Mac app
(`apps/mac`) now links whisper.cpp; the web hook still uses Web Speech.

## REA pass 2: how Willow puts text in your app (2026-10-25)

Question: Relay's paste wasn't landing; how does a shipping native dictation app make
insertion reliable? Same boundary as above — only the Mach-O import table, string
constants, Objective-C class names, entitlements and signature (REA `inspect_signature`,
`search_strings`, `analyze_swift_types`; `nm -u` for the import table). No function was
decompiled; Relay's implementation is written from scratch on public macOS APIs.

| Observation (Willow 2.6.9) | What it tells us |
|---|---|
| Developer ID signed, stable designated requirement, hardened runtime | Its Accessibility approval survives updates. Relay's ad-hoc signature changes every build, so the approval went stale — **the actual cause of "paste not landing"** (tccd: `kTCCServiceAccessibility authValue=0` for the rebuilt binary). |
| Class `PasteboardReadReceipt` implementing `NSPasteboardItemDataProvider` | Pastes via a lazily provided pasteboard item, so it knows when the target app actually read the text. |
| Strings `org.nspasteboard.TransientType`, `org.nspasteboard.ConcealedType`; imports of `NSPasteboardItem` + String/RTF/HTML/PNG/URL/file-URL types | Marks its clipboard use as temporary (nspasteboard.org convention) and saves/restores several clipboard types. |
| `CGEventCreateKeyboardEvent`, `CGEventPost`, `CGEventSourceSetUserData`; no `CGEventKeyboardSetUnicodeString` | Synthesizes ⌘V and tags its own events; doesn't type text key-by-key. |
| Class `KeyboardLayoutDetector`; `TISCopyCurrentKeyboardLayoutInputSource`, `UCKeyTranslate`, `LMGetKbdType`, `kTISNotifySelectedKeyboardInputSourceChanged` | Finds the right key for "v" in the user's layout. |
| `AXFocusedUIElement`, `AXSelectedTextRange`, `AXSelectedTextMarkerRange`, `AXSecureTextField`, `AXManualAccessibility`/`AXEnhancedUserInterface`, `AXUIElementSetMessagingTimeout`, `AXObserver*`; class `FocusedInputCapture` | Reads the focused field and its context through Accessibility (incl. waking Electron/Chromium trees), with short timeouts, and watches focus changes. |
| Classes `KeyMonitor`, `KeyboardState`, `CapsLockRemap`; `CGEventTapCreate`; `HIDKeyboardModifierMappingSrc/Dst` + `IOHIDServiceClientSetProperty` | Hotkeys through an event tap; when Caps Lock is the hotkey it's remapped at the HID level. Nothing references the Globe key's `AppleFnUsageType`. |
| `CVDisplayLink*`; classes `BarPanel`, `BarOverlayPanel`, `NotchTutorialPanel` | HUD animation is driven by the display's refresh; the HUD is a movable "bar" panel. |

What Relay adopted (as techniques, in its own code — `apps/mac/Sources/Relay/Inserter.swift`):
a read receipt via `NSPasteboardItemDataProvider`, the transient marker plus
current-host-only, a full clipboard save/restore, a layout-aware ⌘V, and waiting for
modifier release. Also honest outcomes ("Copied — press ⌘V") and a build step that clears
stale approvals. Relay deliberately does **not** read the text in your apps (no AX
context reading), so it stays output-only. Separately measured on this Mac: Globe-key
input-source switches only follow presses ≤ 0.21 s, so Relay can let taps be macOS's and
holds be its own (`GlobeKey.swift`).

## Setup flow: what Willow Voice asks for, and in what shape (2026-10-25)

Same boundary as above. Sources were Willow 2.6.9's `Info.plist`, its code signature and
entitlements (REA `inspect_plist` / `inspect_signature`), its bundle's resource **file
names**, and the Swift **type names** in its binary. I did not open, decompile or reuse
any of its code, copy or animations.

- **What it asks for:** Microphone ("to transcribe your speech") and Accessibility ("to
  paste text in your applications"), plus Apple Events. It has no Speech Recognition
  usage string, so it doesn't use Apple's recognizer: whisper.cpp does the work.
- **Screen Recording is asked for later, not during setup.** The `ScribeScreenContextPermission*`
  types and a `Privacy_ScreenCapture` deep link show the screen-context permission is
  requested only when its AI mode first needs it.
- **Setup shape** (from resource names such as `onboarding_permissions.json`,
  `onboarding_permissions_completed.json`, `onboarding_try_dictation.mov` and
  `onboarding_try_scribe.mov`, and type names such as `MicrophonePermissionView`,
  `AccessibilityPermissionView`, `ShortcutOnboardingStepView`, `NotchTutorialFlowView` and
  `ScribeOnboardingPracticePasteModifier`):
  1. A short survey (role, use case, source).
  2. Privacy.
  3. Permissions, one view each, with a "completed" moment.
  4. Shortcut.
  5. Practice dictation and practice AI mode, pasting into a field inside setup.
  6. A notch-anchored tutorial.
  7. A post-setup checklist.
- **Why its permissions survive updates:** it is signed "Developer ID Application" with
  hardened runtime and notarized. Its designated requirement is anchored to the Team ID,
  not a per-build hash, so macOS keeps the Accessibility approval across updates. Relay's
  ad-hoc dev builds are pinned to each build's CDHash, which is why every rebuild has to be
  re-approved. Shipping Relay needs a Developer ID certificate and notarization.

What Relay's setup took from this: practise inside setup and let it prove the whole chain
works (mic → Whisper → paste); detect permissions live and move on automatically; ask only
for what the first minute needs. Relay's own additions:
- a guide card docked beside System Settings, with a draggable app icon;
- the real notch HUD as the illustration on every page;
- downloading and SHA-256-verifying the speech model during setup;
- reopening on the permissions page whenever a permission goes missing.

## Grok Bot: how the agent half works (REA pass, 2026-10-25)

Question: when you ask Grok Bot for something, where does the work happen, and how
does a result come back for your OK? Same boundary as above. I read stack facts:
fuses, the package manifest, bundle file names, the bundled native modules' own
`package.json` descriptions, and the key *names* of the app's local state store.
I did not read or reproduce its application code, prompts, or endpoints.

### Observed

| Fact | Evidence |
|---|---|
| `Grok Bot` 0.75.0, bundle id `com.anysphere.sand`, © 2026 SpaceXAI. URL schemes `grokbot://`, `sand://`. Package name `sand`, entry `dist/electron-main/main.cjs`. | `Info.plist`; REA `analyze_javascript_application` ev_96d7c610… |
| Hardened Electron: RunAsNode, NODE_OPTIONS and `--inspect` off; ASAR integrity on; only loads from app.asar. | REA `inspect_electron_fuses` ev_0da15c6e… |
| Process model: main (`main-core` + `main-app`), 5 BrowserWindow constructions, **2 utility-process forks**. At runtime, 2 `node.mojom.NodeService` utility processes are running. The bundle ships `node-agent-coordinator/main.cjs` and `local-exec-daemon/main.cjs` (+ `messages-worker.cjs`). | REA ev_1839e665…; `ps` |
| A typed protocol module, `proto.cjs` (1.3 MB, protobuf). | asar inventory |
| Preloads for a **VNC viewer** (`preload-vnc.cjs`), a webview, an avatar, and a "desktop mount" panel + capture overlay. | asar inventory |
| Native modules, described in their own `package.json`: window/screen-region capture "for the mounted bot", DeviceCheck token + "VM marker read", on-device "card photo fill" OCR, notification-permission reads, process list. tree-sitter + tree-sitter-bash (shell parsing). Native helpers `sand-op-launcher` and `sand-webauthn-signer`, plus `onepassword-connection-service.cjs`. | `app.asar.unpacked/dist/deps/*/package.json` |
| Client state keys (names only): per-account `roster.last-roster`, `selection.last-agent`, `transcript.replicas.<uuid>`, `send-journal`, `composer-drafts.<uuid>`, `connection.last-host-capabilities`, `mcp.connect-logos`. Plus `box-secrets-push-state.v1.json` and a `grok-bot-computer-use/` service (`CUGrokBotService`). | `~/Library/Application Support/Grok Bot/` |
| The renderer bundles PDF, XLSX, KaTeX, Mermaid, three.js/d3 and code highlighting; results come back as rich artifacts. A notch-drop card ("New Event" with the Calendar icon) appears on screen. | chunk names; user screenshot |

### Inferred operating model (inference, not observed execution)

1. **Server-authoritative tickets, thin client.** Each bot conversation is a
   transcript on the server. The desktop app keeps a replica and sends through a
   journaled outbox (`send-journal`), so a request survives the app going away.
2. **The work runs on a "box"**, a remote VM with declared capabilities
   (`last-host-capabilities`) that you can watch over VNC. Secrets are pushed to the
   box rather than typed into it. A local daemon and a computer-use service also exist
   for work that has to happen on your own Mac.
3. **It acts through connectors**: MCP servers, 1Password, passkeys (WebAuthn), and
   card OCR for checkout. So it is built to finish real-world actions, not just
   write text.
4. **Results come back as rendered artifacts** that drop from the notch, which matches
   the "New Event" card.

### What Relay took from it (original implementation)

- The **work-ticket lifecycle**: `queued → running → awaiting_approval → (approve →
  commit) | revise | discard`. The ticket lives on the server; any worker can pick up
  the next step (`packages/shared/src/proposal.ts`, `jobFor`).
- **Reversible work runs alone; irreversible work waits for you.** Drafting is free.
  Sending and scheduling become a Proposal whose arguments are frozen, and approving
  names the proposal id (`policy.ts`, `store.decide`, `commit.ts`).
- **Connectors over driving a remote browser** for mail and calendar: Gmail and
  Google Calendar over REST, plus a local outbox (`connectors.ts`, `google.ts`).
- **The notch as the return channel**: work → ready line → review card → Send
  (`apps/mac/Sources/Relay/Agent/`).

## Grok Bot: computer-use, takeover, speed (REA pass, 2026-10-25)

Same boundary as above — observable stack/architecture facts, UI strings, Mach-O linkage/entitlements,
process layout from `ps`/`lsof`, and non-secret JSON **key names**. No decompiled logic; no secret
files opened (sand-secrets.json, box-secrets-push-state, daemon credential/log, Cookies all left
closed); the helper's embedded agent instructions were found but deliberately not read or reproduced;
the daemon's cloud endpoint was seen in `lsof` and left out.

### Where it runs (observed)
- **Default = their own cloud computer (the "box")**, shown in the app through an **embedded noVNC
  viewer**. Preload `preload-vnc.cjs` has 26 noVNC markers; renderer chunks `chunk-box-desktop-modal`,
  `chunk-computer-screen-preview`; a persistent session named `sand-forever-box`. UI: "Grok Bot has
  its own computer and works just like you", "Connecting to Grok Bot's computer…", "Computer is asleep".
- **The user's Mac is opt-in**, split between a background Node **local-exec daemon** (Electron utility
  process) and a **separately-signed Swift helper `CUGrokBotService`** (own LaunchServices identity, so
  its Accessibility/Screen-Recording grants belong to it, not Electron). The daemon holds one outbound
  HTTPS connection to the cloud and listens on no TCP port — the cloud **pushes work down** over that
  connection. Helper talks over a unix socket that checks the peer's code signature.

### Takeover (observed)
- Cloud box: UI "Take over", "Take control to click and type" — a noVNC view that is watch-only until
  the user takes control. (This is exactly our x11vnc + noVNC + takeover design.)
- Local Mac helper: two input paths — background input to one app (cursor doesn't move) and system-wide
  input (real cursor moves); a single-holder "remote control" session that needs the overlay visible
  and a stop-key event tap; events tagged so the helper can tell its own input from the user's.

### Speed (inferred from the setup, not measured)
- A long-running **native** helper over a local socket → **no JavaScript in the action loop**.
- **Accessibility-tree first**, per-call timeouts, **capture only the target window**, **single**
  screenshots sized at capture and JPEG-compressed (no continuous video for the agent).
- Cloud traffic is Connect-RPC + protobuf over HTTP/2; renderer↔coordinator direct channel; V8 code
  cache on; feature flags pre-loaded from a local file; boot snapshot sent synchronously.

### What this means for Relay (original build)
- Our **local Docker box first, noVNC viewer, takeover = give the user control** matches their shape —
  we're not guessing. Cloud box later is their default; our choice to start local is the cheap, private
  first step.
- **Our "read page as a tagged-element list, not a screenshot wall" is the right call** — their speed
  comes from a11y-first + target-window-only + single shots, not from streaming frames to the model.
- Keep the **native-helper-over-a-socket** idea in reserve for an eventual "run on my own Mac" mode
  (vs the box) — but the box path needs none of that, so v1 stays simple.
- Their passkey story (a local WebAuthn signer proxying to the cloud box) is sophisticated; we sidestep
  it entirely with takeover (the user signs in on the box; credentials never reach the agent).
