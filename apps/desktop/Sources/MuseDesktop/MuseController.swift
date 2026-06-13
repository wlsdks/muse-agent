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
        // The glowing orb itself, so Muse is recognizable in the menu bar.
        let icon = VoiceOrb.icon(diameter: 18)
        icon.isTemplate = false
        item.button?.image = icon
        item.button?.toolTip = "Muse — click for options (⌃⌥Space to show/hide)"

        let menu = NSMenu()
        add(menu, "Show / Hide Muse  (⌃⌥Space)", #selector(toggleFromMenu))

        let characterItem = NSMenuItem(title: "Character", action: nil, keyEquivalent: "")
        let characterMenu = NSMenu()
        // Two refined looks: the glowing "Orb" (default) and the glowing "Harp" (lyre).
        let names = ["orb", "harp"]
        for name in names {
            let mi = NSMenuItem(title: name.capitalized, action: #selector(pickCharacter(_:)), keyEquivalent: "")
            mi.representedObject = name
            mi.target = self
            mi.state = (name == "orb") ? .on : .off
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
