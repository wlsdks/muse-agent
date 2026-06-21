import AppKit
import SwiftUI
import MuseDesktopCore

/// A native, pretty Settings window for Muse — chat entry, look, language, voice,
/// the full-app URL, and the privacy posture. Hosts a SwiftUI view in a dark,
/// resizable NSWindow.
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
        win.title = UIStrings.current().settingsTitle
        win.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        win.titlebarAppearsTransparent = true
        win.isReleasedWhenClosed = false
        win.appearance = NSAppearance(named: .darkAqua)   // readable on the dark UI
        win.setContentSize(NSSize(width: 560, height: 780))
        win.minSize = NSSize(width: 480, height: 600)
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
    @State private var showAdvanced = false

    private let s = UIStrings.current()

    // Explicit colours so text is legible regardless of system light/dark.
    private let violet = Color(red: 0.62, green: 0.52, blue: 1.0)
    private let ink = Color.white
    private let dim = Color.white.opacity(0.62)
    private let faint = Color.white.opacity(0.40)

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
            VStack(spacing: 20) {
                header
                chatSection
                appearanceSection
                voiceSection
                privacySection
                advancedSection
                footer
            }
            .padding(26)
            .frame(maxWidth: 620)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(colors: [Color(red: 0.10, green: 0.09, blue: 0.16),
                                    Color(red: 0.05, green: 0.04, blue: 0.09)],
                           startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
        )
    }

    private var header: some View {
        VStack(spacing: 6) {
            if let g = MuseAssets.goddess {
                Image(nsImage: g).resizable().scaledToFit().frame(height: 120)
                    .shadow(color: violet.opacity(0.45), radius: 18)
            }
            Text("Muse").font(.system(size: 26, weight: .bold)).foregroundStyle(ink)
            Text(s.tagline).font(.system(size: 12)).foregroundStyle(dim)
        }
    }

    private var chatSection: some View {
        VStack(spacing: 10) {
            Button(action: onOpenFull) {
                HStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                    Text(s.openFull).fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(violet)
            .controlSize(.large)
            Text(s.openFullSub)
                .font(.system(size: 11)).foregroundStyle(faint).multilineTextAlignment(.center)
        }
    }

    private var appearanceSection: some View {
        card(s.sectionAppearance) {
            row(s.rowCharacter) {
                Picker("", selection: $character) {
                    Text(s.characterGoddess).tag("goddess")
                    Text(s.characterOrb).tag("orb")
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 190)
                .onChange(of: character) { _, v in onCharacter(v) }
            }
            row(s.rowLanguage) {
                Picker("", selection: $language) {
                    ForEach(AppLanguage.allCases, id: \.self) { Text($0.menuTitle).tag($0) }
                }
                .labelsHidden().frame(width: 190)
                .onChange(of: language) { _, v in onLanguage(v) }
            }
        }
    }

    private var voiceSection: some View {
        card(s.sectionVoice) {
            Toggle(isOn: $muted) {
                Text(s.muteSpoken).foregroundStyle(ink)
            }
            .toggleStyle(.switch).tint(violet)
            .onChange(of: muted) { _, v in onMute(v) }
        }
    }

    private var privacySection: some View {
        card(s.sectionPrivacy) {
            label(s.privacyLocal, "lock.fill")
            label(s.privacyHotkey, "keyboard")
            label(s.openHint, "cursorarrow.rays")
        }
    }

    private var advancedSection: some View {
        card(s.sectionAdvanced) {
            Toggle(isOn: $showAdvanced) { Text(s.customURL).foregroundStyle(ink) }
                .toggleStyle(.switch).tint(violet)
            if showAdvanced {
                TextField(s.customURLPlaceholder, text: $museURL)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: museURL) { _, v in PrefsStore.update { $0.museURL = v } }
                Text(s.customURLHint).font(.system(size: 11)).foregroundStyle(faint)
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Button(role: .destructive, action: onQuit) {
                Text(s.quit).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered).controlSize(.large)
            Text("Muse 0.1.0").font(.system(size: 10)).foregroundStyle(faint)
        }
    }

    // MARK: - building blocks

    @ViewBuilder private func card<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased()).font(.system(size: 11, weight: .bold)).foregroundStyle(faint).tracking(0.8)
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.white.opacity(0.10)))
    }

    @ViewBuilder private func row<Content: View>(_ title: String, @ViewBuilder _ trailing: () -> Content) -> some View {
        HStack {
            Text(title).foregroundStyle(ink)
            Spacer()
            trailing()
        }
    }

    @ViewBuilder private func label(_ text: String, _ icon: String) -> some View {
        Label { Text(text).foregroundStyle(dim) } icon: { Image(systemName: icon).foregroundStyle(violet) }
            .font(.system(size: 12))
    }
}
