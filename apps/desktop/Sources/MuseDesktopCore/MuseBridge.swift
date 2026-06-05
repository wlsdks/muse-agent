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

    /// Build the invocation for a grounded answer. Local-first BY CONSTRUCTION:
    /// `--local` is always present, so the companion can never route a question
    /// to a cloud model — the MUSE_LOCAL_ONLY posture holds end-to-end.
    public static func invocation(query: String, bin: String) -> MuseInvocation {
        MuseInvocation(executable: bin, arguments: ["ask", "--local", query])
    }

    /// Strip ANSI escape codes + surrounding whitespace from the CLI's stdout so
    /// the speech bubble shows clean text (the CLI colourises for a terminal).
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
        return try run(invocation(query: trimmed, bin: bin))
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
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let err = String(data: errData, encoding: .utf8) ?? ""
            throw MuseBridgeError.cliFailed(status: process.terminationStatus, stderr: err)
        }
        return cleanAnswer(String(data: outData, encoding: .utf8) ?? "")
    }
}
