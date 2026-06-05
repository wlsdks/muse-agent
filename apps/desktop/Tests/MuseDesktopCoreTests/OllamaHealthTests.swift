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
}
