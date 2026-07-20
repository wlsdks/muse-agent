// swift-tools-version: 6.0
import PackageDescription

// `muse-mac-helper` — a small, headless CLI that reads macOS state through
// Apple's native frameworks instead of driving GUI apps with AppleScript.
//
// Why it exists (measured on the owner's machine, 2026-07-20):
//   • Contacts via AppleScript: 3,273 ms AND it launches Contacts.app.
//     The same read through Contacts.framework: 131-175 ms, no GUI.
//   • A full AX window snapshot (13 apps / 18 windows): 190 ms, 681 bytes.
//     The screenshot it replaces: 1.9 MB.
//
// It is READ-ONLY by construction. There is no code path here that clicks,
// types, or synthesises any input event — per docs/design/macos-control.md,
// AX INPUT is excluded policy. Apple gates AX reads and AX control behind the
// SAME trust prompt (AXUIElement.h: "communicate with and control"), so that
// restraint is ours to keep in code, not something macOS enforces for us.
// Version posture (checked 2026-07-20 against the machine this is built on:
// macOS 26.5.1, SDK 26.5, Swift 6.3.3):
//   • Minimum is macOS 14, matching apps/desktop so the repo has ONE floor.
//     macOS 14 is also where EventKit's current auth API lands
//     (requestFullAccessToEvents; the older requestAccess is deprecated there),
//     so a lower floor would force a dual-path auth flow for no gain.
//   • Every AX symbol used here was checked for deprecation against SDK 26.5
//     and none is deprecated. Notably AXIsProcessTrustedWithOptions is the
//     REPLACEMENT for the deprecated AXAPIEnabled, so this uses the current
//     API rather than the legacy one.
//   • AXUIElementPostKeyboardEvent — the synthesised-keystroke call — has been
//     deprecated by Apple since 10.9. It is not used here, and its absence is
//     policy, not oversight.
let package = Package(
    name: "MuseMacHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MuseMacHelper", path: "Sources/MuseMacHelper")
    ]
)
