import XCTest
@testable import MuseDesktopCore

final class SpeakerSelectionTests: XCTestCase {
    func testCommonFalsyValuesSilenceSpeech() {
        for value in ["0", "false", "FALSE", "no", "off", " off "] {
            XCTAssertEqual(selectSpeakerKind(["MUSE_DESKTOP_SPEAK": value]), .silent, "'\(value)' should silence")
        }
    }

    func testSystemTtsSelectsSystem() {
        XCTAssertEqual(selectSpeakerKind(["MUSE_DESKTOP_TTS": "system"]), .system)
    }

    func testDefaultsToQwenAndTruthyDoesNotSilence() {
        XCTAssertEqual(selectSpeakerKind([:]), .qwen)
        XCTAssertEqual(selectSpeakerKind(["MUSE_DESKTOP_SPEAK": "1"]), .qwen)
    }

    func testSilenceTakesPrecedenceOverSystem() {
        XCTAssertEqual(selectSpeakerKind(["MUSE_DESKTOP_SPEAK": "0", "MUSE_DESKTOP_TTS": "system"]), .silent)
    }
}
