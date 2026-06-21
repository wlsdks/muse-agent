import Foundation

/// What the companion remembers across launches: the chosen look and where the
/// user dragged it. Pure + Codable so the persistence logic is headless-testable;
/// the AppKit layer just loads on launch and saves on change.
public struct CompanionPrefs: Codable, Equatable, Sendable {
    public var look: String?
    public var originX: Double?
    public var originY: Double?
    public var language: String?
    /// URL of the local Muse web UI shown in the full-app window.
    public var museURL: String?

    public init(look: String? = nil, originX: Double? = nil, originY: Double? = nil, language: String? = nil, museURL: String? = nil) {
        self.look = look
        self.originX = originX
        self.originY = originY
        self.language = language
        self.museURL = museURL
    }

    /// The configured Muse web URL, or the local default (Vite dev server).
    public var resolvedMuseURL: String {
        let trimmed = museURL?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false ? trimmed! : "http://127.0.0.1:5173")
    }

    public func encoded() -> String {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    public static func decode(_ json: String) -> CompanionPrefs? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(CompanionPrefs.self, from: data)
    }

    public var hasOrigin: Bool { originX != nil && originY != nil }
}

public enum CompanionGeometry {
    public struct Rect: Equatable, Sendable {
        public let x: Double, y: Double, width: Double, height: Double
        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x; self.y = y; self.width = width; self.height = height
        }
    }

    /// Is a window at `frame` visible on at least one screen by a usable margin?
    /// A position saved on a now-disconnected monitor (off every current screen)
    /// is rejected so the companion falls back to its default spot instead of
    /// landing off-screen and unreachable.
    public static func isVisible(_ frame: Rect, on screens: [Rect], minVisible: Double = 40) -> Bool {
        for screen in screens {
            let ix = max(frame.x, screen.x)
            let iy = max(frame.y, screen.y)
            let ax = min(frame.x + frame.width, screen.x + screen.width)
            let ay = min(frame.y + frame.height, screen.y + screen.height)
            if ax - ix >= minVisible && ay - iy >= minVisible { return true }
        }
        return false
    }
}
