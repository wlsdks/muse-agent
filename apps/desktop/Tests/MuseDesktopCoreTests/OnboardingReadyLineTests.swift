import XCTest
@testable import MuseDesktopCore

final class OnboardingReadyLineTests: XCTestCase {
    func testReadyLinesAreHumanAndPlentiful() {
        for korean in [true, false] {
            let pool = OnboardingGuidance.readyLines(korean: korean)
            XCTAssertGreaterThanOrEqual(pool.count, 4, "want several variants to randomise over")
            for line in pool {
                XCTAssertFalse(line.trimmingCharacters(in: .whitespaces).isEmpty)
                // The complaint was the machine-like em-dash — none of the human lines carry it.
                XCTAssertFalse(line.contains("—"), "ready line should read human, not '\(line)'")
            }
        }
    }

    func testKoreanAndEnglishPoolsDiffer() {
        XCTAssertNotEqual(OnboardingGuidance.readyLines(korean: true),
                          OnboardingGuidance.readyLines(korean: false))
    }

    func testDeterministicPinsFirstVariant() {
        let a = OnboardingGuidance.readyLine(korean: true, deterministic: true)
        let b = OnboardingGuidance.readyLine(korean: true, deterministic: true)
        XCTAssertEqual(a, b)
        XCTAssertEqual(a, OnboardingGuidance.readyLines(korean: true).first)
    }

    func testRandomStaysWithinPool() {
        let pool = Set(OnboardingGuidance.readyLines(korean: false))
        for _ in 0..<20 {
            XCTAssertTrue(pool.contains(OnboardingGuidance.readyLine(korean: false)))
        }
    }
}
