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
}

/// A concrete language (system already resolved) with the user-facing strings +
/// the on-device speech locale. Pure, so the choice → strings mapping is tested.
public enum ResolvedLanguage: String, Sendable {
    case korean, english

    public var speechLocale: String { self == .korean ? "ko-KR" : "en-US" }
    public var askPlaceholder: String { self == .korean ? "무엇이든 물어보세요…" : "Ask Muse anything…" }
    public var greeting: String {
        self == .korean ? "안녕하세요, Muse예요. 무엇이든 물어보세요." : "Hi, I'm Muse — ask me anything."
    }
    public var listeningHint: String {
        self == .korean ? "듣고 있어요… 질문을 말해주세요." : "Listening… speak your question."
    }
    public var voiceUnavailable: String {
        self == .korean
            ? "이 언어는 온디바이스 음성을 지원하지 않아요 — 입력해 주세요."
            : "On-device speech isn't available — type instead."
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
