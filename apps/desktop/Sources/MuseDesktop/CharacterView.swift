import AppKit
import MuseDesktopCore

/// The on-screen avatar. The default look is the glowing **voice orb** (the
/// modern AI-assistant visual); a clean vector mascot and the pixel sprites
/// (aria / celestial) are selectable alternates. All are pure-code original art.
/// It breathes/pulses, blinks, mouths the words / ripples while speaking, and
/// shows activity when listening.
final class CharacterView: NSView {
    enum State { case idle, listening, thinking, speaking }
    enum Look { case orb, vector, pixel }

    var state: State = .idle { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    var sprite: Sprite = SpriteLibrary.default {
        didSet { rebuildColorCache(); tick = 0; blinking = false; mouthOpen = false; needsDisplay = true }
    }
    private var look: Look = .orb

    /// `orb`/default → the glowing orb; `muse`/`vector` → the vector mascot;
    /// `aria`/`celestial` → those pixel sprites.
    func setCharacterNamed(_ name: String?) {
        switch (name ?? "").lowercased() {
        case "aria", "celestial":
            look = .pixel
            sprite = SpriteLibrary.named((name ?? "").lowercased())
        case "muse", "vector":
            look = .vector
            tick = 0; needsDisplay = true
        default:
            look = .orb
            tick = 0; needsDisplay = true
        }
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

    // Standard (non-flipped) coordinates: the orb is symmetric, the vector
    // mascot sets up its own y-down space, and the pixel sprite flips its rows.
    override var isFlipped: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        guard window != nil else { return }
        // ~25fps so the orb's pulse + ripples are smooth.
        let timer = Timer(timeInterval: 0.04, repeats: true) { [weak self] _ in self?.animate() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func animate() {
        tick += 1
        blinking = (tick % 75 == 0)                                   // a blink every ~3s
        mouthOpen = (state == .speaking) && ((tick / 6) % 2 == 0)     // flap while speaking
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let phase = CGFloat(tick) * 0.08

        switch look {
        case .orb:
            VoiceOrb.draw(in: bounds, state: state, phase: phase)
            return
        case .vector:
            let bob: CGFloat = (tick % 50 < 25) ? 0 : 2
            VectorMuse.draw(in: bounds, state: state, blink: blinking, mouthOpen: mouthOpen, breathe: bob)
            return
        case .pixel:
            break
        }

        ctx.setShouldAntialias(false)
        let cols = sprite.width
        let rowsN = sprite.height
        guard cols > 0, rowsN > 0 else { return }
        let cell = min(bounds.width / CGFloat(cols), bounds.height / CGFloat(rowsN))
        let artW = cell * CGFloat(cols)
        let artH = cell * CGFloat(rowsN)
        let originX = (bounds.width - artW) / 2
        let bob = (tick % 50 < 25) ? CGFloat(0) : cell * 0.18
        let originY = (bounds.height - artH) / 2 + bob

        for (r, baseRow) in sprite.rows.enumerated() {
            var row = baseRow
            if r == sprite.eyeRowIndex, blinking, let closed = sprite.closedEyesRow { row = closed }
            if r == sprite.mouthRowIndex, mouthOpen, let open = sprite.openMouthRow { row = open }
            // row 0 is the TOP of the sprite; in non-flipped coords that is high y.
            let y = originY + CGFloat(rowsN - 1 - r) * cell
            for (c, ch) in row.enumerated() {
                guard let color = colorCache[ch] else { continue }
                color.setFill()
                ctx.fill(CGRect(x: originX + CGFloat(c) * cell, y: y, width: cell, height: cell))
            }
        }

        if state == .listening || state == .speaking {
            let note = "\u{266A}"
            let size = max(12, cell * 2)
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: .bold), .foregroundColor: noteColor]
            note.draw(at: NSPoint(x: originX + artW - cell, y: originY + artH - cell * 2), withAttributes: attrs)
        }
    }

    override func mouseDown(with event: NSEvent) { onClick?() }

    deinit { timer?.invalidate() }
}
