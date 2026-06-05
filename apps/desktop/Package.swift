// swift-tools-version: 5.9
import PackageDescription

// Muse Desktop — a native macOS floating companion (an always-on-top,
// transparent, draggable pixel-art Muse you click to talk to). It shares the
// SAME local Muse runtime as the CLI/server by shelling out to the `muse` CLI
// (`muse ask --local`), so the local-only privacy guarantee holds end-to-end
// and there is no second agent implementation to keep in sync.
let package = Package(
    name: "MuseDesktop",
    platforms: [.macOS(.v13)],
    targets: [
        // Pure, headless-testable bridge to the Muse CLI (no AppKit).
        .target(name: "MuseDesktopCore"),
        // The AppKit app (NSPanel companion window).
        .executableTarget(
            name: "MuseDesktop",
            dependencies: ["MuseDesktopCore"]
        ),
        .testTarget(
            name: "MuseDesktopCoreTests",
            dependencies: ["MuseDesktopCore"]
        )
    ]
)
