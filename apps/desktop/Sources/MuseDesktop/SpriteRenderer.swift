import AppKit
import MuseDesktopCore

/// Renders a `Sprite` straight to a PNG (no window) for a headless visual check
/// of the art — `MuseDesktop --render <png>` (the active Muse) or
/// `MuseDesktop --render-json <sprite.json> <png>` (any candidate design). Same
/// grid + palette the live window uses, so the preview is faithful.
enum SpriteRenderer {
    enum RenderError: Error { case allocFailed, encodeFailed, badSprite }

    static func renderPNG(_ sprite: Sprite, to url: URL, scale: Int = 18) throws {
        let cols = sprite.width
        let rowsN = sprite.height
        guard cols > 0, rowsN > 0 else { throw RenderError.badSprite }
        let width = cols * scale
        let height = rowsN * scale
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { throw RenderError.allocFailed }

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { throw RenderError.allocFailed }
        NSGraphicsContext.current = ctx
        ctx.cgContext.setShouldAntialias(false)

        let palette = sprite.paletteMap()
        for (r, row) in sprite.rows.enumerated() {
            for (c, ch) in row.enumerated() {
                guard let hex = palette[ch], let color = HexColor.parse(hex) else { continue }
                color.setFill()
                // Bitmap origin is bottom-left; sprite row 0 is the TOP, so flip y.
                NSBezierPath.fill(NSRect(x: c * scale, y: (rowsN - 1 - r) * scale, width: scale, height: scale))
            }
        }

        guard let data = rep.representation(using: .png, properties: [:]) else { throw RenderError.encodeFailed }
        try data.write(to: url)
    }
}
