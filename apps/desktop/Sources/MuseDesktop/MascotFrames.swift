// GENERATED from @muse/mascot — do not edit by hand.
// Regenerate: node apps/desktop/scripts/gen-mascot-swift.mjs
// Source of truth: packages/mascot/src/pixel-data.ts (the SAME bluebird the CLI
// banner, the README SVG, and the web DeskPet render from).

import Foundation

/// Canonical bluebird pose matrices + palette, single-sourced from @muse/mascot.
/// CharacterView renders these live (Core Graphics) with a gentle idle loop.
enum MascotFrames {
    /// Grid is authored facing RIGHT on a fixed 13x11 grid.
    static let width = 13
    static let height = 11

    /// char -> hex colour. The transparent "." is omitted (drawn as nothing).
    static let palette: [Character: String] = [
        "B": "#8b9dff",
        "S": "#6b78e8",
        "W": "#f4f1ea",
        "K": "#1b1e2e",
        "C": "#e79ab0",
        "A": "#f2c14e",
        "T": "#6b78e8",
        "L": "#b7a98f"
    ]

    /// Poses whose eye is shut (a 2px dark line instead of the single pixel).
    static let closedEyeFrames: Set<String> = ["blink", "doze"]

    /// Every pose is a 13-wide x 11-tall grid of palette chars.
    static let frames: [String: [String]] = [
        "stand": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "blink": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBKKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "hopUp": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            "............."
        ],
        "hopLand": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            "....L...L...."
        ],
        "tilt": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBBBB..",
            "TTBSBBBKBBB..",
            "..BSSBBCBBA..",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "peck": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBBBB..",
            "TTBSBBBBKBB..",
            "..BSSBBCBB...",
            "..BBSWWWBBAA.",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "preen": [
            ".............",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBSBBBBBBB..",
            "TTBSBKCBBBB..",
            "..BBABBBBB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            "....BBBB.....",
            ".....L.L....."
        ],
        "tail": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            ".TBBBBBBBB...",
            "TTBBBBBBKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "attend": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBKB...",
            ".TBBBBBBBBA..",
            "TTBSBBBBCBB..",
            "..BSSBBBBB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "flapA": [
            "....BBBB.....",
            "...BBBBBB....",
            ".SBBBBBBBBS..",
            "..BBBBBBBB...",
            ".TBBBBBBKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "flapB": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            "STBBBBBBKBBS.",
            "TTBSBBBBBBA..",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "stretch": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBKBB..",
            "TTBSBBBBBBA..",
            ".SBSSBBBCB...",
            "SBBBSWWWBB...",
            "...BBWWWB....",
            "..L..........",
            ".......L....."
        ],
        "ruffleA": [
            ".....BBBB....",
            "....BBBBBB...",
            "...BBBBBBBB..",
            "...BBBBBBBB..",
            ".TBBBBBBBKBB.",
            "TTBBSBBBBBBA.",
            "..SBSBBBBCB..",
            "...BBSWWWBB..",
            "....BBWWWB...",
            ".............",
            ".....L.L....."
        ],
        "ruffleB": [
            "...BBBB......",
            "..BBBBBB.....",
            ".BBBBBBBB....",
            ".BBBBBBBB....",
            "TBBBBBBKBB...",
            "TBSBBBBBBAS..",
            ".BSSBBBCB....",
            ".BBSWWWBBS...",
            "..BBWWWB.....",
            ".............",
            ".....L.L....."
        ],
        "doze": [
            ".............",
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBKKBBA..",
            "TTBSBBBBBB...",
            "..BSSBBBCB...",
            "..BBSWWWBB...",
            "...BBWWWB....",
            "............."
        ],
        "sing": [
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBKBB..",
            "TTBSBBBBBBA..",
            "..BSSBBBCBA..",
            "..BBSWWWBB...",
            "...BBWWWB....",
            ".............",
            ".....L.L....."
        ],
        "droop": [
            ".............",
            "....BBBB.....",
            "...BBBBBB....",
            "..BBBBBBBB...",
            "..BBBBBBBB...",
            ".TBBBBBBKB...",
            "TTBSBBBBCBA..",
            "..BSSWWWBB...",
            "..BBWWWBB....",
            "...BBWB......",
            ".....L.L....."
        ]
    ]
}
