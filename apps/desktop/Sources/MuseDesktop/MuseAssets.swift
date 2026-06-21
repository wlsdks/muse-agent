import AppKit

/// Shared access to the goddess mascot image (bundled SwiftPM resource), used by
/// the floating avatar, the menu-bar item, and the settings/web windows.
enum MuseAssets {
    /// The full-resolution goddess (transparent background). Loaded once.
    static let goddess: NSImage? = {
        for bundle in [Bundle.module, Bundle.main] {
            if let url = bundle.url(forResource: "muse-goddess", withExtension: "png"),
               let img = NSImage(contentsOf: url) { return img }
        }
        return nil
    }()

    /// A menu-bar-sized rendering, aspect-preserving (height-fit), grayscale kept
    /// (not a template) so the goddess reads as herself in the status bar.
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
