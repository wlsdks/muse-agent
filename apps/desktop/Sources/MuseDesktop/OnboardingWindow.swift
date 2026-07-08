import AppKit
import SwiftUI
import MuseDesktopCore

/// First-run onboarding: welcome + a live check that the local AI brain (Ollama +
/// model) is ready, with fix guidance, then a one-tap entry into the full app.
/// Shown once (tracked in UserDefaults); re-openable from the menu.
final class OnboardingWindowController {
    var onOpenFull: (() -> Void)?
    private var window: NSWindow?
    private var resizeObserver: NSObjectProtocol?
    private static let seenKey = "didOnboard"

    static var hasOnboarded: Bool {
        // Test mode always re-shows first-run so it can be captured repeatedly.
        if WindowPlacer.isTestMode { return false }
        return UserDefaults.standard.bool(forKey: seenKey)
    }

    func showIfFirstRun() { if !Self.hasOnboarded { show() } }

    func show() {
        if window == nil { build() }
        NSApp.activate(ignoringOtherApps: true)
        guard let win = window else { return }
        win.makeKeyAndOrderFront(nil)
        WindowPlacer.place(win)
        // The SwiftUI content's preferredContentSize can finalize one runloop
        // tick AFTER the window first orders front, so a single placement runs
        // against a stale (default) size and the window lands off-center. Re-
        // place once the final size has settled so it reliably sits dead-center.
        DispatchQueue.main.async { [weak win] in
            guard let win else { return }
            WindowPlacer.place(win)
        }
    }

    private func build() {
        let view = OnboardingView(
            onOpenFull: { [weak self] in self?.onOpenFull?(); self?.finish() },
            onFinish: { [weak self] in self?.finish() }
        )
        let host = NSHostingController(rootView: view)
        // Size the window to the SwiftUI content's ideal size (no empty void); the
        // content declares a fixed width + natural height, so the window wraps it.
        host.sizingOptions = .preferredContentSize
        let win = NSWindow(contentViewController: host)
        win.title = "Muse"
        win.styleMask = [.titled, .closable, .fullSizeContentView]
        win.titlebarAppearsTransparent = true
        win.isReleasedWhenClosed = false
        win.appearance = NSAppearance(named: .darkAqua)
        window = win
        // The async local-AI health check flips the status card (checking →
        // ready/error) AFTER the window is shown, which resizes the content. AppKit
        // keeps the top-left corner fixed on that resize, so a window centered once
        // at show() drifts down-left. The window isn't user-resizable, so every
        // resize is content-driven — re-center on each one to keep it dead-center.
        resizeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification, object: win, queue: .main
        ) { [weak win] _ in
            guard let win else { return }
            WindowPlacer.place(win)
        }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: Self.seenKey)
        if let resizeObserver { NotificationCenter.default.removeObserver(resizeObserver) }
        resizeObserver = nil
        window?.close()
    }
}

private struct OnboardingView: View {
    let onOpenFull: () -> Void
    let onFinish: () -> Void

    @State private var checking = true
    @State private var ready = false
    @State private var guidance = ""
    @State private var readyLine = ""

    private let s = UIStrings.current()
    private let violet = Color(red: 0.62, green: 0.52, blue: 1.0)
    private let ink = Color.white
    private let dim = Color.white.opacity(0.60)

    var body: some View {
        VStack(spacing: 0) {
            if let g = MuseAssets.bird {
                Image(nsImage: g).resizable().interpolation(.none).scaledToFit()
                    .frame(width: 128, height: 128)
                    .shadow(color: violet.opacity(0.50), radius: 26, y: 6)
            }

            VStack(spacing: 10) {
                Text(s.onboardWelcome)
                    .font(.system(size: 26, weight: .bold)).foregroundStyle(ink)
                    .tracking(0.2)
                Text(s.onboardSubtitle)
                    .font(.system(size: 13.5)).foregroundStyle(dim)
                    .multilineTextAlignment(.center).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 22)

            statusCard
                .padding(.top, 32)

            VStack(spacing: 10) {
                Button(action: onOpenFull) {
                    Text(s.onboardOpenFull)
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .foregroundStyle(.white)
                        .background(ready ? violet : violet.opacity(0.35),
                                    in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!ready)

                Button(action: onFinish) {
                    Text(s.onboardStart)
                        .font(.system(size: 13)).foregroundStyle(dim)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 28)
        }
        .padding(.horizontal, 34)
        .padding(.top, 46)
        .padding(.bottom, 30)
        .frame(width: 440)
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
                Text(readyLine.isEmpty ? s.onboardReady : readyLine).foregroundStyle(ink)
            } else {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                Text(guidance).foregroundStyle(dim).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .font(.system(size: 12.5))
        .padding(.horizontal, 16).padding(.vertical, 15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(Color.white.opacity(0.10)))
    }

    private func runCheck() async {
        checking = true
        let status = await OllamaHealth.check()
        ready = status == .ok
        let korean = UIStrings.current().lang == .korean
        guidance = OnboardingGuidance.text(for: status, korean: korean)
        if ready { readyLine = OnboardingGuidance.readyLine(korean: korean, deterministic: WindowPlacer.isTestMode) }
        checking = false
    }
}
