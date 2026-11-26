#!/bin/bash
# sherpa-onnx (Apache-2.0) and ONNX Runtime (MIT), which run SenseVoice, Relay's fast speech
# engine. Prebuilt universal (Apple silicon + Intel) macOS libraries from the sherpa-onnx
# release, checked against the release's SHA-256, unpacked into Vendor/sherpa-onnx (include/
# and lib/). build.sh copies the dylibs into Relay.app/Contents/Frameworks.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=2.0.0
NAME="sherpa-onnx-v$VERSION-osx-universal2-shared-no-tts"
SHA256=1b1626b7e2f0873bac0e7d9f81e136547eee506d25f6d36548c9d2e93424d985
OUT=Vendor/sherpa-onnx

if [ -f "$OUT/lib/libsherpa-onnx-c-api.dylib" ] && [ "$(cat "$OUT/VERSION" 2>/dev/null)" = "$VERSION-universal2" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "› downloading sherpa-onnx $VERSION"
curl -L --fail --silent --show-error -o "$TMP/$NAME.tar.bz2" \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$VERSION/$NAME.tar.bz2"
echo "$SHA256  $TMP/$NAME.tar.bz2" | shasum -a 256 -c --quiet
tar xjf "$TMP/$NAME.tar.bz2" -C "$TMP"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$TMP/$NAME/include" "$TMP/$NAME/lib" "$OUT/"
echo "$VERSION-universal2" > "$OUT/VERSION"
echo "✓ sherpa-onnx $VERSION → $OUT"
