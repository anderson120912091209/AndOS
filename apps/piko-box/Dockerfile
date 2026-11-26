# Relay's computer: a whole Linux desktop in a container on your Mac — a screen, a real Chromium
# with your sign-ins, and a workspace with a shell where the agent can run anything it needs.
#
# The agent works it two ways: Chromium over the Chrome DevTools Protocol (fast, for websites), and
# boxd — the box's hands — for a shell, files, screenshots, mouse and keyboard (apps/box/boxd).
# When a site needs *you* — a password, a 2FA code — you take over the same screen from the Box
# window and hand it back.
#
# Two users, so the agent's shell can't reach your sign-ins:
#   relay  runs the screen, the browser and the viewer; owns the profile (mode 700)
#   agent  runs boxd and everything the agent starts; owns the workspace /home/agent
# start.sh also fences both users off the machine running the box, other boxes and private networks.
#
# Nothing here is reachable from outside the machine: Piko publishes the viewer and boxd on 127.0.0.1
# only, and each needs its own fresh token. (Piko's copy has no DevTools port; see start.sh.)
#
# Build from the repo root:  docker build -t relay-browser apps/box
FROM debian:bookworm-slim

# upgrade first: the base image can be weeks behind bookworm-security.
RUN apt-get -o Acquire::Retries=5 update \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 upgrade -y \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      chromium xvfb x11vnc websockify curl ca-certificates tini procps \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      openbox xdotool xsel imagemagick iptables util-linux python3-seccomp \
      nodejs bash python3 python3-pip python3-venv git jq ripgrep file less unzip zip poppler-utils \
      ffmpeg pandoc \
 && rm -rf /var/lib/apt/lists/*

# The toolkit for real outputs, so "make me slides / a chart / a short animation / a PDF" ends in a
# file you can open, not a wall of text: decks (python-pptx), documents (python-docx), spreadsheets
# (openpyxl), charts (matplotlib), PDFs (reportlab), images (pillow). ffmpeg and pandoc came from apt
# above. Installed into the system site so the agent's own `python3` finds them with no venv to
# activate. --break-system-packages: Debian guards the system Python, but this is a throwaway box.
RUN pip3 install --no-cache-dir --break-system-packages \
      python-pptx python-docx openpyxl matplotlib reportlab pillow

COPY start.sh /opt/relay/start.sh
COPY boxd/boxd.mjs /opt/relay/boxd.mjs
COPY agentctl /opt/relay/agentctl
COPY no-userns /opt/relay/no-userns
COPY chromium-policy.json /etc/chromium/policies/managed/relay.json
# relay joins agent's group: the browser may read and write the agent's workspace (uploads,
# downloads); the agent never gets into relay's home. `screen` runs the X server and window manager and
# can read neither: X.Org has unfixed memory-safety bugs, and a hijacked X server must not reach the
# sign-ins. No program in the box may raise privileges:
# the setuid/setgid bits come off everything (su, passwd, mount…), and the server also runs the box
# with no-new-privileges.
# Every window fills the screen, whatever size it remembers: the screen changes shape for a takeover
# (phone-shaped, see agentctl), and a restored Chromium would otherwise keep its old desktop size.
RUN sed -i 's#</applications>#  <application class="*"><maximized>yes</maximized></application>\n</applications>#' /etc/xdg/openbox/rc.xml \
 && grep -q '<application class="\*"><maximized>yes' /etc/xdg/openbox/rc.xml

RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && chmod 755 /opt/relay/start.sh /opt/relay/no-userns && chmod 700 /opt/relay/agentctl \
 && chmod 644 /opt/relay/boxd.mjs /etc/chromium/policies/managed/relay.json \
 && useradd --create-home --uid 1000 relay \
 && useradd --create-home --uid 1001 --shell /bin/bash agent \
 && useradd --create-home --uid 1002 screen \
 && usermod -aG agent relay \
 && mkdir -p /home/relay/profile /home/agent/Downloads \
 && chown -R relay:relay /home/relay && chmod 700 /home/relay \
 && chown -R agent:agent /home/agent && chmod 2770 /home/agent && chmod 2775 /home/agent/Downloads

# start.sh begins as root only to fence the agent's shell in, then runs everything as relay or agent.
ENV DISPLAY=:99 SCREEN=1280x800
# 6080 → the takeover screen (token-gated, reached only through Piko's gateway); 7070 → boxd (token-gated).
EXPOSE 6080 7070
# -g: `docker stop` reaches the whole process group, so the browser shuts down cleanly (and keeps
# your session) instead of being killed mid-write when the stop times out.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/relay/start.sh"]
