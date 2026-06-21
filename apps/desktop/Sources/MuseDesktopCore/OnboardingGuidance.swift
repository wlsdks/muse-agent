import Foundation

/// The actionable fix-it line shown during first-run onboarding for each local-AI
/// readiness state. Pure + headless-testable so the AppKit onboarding view holds
/// no copy. The model-missing case interpolates the exact model id into the
/// `ollama pull …` command the user will copy-paste, so it must be precise.
public enum OnboardingGuidance {
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
