import Foundation

/// Conservative identity check for a process that may be terminated as a stale
/// bundled Muse API server. Only the executable token is trusted; a substring
/// in another program's argument must never authorize SIGTERM.
public enum MuseApiProcessIdentity {
    public static func isMuseApiCommand(_ command: String) -> Bool {
        guard let executable = command
            .split(whereSeparator: { $0.isWhitespace })
            .first
            .map(String.init),
              !executable.isEmpty else {
            return false
        }
        let name = URL(fileURLWithPath: executable).lastPathComponent
        return name == "muse-api-bin" || name == "muse-api"
    }
}
