#!/bin/sh
# Bring up the computer: a fence → screen → browser → the agent's hands (boxd) → the viewer for
# takeovers.
#
# This script starts as root only to put the fence up. Every process it leaves running runs as
# `relay` (screen, browser, viewer) or `agent` (boxd and whatever the agent starts), each with a
# clean environment, so none of the box's tokens leak into what the agent can read.
set -eu
: "${RELAY_BOX_TOKEN:?the server sets a fresh token for the viewer}"
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

# 0. The fence. Everything in the box may reach the internet and itself, and nothing else:
#    - not the machine running the box (host.docker.internal: on a Mac it reaches every service bound to
#      the Mac's localhost — Temporal, Piko's gateway, ngrok's local API), other boxes, or private networks;
#    - not a cloud machine's metadata service (169.254.169.254);
#    - and the agent's shell not the raw VNC screens or the viewer either.
#    It holds for every user in the box, `relay` included: the agent drives the browser, and a page that
#    talked it into opening http://host.docker.internal:8233 would otherwise get there as `relay`.
#    Replies on connections someone else opened (Piko's worker to boxd, the takeover screen) stay allowed.
fence() {
  iptables -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -w -A OUTPUT -m owner --uid-owner agent -o lo -p tcp -m multiport --dports 5900,5901,6080,9222,9223 -j REJECT
  iptables -w -A OUTPUT -o lo -j ACCEPT
  # Name lookups go to the box's own resolver, which may sit on a private address: port 53 only.
  for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf | grep -v ':'); do
    iptables -w -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
    iptables -w -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
  done
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 0.0.0.0/8 198.18.0.0/15 224.0.0.0/4; do
    iptables -w -A OUTPUT -d "$net" -j REJECT
  done
  for name in host.docker.internal gateway.docker.internal host.lima.internal; do
    for ip in $(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u); do
      iptables -w -A OUTPUT -d "$ip" -j REJECT
    done
  done
  # No IPv6 beyond loopback; if the box has no IPv6 filter, it must have no IPv6 beyond loopback.
  if ip6tables -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; then
    ip6tables -w -A OUTPUT -o lo -j ACCEPT
    ip6tables -w -A OUTPUT -j REJECT
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

# 1. A screen (Xvfb, as `screen`), a window manager so the apps the agent opens get proper windows, and
#    the always-on watching VNC. agentctl owns them, because every takeover starts on a fresh one. A box
#    that restarted (a crash, Docker Desktop restarting) still has the last run's lock files, and
#    Chromium would refuse to start over them; nothing is running yet, so they're stale.
rm -f /home/relay/profile/SingletonLock /home/relay/profile/SingletonSocket /home/relay/profile/SingletonCookie
/opt/relay/agentctl screen >/dev/null

# 2. The browser, kept alive: if it's closed or crashes, it comes straight back with the same
#    profile (your sign-ins) and its tabs, the one that was in front still in front (no start URL: one
#    would open a new tab on top, hiding the sign-in page a takeover was meant to show). It has no DevTools port at all: Piko works the screen through boxd, and a
#    DevTools door would hand anyone who reached it the cookies of every site the user signed in to.
#    It fills whatever screen there is, at the scale agentctl chose for it (2 on a phone-shaped takeover
#    screen, so sites lay out for a phone).
as relay sh -c '
  while true; do
    scale=$(cut -d" " -f2 /run/relay/screen 2>/dev/null)
    case "$scale" in 1|2) ;; *) scale=1 ;; esac
    chromium \
      --user-data-dir=/home/relay/profile \
      --start-maximized --force-device-scale-factor="$scale" \
      --no-first-run --no-default-browser-check --password-store=basic \
      --disable-dev-shm-usage --hide-crash-restore-bubble \
      '"${RELAY_BOX_CHROMIUM_FLAGS:-}"' \
      >'"$LOG"'/chromium.log 2>&1 || true
    sleep 1
  done' &


# 6. The agent's hands (boxd: a shell, files, the screen, mouse and keyboard — only behind the fence).
#    agentctl owns them, because a takeover stops them while you have the box and starts them again
#    when you hand it back.
/opt/relay/agentctl up >/dev/null || true

# 5. The viewer: the screen over VNC (inside the box only), behind websockify, and only to whoever holds a
#    token. The page that shows it (noVNC) is served by Piko's gateway, not from the box. Watching is
#    always on; the screen that takes typing is agentctl's to open during a takeover.
exec env -i PATH="$PATH" HOME=/home/relay USER=relay LANG=C.UTF-8 \
  setpriv --reuid=relay --regid=relay --init-groups --inh-caps=-all -- \
  /opt/relay/no-userns websockify --token-plugin TokenFile --token-source /tmp/relay-tokens 6080
