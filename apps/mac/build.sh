#!/bin/bash
# Compile the Swift package and assemble a runnable Relay.app bundle.
# Menu-bar apps need a real bundle (Info.plist + signature) for macOS permissions to
# attach, so we can't just run the bare executable.
#
# This is the full dev app. RELAY_EDITION=dictation builds the download for other people instead
# (scripts/release.sh): no AI half, and the server's dictation cleanup bundled in as scribe.js.
#   RELAY_APP       where the bundle goes (default Relay.app)
#   RELAY_VERSION   the version people see (default 0.1.0)
set -euo pipefail
cd "$(dirname "$0")"
EDITION="${RELAY_EDITION:-}"
APP="${RELAY_APP:-Relay.app}"
VERSION="${RELAY_VERSION:-0.1.0}"

# whisper.cpp static libs, universal (first build, ~40 s), and again whenever Relay's patches to it change.
LIB=Vendor/whisper-universal/src/libwhisper.a
if [ ! -f "$LIB" ] || [ -n "$(find scripts -name 'whisper-*.patch' -newer "$LIB")" ]; then
  ./scripts/build-whisper.sh
fi
# The speech model lives outside the app (~570 MB, one-time). Without it Relay falls back
# to Apple Speech in a single language.
if [ ! -s "$HOME/Library/Application Support/Relay/models/ggml-large-v3-turbo-q5_0.bin" ]; then
  echo "  note: Whisper model missing — run ./scripts/fetch-model.sh for any-language dictation"
fi

# sherpa-onnx + ONNX Runtime for SenseVoice, the fast engine (once, ~17 MB).
./scripts/fetch-sherpa.sh

# The dev app is this Mac's own architecture. RELAY_UNIVERSAL=1 (scripts/release.sh) builds both
# Apple silicon and Intel and joins them into one binary that runs on either.
if [ -n "${RELAY_UNIVERSAL:-}" ]; then
  echo "› swift build -c release (Apple silicon + Intel)"
  # Each architecture in its own build folder: two triples in one .build overwrite each other's
  # build plan ("command … not registered"), and a dev build running alongside can't touch them.
  BIN="$(mktemp -d)/Relay"
  SLICES=()
  for arch in arm64 x86_64; do
    args=(-c release --triple "$arch-apple-macosx13.0" --scratch-path ".build-release/$arch")
    swift build "${args[@]}"
    SLICES+=("$(swift build "${args[@]}" --show-bin-path)/Relay")
  done
  lipo -create -output "$BIN" "${SLICES[@]}"
else
  echo "› swift build -c release"
  swift build -c release
  BIN="$(swift build -c release --show-bin-path)/Relay"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Relay"
# The icon (drawn in code; regenerate with ./scripts/make-icon.sh) — it's how you spot Relay
# in System Settings' Accessibility list during setup.
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# The About window shows it: the speech engines Relay runs, and the credit their licenses ask for.
cp Resources/Credits.html "$APP/Contents/Resources/Credits.html"
# SenseVoice's runtime, where the binary looks for it (@executable_path/../Frameworks).
mkdir -p "$APP/Contents/Frameworks"
cp Vendor/sherpa-onnx/lib/libsherpa-onnx-c-api.dylib Vendor/sherpa-onnx/lib/libonnxruntime.dylib "$APP/Contents/Frameworks/"
EDITION_KEY=""
if [ "$EDITION" = "dictation" ]; then
  # The server's own dictation cleanup, for the app to run itself (LocalScribe.swift). Targeting
  # safari16, the JavaScript engine of macOS 13, makes esbuild turn any regex that engine can't
  # parse into a `new RegExp` call, so the bundle always loads.
  ../../node_modules/.bin/esbuild scripts/scribe-entry.ts --bundle --format=iife --global-name=RelayScribe \
    --target=safari16 --log-level=warning --outfile="$APP/Contents/Resources/scribe.js"
  EDITION_KEY="<key>RelayEdition</key><string>dictation</string>"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.relay.mac</string>
  <key>CFBundleName</key><string>Relay</string>
  <key>CFBundleExecutable</key><string>Relay</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Relay listens when you hold the dictation shortcut, so it can turn your speech into text.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Relay transcribes your speech, on-device when your Mac supports it.</string>
  ${EDITION_KEY}
</dict>
</plist>
PLIST

# Signing. macOS ties the Accessibility approval (needed to paste) to the code signature.
# The default ad-hoc signature changes on every build, which leaves the old approval stale:
# the switch in System Settings still looks on, but Relay can't paste. So when the signature
# changes we clear that stale approval and Relay asks again on launch — one click.
# Set RELAY_SIGN_IDENTITY to a code-signing identity in your keychain to keep one signature
# across builds (approvals then survive rebuilds).
IDENTITY="${RELAY_SIGN_IDENTITY:--}"
# The bundled libraries first, then the app that contains them.
for lib in "$APP"/Contents/Frameworks/*.dylib; do
  codesign --force --sign "$IDENTITY" "$lib" >/dev/null 2>&1 || echo "  (codesign failed: $(basename "$lib"))"
done
codesign --force --sign "$IDENTITY" "$APP" >/dev/null 2>&1 || echo "  (codesign failed)"
# Only for the dev app: a release build shares the bundle id, and must leave your approval alone.
if [ "$IDENTITY" = "-" ] && [ -z "$EDITION" ]; then
  CDHASH="$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
  STAMP=".build/relay-cdhash"
  if [ -n "$CDHASH" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$CDHASH" ]; then
    if tccutil reset Accessibility com.relay.mac >/dev/null 2>&1; then
      echo "  new signature → cleared the old Accessibility approval; Relay will ask once on launch"
    fi
    echo "$CDHASH" > "$STAMP"
  fi
fi

echo "✓ Built $(pwd)/$APP"

# A Relay that's already running keeps the old build in memory, and `open` on a running app
# only brings that old process forward. So --open quits it first and starts the new build.
RUNNING="$(pwd)/$APP/Contents/MacOS/Relay"
if [ "${1:-}" = "--open" ]; then
  if pgrep -f "$RUNNING" >/dev/null; then
    osascript -e 'quit app id "com.relay.mac"' >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do pgrep -f "$RUNNING" >/dev/null || break; sleep 0.1; done
  fi
  open "$APP"
  echo "  Started the new build"
elif pgrep -f "$RUNNING" >/dev/null; then
  echo "  Relay is still running the previous build: ./build.sh --open restarts it"
else
  echo "  Run it:   open $APP   (or ./build.sh --open next time)"
fi
echo "  Logs:     /usr/bin/log stream --predicate 'subsystem == \"com.relay.mac\"'"
