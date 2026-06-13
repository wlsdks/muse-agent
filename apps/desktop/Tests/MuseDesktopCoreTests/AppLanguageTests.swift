import XCTest
@testable import MuseDesktopCore

/// `AppLanguage.fromPersisted` is the single source of truth for turning the
/// `CompanionPrefs.language` String? back into a menu choice. Both AppKit sites
/// (the menu checkmark in MuseController, the resolved language in
/// CompanionModel) delegate to it, so this truth table is what keeps the menu
/// state and the actually-used language from drifting apart.
final class AppLanguageTests: XCTestCase {
    func testCanonicalRawValuesRoundTrip() {
        for lang in AppLanguage.allCases {
            XCTAssertEqual(AppLanguage.fromPersisted(lang.rawValue), lang)
        }
    }

    func testNilFallsBackToSystem() {
        XCTAssertEqual(AppLanguage.fromPersisted(nil), .system)
    }

    func testEmptyFallsBackToSystem() {
        XCTAssertEqual(AppLanguage.fromPersisted(""), .system)
    }

    func testUnknownFallsBackToSystem() {
        XCTAssertEqual(AppLanguage.fromPersisted("français"), .system)
        XCTAssertEqual(AppLanguage.fromPersisted("ko"), .system)
    }
}
