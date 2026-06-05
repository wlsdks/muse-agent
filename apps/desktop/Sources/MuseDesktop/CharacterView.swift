import AppKit

/// A placeholder pixel-art Muse mascot drawn programmatically (no asset yet —
/// a real sprite sheet with idle/listening/thinking/speaking frames is a later
/// slice). Hard-edged rectangles, no anti-aliasing, so it reads as pixel art.
/// `state` lets the rest of the app reflect what Muse is doing (the eyes/mouth
/// change), wiring the character to the agent's real state.
final class CharacterView: NSView {
    enum State { case idle, listening, thinking, speaking }

    var state: State = .idle { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?

    // A 12x12 grid scaled up to the view — the canonical pixel-art trick.
    private let grid = 12

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setShouldAntialias(false)
        let cell = min(bounds.width, bounds.height) / CGFloat(grid)
        func px(_ x: Int, _ y: Int, _ color: NSColor) {
            color.setFill()
            ctx.fill(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell))
        }

        let body = NSColor(calibratedRed: 0.25, green: 0.78, blue: 0.74, alpha: 1) // teal
        let dark = NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.16, alpha: 1)

        // Rounded body: fill the 12x12 minus the four corner pixels.
        for y in 0..<grid {
            for x in 0..<grid {
                let corner = (x == 0 || x == grid - 1) && (y == 0 || y == grid - 1)
                if !corner { px(x, y, body) }
            }
        }

        // Eyes + mouth vary with state so the mascot reflects what Muse is doing.
        switch state {
        case .idle, .speaking:
            px(3, 4, dark); px(8, 4, dark)            // open eyes
        case .listening:
            px(3, 4, dark); px(4, 4, dark); px(8, 4, dark); px(9, 4, dark) // wide eyes
        case .thinking:
            px(3, 5, dark); px(8, 5, dark)            // half-closed (looking down)
        }
        switch state {
        case .speaking:
            px(4, 8, dark); px(5, 9, dark); px(6, 9, dark); px(7, 8, dark) // open smile
        case .thinking:
            px(5, 9, dark); px(6, 9, dark)            // small flat mouth
        default:
            px(4, 8, dark); px(5, 9, dark); px(6, 9, dark); px(7, 8, dark) // smile
        }
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}
