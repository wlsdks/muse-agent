import Foundation

/// A resolved command line for one grounded Muse answer.
public struct MuseInvocation: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]

    public init(executable: String, arguments: [String]) {
        self.executable = executable
        self.arguments = arguments
    }
}

public enum MuseBridgeError: Error, Equatable {
    case emptyQuery
    case cliFailed(status: Int32, stderr: String)
}

/// Bridges the desktop companion to the existing local Muse runtime by
/// shelling out to the `muse` CLI. The companion is a thin window over the same
/// agent — NOT a second implementation — so cited recall, the refusal floor,
/// and the local-only guarantee all come for free.
public enum MuseBridge {
    /// The CLI to invoke. `MUSE_BIN` overrides (an absolute path or a name on
    /// PATH); defaults to `muse`.
    public static func defaultBin(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let override = environment["MUSE_BIN"], !override.isEmpty {
            return override
        }
        return "muse"
    }

    /// Build the invocation for a CONVERSATIONAL turn. `muse chat --local -c`
    /// keeps the prior turns (memory across questions — follow-ups work, so it
    /// feels like a real conversation, not disconnected one-shots) on the LOCAL
    /// Qwen, with the same per-turn note grounding. `--json` makes stdout a clean
    /// `{response, …}` object so the bubble shows just the reply — not the CLI's
    /// progress lines.
    public static func invocation(query: String, bin: String) -> MuseInvocation {
        MuseInvocation(executable: bin, arguments: ["chat", "--local", "-c", "--json", query])
    }

    private struct ChatJSON: Decodable { let response: String?; let answer: String? }

    /// Extract the reply from `muse chat --json` (`response`) — or `ask --json`
    /// (`answer`) — stdout. Falls back to `cleanAnswer` (ANSI/whitespace strip)
    /// if the output isn't the expected JSON, so a CLI change degrades gracefully.
    public static func parseAnswer(_ raw: String) -> String {
        if let data = raw.data(using: .utf8), let decoded = try? JSONDecoder().decode(ChatJSON.self, from: data) {
            let text = (decoded.response ?? decoded.answer ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        return cleanAnswer(raw)
    }

    /// Strip ANSI escape codes + surrounding whitespace (the non-JSON fallback,
    /// and the cleaner used before display).
    public static func cleanAnswer(_ raw: String) -> String {
        let stripped = raw.replacingOccurrences(
            of: "\u{1B}\\[[0-9;]*[A-Za-z]",
            with: "",
            options: .regularExpression
        )
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Run the Muse CLI for `query` and return its cleaned, cited answer.
    /// Throws on an empty query (no spawn) or a non-zero CLI exit.
    public static func ask(
        query: String,
        bin: String = MuseBridge.defaultBin()
    ) async throws -> String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw MuseBridgeError.emptyQuery }
        return parseAnswer(try run(invocation(query: trimmed, bin: bin)))
    }

    static func run(_ invocation: MuseInvocation) throws -> String {
        let process = Process()
        // Resolve via `env` so a bare name like `muse` is found on PATH.
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [invocation.executable] + invocation.arguments

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()
        // Drain stderr concurrently: reading stdout to EOF first while the child
        // fills (and blocks on) a full stderr pipe would deadlock both sides.
        let group = DispatchGroup()
        var errData = Data()
        DispatchQueue.global(qos: .userInitiated).async(group: group) {
            errData = stderr.fileHandleForReading.readDataToEndOfFile()
        }
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let err = String(data: errData, encoding: .utf8) ?? ""
            throw MuseBridgeError.cliFailed(status: process.terminationStatus, stderr: err)
        }
        return String(data: outData, encoding: .utf8) ?? ""
    }
}
