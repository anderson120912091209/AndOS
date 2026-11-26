#!/bin/sh
# Bring up Relay's computer: a fence for the agent's shell → screen → browser → CDP for the
# agent → the agent's hands (boxd) → the viewer for you.
#
# This script starts as root only to put the fence up. Every process it leaves running runs as
# `relay` (screen, browser, viewer) or `agent` (boxd and whatever the agent starts), each with a
# clean environment, so none of the box's tokens leak into what the agent can read.
set -eu
: "${RELAY_BOX_TOKEN:?the server sets a fresh token for the viewer}"
W=${SCREEN%x*}; H=${SCREEN#*x}
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Run a command as relay or agent: that user's ids and groups, and an environment with nothing in it
# but the basics.
# Always started with `&`, so the exec replaces only that background subshell: no root shell
# lingers as the parent of what the agent can reach.
as() {
  who=$1; shift
  exec env -i PATH="$PATH" HOME="/home/$who" USER="$who" LOGNAME="$who" LANG=C.UTF-8 DISPLAY=:99 SCREEN="$SCREEN" \
    setpriv --reuid="$who" --regid="$who" --init-groups --inh-caps=-all -- "$@"
}

# 0. The fence. The agent's shell may reach the internet, but not:
#    - the browser's DevTools (cookie values), the raw VNC screen, or the viewer;
#    - your Mac (host.docker.internal — Relay's server holds your tokens), other containers,
#      or private networks;
#    - a cloud machine's metadata service (169.254.169.254).
#    Replies on connections someone else opened to boxd (the worker) stay allowed.
fence() {
  iptables -w -A OUTPUT -m owner --uid-owner agent -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Name lookups go to the box's own resolver, which may sit on a private address: port 53 only.
  for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf | grep -v ':'); do
    iptables -w -A OUTPUT -m owner --uid-owner agent -d "$ns" -p udp --dport 53 -j ACCEPT
    iptables -w -A OUTPUT -m owner --uid-owner agent -d "$ns" -p tcp --dport 53 -j ACCEPT
  done
  iptables -w -A OUTPUT -m owner --uid-owner agent -o lo -p tcp -m multiport --dports 5900,5901,6080,9222,9223 -j REJECT
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    iptables -w -A OUTPUT -m owner --uid-owner agent -d "$net" -j REJECT
  done
  for name in host.docker.internal gateway.docker.internal host.lima.internal; do
    for ip in $(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u); do
      iptables -w -A OUTPUT -m owner --uid-owner agent -d "$ip" -j REJECT
    done
  done
  # No IPv6 for the agent at all; if the box has no IPv6 filter, it must have no IPv6 beyond loopback.
  if ip6tables -w -A OUTPUT -m owner --uid-owner agent -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; then
    ip6tables -w -A OUTPUT -m owner --uid-owner agent -j REJECT
  elif grep -qv ' lo$' /proc/net/if_inet6 2>/dev/null; then
    return 1
  fi
}
# /run/relay is root's: whether the fence is up, and whether a person has the box (agentctl).
# A hold survives a restart: if the box went down mid-takeover, the person may still be typing when
# it comes back, so agentctl decides (the hold's own 10-minute limit), not the boot.
install -d -m 755 /run/relay
rm -f /run/relay/fenced
if fence; then : > /run/relay/fenced; else echo "[box] couldn't fence the agent's shell in — boxd stays off" >&2; fi

# The viewer's tokens go to a file only `relay` can read (boxd's is handed over by agentctl):
#   RELAY_BOX_TOKEN       → :5900, the screen that takes typing — it only runs during a takeover
#   RELAY_BOX_VIEW_TOKEN  → :5901, the view-only screen — always on, for watching
printf '%s: 127.0.0.1:5900\n' "$RELAY_BOX_TOKEN" > /tmp/relay-tokens
[ -n "${RELAY_BOX_VIEW_TOKEN:-}" ] && printf '%s: 127.0.0.1:5901\n' "$RELAY_BOX_VIEW_TOKEN" >> /tmp/relay-tokens
chown relay:relay /tmp/relay-tokens && chmod 600 /tmp/relay-tokens

# relay's logs (the browser's can name pages you visited) stay where the agent can't read them.
install -d -o relay -g relay -m 700 /home/relay/log
LOG=/home/relay/log

# 1. A screen, and a window manager so the apps the agent opens get proper windows. A box that
#    restarted (a crash, Docker Desktop restarting) still has the last run's lock files, and Xvfb
#    and Chromium would refuse to start over them; nothing is running yet, so they're stale.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /home/relay/profile/SingletonLock /home/relay/profile/SingletonSocket /home/relay/profile/SingletonCookie
as relay Xvfb :99 -screen 0 "${SCREEN}x24" -nolisten tcp -nolisten unix -ac >"$LOG/xvfb.log" 2>&1 &
for _ in $(seq 50); do DISPLAY=:99 xdotool getdisplaygeometry >/dev/null 2>&1 && break; sleep 0.1; done
as relay openbox >"$LOG/openbox.log" 2>&1 &

# 2. The browser, kept alive: if it's closed or crashes, it comes straight back with the same
#    profile (your sign-ins). Its DevTools port only listens inside the box.
as relay sh -c '
  while true; do
    chromium \
      --user-data-dir=/home/relay/profile \
      --remote-debugging-port=9223 \
      --window-position=0,0 --window-size="'"$W,$H"'" \
      --no-first-run --no-default-browser-check --password-store=basic \
      --disable-dev-shm-usage --hide-crash-restore-bubble \
      '"${RELAY_BOX_CHROMIUM_FLAGS:-}"' \
      about:blank >'"$LOG"'/chromium.log 2>&1 || true
    sleep 1
  done' &


# 5. The viewer: the screen over VNC (inside the box only), shown through noVNC, and only to
#    whoever holds a token. Watching is always on; the screen that takes typing is agentctl's to open
#    during a takeover. (A server from before the view token gets the one typing screen, as before.)
if [ -n "${RELAY_BOX_VIEW_TOKEN:-}" ]; then
  as relay x11vnc -display :99 -rfbport 5901 -localhost -forever -shared -nopw -noxdamage -quiet -viewonly >"$LOG/x11vnc-view.log" 2>&1 &
else
  as relay x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -noxdamage -quiet >"$LOG/x11vnc.log" 2>&1 &
fi
sleep 0.3

# 6. The agent's side: CDP for its brain (the worker), and its hands (boxd: a shell, files, the
#    screen, mouse and keyboard — only behind the fence). agentctl owns both, because a takeover
#    stops them while you have the box and starts them again when you hand it back.
/opt/relay/agentctl up >/dev/null || true

exec env -i PATH="$PATH" HOME=/home/relay USER=relay LANG=C.UTF-8 \
  setpriv --reuid=relay --regid=relay --init-groups --inh-caps=-all -- \
  websockify --web /usr/share/novnc --token-plugin TokenFile --token-source /tmp/relay-tokens 6080
