import AppKit
import Carbon.HIToolbox
import MuseDesktopCore

/// Owns the companion's app-level pieces: the floating panel, a menu-bar item,
/// and a global hotkey. One small coordinator so `AppDelegate` stays trivial.
final class MuseController: NSObject {
    private let panel = FloatingPanel()
    private var statusItem: NSStatusItem?
    private var hotKey: GlobalHotKey?
    private var muteItem: NSMenuItem?
    private lazy var settingsWindow = SettingsWindowController()
    private lazy var webWindow = MuseWebWindowController()

    func start() {
        panel.orderFrontRegardless()
        installMenuBar()
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
        // The goddess herself, so Muse is recognizable in the menu bar.
        item.button?.image = MuseAssets.menuBarIcon(height: 18)
        item.button?.toolTip = "Muse — click for options (⌃⌥Space to show/hide)"

        let menu = NSMenu()
        add(menu, "Show / Hide Muse  (⌃⌥Space)", #selector(toggleFromMenu))
        add(menu, "Open Muse  (full app)", #selector(openFullApp))
        menu.addItem(.separator())

        let characterItem = NSMenuItem(title: "Character", action: nil, keyEquivalent: "")
        let characterMenu = NSMenu()
        // The goddess (default) and the glowing orb.
        let names = ["goddess", "orb"]
        let currentLook = PrefsStore.load().look ?? "goddess"
        for name in names {
            let mi = NSMenuItem(title: name.capitalized, action: #selector(pickCharacter(_:)), keyEquivalent: "")
            mi.representedObject = name
            mi.target = self
            mi.state = (name == currentLook) ? .on : .off
            characterMenu.addItem(mi)
        }
        characterItem.submenu = characterMenu
        menu.addItem(characterItem)

        let languageItem = NSMenuItem(title: "Language", action: nil, keyEquivalent: "")
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

        muteItem = add(menu, "Mute voice", #selector(toggleMute))
        menu.addItem(.separator())
        add(menu, "Settings…", #selector(openSettings), key: ",")
        add(menu, "Quit Muse", #selector(quit), key: "q")

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
        sender.menu?.items.forEach { $0.state = ($0 === sender) ? .on : .off }
    }

    @objc private func toggleMute() {
        panel.voiceMuted.toggle()
        muteItem?.state = panel.voiceMuted ? .on : .off
    }

    @objc private func quit() { NSApplication.shared.terminate(nil) }
}
