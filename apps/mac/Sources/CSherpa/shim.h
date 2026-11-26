// Exposes sherpa-onnx's C API (SenseVoice) to Swift. The include path comes from Package.swift;
// the library is weak-linked, so a build without it still runs (Whisper only).
#include <sherpa-onnx/c-api/c-api.h>
