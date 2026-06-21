import XCTest
@testable import MuseDesktopCore

final class MenuStatusTests: XCTestCase {
    func testShortModelNameTakesLastPathSegment() {
        XCTAssertEqual(MenuStatus.shortModelName("ollama/gemma4:12b"), "gemma4:12b")
        XCTAssertEqual(MenuStatus.shortModelName("a/b/c"), "c")
        XCTAssertEqual(MenuStatus.shortModelName("gemma4:12b"), "gemma4:12b") // no slash
        XCTAssertEqual(MenuStatus.shortModelName(""), "")
    }

    func testIsLocalOnlyDefaultsOnAndOnlyFalseDisables() {
        XCTAssertTrue(MenuStatus.isLocalOnly(nil))      // default on
        XCTAssertTrue(MenuStatus.isLocalOnly("true"))
        XCTAssertTrue(MenuStatus.isLocalOnly(""))       // garbage ⇒ stays private
        XCTAssertTrue(MenuStatus.isLocalOnly("FALSE"))  // case-sensitive: not the literal "false"
        XCTAssertFalse(MenuStatus.isLocalOnly("false")) // the ONLY disabling value
    }

    func testLineComposesWithShortenedModel() {
        XCTAssertEqual(
            MenuStatus.line(localLabel: "Local", model: "ollama/gemma4:12b", serverLabel: "Server on"),
            "Local · gemma4:12b · Server on"
        )
    }
}
