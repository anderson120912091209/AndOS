#!/bin/bash
# Render Relay's app icon (drawn in code — Sources/Relay/AppIcon.swift) into
# Resources/AppIcon.icns, which build.sh copies into the app. Re-run after changing the icon.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build >/dev/null
BIN="$(swift build --show-bin-path)/Relay"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RELAY_RENDER_SHOTS="$TMP" "$BIN" >/dev/null
SET="$TMP/AppIcon.iconset"
mkdir -p "$SET" Resources
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$TMP/app-icon-1024.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$TMP/app-icon-1024.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o Resources/AppIcon.icns
echo "✓ Resources/AppIcon.icns"
