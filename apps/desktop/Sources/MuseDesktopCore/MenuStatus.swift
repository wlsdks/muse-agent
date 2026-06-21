import Foundation

/// Pure composition of the menu-bar status line (privacy posture · model ·
/// server). Headless-testable so MuseController holds only the AppKit plumbing
/// and the localized label lookup.
public enum MenuStatus {
    /// The display name for a model id: the last path segment, so
    /// "ollama/gemma4:12b" → "gemma4:12b". No slash ⇒ unchanged; empty ⇒ empty.
    public static func shortModelName(_ model: String) -> String {
        model.split(separator: "/").last.map(String.init) ?? model
    }

    /// Interpret the MUSE_LOCAL_ONLY env value: local-only is the default-on
    /// posture, disabled ONLY by the explicit string "false" (anything else,
    /// incl. nil/empty/garbage, stays local-only — fail-safe toward privacy).
    public static func isLocalOnly(_ raw: String?) -> Bool {
        (raw ?? "true") != "false"
    }

    /// Compose the line from already-localized labels; the model id is shortened.
    public static func line(localLabel: String, model: String, serverLabel: String) -> String {
        "\(localLabel) · \(shortModelName(model)) · \(serverLabel)"
    }
}
