import AppKit

enum HexColor {
    /// Parse "#rgb", "#rrggbb", or "#rrggbbaa" (and the alpha-zero "#00000000"
    /// transparent convention) into an NSColor. Returns nil for unparseable or
    /// fully-transparent values so the renderer simply skips that cell.
    static func parse(_ hex: String) -> NSColor? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard let value = UInt64(s, radix: 16) else { return nil }
        let r, g, b, a: CGFloat
        switch s.count {
        case 3:
            r = CGFloat((value >> 8) & 0xF) / 15
            g = CGFloat((value >> 4) & 0xF) / 15
            b = CGFloat(value & 0xF) / 15
            a = 1
        case 6:
            r = CGFloat((value >> 16) & 0xFF) / 255
            g = CGFloat((value >> 8) & 0xFF) / 255
            b = CGFloat(value & 0xFF) / 255
            a = 1
        case 8:
            r = CGFloat((value >> 24) & 0xFF) / 255
            g = CGFloat((value >> 16) & 0xFF) / 255
            b = CGFloat((value >> 8) & 0xFF) / 255
            a = CGFloat(value & 0xFF) / 255
        default:
            return nil
        }
        if a == 0 { return nil } // transparent ⇒ skip the cell
        return NSColor(calibratedRed: r, green: g, blue: b, alpha: a)
    }
}
