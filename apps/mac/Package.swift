// swift-tools-version:5.9
import PackageDescription

// whisper.cpp is built as static libraries by scripts/build-whisper.sh — Apple silicon (Metal)
// and Intel (AVX2), merged into one universal set in Vendor/whisper-universal — and linked
// straight into the app, with no runtime dependency on Homebrew.
// sherpa-onnx (SenseVoice, the fast engine) comes prebuilt from scripts/fetch-sherpa.sh. It's
// weak-linked: build.sh puts its dylibs in Relay.app/Contents/Frameworks, and a binary run
// without them still works, with Whisper only.
let root = Context.packageDirectory
let whisperInclude = "\(root)/Vendor/whisper.cpp/include"
let ggmlInclude = "\(root)/Vendor/whisper.cpp/ggml/include"
let whisperBuild = "\(root)/Vendor/whisper-universal"
let sherpa = "\(root)/Vendor/sherpa-onnx"

let package = Package(
  name: "Relay",
  platforms: [.macOS(.v13)],
  targets: [
    .systemLibrary(name: "CWhisper", path: "Sources/CWhisper"),
    .systemLibrary(name: "CSherpa", path: "Sources/CSherpa"),
    .executableTarget(
      name: "Relay",
      dependencies: ["CWhisper", "CSherpa"],
      path: "Sources/Relay",
      swiftSettings: [
        .unsafeFlags(["-Xcc", "-I\(whisperInclude)", "-Xcc", "-I\(ggmlInclude)", "-Xcc", "-I\(sherpa)/include"]),
      ],
      linkerSettings: [
        .unsafeFlags([
          "-L\(whisperBuild)/src",
          "-L\(whisperBuild)/ggml/src",
          "-L\(whisperBuild)/ggml/src/ggml-metal",
          "-L\(whisperBuild)/ggml/src/ggml-blas",
          "-lwhisper", "-lparakeet", "-lggml", "-lggml-base", "-lggml-cpu", "-lggml-metal", "-lggml-blas",
          "-lc++",
          "-L\(sherpa)/lib",
          "-Xlinker", "-weak-lsherpa-onnx-c-api",
          "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
        ]),
        .linkedFramework("Metal"),
        .linkedFramework("MetalKit"),
        .linkedFramework("Accelerate"),
        .linkedFramework("Foundation"),
      ]
    ),
  ]
)
