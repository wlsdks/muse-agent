import AVFoundation
import MuseDesktopCore
@preconcurrency import TTSKit

/// Speaks an answer aloud. Abstracted so the panel's logic stays testable and
/// so speech can be turned off (`MUSE_DESKTOP_SPEAK=0`) without branching.
protocol Speaker {
    func speak(_ text: String, language: ResolvedLanguage, onFinish: @escaping () -> Void)
}

/// Natural on-device speech via TTSKit (Argmax, MIT) running Qwen3-TTS
/// (Apache-2.0 weights) on CoreML + the Neural Engine. Local by construction —
/// the spoken reply never leaves the Mac, no cloud, no key. The model
/// (~1GB, 0.6b) downloads once from HuggingFace then is cached, and is loaded
/// lazily on the FIRST spoken reply (not at launch — see `ensureLoaded`, which
/// defers it so it doesn't contend with the speech-to-text model load). The
/// cold load is ~22s; while it runs, that first reply falls back to the system
/// voice so nothing is ever silent, and subsequent replies use the neural voice.
final class QwenSpeaker: Speaker {
    private let fallback = SystemSpeaker()
    private var tts: TTSKit?
    private var loadTask: Task<Void, Never>?
    private var current: Task<Void, Never>?

    func speak(_ text: String, language: ResolvedLanguage, onFinish: @escaping () -> Void) {
        ensureLoaded()
        current?.cancel()
        guard let tts else {
            // Neural voice still loading — don't be silent; use the system voice this once.
            fallback.speak(text, language: language, onFinish: onFinish)
            return
        }
        let langValue = (language == .korean ? Qwen3Language.korean : Qwen3Language.english).rawValue
        current = Task {
            do { _ = try await tts.play(text: text, voice: nil, language: langValue) }
            catch { WhisperCapture.log("TTS play failed: \(error.localizedDescription)") }
            await MainActor.run { onFinish() }
        }
    }

    /// Load the Qwen3-TTS model on the first spoken reply — lazy (after launch) so
    /// it doesn't contend with the speech-to-text model loading at the same time.
    /// A failed load isn't cached, so the next reply retries.
    private func ensureLoaded() {
        guard loadTask == nil, tts == nil else { return }
        loadTask = Task { [weak self] in
            do {
                let kit = try await TTSKit(model: .qwen3TTS_0_6b)
                await MainActor.run { self?.tts = kit }
                WhisperCapture.log("TTS model loaded (qwen3-tts 0.6b)")
            } catch {
                WhisperCapture.log("TTS load FAILED: \(error.localizedDescription)")
                await MainActor.run { self?.loadTask = nil }
            }
        }
    }
}

/// On-device macOS speech (AVSpeechSynthesizer) — the offline fallback while the
/// neural voice loads, and the explicit `MUSE_DESKTOP_TTS=system` option.
final class SystemSpeaker: NSObject, Speaker, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var onFinish: (() -> Void)?
    private var currentUtterance: AVSpeechUtterance?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String, language: ResolvedLanguage, onFinish: @escaping () -> Void) {
        // Disarm first: stopSpeaking fires didCancel for the PRIOR utterance, and
        // we must NOT route the new callback to that old cancel. Nil-ing
        // currentUtterance makes the delegate ignore the stale event.
        currentUtterance = nil
        synthesizer.stopSpeaking(at: .immediate)
        self.onFinish = onFinish
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.voice = AVSpeechSynthesisVoice(language: language == .korean ? "ko-KR" : "en-US")
        currentUtterance = utterance
        synthesizer.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard utterance === currentUtterance else { return }
        finish()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard utterance === currentUtterance else { return }
        finish()
    }

    private func finish() {
        currentUtterance = nil
        let callback = onFinish
        onFinish = nil
        callback?()
    }
}

/// Speech disabled — answers still show in the bubble.
final class SilentSpeaker: Speaker {
    func speak(_ text: String, language: ResolvedLanguage, onFinish: @escaping () -> Void) { onFinish() }
}

enum SpeakerFactory {
    static func make(environment: [String: String] = ProcessInfo.processInfo.environment) -> Speaker {
        switch selectSpeakerKind(environment) {
        case .silent: return SilentSpeaker()
        case .system: return SystemSpeaker()
        case .qwen: return QwenSpeaker()
        }
    }
}
