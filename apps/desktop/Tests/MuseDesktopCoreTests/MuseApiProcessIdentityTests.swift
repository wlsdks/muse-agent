import XCTest
@testable import MuseDesktopCore

final class MuseApiProcessIdentityTests: XCTestCase {
    func testRecognizesOnlyExactMuseApiExecutables() {
        XCTAssertTrue(MuseApiProcessIdentity.isMuseApiCommand("/Applications/Muse.app/Contents/Resources/muse-api-bin --port 3030"))
        XCTAssertTrue(MuseApiProcessIdentity.isMuseApiCommand("muse-api --port 3030"))
        XCTAssertFalse(MuseApiProcessIdentity.isMuseApiCommand("/usr/local/bin/muse-api-client --port 3030"))
        XCTAssertFalse(MuseApiProcessIdentity.isMuseApiCommand("/usr/bin/python3 worker-muse-api.py"))
    }

    func testRejectsBlankAndWhitespaceOnlyCommands() {
        XCTAssertFalse(MuseApiProcessIdentity.isMuseApiCommand(""))
        XCTAssertFalse(MuseApiProcessIdentity.isMuseApiCommand("  \n\t "))
    }
}
