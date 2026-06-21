import XCTest
@testable import MuseDesktopCore

final class OnboardingGuidanceTests: XCTestCase {
    func testReadyWhenOk() {
        XCTAssertEqual(OnboardingGuidance.text(for: .ok, korean: false), "Ready!")
        XCTAssertEqual(OnboardingGuidance.text(for: .ok, korean: true), "준비 완료!")
    }

    func testNotRunningTellsHowToStartOllama() {
        XCTAssertTrue(OnboardingGuidance.text(for: .notRunning, korean: false).contains("ollama serve"))
        XCTAssertTrue(OnboardingGuidance.text(for: .notRunning, korean: true).contains("ollama serve"))
    }

    func testModelMissingInterpolatesTheExactPullCommand() {
        // The user copy-pastes this — the model id must be exact, both languages.
        XCTAssertTrue(OnboardingGuidance.text(for: .modelMissing("gemma4:12b"), korean: false).contains("ollama pull gemma4:12b"))
        XCTAssertTrue(OnboardingGuidance.text(for: .modelMissing("gemma4:12b"), korean: true).contains("ollama pull gemma4:12b"))
    }

    func testModelMissingUsesTheGivenModelNotAHardcodedOne() {
        let g = OnboardingGuidance.text(for: .modelMissing("qwen3:8b"), korean: false)
        XCTAssertTrue(g.contains("ollama pull qwen3:8b"))
        XCTAssertFalse(g.contains("gemma4")) // must not leak a hardcoded default
    }
}
