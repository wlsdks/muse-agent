import AppKit
import MuseDesktopCore

/// The companion's UI state + actions, driving the SwiftUI `CompanionView`. Owns
/// the bridge to the local Muse runtime (text + voice) and the language.
@MainActor
final class CompanionModel: ObservableObject {
    @Published var bubble: String
    @Published var inputText = ""
    @Published var inputVisible = false
    @Published var orbState: CharacterView.State = .idle
    @Published var lookName: String?
    @Published private(set) var language: ResolvedLanguage

    var voiceMuted = false

    private let speaker: Speaker = SpeakerFactory.make()
    private let whisper = WhisperCapture()
    private var busy = false
    private var listening = false

    static var systemIsKorean: Bool { (Locale.preferredLanguages.first ?? "en").hasPrefix("ko") }

    init() {
        let prefs = PrefsStore.load()
        let pref = AppLanguage.fromPersisted(prefs.language)
        let lang = resolveLanguage(pref, systemIsKorean: Self.systemIsKorean)
        lookName = ProcessInfo.processInfo.environment["MUSE_DESKTOP_CHARACTER"] ?? prefs.look
        language = lang
        bubble = "" // idle = just the orb; the bubble appears only on an answer / listening
        whisper.onLoadProgress = { [weak self] phase in MainActor.assumeIsolated { self?.handleLoadProgress(phase) } }
        whisper.preload() // warm the CoreML speech model at launch so the first tap is instant
        checkOllamaAtLaunch()
    }

    /// The companion bundles its own runtime, but the LLM weights can't be — so
    /// if the local AI brain (Ollama + model) isn't ready, surface actionable
    /// setup guidance at launch instead of letting the first question just fail.
    /// Only while genuinely idle, so it never stomps on a real interaction.
    private func checkOllamaAtLaunch() {
        Task { [weak self] in
            let status = await OllamaHealth.check()
            guard let self, status != .ok else { return }
            if !self.busy, !self.listening, self.bubble.isEmpty, !self.inputVisible {
                self.bubble = self.language.ollamaGuidance(status)
            }
        }
    }

    /// Live model-download/load feedback — only while the user is waiting to talk
    /// (idle stays just-the-orb). Lets the user SEE the download progressing
    /// instead of guessing whether it hung.
    private func handleLoadProgress(_ phase: WhisperCapture.LoadPhase) {
        guard listening else { return }
        switch phase {
        // Before any bytes arrive (the metadata check) show "준비 중"; only show a
        // percentage once a real download is actually moving.
        case .downloading(let fraction):
            bubble = language.downloadProgressBubble(fraction: fraction)
        case .loading: bubble = language.loadingVoice
        case .ready: if orbState == .listening { bubble = language.listeningHint }
        case .failed: break // startVoice's catch sets the failure message
        }
    }

    /// Tap the orb → toggle the input (always works); cancel voice if listening.
    /// Closing returns to just-the-orb (clears the bubble).
    func clickOrb() {
        guard !busy else { return }
        if listening { stopVoiceAndTranscribe(); return } // tap while recording → finish + transcribe
        inputVisible.toggle()
        if !inputVisible { bubble = "" }
        orbState = .idle
    }

    func submit() {
        let query = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, !busy else { return }
        busy = true
        inputVisible = false
        inputText = ""
        orbState = .thinking
        bubble = "" // empty + .thinking → the animated TypingIndicator shows
        Task { [weak self] in
            guard let self else { return }
            let result: Result<String, MuseBridgeError>
            do { result = .success(try await MuseBridge.ask(query: query)) }
            catch let error as MuseBridgeError { result = .failure(error) }
            catch { result = .failure(.cliFailed(status: -1, stderr: "\(error)")) }
            // If the turn failed, see whether the local AI brain is the cause and
            // give actionable setup guidance rather than a generic error.
            if case .failure = result {
                let status = await OllamaHealth.check()
                if status != .ok {
                    self.bubble = self.language.ollamaGuidance(status)
                    self.busy = false
                    self.orbState = .idle
                    return
                }
            }
            let presentation = MusePresenter.present(result, language: self.language)
            self.bubble = presentation.bubbleText
            self.busy = false
            if let speech = presentation.speechText, !self.voiceMuted {
                self.orbState = .speaking
                self.speaker.speak(speech, language: self.language) { [weak self] in Task { @MainActor in self?.orbState = .idle } }
            } else {
                self.orbState = .idle
            }
        }
    }

    /// Tap the mic: start recording, or — if already recording — STOP and
    /// transcribe (push-to-talk; reliable, no silence guessing).
    func startVoice() {
        guard !busy else { return }
        if listening { stopVoiceAndTranscribe(); return }
        listening = true
        orbState = .listening
        inputVisible = true
        inputText = ""
        // The first-ever tap may trigger the one-time model download; afterwards
        // the cached CoreML model loads in well under a second.
        bubble = whisper.isReady ? language.listeningHint : language.preparingVoice
        whisper.languageCode = language.whisperLang
        Task { [weak self] in
            guard await WhisperCapture.requestMic() else {
                guard let self else { return }
                self.listening = false; self.orbState = .idle
                self.bubble = self.language == .korean ? "마이크 권한이 필요해요 (시스템 설정 → 개인정보 보호 → 마이크)." : "Microphone access is needed (System Settings → Privacy → Microphone)."
                return
            }
            guard let self, self.listening else { return }
            do {
                try await self.whisper.start(
                    onPartial: { [weak self] text in MainActor.assumeIsolated { self?.voicePartial(text) } },
                    onDone: { [weak self] text in MainActor.assumeIsolated { self?.whisperDone(text) } }
                )
                if self.listening { self.bubble = self.language.listeningHint }
            } catch {
                self.listening = false
                self.orbState = .idle
                self.bubble = self.language.voiceUnavailable
            }
        }
    }

    func stopVoiceAndTranscribe() {
        guard listening else { return }
        listening = false
        orbState = .thinking
        bubble = language.transcribing
        whisper.stopAndTranscribe()
    }

    /// A periodic interim transcript (whisper isn't streaming, so this is the
    /// audio-so-far transcribed ~every 1.5s) — show it LIVE in the input field so
    /// the text appears as you speak (Jinan: "입력된 글자가 실시간으로 보이면").
    private func voicePartial(_ text: String) {
        guard listening else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { inputText = trimmed }
    }

    /// Transcript lands in the INPUT FIELD (Jinan: "말하면 입력창에 나왔으면") for
    /// review/send — not auto-submitted.
    private func whisperDone(_ text: String) {
        listening = false
        orbState = .idle
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        inputText = trimmed
        bubble = trimmed.isEmpty
            ? (language == .korean ? "잘 못 들었어요 — 마이크를 탭하고 다시 말해주세요." : "Didn't catch that — tap the mic and try again.")
            : ""
        inputVisible = true
    }

    func setCharacter(_ name: String) {
        lookName = name
        PrefsStore.update { $0.look = name }
    }

    func setLanguage(_ pref: AppLanguage) {
        PrefsStore.update { $0.language = pref.rawValue }
        language = resolveLanguage(pref, systemIsKorean: Self.systemIsKorean)
    }
}
