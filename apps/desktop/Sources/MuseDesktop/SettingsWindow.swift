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
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var creds = MessagingCredentials.load()
    @State private var msgSaved = false
    @State private var models: [OllamaModel] = []
    @State private var pullName = ""
    @State private var pulling = false

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
                modelsSection
                voiceSection
                startupSection
                messagingSection
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

    private var defaultModel: String {
        (ProcessInfo.processInfo.environment["MUSE_MODEL"] ?? "ollama/gemma4:12b")
            .split(separator: "/").last.map(String.init) ?? "gemma4:12b"
    }

    private var modelsSection: some View {
        card(s.sectionModels) {
            Text(s.modelsHint).font(.system(size: 11)).foregroundStyle(faint)
            if models.isEmpty {
                Text(s.modelsEmpty).font(.system(size: 12)).foregroundStyle(dim)
            }
            ForEach(models) { m in
                HStack(spacing: 8) {
                    Text(m.name).font(.system(size: 12)).foregroundStyle(ink)
                    if m.name == defaultModel {
                        Text(s.modelDefault).font(.system(size: 10, weight: .semibold)).foregroundStyle(violet)
                    }
                    Spacer()
                    Text(m.sizeText).font(.system(size: 11)).foregroundStyle(faint)
                    Button { Task { await OllamaModels.delete(m.name); await reloadModels() } } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.plain).foregroundStyle(.red.opacity(0.85))
                    .help("Delete \(m.name)")
                }
            }
            HStack(spacing: 8) {
                TextField(s.modelPullPlaceholder, text: $pullName).textFieldStyle(.roundedBorder)
                Button(pulling ? s.modelPulling : s.modelPull) {
                    let name = pullName.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !name.isEmpty, !pulling else { return }
                    pulling = true
                    Task { _ = await OllamaModels.pull(name); pulling = false; pullName = ""; await reloadModels() }
                }
                .buttonStyle(.borderedProminent).tint(violet).disabled(pulling)
            }
        }
        .task { await reloadModels() }
    }

    @MainActor private func reloadModels() async { models = await OllamaModels.list() }

    private var messagingSection: some View {
        card(s.sectionMessengers) {
            Text(s.msgHint).font(.system(size: 11)).foregroundStyle(faint)
            field(s.msgTelegram, $creds.telegramToken, secure: true)
            field(s.msgDiscord, $creds.discordToken, secure: true)
            field(s.msgDiscordChannels, $creds.discordChannels)
            field(s.msgSlack, $creds.slackToken, secure: true)
            field(s.msgSlackChannels, $creds.slackChannels)
            field(s.msgLineToken, $creds.lineAccessToken, secure: true)
            field(s.msgLineSecret, $creds.lineSecret, secure: true)
            Button(s.msgSave) {
                creds.save()
                ServerManager.shared.restart()
                msgSaved = true
            }
            .buttonStyle(.borderedProminent).tint(violet)
            if msgSaved { Text(s.msgSaved).font(.system(size: 11)).foregroundStyle(faint) }
        }
    }

    @ViewBuilder private func field(_ label: String, _ text: Binding<String>, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 11)).foregroundStyle(dim)
            Group {
                if secure { SecureField(label, text: text) } else { TextField(label, text: text) }
            }
            .textFieldStyle(.roundedBorder)
        }
    }

    private var startupSection: some View {
        card(s.sectionStartup) {
            Toggle(isOn: $launchAtLogin) { Text(s.launchAtLogin).foregroundStyle(ink) }
                .toggleStyle(.switch).tint(violet)
                .onChange(of: launchAtLogin) { _, v in
                    if !LaunchAtLogin.set(v) { launchAtLogin = LaunchAtLogin.isEnabled }  // revert on failure
                }
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
