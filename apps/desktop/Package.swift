// swift-tools-version: 6.0
import PackageDescription

// Muse Desktop — a native macOS floating companion (an always-on-top,
// transparent, draggable pixel-art Muse you click to talk to). It shares the
// SAME local Muse runtime as the CLI/server by shelling out to the `muse` CLI
// (`muse ask --local`), so the local-only privacy guarantee holds end-to-end
// and there is no second agent implementation to keep in sync.
let package = Package(
    name: "MuseDesktop",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Argmax Open-Source SDK (MIT) — on-device speech AI for Apple Silicon:
        //   • WhisperKit: speech-to-text (Whisper on CoreML + Neural Engine,
        //     native real-time streaming).
        //   • TTSKit: text-to-speech (Qwen3-TTS, Apache-2.0 weights) — natural
        //     spoken replies on-device.
        // Both run entirely local; audio never leaves the Mac, no cloud, no key.
        .package(url: "https://github.com/argmaxinc/argmax-oss-swift.git", exact: "1.0.0")
    ],
    targets: [
        // Pure, headless-testable bridge to the Muse CLI (no AppKit).
        .target(name: "MuseDesktopCore"),
        // The AppKit app (NSPanel companion window).
        .executableTarget(
            name: "MuseDesktop",
            dependencies: [
                "MuseDesktopCore",
                .product(name: "WhisperKit", package: "argmax-oss-swift"),
                .product(name: "TTSKit", package: "argmax-oss-swift")
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "MuseDesktopCoreTests",
            dependencies: ["MuseDesktopCore"]
        )
    ],
    // Latest Swift 6 toolchain + 6.0 manifest. Language mode stays v5 until the
    // bundled on-device voice SDK (WhisperKit / TTSKit) is Sendable-clean — full
    // Swift 6 strict-concurrency would otherwise require wrapping the whole audio
    // stack in actors. Migrate to .v6 as the SDK catches up.
    swiftLanguageModes: [.v5]
)
