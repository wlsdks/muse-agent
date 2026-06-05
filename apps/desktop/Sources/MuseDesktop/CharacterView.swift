import AppKit
import MuseDesktopCore

/// Renders a `Sprite` as a pretty, faintly-alive pixel-art Muse. She breathes
/// (gentle bob), blinks, mouths the words while speaking, and shows a little
/// gold music note when listening/speaking — the "woman enjoying music" feel,
/// Muse-styled. Swapping `sprite` (e.g. for an artist sprite) restyles her with
/// no other change.
final class CharacterView: NSView {
    enum State { case idle, listening, thinking, speaking }

    var state: State = .idle { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    var sprite: Sprite = SpriteLibrary.default {
        // Reset animation state on a swap, or the new sprite's eye/mouth rows get
        // toggled at the old `tick` phase (stale blink/mouth on a different grid).
        didSet { rebuildColorCache(); tick = 0; blinking = false; mouthOpen = false; needsDisplay = true }
    }

    private var tick = 0
    private var blinking = false
    private var mouthOpen = false
    private var timer: Timer?
    private var colorCache: [Character: NSColor] = [:]
    private let noteColor = NSColor(calibratedRed: 0.90, green: 0.74, blue: 0.36, alpha: 1)

    override init(frame: NSRect) {
        super.init(frame: frame)
        rebuildColorCache()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unused") }

    private func rebuildColorCache() {
        colorCache.removeAll(keepingCapacity: true)
        for (key, hex) in sprite.paletteMap() {
            if let color = HexColor.parse(hex) { colorCache[key] = color }
        }
    }

    override var isFlipped: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        guard window != nil else { return }
        let timer = Timer(timeInterval: 0.16, repeats: true) { [weak self] _ in self?.animate() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func animate() {
        tick += 1
        blinking = (tick % 19 == 0)                              // a blink every ~3s
        mouthOpen = (state == .speaking) && (tick % 2 == 0)      // flap while speaking
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setShouldAntialias(false)

        let cols = sprite.width
        let rowsN = sprite.height
        guard cols > 0, rowsN > 0 else { return }
        let cell = min(bounds.width / CGFloat(cols), bounds.height / CGFloat(rowsN))
        let artW = cell * CGFloat(cols)
        let artH = cell * CGFloat(rowsN)
        let originX = (bounds.width - artW) / 2
        let bob = (tick % 12 < 6) ? CGFloat(0) : cell * 0.18     // gentle breathing
        let originY = (bounds.height - artH) / 2 + bob

        for (r, baseRow) in sprite.rows.enumerated() {
            var row = baseRow
            if r == sprite.eyeRowIndex, blinking, let closed = sprite.closedEyesRow { row = closed }
            if r == sprite.mouthRowIndex, mouthOpen, let open = sprite.openMouthRow { row = open }
            for (c, ch) in row.enumerated() {
                guard let color = colorCache[ch] else { continue }
                color.setFill()
                ctx.fill(CGRect(x: originX + CGFloat(c) * cell, y: originY + CGFloat(r) * cell, width: cell, height: cell))
            }
        }

        if state == .listening || state == .speaking {
            let note = "\u{266A}" // ♪
            let size = max(12, cell * 2)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: size, weight: .bold),
                .foregroundColor: noteColor
            ]
            let wobble: CGFloat = (tick % 8 < 4) ? 0 : cell * 0.4
            note.draw(at: NSPoint(x: originX + artW - cell, y: originY - wobble), withAttributes: attrs)
        }
    }

    override func mouseDown(with event: NSEvent) { onClick?() }

    deinit { timer?.invalidate() }
}
