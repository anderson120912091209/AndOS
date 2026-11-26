# Relay's computer (the box)

A whole Linux desktop in a Docker container on your Mac: a 1280×800 screen, a real Chromium with your
sign-ins, and a workspace with a shell. The agent works it in two ways:

- **the browser over the Chrome DevTools Protocol**, which is fast for websites;
- **boxd**, the box's hands, for everything else: a shell, files, screenshots, mouse and keyboard.

When a site needs a person, the Mac app's Box window shows you the same screen (noVNC) and you take over.
The design is in `docs/box-and-memory.md`.

```bash
pnpm box:build
```

The server starts the box on demand (`apps/server/src/box/driver.ts`; `POST /api/box/start`, or
`POST /api/worker/box/ensure` when a task reaches for the computer).

| | Where | Who |
|---|---|---|
| Viewer | `http://127.0.0.1:16080/relay.html?token=…` | The Box window. `GET /api/box` hands out a watching URL, or a typing URL while a takeover is open; `POST /api/box/takeover` returns the typing URL. |
| CDP | `http://127.0.0.1:19222` | A worker on the Mac |
| CDP | `http://<relay-browser's IP>:9222` on network `relay-box` | A worker in a container. Resolve the name first: Chrome refuses a Host that isn't an IP or `localhost`. |
| boxd | `http://127.0.0.1:17070` | A worker on the Mac (`GET /api/worker/box` hands out the address and token) |
| boxd | `http://relay-browser:7070` on network `relay-box` | A worker in a container (`RELAY_BOXD_URL`) |

## Two users, and a fence

| User | Runs | Owns |
|---|---|---|
| `relay` | Xvfb, openbox, Chromium, socat, x11vnc, websockify | `/home/relay`, mode 700: the profile (your sign-ins) and the logs |
| root | tini, plus `agentctl` when the server calls it (`docker exec`) | `/run/relay`: the fence marker and the takeover hold |
| `agent` | boxd and everything the agent starts | `/home/agent`, the workspace. Downloads land in `/home/agent/Downloads`. |

`start.sh` starts as root only to put up the fence, then runs every process through `setpriv` with a
clean environment. After startup, only tini (PID 1) still runs as root. The fence is iptables
owner-match rules for uid `agent`:

- **rejected:** loopback ports 5900/6080/9222/9223 (the browser's DevTools would hand over cookie
  values); 10/8, 172.16/12, 192.168/16, 100.64/10 and 169.254/16; the resolved `host.docker.internal`
  / `gateway.docker.internal`, which is your Mac, where Relay's server holds your tokens; all of IPv6.
- **allowed:** replies on connections the worker opened to boxd, DNS to the box's resolver (port 53 only),
  and the public internet.

If the fence can't be built, boxd doesn't start. The browser and the viewer still work.

**When you have the box, the agent is gone.** X11 lets any program on the screen read every keystroke,
so a firewall can't protect a password you type. Before any takeover hands you the screen (from a task,
a sign-in, or the Box window's Take Over), the server runs `agentctl hold` as root inside the box:
- every `agent` process is killed (SIGKILL, never SIGSTOP: a stopped X client still receives the keys
  typed while it's stopped);
- the worker's CDP door (socat :9222) closes too, so no model can read the page you're typing into.

If that fails, the takeover is refused. `agentctl release`, run when the last open takeover finishes
and before `/done` answers, clears the clipboard you used and brings both back. Holds expire as follows:
- a hold the server lost track of (the server restarted mid-takeover) wears off after 10 minutes;
- a box that itself restarts mid-takeover keeps the hold, so the agent doesn't come back while you're still typing.

**Typing is a takeover-only screen, enforced by the server.** Watching (`RELAY_BOX_VIEW_TOKEN`) goes to an
x11vnc started with `-viewonly` on :5901, which is always on. Typing (`RELAY_BOX_TOKEN`) goes to :5900,
which only runs while a takeover holds the box:
- `agentctl hold` opens :5900 after the agent is gone;
- `release` closes it and cuts off anyone still connected.

`GET /api/box` hands out the watching URL, and the typing one only while a takeover is open. Verified with
a raw VNC client: keys sent on the watching screen never reach a focused field, and the typing token
connects to nothing outside a takeover. The Mac's `?view=1` is a second layer on top. Files you download
during a takeover land in `/home/agent/Downloads`, so the agent can read them afterwards.

`chromium-policy.json` (managed policy) blocks `devtools://*`, `view-source:`, the password and cookie
settings pages, and saving passwords and cards. F12 or "Inspect" then shows "DevTools not allowed".
`DeveloperToolsAvailability: 2` would also do that, but it makes Chromium refuse the worker's own CDP
attach to pages ("Not allowed"), so it isn't used.

## boxd

The box can make real files, not just text: `python-pptx` (decks), `python-docx`, `openpyxl`, `matplotlib` (charts), `reportlab` (PDFs), `pillow`, plus `ffmpeg`, `pandoc` and `poppler`. The agent builds them with `bash`, and `/files/read` hands the finished file out.

`boxd/boxd.mjs`, plain Node with no dependencies. Every endpoint except `GET /health` needs
`Authorization: Bearer <RELAY_BOXD_TOKEN>`, and requests carrying an `Origin` are refused.

| Endpoint | What it does |
|---|---|
| `POST /exec` `{session, command, timeout_ms?}` / `{session, restart: true}` | One persistent bash per `session` (a task id). cd and variables persist. stdin is `/dev/null`, stderr is folded in, and the output is clipped to 30K characters. |
| `POST /files/view · create · str_replace · insert` | Anthropic's text editor semantics, confined to `/home/agent`, symlinks included. |
| `POST /screenshot` `{session, region?}` | A PNG of the screen, or the `region` enlarged to the screen's size (a zoom). |
| `POST /input` `{session, action, input}` | One computer-toolset member, run through xdotool with an argument list, never a shell. |
| `POST /cursor` `{session}` | Where the mouse is. |
| `POST /files/read` `{session, path}` | A finished file's raw bytes (base64), for handing to the user — a .pptx, a chart, an MP4. Capped at 25 MB; the bytes go to the server, never into the model's context. |

The screen is leased to one session at a time, for 60 s after its last action. Another session gets 409
"Another task is using the screen". The token reaches boxd in a file only `agent` can read, and boxd
deletes it once read.

## Older notes

- **Loopback only.** Every port is published on 127.0.0.1. The viewer and boxd each take their own
  random per-box token, passed in through the environment (never in `argv`).
- **Chromium keeps its sandbox.** The container runs with `seccomp=unconfined` so Chromium can create the
  user namespaces its sandbox needs. `--cap-add NET_ADMIN` exists only for the fence. Relay never uses
  `--no-sandbox` or `--privileged`.
- **Sign-ins persist** in the `relay-box-profile` volume, and the agent's files in `relay-box-home`, so a
  recreated container keeps both. `docker volume rm relay-box-profile` forgets every site.
- `relay.html` is the viewer: just the screen, scaled to fit. In the Box window it reports `connected` and
  clipboard events to the app, and takes `relayPaste(text)` and `relayShortcut(key)`, so ⌘V and
  ⌘A/C/X/Z work the Mac way on a Linux box.
