import XCTest
@testable import MuseDesktopCore

final class WebNavPolicyTests: XCTestCase {
    func testLoopbackHostsLoadInApp() {
        XCTAssertEqual(WebNavPolicy.decide(scheme: "http", host: "127.0.0.1"), .allow)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "http", host: "localhost"), .allow)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "https", host: "localhost"), .allow)
    }

    func testInertSchemesLoadInApp() {
        XCTAssertEqual(WebNavPolicy.decide(scheme: "about", host: ""), .allow)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "data", host: ""), .allow)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "blob", host: ""), .allow)
    }

    func testExternalHttpOpensInBrowser() {
        XCTAssertEqual(WebNavPolicy.decide(scheme: "https", host: "example.com"), .openExternally)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "http", host: "muse.ai"), .openExternally)
    }

    func testNonHttpSchemesAreBlocked() {
        XCTAssertEqual(WebNavPolicy.decide(scheme: "file", host: ""), .cancel)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "javascript", host: ""), .cancel)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "ftp", host: "host"), .cancel)
    }

    func testSchemeMatchIsCaseInsensitive() {
        XCTAssertEqual(WebNavPolicy.decide(scheme: "HTTP", host: "localhost"), .allow)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "HTTPS", host: "example.com"), .openExternally)
    }

    func testLookalikeLocalhostHostIsNotTreatedAsLocal() {
        // exact-match guard: a host that merely CONTAINS "localhost" must not load
        // in-app — it goes to the browser like any other external site.
        XCTAssertEqual(WebNavPolicy.decide(scheme: "https", host: "localhost.evil.com"), .openExternally)
        XCTAssertEqual(WebNavPolicy.decide(scheme: "https", host: "127.0.0.1.evil.com"), .openExternally)
    }
}
