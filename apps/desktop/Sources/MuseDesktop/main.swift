import AppKit
import Foundation
import MuseDesktopCore

let arguments = CommandLine.arguments

/// Keep a user-supplied pixel scale in a sane range so a typo can't request a
/// multi-gigabyte bitmap (or a zero/negative one).
func clampScale(_ value: Int) -> Int { min(max(value, 1), 256) }

// Headless preview of the ACTIVE Muse: `MuseDesktop --render <png> [scale]`.
if let flag = arguments.firstIndex(of: "--render"), flag + 1 < arguments.count {
    let path = arguments[flag + 1]
    let scale = clampScale((flag + 2 < arguments.count ? Int(arguments[flag + 2]) : nil) ?? 18)
    do {
        let sprite = SpriteLibrary.named(ProcessInfo.processInfo.environment["MUSE_DESKTOP_CHARACTER"])
        try SpriteRenderer.renderPNG(sprite, to: URL(fileURLWithPath: path), scale: scale)
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("render failed: \(error)\n".utf8))
        exit(1)
    }
}

// Headless preview of ANY candidate design: `MuseDesktop --render-json <sprite.json> <png> [scale]`.
if let flag = arguments.firstIndex(of: "--render-json"), flag + 2 < arguments.count {
    let jsonPath = arguments[flag + 1]
    let pngPath = arguments[flag + 2]
    let scale = clampScale((flag + 3 < arguments.count ? Int(arguments[flag + 3]) : nil) ?? 18)
    do {
        let sprite = try Sprite.decode(Data(contentsOf: URL(fileURLWithPath: jsonPath)))
        guard sprite.isRectangular() else {
            FileHandle.standardError.write(Data("sprite is not rectangular (\(sprite.width)x\(sprite.height), \(sprite.rows.count) rows)\n".utf8))
            exit(2)
        }
        try SpriteRenderer.renderPNG(sprite, to: URL(fileURLWithPath: pngPath), scale: scale)
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("render-json failed: \(error)\n".utf8))
        exit(1)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller = MuseController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.start()
    }
}

let app = NSApplication.shared
// `.accessory` → no Dock icon and no menu bar; it lives as a floating companion.
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
