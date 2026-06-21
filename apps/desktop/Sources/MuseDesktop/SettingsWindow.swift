import AppKit
import SwiftUI
import MuseDesktopCore

/// A native, pretty Settings window for Muse — look, language, voice, the full-app
/// URL, and the privacy posture. Hosts a SwiftUI view in a standard NSWindow.
final class SettingsWindowController {
    var onCharacter: ((String) -> Void)?
    var onLanguage: ((AppLanguage) -> Void)?
    var onMute: ((Bool) -> Void)?
    var onOpenFull: (() -> Void)?
    var onQuit: (() -> Void)?
    var isMuted: () -> Bool = { false }

    private var window: NSWindow?

    func show() {
        if window == nil { build() }
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let view = SettingsView(
            initialMuted: isMuted(),
            onCharacter: { [weak self] in self?.onCharacter?($0) },
            onLanguage: { [weak self] in self?.onLanguage?($0) },
            onMute: { [weak self] in self?.onMute?($0) },
            onOpenFull: { [weak self] in self?.onOpenFull?() },
            onQuit: { [weak self] in self?.onQuit?() }
        )
        let host = NSHostingController(rootView: view)
        let win = NSWindow(contentViewController: host)
        win.title = "Muse Settings"
        win.styleMask = [.titled, .closable, .miniaturizable]
        win.isReleasedWhenClosed = false
        win.setContentSize(NSSize(width: 440, height: 600))
        win.center()
        window = win
    }
}

private struct SettingsView: View {
    let onCharacter: (String) -> Void
    let onLanguage: (AppLanguage) -> Void
    let onMute: (Bool) -> Void
    let onOpenFull: () -> Void
    let onQuit: () -> Void

    @State private var character: String
    @State private var language: AppLanguage
    @State private var muted: Bool
    @State private var museURL: String

    private let violet = Color(red: 0.55, green: 0.45, blue: 0.95)

    init(initialMuted: Bool,
         onCharacter: @escaping (String) -> Void,
         onLanguage: @escaping (AppLanguage) -> Void,
         onMute: @escaping (Bool) -> Void,
         onOpenFull: @escaping () -> Void,
         onQuit: @escaping () -> Void) {
        self.onCharacter = onCharacter
        self.onLanguage = onLanguage
        self.onMute = onMute
        self.onOpenFull = onOpenFull
        self.onQuit = onQuit
        let prefs = PrefsStore.load()
        _character = State(initialValue: prefs.look ?? "goddess")
        _language = State(initialValue: AppLanguage.fromPersisted(prefs.language))
        _muted = State(initialValue: initialMuted)
        _museURL = State(initialValue: prefs.museURL ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                header
                appearanceSection
                voiceSection
                fullAppSection
                privacySection
                footer
            }
            .padding(24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LinearGradient(colors: [Color(red: 0.09, green: 0.08, blue: 0.14),
                                            Color(red: 0.05, green: 0.04, blue: 0.09)],
                                   startPoint: .top, endPoint: .bottom))
    }

    private var header: some View {
        VStack(spacing: 8) {
            if let g = MuseAssets.goddess {
                Image(nsImage: g).resizable().scaledToFit().frame(height: 132)
                    .shadow(color: violet.opacity(0.4), radius: 16)
            }
            Text("Muse").font(.system(size: 24, weight: .bold))
            Text("Learns you, not the world.").font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

    private var appearanceSection: some View {
        card("Appearance") {
            Picker("Character", selection: $character) {
                Text("Goddess").tag("goddess")
                Text("Orb").tag("orb")
            }
            .pickerStyle(.segmented)
            .onChange(of: character) { _, v in onCharacter(v) }

            Picker("Language", selection: $language) {
                ForEach(AppLanguage.allCases, id: \.self) { lang in
                    Text(lang.menuTitle).tag(lang)
                }
            }
            .onChange(of: language) { _, v in onLanguage(v) }
        }
    }

    private var voiceSection: some View {
        card("Voice") {
            Toggle("Mute voice", isOn: $muted)
                .onChange(of: muted) { _, v in onMute(v) }
        }
    }

    private var fullAppSection: some View {
        card("Full app") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Muse web URL").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                TextField("http://127.0.0.1:5173", text: $museURL)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: museURL) { _, v in PrefsStore.update { $0.museURL = v } }
                Button(action: onOpenFull) {
                    Text("Open the full Muse app").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(violet)
            }
        }
    }

    private var privacySection: some View {
        card("Privacy") {
            Label("Runs on your local model — your data never leaves this Mac (local-only by default).",
                  systemImage: "lock.fill")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        Button(role: .destructive, action: onQuit) {
            Text("Quit Muse").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }

    @ViewBuilder private func card<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(.tertiary)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.white.opacity(0.08)))
    }
}
