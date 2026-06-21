import AppKit
import SwiftUI
import MuseDesktopCore

/// First-run onboarding: welcome + a live check that the local AI brain (Ollama +
/// model) is ready, with fix guidance, then a one-tap entry into the full app.
/// Shown once (tracked in UserDefaults); re-openable from the menu.
final class OnboardingWindowController {
    var onOpenFull: (() -> Void)?
    private var window: NSWindow?
    private static let seenKey = "didOnboard"

    static var hasOnboarded: Bool { UserDefaults.standard.bool(forKey: seenKey) }

    func showIfFirstRun() { if !Self.hasOnboarded { show() } }

    func show() {
        if window == nil { build() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let view = OnboardingView(
            onOpenFull: { [weak self] in self?.onOpenFull?(); self?.finish() },
            onFinish: { [weak self] in self?.finish() }
        )
        let host = NSHostingController(rootView: view)
        let win = NSWindow(contentViewController: host)
        win.title = "Muse"
        win.styleMask = [.titled, .closable, .fullSizeContentView]
        win.titlebarAppearsTransparent = true
        win.isReleasedWhenClosed = false
        win.appearance = NSAppearance(named: .darkAqua)
        win.setContentSize(NSSize(width: 480, height: 600))
        win.center()
        window = win
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: Self.seenKey)
        window?.close()
    }
}

private struct OnboardingView: View {
    let onOpenFull: () -> Void
    let onFinish: () -> Void

    @State private var checking = true
    @State private var ready = false
    @State private var guidance = ""

    private let s = UIStrings.current()
    private let violet = Color(red: 0.62, green: 0.52, blue: 1.0)
    private let ink = Color.white
    private let dim = Color.white.opacity(0.62)

    var body: some View {
        VStack(spacing: 22) {
            if let g = MuseAssets.goddess {
                Image(nsImage: g).resizable().scaledToFit().frame(height: 150)
                    .shadow(color: violet.opacity(0.45), radius: 18)
            }
            Text(s.onboardWelcome).font(.system(size: 24, weight: .bold)).foregroundStyle(ink)
            Text(s.onboardSubtitle).font(.system(size: 13)).foregroundStyle(dim)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)

            statusCard

            Spacer(minLength: 0)

            Button(action: onOpenFull) {
                Text(s.onboardOpenFull).fontWeight(.semibold).frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent).tint(violet).controlSize(.large)
            .disabled(!ready)

            Button(action: onFinish) { Text(s.onboardStart).frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LinearGradient(colors: [Color(red: 0.10, green: 0.09, blue: 0.16),
                                            Color(red: 0.05, green: 0.04, blue: 0.09)],
                                   startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .task { await runCheck() }
    }

    private var statusCard: some View {
        HStack(spacing: 10) {
            if checking {
                ProgressView().controlSize(.small)
                Text(s.onboardChecking).foregroundStyle(dim)
            } else if ready {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(s.onboardReady).foregroundStyle(ink)
            } else {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                Text(guidance).foregroundStyle(dim).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .font(.system(size: 12))
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.10)))
    }

    private func runCheck() async {
        checking = true
        let status = await OllamaHealth.check()
        ready = status == .ok
        guidance = UIStrings.current().lang == .korean
            ? localizedGuidance(status, korean: true)
            : localizedGuidance(status, korean: false)
        checking = false
    }

    private func localizedGuidance(_ status: OllamaStatus, korean: Bool) -> String {
        switch status {
        case .ok: return korean ? "준비 완료!" : "Ready!"
        case .notRunning:
            return korean
                ? "Ollama가 실행 중이 아니에요. 터미널에서 `ollama serve`를 실행하거나 Ollama 앱을 여세요."
                : "Ollama isn't running. Run `ollama serve` or open the Ollama app."
        case .modelMissing(let model):
            return korean
                ? "모델이 없어요. 터미널에서 `ollama pull \(model)`을 실행하세요."
                : "Model missing. Run `ollama pull \(model)` in Terminal."
        }
    }
}
