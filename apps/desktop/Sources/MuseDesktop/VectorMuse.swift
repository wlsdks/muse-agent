import AppKit

/// A clean, anti-aliased VECTOR Muse mascot drawn with Core Graphics — smooth
/// curves, soft gradients, big expressive eyes (kawaii style), far prettier than
/// a blocky pixel grid. Original art (pure code, no third-party asset). Designed
/// on a 200×240 canvas and scaled to fit; `draw` is shared by the live view and
/// the `--render-vector` headless preview so what you see matches.
enum VectorMuse {
    // Palette
    private static let hair = NSColor(srgbRed: 0.45, green: 0.27, blue: 0.20, alpha: 1)
    private static let hairDark = NSColor(srgbRed: 0.34, green: 0.19, blue: 0.14, alpha: 1)
    private static let hairLight = NSColor(srgbRed: 0.57, green: 0.36, blue: 0.26, alpha: 1)
    private static let skin = NSColor(srgbRed: 1.00, green: 0.86, blue: 0.74, alpha: 1)
    private static let skinShade = NSColor(srgbRed: 0.97, green: 0.78, blue: 0.64, alpha: 1)
    private static let blush = NSColor(srgbRed: 1.00, green: 0.66, blue: 0.62, alpha: 0.75)
    private static let eyeDark = NSColor(srgbRed: 0.27, green: 0.18, blue: 0.24, alpha: 1)
    private static let cup = NSColor(srgbRed: 0.55, green: 0.62, blue: 0.80, alpha: 1)
    private static let cupDark = NSColor(srgbRed: 0.42, green: 0.49, blue: 0.68, alpha: 1)
    private static let gold = NSColor(srgbRed: 0.95, green: 0.80, blue: 0.42, alpha: 1)
    private static let mouthColor = NSColor(srgbRed: 0.80, green: 0.36, blue: 0.40, alpha: 1)

    static func draw(in rect: NSRect, state: CharacterView.State, blink: Bool, mouthOpen: Bool, breathe: CGFloat) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setShouldAntialias(true)
        // Design space 200×240, y-down, centered + scaled into rect (with a small bob).
        let s = min(rect.width / 200, rect.height / 240)
        ctx.saveGState()
        ctx.translateBy(x: rect.minX + (rect.width - 200 * s) / 2, y: rect.minY + (rect.height - 240 * s) / 2 - breathe)
        ctx.scaleBy(x: s, y: -s)
        ctx.translateBy(x: 0, y: -240)

        // soft halo
        oval(60, 30, 80, 80, fill: NSColor(srgbRed: 1, green: 0.95, blue: 0.85, alpha: 0.0)) // placeholder keeps bg clear

        // hair (back)
        roundedBlob(34, 36, 132, 150, r: 60, fill: hair)
        // shoulders / body
        path([(20, 240), (28, 196), (100, 176), (172, 196), (180, 240)], close: true, fill: cup.withAlphaComponent(0.0)) // reserved

        // face
        oval(52, 58, 96, 104, fill: skin)
        oval(52, 96, 96, 66, fill: skinShade.withAlphaComponent(0.5)) // subtle lower-face shade

        // headphone band over the hair
        ctx.saveGState()
        ctx.setLineWidth(12)
        ctx.setLineCap(.round)
        ctx.setStrokeColor(cupDark.cgColor)
        arc(centerX: 100, centerY: 92, radius: 70, start: 200, end: 340)
        ctx.restoreGState()
        // earcups
        roundedBlob(28, 96, 26, 42, r: 12, fill: cup)
        roundedBlob(146, 96, 26, 42, r: 12, fill: cup)
        roundedBlob(33, 102, 16, 30, r: 8, fill: cupDark)
        roundedBlob(151, 102, 16, 30, r: 8, fill: cupDark)

        // hair fringe (front bangs) — soft scalloped curve, not a jagged zigzag
        if let ctx0 = NSGraphicsContext.current?.cgContext {
            hairLight.setFill()
            ctx0.move(to: CGPoint(x: 50, y: 60))
            ctx0.addLine(to: CGPoint(x: 50, y: 90))
            ctx0.addQuadCurve(to: CGPoint(x: 76, y: 86), control: CGPoint(x: 60, y: 104))
            ctx0.addQuadCurve(to: CGPoint(x: 100, y: 92), control: CGPoint(x: 88, y: 106))
            ctx0.addQuadCurve(to: CGPoint(x: 124, y: 86), control: CGPoint(x: 112, y: 106))
            ctx0.addQuadCurve(to: CGPoint(x: 150, y: 90), control: CGPoint(x: 140, y: 104))
            ctx0.addLine(to: CGPoint(x: 150, y: 60))
            ctx0.closePath(); ctx0.fillPath()
        }

        // eyes
        if blink {
            stroke([(70, 116), (86, 120)], width: 4, color: eyeDark)
            stroke([(114, 120), (130, 116)], width: 4, color: eyeDark)
        } else {
            oval(68, 108, 22, 26, fill: eyeDark)
            oval(110, 108, 22, 26, fill: eyeDark)
            oval(74, 112, 8, 9, fill: .white)   // highlight
            oval(116, 112, 8, 9, fill: .white)
            oval(72, 124, 5, 5, fill: NSColor.white.withAlphaComponent(0.7))
            oval(114, 124, 5, 5, fill: NSColor.white.withAlphaComponent(0.7))
        }

        // blush
        oval(58, 132, 20, 12, fill: blush)
        oval(122, 132, 20, 12, fill: blush)

        // mouth
        if mouthOpen {
            oval(92, 142, 16, 14, fill: mouthColor)
            oval(94, 144, 12, 7, fill: NSColor(srgbRed: 0.95, green: 0.55, blue: 0.55, alpha: 1))
        } else {
            ctx.saveGState()
            ctx.setLineWidth(3.5); ctx.setLineCap(.round); ctx.setStrokeColor(mouthColor.cgColor)
            arc(centerX: 100, centerY: 138, radius: 12, start: 20, end: 160)
            ctx.restoreGState()
        }

        // a little laurel/gold sparkle on the band — a nod to the Muse
        oval(95, 24, 10, 10, fill: gold)

        // music note when she's listening or speaking
        if state == .listening || state == .speaking {
            drawNote(x: 158, y: 60)
        }

        ctx.restoreGState()
    }

    // MARK: - primitives (design space, y-down)

    private static func oval(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, fill: NSColor) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        fill.setFill()
        ctx.fillEllipse(in: CGRect(x: x, y: y, width: w, height: h))
    }

    private static func roundedBlob(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, r: CGFloat, fill: NSColor) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        fill.setFill()
        let p = CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
        ctx.addPath(p); ctx.fillPath()
    }

    private static func path(_ pts: [(CGFloat, CGFloat)], close: Bool, fill: NSColor) {
        guard let ctx = NSGraphicsContext.current?.cgContext, let first = pts.first else { return }
        fill.setFill()
        ctx.move(to: CGPoint(x: first.0, y: first.1))
        for p in pts.dropFirst() { ctx.addLine(to: CGPoint(x: p.0, y: p.1)) }
        if close { ctx.closePath() }
        ctx.fillPath()
    }

    private static func stroke(_ pts: [(CGFloat, CGFloat)], width: CGFloat, color: NSColor) {
        guard let ctx = NSGraphicsContext.current?.cgContext, let first = pts.first else { return }
        ctx.saveGState()
        ctx.setLineWidth(width); ctx.setLineCap(.round); ctx.setStrokeColor(color.cgColor)
        ctx.move(to: CGPoint(x: first.0, y: first.1))
        for p in pts.dropFirst() { ctx.addLine(to: CGPoint(x: p.0, y: p.1)) }
        ctx.strokePath()
        ctx.restoreGState()
    }

    private static func arc(centerX: CGFloat, centerY: CGFloat, radius: CGFloat, start: CGFloat, end: CGFloat) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.addArc(center: CGPoint(x: centerX, y: centerY), radius: radius,
                   startAngle: start * .pi / 180, endAngle: end * .pi / 180, clockwise: false)
        ctx.strokePath()
    }

    private static func drawNote(x: CGFloat, y: CGFloat) {
        oval(x, y + 16, 12, 9, fill: gold)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.setLineWidth(3); ctx.setStrokeColor(gold.cgColor)
        ctx.move(to: CGPoint(x: x + 11, y: y + 20)); ctx.addLine(to: CGPoint(x: x + 11, y: y))
        ctx.strokePath()
        ctx.restoreGState()
    }
}
