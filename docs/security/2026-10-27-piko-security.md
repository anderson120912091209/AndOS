# Piko security: takeover, box isolation, and the tools underneath

2026-10-27. Covers `apps/piko` (the harness and gateway) and `apps/piko-box` (each user's computer). Run
`pnpm check:takeover`, `--liff` and `--browser` in `apps/piko` to re-verify everything marked ✅ below.

## What we protect

- **Each user's signed-in browser.** The box's Chromium profile holds their Facebook, Google, bank and
  government sessions. Whoever drives that browser *is* the user on those sites.
- **What the user types during a takeover:** passwords and one-time codes.
- **Every other user.** Many boxes share one machine. That machine also runs our control plane:
  Temporal (every user's messages), the gateway, and the ngrok agent.
- **Our own keys:** the LINE channel, Anthropic, Google OAuth, `PIKO_SECRET`.

## Who we defend against

1. **A prompt-injected agent.** A web page or file tells Piko to do something the user never asked. This
   is the most likely attacker. It already has a shell and a browser, inside its own box.
2. **Someone holding a takeover link.** The link was forwarded, screenshotted, or left in a browser's
   history.
3. **The open internet** hitting the public URL: scanners, cross-site requests from other pages, floods.
4. **A compromised component** (Chromium, VNC, websockify, a dependency) trying to move outward.

## Controls

### The box: internet only ✅

- **One fence for every process in the box** (`apps/piko-box/start.sh`). Allowed: the internet, the box's
  own loopback, and DNS to its resolver. Rejected: private networks (10/8, 172.16/12, 192.168/16,
  100.64/10), link-local (169.254/16, cloud metadata), `host.docker.internal` and
  `gateway.docker.internal`, multicast, and all non-loopback IPv6.
- **Before this change only the agent's shell was fenced.** The browser's user (`relay`) got **HTTP 200
  from the Temporal UI** through `host.docker.internal:8233`. On Docker Desktop that name reaches every
  service bound to the Mac's 127.0.0.1. The agent drives that browser, so one malicious page could have had
  it read every user's tasks. This is now closed for `relay`, `agent` and root, which the check verifies.
- **Inter-container traffic is off** on the `piko-box` network (`enable_icc=false`), a second wall behind
  the fence.
- **No DevTools door.** Chromium runs without `--remote-debugging-port`, socat is gone, and policy sets
  `DeveloperToolsAvailability: 2`. Piko only uses boxd. A DevTools port exposes every cookie in the profile.
- **Two users inside the box:**
  - `relay` owns the screen, the browser and the profile (mode 700);
  - `agent` owns the shell and workspace and can't read the profile;
  - no setuid binaries, and `no-new-privileges`.
- **Resource limits:** 2 GB memory, 2 CPUs, 1024 pids.
- **Seccomp:** `apps/piko-box/seccomp-chromium.json`, which is Docker's default profile plus only what
  Chromium's sandbox needs:
  - `clone` with exactly the NEWUSER, NEWUSER|NEWPID|NEWNET and NEWPID flag sets, and
    `unshare(NEWUSER)`;
  - `chroot`.
  - Removing any one rule breaks Chromium's sandbox. Docker's default profile on its own gives "No usable
    sandbox!". `chrome://sandbox` reports "adequately sandboxed". The box manager refuses to start a box if
    the profile file is missing, rather than falling back to `unconfined`. ✅
- **No user namespaces for anything but Chromium.** Everything else (boxd and every command the agent
  runs, the VNC servers, websockify, the X server) runs under a stacked filter (`apps/piko-box/no-userns`)
  that refuses to create them. Kernel namespace code is a well-worn escape path, and a kernel exploit from a
  box would give root in Docker's VM, which mounts `/Users`. ✅
- **The X server runs as its own user, `screen`,** which can read neither the profile nor the workspace.
  X.Org has 11 unfixed memory-safety bugs (2026-10-07 advisory), and the agent has to talk to X to click
  and type. A hijacked X server now gets no sign-ins. ✅
- **MIT-SHM is off** (it only works between same-user processes), and VNC listens on IPv4 only
  (`-noipv6`).
- **Browser policy:**
  - no password manager, no card or address autofill;
  - no extensions;
  - no guest or extra profiles;
  - password and cookie settings pages blocked.
- **No clipboard over VNC** (`x11vnc -nosel`). `agentctl release` also clears the X clipboard after a
  takeover ✅.

### Takeover: the person drives, Piko is gone ✅

The flow is described in `apps/piko/src/takeover.ts`.

| Threat | Control | Checked |
|---|---|---|
| Link forwarded or leaked | LIFF: LINE's server verifies an ID token and its `sub` must be the box owner. Ticket is single-use and lives 10 minutes. | ✅ refused for another LINE user, no identity, or a second use |
| Ticket stolen from our data | Only sha256 hashes are stored. The ticket is minted in `deliver`, so it never enters Temporal's history. | ✅ |
| Forged ticket or cookie | 256-bit secrets, constant-time comparison | ✅ |
| Cross-site request or WebSocket hijack | Origin must be ours on `/open`, `/done` and the WebSocket. Cookie is `__Host-`, HttpOnly and SameSite=Strict. | ✅ |
| The agent watching or keylogging | `agentctl hold` SIGKILLs every agent process **before** a session exists, and the typing screen only runs during a hold. | ✅ no agent process while the screen is open |
| A hijacked X server keylogging | Every takeover runs on a **brand-new X server** that no agent process has ever talked to. Chromium comes back on it with its tabs. | ✅ new X server per takeover; typing reaches the page |
| Session outliving its purpose | 20-minute session; one phone at a time. The workflow releases in `finally`/`nonCancellable` on every path: done, a chat message, timeout, stale cancel, or retire. The gateway cuts sockets within 3 s of a close. | ✅ cookie dead after handing back; agent back; screen closed |
| Box token reaching the phone | The gateway adds websockify's token on the server side. The phone only holds our session cookie. | ✅ |
| XSS or clickjacking on the page | Strict CSP: self-hosted noVNC, LIFF SDK pinned and scoped by path, `frame-ancestors 'none'`. Model text only ever goes into `textContent`. | ✅ CSP present |
| Ticket in history or referrer | `history.replaceState` after LIFF init; `Referrer-Policy: no-referrer`; `no-store` | ✅ |
| Keystrokes in logs | noVNC logging is pinned to `error` (its `info` level logs every keysym). The gateway never logs payloads, and ngrok inspection is off. | ✅ audit log has no secrets |
| A double-tap race on one ticket | In-process lock per grant | code review |
| Flooding `/open` | 30 attempts per IP per 10 minutes; bodies of 16 KB or less (webhook bodies 1 MB or less) | code review |
| LINE keeping a snapshot in recently used | Turn on Module mode in the LIFF settings; the page also blanks the screen when hidden | setup step |

**Usable on a phone.** The first live test (Facebook, 2026-10-27 03:30) showed a 1280×800 desktop
shrunk onto a phone, and the user didn't get as far as typing. The page now sends the size of its screen
area. The takeover screen takes that shape, at 2× and at least 500 CSS px wide (Chromium's narrowest
window), so sites show their mobile layout. Openbox maximizes every window. Handing back restores the
agent's 1280×800 desktop. ✅

Every takeover is recorded in `.data/piko/audit.jsonl`: ticket issued, opened (with IP and identity
method), refused (with the reason), screen connected, closed (with the reason). Ids only, never secrets.

### The harness

- **Webhooks** are HMAC-SHA256 with a constant-time compare, and the signature is checked before the body
  is parsed.
- **Google OAuth** uses a signed, expiring state and PKCE. Tokens are stored in 0600 files.
- **Media links** are 22-character random ids from a type allowlist (no SVG or HTML) with `nosniff`.
- **`.env` is 0600.** Never print its values.
- **Tasks that can't replay are retired, not stranded** (`src/worker.ts`, `src/tasks.ts`). A stuck task
  used to swallow every message. That was the 2026-10-27 incident.

## Still open

1. **TLS terminates at ngrok.** Takeover keystrokes are encrypted from the phone to ngrok's edge and over
   the tunnel to us, but ngrok's edge can see them in the clear. Fine for testing with our own accounts.
   **Before real users:** our own domain, with TLS terminated on our server (Caddy or Let's Encrypt), or a
   provider we accept as trusted.
2. **LIFF isn't set up yet,** so dev takeover links are "ticket only". Production refuses takeover without
   LIFF (`takeoverReady`). ngrok's free-plan warning page may break LIFF init, which is another reason for
   a stable domain.
3. **Other containers on this Mac are unfenced.** These are other projects' dev containers. They can reach
   Piko's published ports and the Mac's loopback services. boxd and websockify need tokens, but Temporal
   (:7233, :8233) has no auth. In production Piko gets its own host. On this Mac, Docker can't switch off
   `host.docker.internal` per network (that needs Docker Business's air-gap PAC).
4. **The control plane trusts the machine.** Temporal has no auth and the store is plain files. Anyone with
   a shell on the host has everything. In production: Temporal Cloud or mTLS, Postgres with encryption at
   rest, and boxes on hosts separate from the control plane.
5. **One box per user, not one per session.** A compromise of a user's box lasts until the box is
   recreated. Consider periodic recreation (the volumes keep the profile) and image rebuilds for Chromium
   updates.

6. **Docker Desktop is behind.** It's on 4.79.0; 4.97.0 fixes a containerd CVE (2026-53495), a
   `docker cp` escape (2026-17106) and a compromised-CA distrust. Updating restarts Docker for every
   project on this Mac, so it's the user's call.

## The tools underneath

Audited 2026-10-27, Debian bookworm versions installed in the box. An image built today has no pending
upgrades. Rebuild weekly, and when Debian ships Chrome 157 (upstream 2026-11-03).

| Component | Language | Who can reach it | Status |
|---|---|---|---|
| ngrok agent | Go | the internet | Inspection off. TLS ends at ngrok (see open item 1). |
| Gateway (ours) | TypeScript / Node | the internet, via ngrok | Signed webhooks, the checks above, body limits |
| Temporal dev server | Go | 127.0.0.1 only; boxes are fenced from it | No auth (dev). Production needs mTLS or Cloud. |
| npm dependencies (218) | JS | — | `pnpm audit`: no known vulnerabilities. Build scripts are blocked (`allowBuilds`). Versions pinned by lockfile. |
| noVNC 1.7.0 | JS (runs on the phone) | served by us | No advisories; pinned exactly; no dependencies |
| LIFF SDK 2.31.2 | JS (runs on the phone) | LINE's CDN, path-scoped by CSP | Pinned past CVE-2026-112148 |
| websockify 0.10.0 | Python | box loopback, only through our proxy, with a token | No CVEs. No frame-size limit upstream (needs a valid token). |
| x11vnc 0.9.16 / libvncserver 0.9.14 | C | websockify only, inside the box | No open Debian issues. The 2026 libvncserver CVEs are fixed. |
| Xvfb (X.Org 21.1.7) | C | processes in the box | **11 unfixed memory-safety bugs.** Contained by the `screen` user, a fresh server per takeover and MIT-SHM off. Move to trixie when it gets fixes. |
| Chromium 156 | C++ | browses untrusted sites | Current with bookworm-security. Its own sandbox is on, under our seccomp profile. |
| ImageMagick, ffmpeg, poppler, libheif | C | files the agent opens | Many open low-severity issues. They run as `agent`, so the blast radius is the agent's own (fenced). To do: an ImageMagick format allowlist. |
| boxd (ours) | JS on Node 18 (Debian-patched) | Piko's worker, with a token | Origin and token are checked before the body is read |
| Docker Desktop 4.79 | Go | — | Update to 4.97 (open item 6) |

**About Rust.** None of this is Rust, and it doesn't need to be. Memory safety matters most where
untrusted bytes are parsed:
- **Internet-facing:** ngrok (Go) and our gateway (TypeScript). Both are memory-safe.
- **The C components** (the VNC stack and the X server) are reachable only after authentication, from
  inside the box, run as users that hold nothing, and are replaced at every takeover.
- **What a memory-safe rewrite would buy:** the biggest win would be a memory-safe X server or VNC server.
  None is production-ready today. The containment above is the practical answer until there is one, or
  until a Wayland compositor stack replaces X.
