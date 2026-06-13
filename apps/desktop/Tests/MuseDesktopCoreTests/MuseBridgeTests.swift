import XCTest
@testable import MuseDesktopCore

final class MuseBridgeTests: XCTestCase {
    func testInvocationIsAConversationalLocalChat() {
        let invocation = MuseBridge.invocation(query: "what's my office VPN MTU?", bin: "muse")
        XCTAssertEqual(invocation.executable, "muse")
        // `chat --local -c` keeps prior turns (memory) on the local Qwen; `--json`
        // gives a clean structured reply (no progress lines / CLI hints).
        XCTAssertEqual(invocation.arguments, ["chat", "--local", "-c", "--json", "what's my office VPN MTU?"])
    }

    func testParseAnswerExtractsTheResponseFieldFromJSON() {
        let json = ##"{"response":"  안녕하세요, 진안.  ","runId":"r1","toolsUsed":[]}"##
        XCTAssertEqual(MuseBridge.parseAnswer(json), "안녕하세요, 진안.")
    }

    func testParseAnswerStillAcceptsTheAskAnswerField() {
        let json = ##"{"answer":"  1380 bytes [from vpn.md]  "}"##
        XCTAssertEqual(MuseBridge.parseAnswer(json), "1380 bytes [from vpn.md]")
    }

    func testParseAnswerFallsBackToCleanAnswerForNonJSON() {
        // A CLI that isn't emitting the expected JSON (or an error string) still
        // shows something readable rather than nothing.
        XCTAssertEqual(MuseBridge.parseAnswer("\u{1B}[32mplain text\u{1B}[0m\n"), "plain text")
    }

    func testParseAnswerReturnsEmptyForValidJSONWithNoUsableText() {
        // The output IS the expected JSON but carries no answer (model hiccup) —
        // must yield "" so the empty-answer UX fires, NOT leak the raw object.
        XCTAssertEqual(MuseBridge.parseAnswer(##"{"response":""}"##), "")
        XCTAssertEqual(MuseBridge.parseAnswer(##"{"runId":"abc","toolsUsed":[]}"##), "")
    }

    func testEmptyJSONResponsePresentsAsSilentNoNotesAnswer() {
        let presentation = MusePresenter.present(.success(MuseBridge.parseAnswer(##"{"response":""}"##)))
        XCTAssertNil(presentation.speechText)                 // never speaks raw JSON
        XCTAssertFalse(presentation.bubbleText.contains("{"))  // bubble shows no JSON
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

    func testCompanionEnvironmentInjectsKeepAliveWhenAbsent() {
        let env = MuseBridge.companionEnvironment([:])
        XCTAssertEqual(env["MUSE_OLLAMA_KEEP_ALIVE"], "2h")
    }

    func testCompanionEnvironmentDefaultsWhenBlank() {
        let env = MuseBridge.companionEnvironment(["MUSE_OLLAMA_KEEP_ALIVE": "   "])
        XCTAssertEqual(env["MUSE_OLLAMA_KEEP_ALIVE"], "2h")
    }

    func testCompanionEnvironmentHonoursUserOverride() {
        let env = MuseBridge.companionEnvironment(["MUSE_OLLAMA_KEEP_ALIVE": "-1", "PATH": "/usr/bin"])
        XCTAssertEqual(env["MUSE_OLLAMA_KEEP_ALIVE"], "-1")
        XCTAssertEqual(env["PATH"], "/usr/bin") // inherits the rest of the environment
    }
}
