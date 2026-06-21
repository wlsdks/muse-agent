import Foundation

/// Decides what the idle companion says first and gates a model-generated
/// "genuine thought" before it reaches the bubble. Pure + headless-testable so
/// the AppKit layer holds no idle-chatter policy. Goal: Muse speaks first OFTEN
/// without feeling robotic — never an immediate repeat, never a low-quality or
/// "I'm not sure" line surfaced as an unprompted thought.
public enum IdleChatter {
    /// A thought longer than this reads as a paragraph, not a one-liner.
    public static let maxThoughtLength = 160

    /// How long the idle bubble should stay up for a line of `length` characters
    /// — proportional to reading time so a long generated thought isn't cleared
    /// before it can be read, clamped to a sane [6s, 20s] window. A short
    /// greeting gets the floor; the 160-char max gets near the ceiling.
    public static func displaySeconds(forTextLength length: Int) -> Double {
        let raw = 4.0 + Double(max(0, length)) * 0.09
        return min(20, max(6, raw))
    }

    /// The next canned greeting to show, avoiding an immediate repeat of `last`
    /// (so even a single-step index or a changed line list won't say the same
    /// thing twice in a row). Deterministic — no randomness.
    public static func nextCannedLine(_ lines: [String], last: String?, index: Int) -> String {
        guard !lines.isEmpty else { return "" }
        let primary = lines[((index % lines.count) + lines.count) % lines.count]
        if let last, primary == last, lines.count > 1 {
            return lines[((index + 1) % lines.count + lines.count) % lines.count]
        }
        return primary
    }

    /// A time-of-day-appropriate opening line, so the companion's first greeting
    /// of a session feels present (morning/afternoon/evening/late-night) rather
    /// than a generic hello. `hour` is a 0–23 clock hour (normalized defensively).
    public static func timeGreeting(hour: Int, language: ResolvedLanguage) -> String {
        let h = ((hour % 24) + 24) % 24
        let ko = language == .korean
        switch h {
        case 5...11: return ko ? "좋은 아침이에요, 진안 ☀️" : "Good morning ☀️"
        case 12...17: return ko ? "오후도 잘 보내고 있어요?" : "Hope your afternoon's going well"
        case 18...22: return ko ? "좋은 저녁이에요 🌆" : "Good evening 🌆"
        default: return ko ? "늦었네요 — 무리하지 말아요 🌙" : "It's late — don't overdo it 🌙"
        }
    }

    /// Clean + accept a model-generated thought, or `nil` if it should be dropped:
    /// empty, too long, an "I'm not sure"-style refusal, or a near-duplicate of a
    /// recently shown line (so repeated 8B greetings don't feel like a stuck loop).
    public static func acceptThought(_ raw: String, recent: [String] = []) -> String? {
        let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= maxThoughtLength else { return nil }
        let lower = clean.lowercased()
        guard !lower.contains("i'm not sure"), !clean.contains("잘 모르") else { return nil }
        let key = normalize(clean)
        guard !key.isEmpty else { return nil }
        if recent.contains(where: { normalize($0) == key }) { return nil }
        return clean
    }

    /// Loose equality key: lowercased, whitespace-collapsed, surrounding chatter
    /// punctuation stripped — so "Hi there!" and "hi  there" count as the same.
    static func normalize(_ s: String) -> String {
        let collapsed = s.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return collapsed.trimmingCharacters(in: CharacterSet(charactersIn: ".!?…~ "))
    }
}
