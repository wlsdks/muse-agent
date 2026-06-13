import Foundation

/// Which Speaker the companion should use, decided from the environment.
public enum SpeakerKind: Equatable, Sendable {
    case silent  // speech turned off
    case system  // OS AVSpeechSynthesizer
    case qwen    // bundled on-device TTS (default)
}

/// Pure + headless-testable routing for the companion's voice output, so the
/// on/off/system/qwen contract is locked. The silence toggle accepts the common
/// falsy spellings (0/false/no/off, case-insensitive, trimmed) — not only the
/// literal "0" — so `MUSE_DESKTOP_SPEAK=false` actually silences instead of
/// surprising the user with speech.
public func selectSpeakerKind(_ environment: [String: String]) -> SpeakerKind {
    let speak = environment["MUSE_DESKTOP_SPEAK"]?.trimmingCharacters(in: .whitespaces).lowercased()
    if let speak, ["0", "false", "no", "off"].contains(speak) {
        return .silent
    }
    if environment["MUSE_DESKTOP_TTS"]?.trimmingCharacters(in: .whitespaces).lowercased() == "system" {
        return .system
    }
    return .qwen
}
