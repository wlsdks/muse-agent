import Foundation

/// The actionable fix-it line shown during first-run onboarding for each local-AI
/// readiness state. Pure + headless-testable so the AppKit onboarding view holds
/// no copy. The model-missing case interpolates the exact model id into the
/// `ollama pull …` command the user will copy-paste, so it must be precise.
public enum OnboardingGuidance {
    /// Warm, human-sounding "ready" lines for the onboarding status card. Several
    /// variants so first-run doesn't read like one canned machine string (no
    /// em-dashes / template punctuation); a random one shows each launch.
    public static func readyLines(korean: Bool) -> [String] {
        korean
            ? ["로컬 AI가 다 준비됐어요. 이제 시작해볼까요?",
               "준비 끝났어요! 편하게 말 걸어 주세요.",
               "다 켜졌어요. 오늘 뭐부터 도와드릴까요?",
               "여기 다 준비돼 있어요. 바로 시작해요!",
               "로컬에서 조용히 기다리고 있었어요. 언제든 불러 주세요.",
               "세팅 끝났어요! 이제 저랑 같이 시작해봐요."]
            : ["Your local AI is all set. Ready when you are!",
               "All set up. Come say hi whenever you like.",
               "Everything's running locally. Let's get started!",
               "Ready to go. What can I help with first?",
               "Set up and waiting. Just say the word.",
               "All good here. Let's dive in!"]
    }

    /// One ready line. `deterministic` (test mode) pins the first variant so
    /// screenshots stay stable; otherwise a random variant is picked.
    public static func readyLine(korean: Bool, deterministic: Bool = false) -> String {
        let pool = readyLines(korean: korean)
        guard !pool.isEmpty else { return korean ? "준비 완료!" : "Ready!" }
        return deterministic ? pool[0] : (pool.randomElement() ?? pool[0])
    }

    public static func text(for status: OllamaStatus, korean: Bool) -> String {
        switch status {
        case .ok:
            return korean ? "준비 완료!" : "Ready!"
        case .notRunning:
            return korean
                ? "Ollama가 실행 중이 아니에요. 터미널에서 `ollama serve`를 실행하거나 Ollama 앱을 여세요."
                : "Ollama isn't running. Run `ollama serve` or open the Ollama app."
        case .modelMissing(let model):
            return korean
                ? "모델이 없어요. 터미널에서 `ollama pull \(model)`을 실행하세요."
                : "Model missing. Run `ollama pull \(model)` in Terminal."
        }
    }
}
