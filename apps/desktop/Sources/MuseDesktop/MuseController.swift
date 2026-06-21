import AppKit
import Carbon.HIToolbox
import MuseDesktopCore

extension Notification.Name {
    /// Posted by the floating companion's "open full app" button.
    static let museOpenFullApp = Notification.Name("museOpenFullApp")
}

/// Owns the companion's app-level pieces: the floating panel, a menu-bar item,
/// and a global hotkey. One small coordinator so `AppDelegate` stays trivial.
final class MuseController: NSObject, NSMenuDelegate {
    private let panel = FloatingPanel()
    private var statusItem: NSStatusItem?
    private var hotKey: GlobalHotKey?
    private var muteItem: NSMenuItem?
    private weak var statusInfoItem: NSMenuItem?
    private lazy var settingsWindow = SettingsWindowController()
    private lazy var webWindow = MuseWebWindowController()

    func start() {
        panel.orderFrontRegardless()
        installMenuBar()
        // The floating companion's "open full app" button posts this.
        NotificationCenter.default.addObserver(
            forName: .museOpenFullApp, object: nil, queue: .main
        ) { [weak self] _ in self?.openFullApp() }
        // Control-Option-Space toggles the panel from anywhere (two real
        // modifiers — avoids the macOS 15+ Option-only-hotkey bug; Carbon path
        // needs no Accessibility permission).
        hotKey = GlobalHotKey(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)) { [weak self] in
            self?.toggleVisibility()
        }
    }

    private func toggleVisibility() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
            panel.makeKey()
        }
    }

    private func installMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // A clean music note — Muse, the goddess of song — reads crisply at
        // menu-bar size (a detailed portrait turns to mud that small). Template
        // image so it adapts to light/dark menu bars.
        let note = NSImage(systemSymbolName: "music.note", accessibilityDescription: "Muse")
        note?.isTemplate = true
        item.button?.image = note
        item.button?.toolTip = "Muse — click for options (⌃⌥Space to show/hide)"

        let s = UIStrings.current()
        let menu = NSMenu()
        menu.delegate = self

        // Live status: privacy posture · model · server (refreshed on open).
        let info = NSMenuItem(title: statusTitle(), action: nil, keyEquivalent: "")
        info.isEnabled = false
        menu.addItem(info)
        menu.addItem(.separator())
        statusInfoItem = info

        // The primary action first — one click into the full app (chat + everything).
        let openItem = add(menu, s.menuOpenFull, #selector(openFullApp))
        openItem.image = NSImage(systemSymbolName: "bubble.left.and.bubble.right.fill", accessibilityDescription: nil)
        add(menu, s.menuShowHide, #selector(toggleFromMenu))
        menu.addItem(.separator())

        let characterItem = NSMenuItem(title: s.menuCharacter, action: nil, keyEquivalent: "")
        let characterMenu = NSMenu()
        let names = [("goddess", s.characterGoddess), ("orb", s.characterOrb)]
        let currentLook = PrefsStore.load().look ?? "goddess"
        for (name, title) in names {
            let mi = NSMenuItem(title: title, action: #selector(pickCharacter(_:)), keyEquivalent: "")
            mi.representedObject = name
            mi.target = self
            mi.state = (name == currentLook) ? .on : .off
            characterMenu.addItem(mi)
        }
        characterItem.submenu = characterMenu
        menu.addItem(characterItem)

        let languageItem = NSMenuItem(title: s.menuLanguage, action: nil, keyEquivalent: "")
        let languageMenu = NSMenu()
        let current = AppLanguage.fromPersisted(PrefsStore.load().language)
        for lang in AppLanguage.allCases {
            let mi = NSMenuItem(title: lang.menuTitle, action: #selector(pickLanguage(_:)), keyEquivalent: "")
            mi.representedObject = lang.rawValue
            mi.target = self
            mi.state = (lang == current) ? .on : .off
            languageMenu.addItem(mi)
        }
        languageItem.submenu = languageMenu
        menu.addItem(languageItem)

        muteItem = add(menu, s.menuMute, #selector(toggleMute))
        menu.addItem(.separator())
        add(menu, s.menuSettings, #selector(openSettings), key: ",")
        add(menu, s.menuQuit, #selector(quit), key: "q")

        item.menu = menu
        statusItem = item
    }

    @discardableResult
    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: action, keyEquivalent: key)
        mi.target = self
        menu.addItem(mi)
        return mi
    }

    /// Refresh the status line each time the menu opens (model/server can change).
    func menuWillOpen(_ menu: NSMenu) { statusInfoItem?.title = statusTitle() }

    private func statusTitle() -> String {
        let s = UIStrings.current()
        let env = ProcessInfo.processInfo.environment
        let localOnly = (env["MUSE_LOCAL_ONLY"] ?? "true") != "false"
        let model = env["MUSE_MODEL"] ?? "ollama/gemma4:12b"
        let modelShort = model.split(separator: "/").last.map(String.init) ?? model
        let server = ServerManager.shared.isLikelyRunning ? s.statusServerOn : s.statusServerOff
        return "\(localOnly ? s.statusLocalOn : s.statusLocalOff) · \(modelShort) · \(server)"
    }

    @objc private func toggleFromMenu() { toggleVisibility() }

    @objc private func openFullApp() {
        NSApp.activate(ignoringOtherApps: true)
        webWindow.show()
    }

    @objc private func openSettings() {
        settingsWindow.isMuted = { [weak self] in self?.panel.voiceMuted ?? false }
        settingsWindow.onCharacter = { [weak self] name in
            self?.panel.setCharacter(name)
            if self?.panel.isVisible == false { self?.toggleVisibility() }
        }
        settingsWindow.onLanguage = { [weak self] lang in self?.panel.setLanguage(lang) }
        settingsWindow.onMute = { [weak self] muted in
            self?.panel.voiceMuted = muted
            self?.muteItem?.state = muted ? .on : .off
        }
        settingsWindow.onOpenFull = { [weak self] in self?.openFullApp() }
        settingsWindow.onQuit = { NSApplication.shared.terminate(nil) }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow.show()
    }

    @objc private func pickCharacter(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        panel.setCharacter(name)
        sender.menu?.items.forEach { $0.state = ($0 === sender) ? .on : .off }
        if !panel.isVisible { toggleVisibility() }
    }

    @objc private func pickLanguage(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let lang = AppLanguage(rawValue: raw) else { return }
        panel.setLanguage(lang)
        // Rebuild the menu so its labels re-localize to the new language.
        if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
        installMenuBar()
    }

    @objc private func toggleMute() {
        panel.voiceMuted.toggle()
        muteItem?.state = panel.voiceMuted ? .on : .off
    }

    @objc private func quit() { NSApplication.shared.terminate(nil) }
}
