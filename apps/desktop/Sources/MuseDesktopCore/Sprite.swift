import Foundation

/// A data-driven pixel sprite: a grid of palette keys + a palette mapping each
/// key to a hex colour. Codable so a candidate design (e.g. from a JSON file)
/// can be rendered and swapped in without touching code — the foundation for
/// comparing designs now and dropping in an artist sprite later.
public struct PaletteEntry: Codable, Sendable, Equatable {
    public let key: String
    public let hex: String
    public init(key: String, hex: String) { self.key = key; self.hex = hex }
}

public struct Sprite: Codable, Sendable, Equatable {
    public let name: String?
    public let width: Int
    public let height: Int
    public let rows: [String]
    public let palette: [PaletteEntry]
    /// Optional animation metadata (the live view uses it; static renders ignore it).
    public let eyeRowIndex: Int?
    public let closedEyesRow: String?
    public let mouthRowIndex: Int?
    public let openMouthRow: String?

    public init(
        name: String? = nil,
        width: Int,
        height: Int,
        rows: [String],
        palette: [PaletteEntry],
        eyeRowIndex: Int? = nil,
        closedEyesRow: String? = nil,
        mouthRowIndex: Int? = nil,
        openMouthRow: String? = nil
    ) {
        self.name = name
        self.width = width
        self.height = height
        self.rows = rows
        self.palette = palette
        self.eyeRowIndex = eyeRowIndex
        self.closedEyesRow = closedEyesRow
        self.mouthRowIndex = mouthRowIndex
        self.openMouthRow = openMouthRow
    }

    public func paletteMap() -> [Character: String] {
        var map: [Character: String] = [:]
        for entry in palette where !entry.key.isEmpty {
            map[Character(String(entry.key.prefix(1)))] = entry.hex
        }
        return map
    }

    /// The grid must be a clean rectangle of the declared size or the art skews.
    /// Also validates the optional animation override rows + indices, so a
    /// bad blink/mouth row can't slip through the `--render-json` path either.
    public func isRectangular() -> Bool {
        guard width > 0, height > 0, rows.count == height else { return false }
        guard rows.allSatisfy({ $0.count == width }) else { return false }
        if let closed = closedEyesRow, closed.count != width { return false }
        if let open = openMouthRow, open.count != width { return false }
        if let eye = eyeRowIndex, eye < 0 || eye >= height { return false }
        if let mouth = mouthRowIndex, mouth < 0 || mouth >= height { return false }
        return true
    }

    /// Every glyph in the grid (and the animation override rows) must have a
    /// palette entry. The renderer silently skips an unmapped glyph, so without
    /// this a typo'd / forgotten palette key renders a transparent HOLE — this
    /// rejects such a sprite on the `--render-json` drop-in path instead.
    public func paletteCoversGrid() -> Bool {
        let keys = Set(paletteMap().keys)
        let lines = rows + [closedEyesRow, openMouthRow].compactMap { $0 }
        return lines.allSatisfy { $0.allSatisfy { keys.contains($0) } }
    }

    /// Every palette colour must be a parseable hex (the same `parseHexColor` the
    /// renderer dereferences). The renderer skips a colour it can't parse, so a
    /// typo'd hex renders a transparent HOLE — reject it on `--render-json`
    /// instead. The transparent "#00000000" convention parses (a=0) and is valid.
    public func paletteHexesValid() -> Bool {
        palette.allSatisfy { parseHexColor($0.hex) != nil }
    }

    public static func decode(_ data: Data) throws -> Sprite {
        try JSONDecoder().decode(Sprite.self, from: data)
    }
}
