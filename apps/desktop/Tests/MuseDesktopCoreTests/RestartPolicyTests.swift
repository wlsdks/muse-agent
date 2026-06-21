import XCTest
@testable import MuseDesktopCore

final class RestartPolicyTests: XCTestCase {
    func testExponentialBackoffFromTheDefaults() {
        let p = RestartPolicy() // max 3, base 1.5, cap 30
        XCTAssertEqual(p.decide(restartsSoFar: 0), .restart(afterSeconds: 1.5))
        XCTAssertEqual(p.decide(restartsSoFar: 1), .restart(afterSeconds: 3.0))
        XCTAssertEqual(p.decide(restartsSoFar: 2), .restart(afterSeconds: 6.0))
    }

    func testCircuitBreakerGivesUpAtMaxRestarts() {
        let p = RestartPolicy() // max 3 ⇒ restartsSoFar 0,1,2 restart; 3+ give up
        XCTAssertEqual(p.decide(restartsSoFar: 3), .giveUp)
        XCTAssertEqual(p.decide(restartsSoFar: 9), .giveUp)
    }

    func testDelayIsCappedAtMaxDelay() {
        let p = RestartPolicy(maxRestarts: 10, baseDelay: 1.5, maxDelay: 5)
        // 1.5 * 2^5 = 48, capped to 5
        XCTAssertEqual(p.decide(restartsSoFar: 5), .restart(afterSeconds: 5))
    }

    func testZeroMaxRestartsGivesUpImmediately() {
        XCTAssertEqual(RestartPolicy(maxRestarts: 0).decide(restartsSoFar: 0), .giveUp)
    }
}
