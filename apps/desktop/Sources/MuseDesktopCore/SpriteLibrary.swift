import Foundation

/// The built-in Muse characters. All are ORIGINAL pixel art — designed via our
/// own multi-agent design panel and drawn programmatically pixel-by-pixel, with
/// NO third-party asset traced or copied (the concepts — a Greek muse, a girl
/// with headphones, a celestial figure — are generic, non-copyrightable tropes,
/// and names avoid any brand). Data-driven `Sprite`s so a new look drops in here
/// with no other code change. `aria` is the default.
public enum SpriteLibrary {
    /// a warm girl with headphones, enjoying the music — original pixel art (designed via our own design panel, drawn programmatically; no third-party asset).
    public static let aria = Sprite(
        name: "aria",
        width: 24,
        height: 32,
        rows: [
            ".........HHHHHH.........",
            ".......HHGGGGGGHH.......",
            "......HHGGGGGGGGHHH.....",
            ".....HHGGGGHHGGGGGHH....",
            "....HHHGGHHHHHHGGGHHD...",
            "...PHHHHHHHHHHHHHHDDP...",
            "..PGPHDDSSSSSSSSDDDHPGP.",
            "..PGPHDSSKKKKKKSSWDHPGP.",
            "..PGPHDSSSSSSSSSSWDHPGP.",
            "..PGPDSSSSSSSSSSSSWDPGP.",
            "..PGPDSSEESSSSEESSWDGP..",
            "..PGPDSSSSSSSSSSSSWDGP..",
            "..PGPDSBBSSSSSSBBSWDGP..",
            "..PGPDSSSSSSSSSSSSWDGP..",
            "..PGPDSSSSWLLLLWSSWDGP..",
            "...PPDWSSSSLLLLSSSWDPP..",
            "....DDWWSSSSSSSSWWDDD...",
            "......WWWSSSSSSWWWW.....",
            "........WSSSSSSWW.......",
            "......CCCCCCCCCCCC......",
            ".....CCKKCCCCCCKKCC.....",
            "....CCKKCCCCCCCCKKCC....",
            "...CCKCCCCCCCCCCCKCC....",
            "..CCKCCCCCCCCCCCCCKCC...",
            "..CKCCCCCCGGCCCCCCKCC...",
            "..CCCCCCCGGGGCCCCCCCC...",
            "..OCCCCCCCGGCCCCCCCCO...",
            "..OCCCCCCCCGCCCCCCCCO...",
            "..OOCCCCCCCCCCCCCCCOO...",
            "...OOCCCCCCCCCCCCCOO....",
            "....OOOCCCCCCCCCOOO.....",
            "......OOOOOOOOOOOO......"
        ],
        palette: [
            PaletteEntry(key: ".", hex: "#00000000"),
            PaletteEntry(key: "H", hex: "#7a4a3a"),
            PaletteEntry(key: "G", hex: "#e8b27d"),
            PaletteEntry(key: "D", hex: "#4f2f26"),
            PaletteEntry(key: "S", hex: "#f4c9a8"),
            PaletteEntry(key: "K", hex: "#ffe2c4"),
            PaletteEntry(key: "W", hex: "#d99e7e"),
            PaletteEntry(key: "E", hex: "#5a3528"),
            PaletteEntry(key: "B", hex: "#ef9aa0"),
            PaletteEntry(key: "L", hex: "#d9707a"),
            PaletteEntry(key: "C", hex: "#c87a8a"),
            PaletteEntry(key: "O", hex: "#9a5266"),
            PaletteEntry(key: "P", hex: "#5b6b8a")
        ],
        eyeRowIndex: 10,
        closedEyesRow: "..PGPDSSSSSSSSSSSSWDGP..",
        mouthRowIndex: 14,
        openMouthRow: "..PGPDSSSWLLLLLLWSSDGP.."
    )

    /// an ethereal starlit Muse — original pixel art (designed via our own design panel, drawn programmatically; no third-party asset).
    public static let celestial = Sprite(
        name: "celestial",
        width: 24,
        height: 32,
        rows: [
            "..........GG............",
            ".......GGHHHHGG.........",
            ".....GHHHhhhhHHHG.......",
            "....GHHhhHHHHhhHHG......",
            "...GHhhHHHHHHHHhhHG.....",
            "..GHHhHHHHHHHHHHhHHG....",
            "..GHhHHHHHHHHHHHHhHHG...",
            ".GHHHHHHHsssssHHHHHHHG..",
            ".GHHHHHsssssssssHHHHHG..",
            ".GHHHHsssssssssssHHHHG..",
            ".HHHHsssWWsssWWsssHHHH..",
            ".HHHsssWBWssWBWsssHHHHH.",
            ".HHHsssWWsssWWsssHHHHHH.",
            ".HHHHsssssNNssssssHHHHH.",
            ".HHHHsssRRsssRRsssHHHHH.",
            ".HHHHsssssLLLsssssHHHH..",
            "..HHHHssssssssssHHHHH...",
            "..HHHHsssssssssHHHHH....",
            "...HHHhsssssshHHHH......",
            "....HHhhNNNNhhHHH.......",
            "...GHHhhNNNNhhHHHG......",
            "..GCCHHhhhhhhHHCCCG.....",
            ".GCCCcHHhhhhHHcCCCCG....",
            ".CCCccCCccccCCccCCCG....",
            "GCCcccCCCccccCCCcccCCG..",
            "CCcccCCCCccccCCCCcccCC..",
            "CccccCCCCccccCCCCCcccC..",
            "CcccCMCCCccccCCCMCcccC..",
            "CcccCCCCCccccCCCCCcccC..",
            ".CccCCCCCccccCCCCCccC...",
            "M.CCCCCCCccccCCCCCC.M...",
            "..CCCCCCCCCCCCCCCCCC...."
        ],
        palette: [
            PaletteEntry(key: ".", hex: "#00000000"),
            PaletteEntry(key: "G", hex: "#fff3b0"),
            PaletteEntry(key: "H", hex: "#5b3a7e"),
            PaletteEntry(key: "h", hex: "#3a2456"),
            PaletteEntry(key: "s", hex: "#ffe0c4"),
            PaletteEntry(key: "N", hex: "#e3a87f"),
            PaletteEntry(key: "W", hex: "#fbf7ff"),
            PaletteEntry(key: "B", hex: "#2a2350"),
            PaletteEntry(key: "R", hex: "#f4a6b8"),
            PaletteEntry(key: "L", hex: "#c84d6e"),
            PaletteEntry(key: "C", hex: "#bcd0ff"),
            PaletteEntry(key: "c", hex: "#7d97d6"),
            PaletteEntry(key: "M", hex: "#fff3b0")
        ],
        eyeRowIndex: 11,
        closedEyesRow: ".HHHssssssssssssssHHHHH.",
        mouthRowIndex: 15,
        openMouthRow: ".HHHHssssLLLLLssssHHHH.."
    )

    public static let all: [Sprite] = [aria, celestial]
    public static let `default` = aria

    /// Resolve a character by name (case-insensitive, whitespace-trimmed); falls
    /// back to the default. The name is fed from the user-set
    /// `MUSE_DESKTOP_CHARACTER` env var, which can carry stray whitespace.
    public static func named(_ name: String?) -> Sprite {
        guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !name.isEmpty else { return `default` }
        return all.first { ($0.name ?? "").lowercased() == name } ?? `default`
    }
}
