import XCTest
@testable import MuseDesktopCore

/// Guards the integrity of the ACTUAL shipped mascot (`MuseSprite.default`), not a
/// synthetic fixture — so editing the ASCII art can't silently ship a malformed
/// sprite (ragged rows, an unmapped colour key, an out-of-range animation row)
/// that the renderer would draw wrong or crash on.
final class MuseSpriteTests: XCTestCase {
    private let s = MuseSprite.default

    func testShippedDefaultIsRectangular() {
        XCTAssertTrue(s.isRectangular())
    }

    func testShippedDefaultPaletteCoversEveryCell() {
        XCTAssertTrue(s.paletteCoversGrid())
    }

    func testShippedDefaultPaletteHexesAreValid() {
        XCTAssertTrue(s.paletteHexesValid())
    }

    func testDimensionsMatchDeclaredSize() {
        XCTAssertEqual(s.rows.count, s.height)
        XCTAssertTrue(s.rows.allSatisfy { $0.count == s.width })
    }

    func testAnimationOverridesAreInRangeAndMatchWidth() {
        if let i = s.eyeRowIndex { XCTAssertTrue(i >= 0 && i < s.height, "eye row out of range") }
        if let i = s.mouthRowIndex { XCTAssertTrue(i >= 0 && i < s.height, "mouth row out of range") }
        if let r = s.closedEyesRow { XCTAssertEqual(r.count, s.width, "closed-eyes row width") }
        if let r = s.openMouthRow { XCTAssertEqual(r.count, s.width, "open-mouth row width") }
    }

    func testAnimationOverrideCharsAreAllInThePalette() {
        let keys = Set(s.paletteMap().keys)
        for row in [s.closedEyesRow, s.openMouthRow].compactMap({ $0 }) {
            XCTAssertTrue(row.allSatisfy { keys.contains($0) }, "override row has an unmapped colour key")
        }
    }
}
