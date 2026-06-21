import AppKit

/// Shared access to the goddess mascot frames (bundled SwiftPM resources). The
/// avatar is FRAME-BASED: drop additional PNGs into Resources and Muse animates
/// real behaviours (blink, wink, talk, emotions). Every frame is optional and
/// falls back to the neutral portrait, so behaviours light up as art is added.
///
/// Naming (all transparent PNGs, same canvas as the hero):
///   muse-goddess.png         neutral (required — the base portrait)
///   muse-goddess-blink.png   eyes closed (blink)
///   muse-goddess-wink.png    one eye closed (playful wink)
///   muse-goddess-talk.png    mouth open (lip-sync while speaking)
///   muse-goddess-happy.png   smiling (listening / greeting)
///   muse-goddess-think.png   thinking (while generating)
enum MuseAssets {
    private static var cache: [String: NSImage?] = [:]

    /// Load a frame by suffix ("" = neutral `muse-goddess.png`). Cached; nil when
    /// that frame hasn't been provided.
    static func frame(_ suffix: String = "") -> NSImage? {
        let name = suffix.isEmpty ? "muse-goddess" : "muse-goddess-\(suffix)"
        if let cached = cache[name] { return cached }
        var image: NSImage?
        for bundle in [Bundle.module, Bundle.main] {
            if let url = bundle.url(forResource: name, withExtension: "png"),
               let img = NSImage(contentsOf: url) { image = img; break }
        }
        cache[name] = image
        return image
    }

    /// The neutral goddess portrait (used by Settings header etc.).
    static var goddess: NSImage? { frame() }

    /// Is a non-neutral frame available? (Lets the avatar know real frames exist.)
    static func hasFrame(_ suffix: String) -> Bool { frame(suffix) != nil }

    /// A menu-bar-sized rendering of the neutral portrait (kept for callers that
    /// want the face; the status bar itself uses a crisp music-note glyph).
    static func menuBarIcon(height: CGFloat = 18) -> NSImage {
        guard let g = goddess, g.size.height > 0 else {
            return NSImage(size: NSSize(width: height, height: height))
        }
        let size = NSSize(width: height * (g.size.width / g.size.height), height: height)
        let img = NSImage(size: size)
        img.lockFocus()
        g.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .sourceOver, fraction: 1)
        img.unlockFocus()
        img.isTemplate = false
        return img
    }
}
