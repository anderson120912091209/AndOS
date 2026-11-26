#!/bin/bash
# Download SenseVoice-Small (int8), Relay's fast speech engine: Mandarin, English, Japanese,
# Korean and Cantonese, about 5× faster than Whisper and on the CPU, so a MacBook Air keeps up.
# ~240 MB, one time, checked against Hugging Face's published SHA-256.
# Model: SenseVoice-Small by Alibaba's FunASR team (FunASR Model License 1.1: credit the source
# and keep the model's name), converted to ONNX by sherpa-onnx.
set -euo pipefail

DIR="$HOME/Library/Application Support/Relay/models/sensevoice-small-int8"
BASE="https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
MODEL_SHA256=c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51

mkdir -p "$DIR"
if [ -s "$DIR/model.int8.onnx" ] && [ -s "$DIR/tokens.txt" ]; then
  echo "✓ SenseVoice already present: $DIR"
  exit 0
fi

echo "› downloading SenseVoice-Small → $DIR"
curl -L --fail --progress-bar -o "$DIR/model.int8.onnx.part" "$BASE/model.int8.onnx"
echo "$MODEL_SHA256  $DIR/model.int8.onnx.part" | shasum -a 256 -c --quiet
mv "$DIR/model.int8.onnx.part" "$DIR/model.int8.onnx"
curl -L --fail --silent --show-error -o "$DIR/tokens.txt" "$BASE/tokens.txt"
echo "✓ $(du -sh "$DIR" | cut -f1) $DIR"
