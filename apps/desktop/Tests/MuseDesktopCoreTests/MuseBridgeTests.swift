import XCTest
@testable import MuseDesktopCore

final class MuseBridgeTests: XCTestCase {
    func testInvocationIsLocalFirstByConstruction() {
        let invocation = MuseBridge.invocation(query: "what's my office VPN MTU?", bin: "muse")
        XCTAssertEqual(invocation.executable, "muse")
        XCTAssertEqual(invocation.arguments, ["ask", "--local", "what's my office VPN MTU?"])
        // The companion must NEVER be able to reach a cloud model.
        XCTAssertTrue(invocation.arguments.contains("--local"))
    }

    func testDefaultBinHonoursEnvOverride() {
        XCTAssertEqual(MuseBridge.defaultBin(environment: ["MUSE_BIN": "/opt/muse/bin/muse"]), "/opt/muse/bin/muse")
        XCTAssertEqual(MuseBridge.defaultBin(environment: ["MUSE_BIN": ""]), "muse")
        XCTAssertEqual(MuseBridge.defaultBin(environment: [:]), "muse")
    }

    func testCleanAnswerStripsAnsiAndTrims() {
        let raw = "\u{1B}[32m  1380 bytes [from vpn.md]\u{1B}[0m\n"
        XCTAssertEqual(MuseBridge.cleanAnswer(raw), "1380 bytes [from vpn.md]")
    }

    func testCleanAnswerLeavesPlainTextUntouched() {
        XCTAssertEqual(MuseBridge.cleanAnswer("Mortimer [from plant.md]"), "Mortimer [from plant.md]")
    }

    func testAskRejectsAnEmptyQueryWithoutSpawning() async {
        do {
            _ = try await MuseBridge.ask(query: "   ", bin: "muse")
            XCTFail("expected emptyQuery")
        } catch {
            XCTAssertEqual(error as? MuseBridgeError, .emptyQuery)
        }
    }
}
