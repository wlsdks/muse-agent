import AppKit

/// A glowing, state-reactive voice ORB — the modern AI-assistant visual
/// (Siri / Apple Intelligence / ChatGPT voice). Pure Core Graphics: a soft glow,
/// a 3D gradient sphere with an off-centre highlight, and concentric ripples
/// when listening/speaking. Elegant and abstract — no character, no
/// uncanny-valley. Original art (pure code). `phase` drives the animation.
enum VoiceOrb {
    private static let deep = NSColor(srgbRed: 0.27, green: 0.16, blue: 0.52, alpha: 1)
    private static let mid = NSColor(srgbRed: 0.45, green: 0.34, blue: 0.90, alpha: 1)
    private static let light = NSColor(srgbRed: 0.78, green: 0.74, blue: 1.00, alpha: 1)
    private static let glow = NSColor(srgbRed: 0.49, green: 0.39, blue: 0.94, alpha: 1)
    private static let accent = NSColor(srgbRed: 0.62, green: 0.91, blue: 1.00, alpha: 1)
    // Iridescent tints blended inside the sphere for an Apple-Intelligence shimmer.
    private static let cyanTint = NSColor(srgbRed: 0.50, green: 0.88, blue: 1.00, alpha: 1)
    private static let pinkTint = NSColor(srgbRed: 1.00, green: 0.52, blue: 0.80, alpha: 1)

    static func draw(in rect: NSRect, state: CharacterView.State, phase: CGFloat) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setShouldAntialias(true)
        let cx = rect.midX, cy = rect.midY
        let base = min(rect.width, rect.height) * 0.30
        let pulse: CGFloat = state == .speaking ? 1 + 0.06 * sin(phase * 2) : 1 + 0.03 * sin(phase)
        let r = base * pulse

        // soft outer glow
        radial(ctx, center: CGPoint(x: cx, y: cy), r0: r * 0.7, r1: r * 2.3,
               colors: [glow.withAlphaComponent(0.45), glow.withAlphaComponent(0)], locations: [0, 1])

        // ripples while listening/speaking
        if state == .listening || state == .speaking {
            for i in 0..<3 {
                let t = ((phase / (2 * .pi)) + CGFloat(i) / 3).truncatingRemainder(dividingBy: 1)
                let rr = r * (1 + t * 1.15)
                ctx.setStrokeColor(accent.withAlphaComponent(0.5 * (1 - t)).cgColor)
                ctx.setLineWidth(2.5)
                ctx.strokeEllipse(in: CGRect(x: cx - rr, y: cy - rr, width: rr * 2, height: rr * 2))
            }
        }

        // 3D sphere: a radial gradient whose bright start is offset up-left,
        // with cyan + pink tints blended inside for an iridescent shimmer.
        let hx = cx - r * 0.30, hy = cy + r * 0.32
        ctx.saveGState()
        ctx.addEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
        ctx.clip()
        if let grad = gradient([light, mid, deep], [0, 0.55, 1]) {
            ctx.drawRadialGradient(grad, startCenter: CGPoint(x: hx, y: hy), startRadius: 0,
                                   endCenter: CGPoint(x: cx, y: cy), endRadius: r,
                                   options: [.drawsAfterEndLocation])
        }
        radial(ctx, center: CGPoint(x: cx - r * 0.35, y: cy + r * 0.35), r0: 0, r1: r * 0.95,
               colors: [cyanTint.withAlphaComponent(0.40), cyanTint.withAlphaComponent(0)], locations: [0, 1])
        radial(ctx, center: CGPoint(x: cx + r * 0.42, y: cy - r * 0.42), r0: 0, r1: r * 1.0,
               colors: [pinkTint.withAlphaComponent(0.34), pinkTint.withAlphaComponent(0)], locations: [0, 1])
        ctx.restoreGState()

        // glassy rim + specular highlight
        ctx.setLineWidth(1.5)
        ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.22).cgColor)
        ctx.strokeEllipse(in: CGRect(x: cx - r + 1, y: cy - r + 1, width: r * 2 - 2, height: r * 2 - 2))
        radial(ctx, center: CGPoint(x: hx, y: hy), r0: 0, r1: r * 0.40,
               colors: [NSColor.white.withAlphaComponent(0.8), NSColor.white.withAlphaComponent(0)], locations: [0, 1])

        // thinking: a small bright bead orbiting the rim
        if state == .thinking {
            let a = phase
            let bx = cx + cos(a) * r * 0.78, by = cy + sin(a) * r * 0.78
            radial(ctx, center: CGPoint(x: bx, y: by), r0: 0, r1: r * 0.22,
                   colors: [accent.withAlphaComponent(0.9), accent.withAlphaComponent(0)], locations: [0, 1])
        }
    }

    private static func gradient(_ colors: [NSColor], _ locations: [CGFloat]) -> CGGradient? {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        return CGGradient(colorsSpace: space, colors: colors.map { $0.cgColor } as CFArray, locations: locations)
    }

    private static func radial(_ ctx: CGContext, center: CGPoint, r0: CGFloat, r1: CGFloat, colors: [NSColor], locations: [CGFloat]) {
        guard let grad = gradient(colors, locations) else { return }
        ctx.drawRadialGradient(grad, startCenter: center, startRadius: r0, endCenter: center, endRadius: r1, options: [.drawsAfterEndLocation])
    }
}
