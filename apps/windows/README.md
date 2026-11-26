# Relay for Windows — dictation edition

Hold **Ctrl + Win**, talk, let go: your words land where you're typing, cleaned up by the same
code as the Mac app's DMG (`apps/mac/scripts/scribe-entry.ts` → `packages/shared`). Speech is
whisper.cpp running on the PC; nothing is sent anywhere. No AI half, no server — like the Mac's
dictation edition.

Built and packaged from a Mac; there's no Windows machine in the loop, so the Windows-only parts
(the keyboard hook, Ctrl+V, the Start-menu guard, `whisper-server.exe`) are first exercised on a
real PC. Everything else runs here: `pnpm -C apps/windows smoke` drives the real pipeline —
Electron, whisper-server, the cleanup, the HUD — on recordings, off screen.

## Build the zip

```bash
brew install cabextract
node apps/windows/scripts/fetch.mjs
node apps/windows/scripts/pack.mjs
```

`fetch.mjs` gathers, and checks, what ships inside:

| | from | checked by |
|---|---|---|
| `whisper-server.exe` + ggml DLLs (one per x64 CPU generation, picked at run time) | whisper.cpp release `b5454`, `whisper-bin-x64.zip` | pinned SHA-256 |
| `msvcp140`, `vcruntime140`, `vcruntime140_1`, `vcomp140` | Microsoft's `vc_redist.x64.exe` | Authenticode signer must be Microsoft |
| `ggml-small-q5_1.bin` (190 MB, ~100 languages) | Hugging Face `ggerganov/whisper.cpp` | Hugging Face's SHA-256 |

The engine's DLLs need the Visual C++ runtime, which Windows doesn't ship; bundling it app-local
means a fresh PC works without an installer or an admin prompt.

`pack.mjs` builds `release/Relay-Windows-x64-<version>.zip`: unzip, double-click `Relay.exe`.
It's unsigned, so Windows shows "Windows protected your PC" once (More info → Run anyway) —
`START HERE.txt` in the zip says so.

## How it works

| | |
|---|---|
| `src/hold.ts` | Ctrl + Win in either order arms it; any other key during the hold cancels (Ctrl+Win+D, Ctrl+Win+←/→ are real shortcuts); under 300 ms is a tap |
| `src/main.ts` | taps **F24** when the hold starts: Windows opens Start when Win comes up untouched, and a key pressed meanwhile keeps it shut (F24 comes back through the hook and is ignored) |
| `src/recorder.ts` + `capture-worklet.js` | the mic opens on the hold and closes on release; 16 kHz from the AudioContext itself |
| `src/whisper.ts` | `whisper-server.exe` on a random 127.0.0.1 port, model kept loaded; restarts itself if it crashes |
| `src/paste.ts` | snapshot every clipboard format (Electron 45's clipboard is the async web API), write the text, Ctrl+V once **both** keys are up, restore yours unless you copied something meanwhile |
| `src/hud.*` | a black pill at the top of the screen: listening, writing, ✓, messages |

**Hindi.** Hinglish is usually typed in English letters, so by default Whisper is told the speech
is English and shown one line of romanized Hinglish (`SCRIPTS` in `whisper.ts`). Without that
hint it *translates* Hindi ("I will come to office"); with it, English stays exact and Hindi comes
out as "main kal office aunga". The tray's Hindi → In Devanagari lets Whisper choose the
language and its script instead (better with the More accurate model).

**Models.** Fast (`small`, bundled) is quick on a laptop CPU; More accurate (`large-v3-turbo`,
the Mac's model) is a 574 MB download from the tray, checked by SHA-256 before use.

Logs: `%APPDATA%\Relay\logs\relay.log` (timings and lengths, never what was said).
