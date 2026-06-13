import XCTest
@testable import MuseDesktopCore

final class OllamaHealthTests: XCTestCase {
    private func body(_ names: [String]) -> Data {
        let models = names.map { "{\"name\":\"\($0)\"}" }.joined(separator: ",")
        return Data("{\"models\":[\(models)]}".utf8)
    }

    func testModelPresentIsOk() {
        XCTAssertEqual(OllamaHealth.parse(body(["qwen3:8b", "nomic-embed-text:latest"]), model: "qwen3:8b"), .ok)
    }

    func testQuantSuffixedVariantCounts() {
        XCTAssertEqual(OllamaHealth.parse(body(["qwen3:8b-q4_K_M"]), model: "qwen3:8b"), .ok)
    }

    func testDifferentSizeTagIsNotPresent() {
        // Having qwen3:14b but not qwen3:8b is a missing model, not a match.
        XCTAssertEqual(OllamaHealth.parse(body(["qwen3:14b", "qwen3:80b"]), model: "qwen3:8b"), .modelMissing("qwen3:8b"))
    }

    func testNoModelsIsMissing() {
        XCTAssertEqual(OllamaHealth.parse(body([]), model: "qwen3:8b"), .modelMissing("qwen3:8b"))
    }

    func testUnparseableButReachableAssumesOk() {
        XCTAssertEqual(OllamaHealth.parse(Data("not json".utf8), model: "qwen3:8b"), .ok)
    }

    func testBareNameAndLatestTagAreTheSameIdentity() {
        // Ollama records a bare `ollama pull gemma4` as "gemma4:latest" — the same
        // implicit-:latest identity rule the CLI's findOllamaModelTag uses. Bare
        // and :latest must count as present, else the companion onboards a model
        // the user already has.
        XCTAssertEqual(OllamaHealth.parse(body(["gemma4:latest"]), model: "gemma4"), .ok)
        XCTAssertEqual(OllamaHealth.parse(body(["gemma4"]), model: "gemma4:latest"), .ok)
        // A genuinely different size tag is still missing (no false-positive).
        XCTAssertEqual(OllamaHealth.parse(body(["gemma4:27b"]), model: "gemma4:12b"), .modelMissing("gemma4:12b"))
    }

    func testRequiredModelIsCurrentDefault() {
        // Must match the CLI's LOCAL_FIRST_DEFAULT_MODEL (ollama/gemma4:12b),
        // bare tag — else the companion health-checks/onboards a stale model.
        XCTAssertEqual(OllamaHealth.requiredModel, "gemma4:12b")
    }

    func testNotRunningGuidanceNamesTheRequiredModel() {
        for lang in [ResolvedLanguage.korean, .english] {
            let guidance = lang.ollamaGuidance(.notRunning)
            XCTAssertTrue(
                guidance.contains(OllamaHealth.requiredModel),
                "\(lang) not-running guidance should tell the user to pull the required model"
            )
            XCTAssertFalse(
                guidance.contains("qwen3:8b"),
                "\(lang) guidance must not name the stale qwen3:8b model"
            )
        }
    }
}
