#!/bin/bash
# Build whisper.cpp as static libraries into apps/mac/Vendor, so Relay links it in and ships
# self-contained — no Homebrew dependency at runtime. Two builds, merged into one universal set
# of libraries (Vendor/whisper-universal) that Package.swift links:
#   arm64   Apple silicon: Metal (the GPU does the work)
#   x86_64  Intel: AVX2/FMA/F16C, which every Intel Mac that runs macOS 13 has. Metal is built
#           in so both builds link the same libraries, but Relay doesn't use the GPU on Intel.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${WHISPER_TAG:-v1.9.5}"
SRC="Vendor/whisper.cpp"
ARM="Vendor/whisper-build"
INTEL="Vendor/whisper-build-x86_64"
OUT="Vendor/whisper-universal"

if [ ! -d "$SRC/.git" ]; then
  echo "› cloning whisper.cpp $TAG"
  git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$SRC"
fi

# Relay's own changes to whisper.cpp (scripts/whisper-*.patch), each applied once.
#   whisper-encode-once: language detection's encoder pass is reused for the transcript,
#   so an utterance costs one encoder pass instead of two (about twice as fast).
for patch in "$PWD"/scripts/whisper-*.patch; do
  if git -C "$SRC" apply --reverse --check "$patch" 2>/dev/null; then continue; fi # already in
  echo "› applying $(basename "$patch")"
  git -C "$SRC" apply "$patch"
done

COMMON=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_METAL=ON
  -DGGML_METAL_EMBED_LIBRARY=ON
  -DGGML_NATIVE=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_SDL2=OFF
)

echo "› Apple silicon (static, Metal, embedded shaders)"
cmake -S "$SRC" -B "$ARM" "${COMMON[@]}" -DCMAKE_OSX_ARCHITECTURES=arm64 -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
cmake --build "$ARM" --config Release -j "$(sysctl -n hw.ncpu)" >/dev/null

echo "› Intel (static, AVX2)"
cmake -S "$SRC" -B "$INTEL" "${COMMON[@]}" -DCMAKE_OSX_ARCHITECTURES=x86_64 -DWHISPER_BUILD_EXAMPLES=OFF \
  -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON >/dev/null
cmake --build "$INTEL" --config Release -j "$(sysctl -n hw.ncpu)" >/dev/null

echo "› merging into $OUT"
rm -rf "$OUT"
(cd "$INTEL" && find . -name '*.a') | while read -r lib; do # the libraries, not the dev tools' extras
  mkdir -p "$OUT/$(dirname "$lib")"
  lipo -create "$ARM/$lib" "$INTEL/$lib" -output "$OUT/$lib"
done

echo "✓ universal static libs:"
find "$OUT" -name '*.a' | while read -r lib; do echo "  $lib ($(lipo -archs "$lib"))"; done
echo "✓ cli (Apple silicon): $(find "$ARM" -name whisper-cli -type f | head -1)"
