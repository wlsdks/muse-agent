import AppKit
import MuseDesktopCore
import SwiftUI

/// The always-on-top, transparent, draggable companion window. The window
/// chrome (floating panel, every Space, over fullscreen, drag, position memory)
/// stays AppKit; the CONTENT is a modern SwiftUI `CompanionView` hosted inside.
final class FloatingPanel: NSPanel {
    let model = CompanionModel()

    var voiceMuted: Bool {
        get { model.voiceMuted }
        set { model.voiceMuted = newValue }
    }

    func setCharacter(_ name: String) { model.setCharacter(name) }
    func setLanguage(_ pref: AppLanguage) { model.setLanguage(pref) }

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 440),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered, defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isMovableByWindowBackground = true // drag the background to reposition

        let hosting = NSHostingView(rootView: CompanionView(model: model))
        hosting.frame = NSRect(x: 0, y: 0, width: 360, height: 440)
        hosting.autoresizingMask = [.width, .height]
        contentView = hosting

        let prefs = PrefsStore.load()
        positionAtBottomRight()
        applySavedOrigin(prefs)
        NotificationCenter.default.addObserver(self, selector: #selector(windowMoved), name: NSWindow.didMoveNotification, object: self)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private func positionAtBottomRight() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let margin: CGFloat = 24
        setFrameOrigin(NSPoint(x: visible.maxX - frame.width - margin, y: visible.minY + margin))
    }

    private func applySavedOrigin(_ prefs: CompanionPrefs) {
        guard let x = prefs.originX, let y = prefs.originY else { return }
        let screens = NSScreen.screens.map {
            CompanionGeometry.Rect(x: $0.frame.minX, y: $0.frame.minY, width: $0.frame.width, height: $0.frame.height)
        }
        let candidate = CompanionGeometry.Rect(x: x, y: y, width: frame.width, height: frame.height)
        if CompanionGeometry.isVisible(candidate, on: screens) {
            setFrameOrigin(NSPoint(x: x, y: y))
        }
    }

    @objc private func windowMoved() {
        PrefsStore.update { $0.originX = Double(frame.origin.x); $0.originY = Double(frame.origin.y) }
    }
}
