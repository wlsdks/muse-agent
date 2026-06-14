import XCTest
@testable import MuseDesktopCore

final class AnswerPresentationTests: XCTestCase {
    func testSpeaksAnswerButDropsCitationMarkers() {
        let p = MusePresenter.present(.success("The office VPN MTU is 1380 bytes. [from vpn.md]"))
        XCTAssertEqual(p.bubbleText, "The office VPN MTU is 1380 bytes. [from vpn.md]") // bubble keeps the citation
        XCTAssertEqual(p.speechText, "The office VPN MTU is 1380 bytes.")               // speech drops it
    }

    func testStripsEveryCitationMarker() {
        XCTAssertEqual(MusePresenter.stripCitationsForSpeech("A [from a.md] and B [from b.md]"), "A and B")
    }

    func testStripsCitationMarkerRegardlessOfCase() {
        // agent-core recognizes the citation marker case-insensitively (/\[from…\]/giu),
        // so an 8B model can emit "[From x.md]" / "[FROM x.md]" (e.g. sentence-start
        // capitalization) and the system still counts it a citation — the spoken
        // strip must match the SAME forms, or the companion reads "From x dot md" aloud.
        XCTAssertEqual(MusePresenter.stripCitationsForSpeech("Your flight is 9am [From notes/vpn.md]"), "Your flight is 9am")
        XCTAssertEqual(MusePresenter.stripCitationsForSpeech("Done [FROM a.md]"), "Done")
    }

    func testStripsTheReceiptLineFromSpeech() {
        // withGroundingReceipt appends "\n\n📎 노트: seoul_office.md" — the bubble
        // keeps it, but the voice must not read the file path aloud.
        let answer = "비밀번호는 muse2026입니다.\n\n📎 노트: seoul_office.md"
        let p = MusePresenter.present(.success(answer))
        XCTAssertEqual(p.bubbleText, answer)               // bubble keeps the receipt
        XCTAssertEqual(p.speechText, "비밀번호는 muse2026입니다.") // speech drops it
        XCTAssertEqual(MusePresenter.stripCitationsForSpeech("Done. [from vpn.md]\n\n📎 from: vpn.md"), "Done.")
    }

    func testStripsMultiLineReceiptFromSpeech() {
        // The receipt is multi-line: a "📎 Sources…" header + one line per source.
        // Speech must drop the WHOLE block — the old regex stripped only the header
        // line and left the source file paths to be read aloud.
        let answer = "The MTU is 1380. [from vpn.md]\n\n📎 Sources (open to verify):\n- vpn.md\n- net.md"
        let spoken = MusePresenter.stripCitationsForSpeech(answer)
        XCTAssertEqual(spoken, "The MTU is 1380.")
        XCTAssertFalse(spoken.contains("vpn.md"))  // no leaked source line reaches the Speaker
        XCTAssertFalse(spoken.contains("net.md"))
    }

    func testStaysSilentWhenAnswerIsReceiptOnly() {
        // A model turn that emitted ONLY a grounding receipt strips to empty
        // speech — speechText must be nil (silent), not "" (which the consumer's
        // `if let speech` treats as a real answer → orb "speaks" an empty utterance).
        let p = MusePresenter.present(.success("📎 노트: seoul_office.md"))
        XCTAssertNil(p.speechText)
        XCTAssertFalse(p.bubbleText.isEmpty)  // the bubble still shows the receipt
    }

    func testStaysSilentOnEmptyAnswer() {
        let p = MusePresenter.present(.success("   "))
        XCTAssertNil(p.speechText)
        XCTAssertFalse(p.bubbleText.isEmpty)
    }

    func testStaysSilentOnCliFailure() {
        let p = MusePresenter.present(.failure(.cliFailed(status: 1, stderr: "boom")))
        XCTAssertNil(p.speechText)
        XCTAssertTrue(p.bubbleText.contains("couldn't reach"))
    }
}

final class SpriteTests: XCTestCase {
    func testDefaultMuseIsACleanRectangle() {
        let muse = MuseSprite.default
        XCTAssertTrue(muse.isRectangular())
        XCTAssertEqual(muse.width, 14)
        XCTAssertEqual(muse.height, 16)
    }

    func testDefaultMuseHasFaceLaurelAndDress() {
        let all = MuseSprite.default.rows.joined()
        XCTAssertTrue(all.contains("e")) // eyes
        XCTAssertTrue(all.contains("m")) // lips
        XCTAssertTrue(all.contains("G")) // gold laurel
        XCTAssertTrue(all.contains("D")) // dress
    }

    func testAnimationOverrideRowsLineUp() {
        let muse = MuseSprite.default
        XCTAssertEqual(muse.closedEyesRow?.count, muse.width)
        XCTAssertEqual(muse.openMouthRow?.count, muse.width)
        XCTAssertEqual(muse.eyeRowIndex, 5)
        XCTAssertEqual(muse.mouthRowIndex, 8)
    }

    func testPaletteMapResolvesKeys() {
        let map = MuseSprite.default.paletteMap()
        XCTAssertEqual(map["H"], "#6b3d29")
        XCTAssertEqual(map["."], "#00000000")
    }

    func testSpriteRoundTripsThroughJSON() throws {
        let data = try JSONEncoder().encode(MuseSprite.default)
        let back = try Sprite.decode(data)
        XCTAssertEqual(back, MuseSprite.default)
        XCTAssertTrue(back.isRectangular())
    }

    func testDecodeRejectsRaggedRowsViaIsRectangular() throws {
        let json = ##"{"width":3,"height":2,"rows":["abc","ab"],"palette":[{"key":"a","hex":"#fff"}]}"##
        let sprite = try Sprite.decode(Data(json.utf8))
        XCTAssertFalse(sprite.isRectangular()) // ragged → caught before render
    }
}

final class SpriteLibraryTests: XCTestCase {
    func testEveryBuiltInCharacterIsACleanRectangleWithAnimationRowsAligned() {
        for sprite in SpriteLibrary.all {
            XCTAssertTrue(sprite.isRectangular(), "\(sprite.name ?? "?") is not rectangular")
            if let closed = sprite.closedEyesRow { XCTAssertEqual(closed.count, sprite.width, "\(sprite.name ?? "?") closedEyesRow width") }
            if let open = sprite.openMouthRow { XCTAssertEqual(open.count, sprite.width, "\(sprite.name ?? "?") openMouthRow width") }
            if let eye = sprite.eyeRowIndex { XCTAssertLessThan(eye, sprite.height) }
            if let mouth = sprite.mouthRowIndex { XCTAssertLessThan(mouth, sprite.height) }
        }
    }

    func testPaletteCoversEveryGlyphInTheGrid() {
        // The renderer silently skips any glyph with no palette entry
        // (SpriteRenderer continues past it), so a typo'd / forgotten palette key
        // would render a transparent HOLE. Every built-in must cover its grid,
        // and a sprite that references an undefined key must be rejected.
        for sprite in SpriteLibrary.all + [MuseSprite.default] {
            XCTAssertTrue(sprite.paletteCoversGrid(), "\(sprite.name ?? "?") has an unmapped glyph")
        }
        let undefinedInRows = Sprite(
            width: 2, height: 1, rows: ["XX"],
            palette: [PaletteEntry(key: ".", hex: "#00000000")]
        )
        XCTAssertFalse(undefinedInRows.paletteCoversGrid())
        let undefinedInAnimationRow = Sprite(
            width: 2, height: 1, rows: [".."],
            palette: [PaletteEntry(key: ".", hex: "#00000000")],
            openMouthRow: "ZX"
        )
        XCTAssertFalse(undefinedInAnimationRow.paletteCoversGrid())
    }

    func testPaletteHexesValid() {
        // The renderer skips any palette colour whose hex won't parse (HexColor
        // returns nil → SpriteRenderer continues), so a typo'd hex renders a
        // transparent HOLE just like an unmapped glyph. Built-ins must all parse
        // (incl. the deliberate "#00000000" transparent key); a bad hex is rejected.
        for sprite in SpriteLibrary.all + [MuseSprite.default] {
            XCTAssertTrue(sprite.paletteHexesValid(), "\(sprite.name ?? "?") has an unparseable palette hex")
        }
        let badHex = Sprite(
            width: 1, height: 1, rows: ["A"],
            palette: [PaletteEntry(key: "A", hex: "#GGGGGG")]
        )
        XCTAssertFalse(badHex.paletteHexesValid())
        let wrongLength = Sprite(
            width: 1, height: 1, rows: ["A"],
            palette: [PaletteEntry(key: "A", hex: "12345")]
        )
        XCTAssertFalse(wrongLength.paletteHexesValid())
    }

    func testDefaultIsAriaAndNamedResolves() {
        XCTAssertEqual(SpriteLibrary.default.name, "aria")
        XCTAssertEqual(SpriteLibrary.named("celestial").name, "celestial")
        XCTAssertEqual(SpriteLibrary.named("CELESTIAL").name, "celestial") // case-insensitive
        XCTAssertEqual(SpriteLibrary.named("nope").name, "aria")           // unknown ⇒ default
        XCTAssertEqual(SpriteLibrary.named(nil).name, "aria")
        XCTAssertEqual(SpriteLibrary.named("").name, "aria")
    }

    func testWhitespaceWrappedNameStillResolves() {
        // Fed straight from MUSE_DESKTOP_CHARACTER (main.swift), which commonly
        // carries stray whitespace / a trailing newline — a real name must still
        // resolve, not silently fall back to the default character.
        XCTAssertEqual(SpriteLibrary.named(" celestial ").name, "celestial")
        XCTAssertEqual(SpriteLibrary.named("celestial\n").name, "celestial")
        XCTAssertEqual(SpriteLibrary.named("  Aria  ").name, "aria")
        XCTAssertEqual(SpriteLibrary.named("   ").name, "aria") // whitespace-only ⇒ default
    }

    func testEveryBuiltInCharacterRoundTripsThroughJSON() throws {
        for sprite in SpriteLibrary.all {
            let data = try JSONEncoder().encode(sprite)
            XCTAssertEqual(try Sprite.decode(data), sprite)
        }
    }
}

final class VoiceGateTests: XCTestCase {
    private func decide(usage: Bool = true, speech: Bool = true, mic: Bool = true, avail: Bool = true, onDevice: Bool = true) -> VoiceStart {
        VoiceGate.decide(usageStringsPresent: usage, speechAuthorized: speech, micAuthorized: mic, recognizerAvailable: avail, supportsOnDevice: onDevice)
    }

    func testListensWhenEverythingIsReady() {
        XCTAssertEqual(decide(), .listen)
    }

    func testNoBundleUsageStringsFallsBackToTextWithoutAsking() {
        // The crash-prevention invariant: a bare `swift run` (no usage strings) must NOT request auth.
        XCTAssertEqual(decide(usage: false), .fallbackToText)
        // even if other inputs would otherwise allow listening
        XCTAssertEqual(decide(usage: false, speech: false, mic: false), .fallbackToText)
    }

    func testDeniedOrUnavailableFallsBackToText() {
        XCTAssertEqual(decide(speech: false), .fallbackToText)
        XCTAssertEqual(decide(mic: false), .fallbackToText)
        XCTAssertEqual(decide(avail: false), .fallbackToText)
    }

    func testRefusesRatherThanUseTheNetworkWhenOnDeviceUnavailable() {
        XCTAssertEqual(decide(onDevice: false), .refuseOffDevice)
    }
}

final class SpriteValidationTests: XCTestCase {
    private func sprite(closedEyes: String? = nil, openMouth: String? = nil, eyeRow: Int? = nil, mouthRow: Int? = nil) -> Sprite {
        Sprite(name: "t", width: 3, height: 2, rows: ["abc", "abc"],
               palette: [PaletteEntry(key: "a", hex: "#fff"), PaletteEntry(key: "b", hex: "#000"), PaletteEntry(key: "c", hex: "#0f0")],
               eyeRowIndex: eyeRow, closedEyesRow: closedEyes, mouthRowIndex: mouthRow, openMouthRow: openMouth)
    }

    func testRejectsMismatchedAnimationOverrideRowWidths() {
        XCTAssertFalse(sprite(closedEyes: "ab").isRectangular())   // 2 != width 3
        XCTAssertFalse(sprite(openMouth: "abcd").isRectangular())  // 4 != width 3
        XCTAssertTrue(sprite(closedEyes: "aaa", openMouth: "bbb").isRectangular()) // both width 3 → ok
    }

    func testRejectsOutOfRangeAnimationRowIndices() {
        XCTAssertFalse(sprite(eyeRow: 5).isRectangular())   // >= height 2
        XCTAssertFalse(sprite(mouthRow: -1).isRectangular())
        XCTAssertTrue(sprite(eyeRow: 0, mouthRow: 1).isRectangular())
    }
}

final class CompanionPrefsTests: XCTestCase {
    func testRoundTripsThroughJSON() {
        let prefs = CompanionPrefs(look: "orb", originX: 1200.5, originY: 24)
        let back = CompanionPrefs.decode(prefs.encoded())
        XCTAssertEqual(back, prefs)
        XCTAssertTrue(prefs.hasOrigin)
        XCTAssertFalse(CompanionPrefs(look: "orb").hasOrigin)
    }

    func testDecodeReturnsNilForGarbage() {
        XCTAssertNil(CompanionPrefs.decode("not json"))
    }

    func testGeometryAcceptsAnOnScreenWindowAndRejectsAnOffScreenOne() {
        let screen = CompanionGeometry.Rect(x: 0, y: 0, width: 1512, height: 982)
        let onScreen = CompanionGeometry.Rect(x: 1100, y: 24, width: 360, height: 300)
        let offScreen = CompanionGeometry.Rect(x: 4000, y: 24, width: 360, height: 300) // a disconnected monitor
        XCTAssertTrue(CompanionGeometry.isVisible(onScreen, on: [screen]))
        XCTAssertFalse(CompanionGeometry.isVisible(offScreen, on: [screen]))
        XCTAssertFalse(CompanionGeometry.isVisible(onScreen, on: [])) // no screens
    }

    func testGeometryRejectsABarelyVisibleSliver() {
        let screen = CompanionGeometry.Rect(x: 0, y: 0, width: 1000, height: 1000)
        let sliver = CompanionGeometry.Rect(x: 990, y: 500, width: 360, height: 300) // only 10px on screen
        XCTAssertFalse(CompanionGeometry.isVisible(sliver, on: [screen]))
    }
}

final class LocalizationTests: XCTestCase {
    func testResolveLanguagePicksExplicitOrFollowsSystem() {
        XCTAssertEqual(resolveLanguage(.korean, systemIsKorean: false), .korean)
        XCTAssertEqual(resolveLanguage(.english, systemIsKorean: true), .english)
        XCTAssertEqual(resolveLanguage(.system, systemIsKorean: true), .korean)
        XCTAssertEqual(resolveLanguage(.system, systemIsKorean: false), .english)
    }

    func testResolvedLanguageMapsLocaleAndStrings() {
        XCTAssertEqual(ResolvedLanguage.korean.speechLocale, "ko-KR")
        XCTAssertEqual(ResolvedLanguage.english.speechLocale, "en-US")
        XCTAssertTrue(ResolvedLanguage.korean.askPlaceholder.contains("물어보세요"))
        XCTAssertTrue(ResolvedLanguage.english.askPlaceholder.contains("Ask Muse"))
    }

    func testAppLanguageRoundTripsInPrefs() {
        let prefs = CompanionPrefs(look: "orb", language: AppLanguage.korean.rawValue)
        XCTAssertEqual(CompanionPrefs.decode(prefs.encoded())?.language, "korean")
        XCTAssertEqual(AppLanguage(rawValue: "korean"), .korean)
    }

    func testPresentLocalizesTheCliError() {
        let ko = MusePresenter.present(.failure(.cliFailed(status: 1, stderr: "")), language: .korean)
        XCTAssertTrue(ko.bubbleText.contains("연결하지 못했어요"))
        let en = MusePresenter.present(.failure(.cliFailed(status: 1, stderr: "")), language: .english)
        XCTAssertTrue(en.bubbleText.contains("couldn't reach"))
    }
}
