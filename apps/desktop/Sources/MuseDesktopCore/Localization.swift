import Foundation

/// The companion's language setting (menu bar → Language). Persisted in
/// `CompanionPrefs`. `system` follows the Mac's language.
public enum AppLanguage: String, Codable, CaseIterable, Sendable {
    case system, korean, english

    public var menuTitle: String {
        switch self {
        case .system: return "System"
        case .korean: return "한국어"
        case .english: return "English"
        }
    }

    /// Resolve the persisted `CompanionPrefs.language` String? back to a choice,
    /// falling back to `.system` for nil / empty / any unrecognized value. The
    /// single source of truth so the menu checkmark and the resolved language
    /// can't drift apart.
    public static func fromPersisted(_ raw: String?) -> AppLanguage {
        AppLanguage(rawValue: raw ?? "") ?? .system
    }
}

/// A concrete language (system already resolved) with the user-facing strings +
/// the on-device speech locale. Pure, so the choice → strings mapping is tested.
public enum ResolvedLanguage: String, Sendable {
    case korean, english

    public var speechLocale: String { self == .korean ? "ko-KR" : "en-US" }
    public var whisperLang: String { self == .korean ? "ko" : "en" }
    public var askPlaceholder: String { self == .korean ? "무엇이든 물어보세요…" : "Ask Muse anything…" }
    public var greeting: String {
        self == .korean ? "안녕하세요, Muse예요. 무엇이든 물어보세요." : "Hi, I'm Muse — ask me anything."
    }
    public var listeningHint: String {
        self == .korean ? "🎙️ 듣고 있어요… 끝나면 마이크를 다시 탭하세요." : "🎙️ Listening… tap the mic again when you're done."
    }
    public var transcribing: String {
        self == .korean ? "✍️ 변환 중…" : "✍️ Transcribing…"
    }
    public var preparingVoice: String {
        self == .korean
            ? "🧠 음성 모델 준비 중… (최초 1회만 다운로드)"
            : "🧠 Preparing the speech model… (one-time download)"
    }
    public func downloadingVoice(_ pct: Int) -> String {
        self == .korean
            ? "⬇️ 음성 모델 다운로드 중… \(pct)% (최초 1회만)"
            : "⬇️ Downloading the speech model… \(pct)% (one-time)"
    }
    /// Map a raw download fraction (0...1, externally sourced from WhisperKit/
    /// HuggingFace and occasionally slightly out of range) to the progress
    /// bubble: "Preparing…" until at least 1% of a real download has moved, then
    /// a CLAMPED, ROUNDED percentage. Pure so the fraction→text decision is
    /// tested, not buried in the untested AppKit layer.
    public func downloadProgressBubble(fraction: Double) -> String {
        let pct = Int((max(0, min(1, fraction)) * 100).rounded())
        return pct >= 1 ? downloadingVoice(pct) : preparingVoice
    }
    public var loadingVoice: String {
        self == .korean ? "🧠 음성 모델 불러오는 중…" : "🧠 Loading the speech model…"
    }
    /// Actionable guidance when the local AI brain (Ollama + the model) isn't ready.
    public func ollamaGuidance(_ status: OllamaStatus) -> String {
        switch status {
        case .ok:
            return ""
        case .notRunning:
            return self == .korean
                ? "Muse의 로컬 AI(Ollama)가 안 켜져 있어요. ollama.com에서 설치한 뒤, 터미널에서 `ollama pull \(OllamaHealth.requiredModel)` 후 Ollama를 실행해 주세요."
                : "Muse's local AI (Ollama) isn't running. Install it from ollama.com, then run `ollama pull \(OllamaHealth.requiredModel)` and start Ollama."
        case .modelMissing(let model):
            return self == .korean
                ? "AI 모델이 아직 없어요. 터미널에서 `ollama pull \(model)` 을 실행해 주세요 (최초 1회)."
                : "The AI model isn't installed yet. Run `ollama pull \(model)` in a terminal (one-time)."
        }
    }
    public var voiceUnavailable: String {
        self == .korean
            ? "음성 모델을 불러오지 못했어요. 잠시 후 마이크를 다시 탭해 주세요 (최초 1회는 다운로드)."
            : "Couldn't load the speech model. Tap the mic again in a moment (first run downloads it)."
    }
    public var notCaught: String {
        self == .korean ? "잘 못 들었어요 — 다시 시도해 주세요." : "I didn't catch that — try again."
    }
    public var cliUnreachable: String {
        self == .korean
            ? "Muse CLI에 연결하지 못했어요. `muse`가 PATH에 있는지(또는 MUSE_BIN) 확인해 주세요."
            : "I couldn't reach the Muse CLI. Is `muse` on your PATH (or set MUSE_BIN)?"
    }
}

public func resolveLanguage(_ pref: AppLanguage, systemIsKorean: Bool) -> ResolvedLanguage {
    switch pref {
    case .korean: return .korean
    case .english: return .english
    case .system: return systemIsKorean ? .korean : .english
    }
}
