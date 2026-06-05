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

    func testDefaultIsAriaAndNamedResolves() {
        XCTAssertEqual(SpriteLibrary.default.name, "aria")
        XCTAssertEqual(SpriteLibrary.named("celestial").name, "celestial")
        XCTAssertEqual(SpriteLibrary.named("CELESTIAL").name, "celestial") // case-insensitive
        XCTAssertEqual(SpriteLibrary.named("nope").name, "aria")           // unknown ⇒ default
        XCTAssertEqual(SpriteLibrary.named(nil).name, "aria")
        XCTAssertEqual(SpriteLibrary.named("").name, "aria")
    }

    func testEveryBuiltInCharacterRoundTripsThroughJSON() throws {
        for sprite in SpriteLibrary.all {
            let data = try JSONEncoder().encode(sprite)
            XCTAssertEqual(try Sprite.decode(data), sprite)
        }
    }
}
