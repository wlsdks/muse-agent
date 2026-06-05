// swift-tools-version: 5.9
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
        // On-device speech-to-text: WhisperKit (Argmax, MIT) runs Whisper on
        // CoreML + the Apple Neural Engine with native real-time streaming — no
        // shell-out, no temp WAV, no cloud. Audio never leaves the Mac.
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", .upToNextMinor(from: "0.9.4"))
    ],
    targets: [
        // Pure, headless-testable bridge to the Muse CLI (no AppKit).
        .target(name: "MuseDesktopCore"),
        // The AppKit app (NSPanel companion window).
        .executableTarget(
            name: "MuseDesktop",
            dependencies: [
                "MuseDesktopCore",
                .product(name: "WhisperKit", package: "WhisperKit")
            ]
        ),
        .testTarget(
            name: "MuseDesktopCoreTests",
            dependencies: ["MuseDesktopCore"]
        )
    ]
)
