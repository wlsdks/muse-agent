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
        let pref = AppLanguage(rawValue: prefs.language ?? "") ?? .system
        let lang = resolveLanguage(pref, systemIsKorean: Self.systemIsKorean)
        lookName = ProcessInfo.processInfo.environment["MUSE_DESKTOP_CHARACTER"] ?? prefs.look
        language = lang
        bubble = "" // idle = just the orb; the bubble appears only on an answer / listening
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
            let presentation = MusePresenter.present(result, language: self.language)
            self.bubble = presentation.bubbleText
            self.busy = false
            if let speech = presentation.speechText, !self.voiceMuted {
                self.orbState = .speaking
                self.speaker.speak(speech) { [weak self] in Task { @MainActor in self?.orbState = .idle } }
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
        guard WhisperCapture.isAvailable else {
            bubble = language == .korean
                ? "음성 인식을 쓰려면 whisper.cpp가 필요해요: `brew install whisper-cpp` + 모델을 ~/.muse/whisper-models/ggml-base.bin 에. 일단 입력해 주세요."
                : "Voice needs whisper.cpp: `brew install whisper-cpp` + a model at ~/.muse/whisper-models/ggml-base.bin. Type for now."
            inputVisible = true
            return
        }
        listening = true
        orbState = .listening
        inputVisible = true
        inputText = ""
        bubble = language.listeningHint // clear feedback while recording (whisper isn't streaming)
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
                try self.whisper.start(
                    onPartial: { [weak self] text in Task { @MainActor in self?.voicePartial(text) } },
                    onDone: { [weak self] text in Task { @MainActor in self?.whisperDone(text) } }
                )
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
