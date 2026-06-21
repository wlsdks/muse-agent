import Foundation

/// Decides what the idle companion says first and gates a model-generated
/// "genuine thought" before it reaches the bubble. Pure + headless-testable so
/// the AppKit layer holds no idle-chatter policy. Goal: Muse speaks first OFTEN
/// without feeling robotic — never an immediate repeat, never a low-quality or
/// "I'm not sure" line surfaced as an unprompted thought.
public enum IdleChatter {
    /// A thought longer than this reads as a paragraph, not a one-liner.
    public static let maxThoughtLength = 160

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
