import XCTest
@testable import MuseDesktopCore

final class IdleChatterTests: XCTestCase {
    private let lines = ["Hi, I'm here", "Ask me anything", "What can I help with?"]

    func testCyclesThroughLinesInOrder() {
        XCTAssertEqual(IdleChatter.nextCannedLine(lines, last: nil, index: 0), "Hi, I'm here")
        XCTAssertEqual(IdleChatter.nextCannedLine(lines, last: nil, index: 1), "Ask me anything")
        XCTAssertEqual(IdleChatter.nextCannedLine(lines, last: nil, index: 3), "Hi, I'm here") // wraps
    }

    func testAvoidsImmediateRepeatOfLast() {
        // index 0 would normally yield the same line that was just shown — skip it.
        XCTAssertEqual(IdleChatter.nextCannedLine(lines, last: "Hi, I'm here", index: 0), "Ask me anything")
    }

    func testSingleLineListRepeatsRatherThanCrash() {
        XCTAssertEqual(IdleChatter.nextCannedLine(["only"], last: "only", index: 0), "only")
    }

    func testEmptyLineListReturnsEmpty() {
        XCTAssertEqual(IdleChatter.nextCannedLine([], last: nil, index: 2), "")
    }

    func testAcceptsAGoodThought() {
        XCTAssertEqual(IdleChatter.acceptThought("  Want a hand with today's plan?  "), "Want a hand with today's plan?")
    }

    func testRejectsEmptyOrWhitespace() {
        XCTAssertNil(IdleChatter.acceptThought("   \n  "))
    }

    func testRejectsOverlongThought() {
        let long = String(repeating: "가", count: IdleChatter.maxThoughtLength + 1)
        XCTAssertNil(IdleChatter.acceptThought(long))
        let edge = String(repeating: "x", count: IdleChatter.maxThoughtLength)
        XCTAssertEqual(IdleChatter.acceptThought(edge), edge) // exactly the limit is fine
    }

    func testRejectsUnsureRefusals() {
        XCTAssertNil(IdleChatter.acceptThought("Hmm, I'm not sure about that."))
        XCTAssertNil(IdleChatter.acceptThought("그건 잘 모르겠어요."))
    }

    func testRejectsNearDuplicateOfRecent() {
        // Same words, different case/whitespace/punctuation ⇒ treated as a repeat.
        XCTAssertNil(IdleChatter.acceptThought("Hi there!", recent: ["hi  there"]))
        // A genuinely different line still passes.
        XCTAssertEqual(IdleChatter.acceptThought("Need anything?", recent: ["hi there"]), "Need anything?")
    }
}
