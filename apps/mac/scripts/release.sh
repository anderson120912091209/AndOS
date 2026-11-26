#!/bin/bash
# Package Relay for other people: the dictation edition, as a disk image anyone can download.
#
#   ./scripts/release.sh        → dist/Relay-<version>.dmg, and its .sha256
#
# Hold Fn, talk, and the words are typed where you are, on-device in any language. The AI half
# isn't in it yet (it needs Relay's server and worker), so nothing this app hears leaves the Mac;
# setup downloads the speech model once. Apple silicon or Intel, macOS 13 or later.
#
# Signing — without these the app is ad-hoc signed: it runs, but the first time, macOS makes people
# allow it in System Settings → Privacy & Security → Open Anyway, because Apple can't check it.
#   RELAY_SIGN_IDENTITY="Developer ID Application: …"   sign it with your Developer ID
#   RELAY_NOTARY_PROFILE=<name>                          and have Apple notarize the .dmg, so it
#                                                        opens with a double-click (make the profile
#                                                        once: xcrun notarytool store-credentials)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${RELAY_VERSION:-0.1.0}"
OUT=dist
APP="$OUT/Relay.app"
DMG="$OUT/Relay-$VERSION.dmg"
IDENTITY="${RELAY_SIGN_IDENTITY:--}"

rm -rf "$OUT"
echo "› building Relay $VERSION (dictation edition)"
RELAY_EDITION=dictation RELAY_UNIVERSAL=1 RELAY_APP="$APP" RELAY_VERSION="$VERSION" RELAY_SIGN_IDENTITY=- ./build.sh >/dev/null

# The cleanup it ships must write exactly what the server writes, in the engine it will run in.
../../node_modules/.bin/tsx scripts/scribe-check.ts "$APP/Contents/Resources/scribe.js"

if [ "$IDENTITY" != "-" ]; then
  echo "› signing with $IDENTITY"
  # The hardened runtime notarization requires; its one exception is the microphone.
  for lib in "$APP"/Contents/Frameworks/*.dylib; do
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$lib"
  done
  codesign --force --options runtime --timestamp --entitlements scripts/release.entitlements --sign "$IDENTITY" "$APP"
fi
codesign --verify --strict "$APP"

echo "› making $DMG"
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Relay.app"
ln -s /Applications "$STAGE/Applications" # drag Relay onto it to install
hdiutil create -volname "Relay $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"

if [ "$IDENTITY" != "-" ]; then
  codesign --force --timestamp --sign "$IDENTITY" "$DMG"
  if [ -n "${RELAY_NOTARY_PROFILE:-}" ]; then
    echo "› notarizing (a few minutes)"
    xcrun notarytool submit "$DMG" --keychain-profile "$RELAY_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
fi

(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "✓ $(pwd)/$DMG ($(du -h "$DMG" | cut -f1 | tr -d ' '))"
if [ "$IDENTITY" = "-" ]; then
  echo "  ad-hoc signed: people allow it once in System Settings → Privacy & Security → Open Anyway"
fi
