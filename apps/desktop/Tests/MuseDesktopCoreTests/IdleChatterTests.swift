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

    func testTimeGreetingBucketsByHour() {
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 8, language: .english), "Good morning ☀️")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 14, language: .english), "Hope your afternoon's going well")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 20, language: .english), "Good evening 🌆")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 2, language: .english), "It's late — don't overdo it 🌙")
    }

    func testTimeGreetingBoundaries() {
        // morning 5–11, afternoon 12–17, evening 18–22, night 23–4
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 5, language: .english), "Good morning ☀️")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 11, language: .english), "Good morning ☀️")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 12, language: .english), "Hope your afternoon's going well")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 18, language: .english), "Good evening 🌆")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 22, language: .english), "Good evening 🌆")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 23, language: .english), "It's late — don't overdo it 🌙")
    }

    func testTimeGreetingIsLocalizedAndHourNormalized() {
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 8, language: .korean), "좋은 아침이에요, 진안 ☀️")
        // 26 → 2 (night), -1 → 23 (night): defensive normalization, never crashes
        XCTAssertEqual(IdleChatter.timeGreeting(hour: 26, language: .english), "It's late — don't overdo it 🌙")
        XCTAssertEqual(IdleChatter.timeGreeting(hour: -1, language: .english), "It's late — don't overdo it 🌙")
    }

    func testDisplaySecondsScalesWithLengthWithinClamp() {
        XCTAssertEqual(IdleChatter.displaySeconds(forTextLength: 0), 6)    // floor
        XCTAssertEqual(IdleChatter.displaySeconds(forTextLength: 5), 6)    // still floored (4.45 → 6)
        XCTAssertEqual(IdleChatter.displaySeconds(forTextLength: 100), 13) // 4 + 9 = 13, mid-range
        XCTAssertEqual(IdleChatter.displaySeconds(forTextLength: 1000), 20) // ceiling
    }

    func testDisplaySecondsIsMonotonicAndLongerThanShort() {
        XCTAssertGreaterThan(
            IdleChatter.displaySeconds(forTextLength: 160),
            IdleChatter.displaySeconds(forTextLength: 10)
        )
    }

    func testRejectsNearDuplicateOfRecent() {
        // Same words, different case/whitespace/punctuation ⇒ treated as a repeat.
        XCTAssertNil(IdleChatter.acceptThought("Hi there!", recent: ["hi  there"]))
        // A genuinely different line still passes.
        XCTAssertEqual(IdleChatter.acceptThought("Need anything?", recent: ["hi there"]), "Need anything?")
    }
}
