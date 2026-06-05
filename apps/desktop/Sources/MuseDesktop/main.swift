import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: FloatingPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = FloatingPanel()
        panel.orderFrontRegardless()
        self.panel = panel
    }
}

let app = NSApplication.shared
// `.accessory` → no Dock icon and no menu bar; it lives as a floating companion.
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
