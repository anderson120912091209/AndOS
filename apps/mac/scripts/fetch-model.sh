#!/bin/bash
# Download the Whisper model Relay uses for dictation (multilingual, auto language
# detection, handles English/Mandarin code-switching). ~570 MB, one time.
set -euo pipefail

MODEL="${RELAY_WHISPER_MODEL:-ggml-large-v3-turbo-q5_0.bin}"
DIR="$HOME/Library/Application Support/Relay/models"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"

mkdir -p "$DIR"
if [ -s "$DIR/$MODEL" ]; then
  echo "✓ model already present: $DIR/$MODEL"
  exit 0
fi

echo "› downloading $MODEL → $DIR"
curl -L --fail --progress-bar -o "$DIR/$MODEL.part" "$URL"
mv "$DIR/$MODEL.part" "$DIR/$MODEL"
echo "✓ $(du -h "$DIR/$MODEL" | cut -f1) $DIR/$MODEL"
