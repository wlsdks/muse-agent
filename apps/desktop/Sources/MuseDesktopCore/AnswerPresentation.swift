import Foundation

/// What the companion should show in its bubble and (optionally) speak aloud for
/// one Muse answer. Pure + headless-testable: it decides WHEN to speak (only a
/// real answer — never an error or an empty result) and WHAT to speak (the
/// answer minus citation markers, which read badly aloud). The AppKit layer just
/// renders `bubbleText` and, if `speechText != nil`, hands it to a Speaker.
public struct AnswerPresentation: Equatable, Sendable {
    public let bubbleText: String
    /// nil ⇒ stay silent (an error, an empty answer, or speech disabled).
    public let speechText: String?

    public init(bubbleText: String, speechText: String?) {
        self.bubbleText = bubbleText
        self.speechText = speechText
    }
}

public enum MusePresenter {
    /// Map a CLI result to what the bubble shows and what (if anything) is spoken,
    /// in the companion's chosen language.
    public static func present(_ result: Result<String, MuseBridgeError>, language: ResolvedLanguage = .english) -> AnswerPresentation {
        switch result {
        case .success(let answer):
            let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return AnswerPresentation(bubbleText: language == .korean ? "그건 노트에서 찾지 못했어요." : "I don't have anything on that in your notes.", speechText: nil)
            }
            // A receipt/citation-only answer strips to "" — collapse it to nil so
            // the `nil ⇒ silent` contract holds (the consumer's `if let speech`
            // would otherwise speak an empty utterance + animate the orb).
            let spoken = stripCitationsForSpeech(trimmed)
            return AnswerPresentation(bubbleText: trimmed, speechText: spoken.isEmpty ? nil : spoken)
        case .failure(.emptyQuery):
            return AnswerPresentation(bubbleText: language == .korean ? "노트에 대해 무엇이든 물어보세요." : "Ask me something about your notes.", speechText: nil)
        case .failure(.cliFailed):
            return AnswerPresentation(bubbleText: language.cliUnreachable, speechText: nil)
        }
    }

    /// Drop citation markers from the SPOKEN text — they read badly aloud ("from
    /// v-p-n dot m-d") — while the bubble keeps them visible. Strips BOTH the
    /// inline "[from <source>]" and the trailing "📎 노트: …" / "📎 from: …" receipt
    /// line that `withGroundingReceipt` appends (a spoken file path is just noise).
    public static func stripCitationsForSpeech(_ text: String) -> String {
        var spoken = text.replacingOccurrences(
            of: "\\s*\\[from[^\\]]*\\]",
            with: "",
            options: .regularExpression
        )
        spoken = spoken.replacingOccurrences(
            of: "\\s*📎[\\s\\S]*",
            with: "",
            options: .regularExpression
        )
        return spoken.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
