import Foundation

/// The default Muse sprite — a classical Muse bust (laurel-crowned woman, auburn
/// hair, draped dress). Data-driven (a `Sprite` with its own hex palette) so the
/// renderer + live view treat it like any candidate, and an artist sprite can
/// replace it by swapping this value. Animation metadata (eye/mouth rows) lets
/// the live view blink and mouth the words.
public enum MuseSprite {
    public static let `default` = Sprite(
        name: "muse-classical-v1",
        width: 14,
        height: 16,
        rows: [
            "....HHHHHH....",
            "..HHHHHHHHHH..",
            ".HHGGGGGGGGHH.",
            ".HHhFFFFFFhHH.",
            "HHhFFFFFFFFhHH",
            "HHFFeFFFFeFFHH",
            "HHFFFFFFFFFFHH",
            "HHFkFFFFFFkFHH",
            "HHFFFFmmFFFFHH",
            ".HHFFFFFFFFHH.",
            "..HHFFFFFFHH..",
            "...HH.FF.HH...",
            ".HHDDDGGDDDHH.",
            "HHDDDdddDDDDHH",
            "HHDDDDDDDDDDHH",
            ".HHDDDDDDDDHH."
        ],
        palette: [
            PaletteEntry(key: ".", hex: "#00000000"), // transparent
            PaletteEntry(key: "H", hex: "#6b3d29"),   // auburn hair
            PaletteEntry(key: "h", hex: "#995c38"),   // hair highlight
            PaletteEntry(key: "F", hex: "#f5cca8"),   // skin
            PaletteEntry(key: "e", hex: "#332938"),   // eyes
            PaletteEntry(key: "k", hex: "#ed9e99"),   // blush
            PaletteEntry(key: "m", hex: "#c75761"),   // lips
            PaletteEntry(key: "G", hex: "#e6bd5c"),   // gold laurel
            PaletteEntry(key: "D", hex: "#f5eddb"),   // dress
            PaletteEntry(key: "d", hex: "#d1c7b3")    // dress shadow
        ],
        eyeRowIndex: 5,
        closedEyesRow: "HHFFFFFFFFFFHH",
        mouthRowIndex: 8,
        openMouthRow: "HHFFFmmmmFFFHH"
    )
}
