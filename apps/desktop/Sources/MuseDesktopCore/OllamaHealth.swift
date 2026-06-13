import Foundation

/// Whether the local AI brain (Ollama + the chat model) is ready. The companion
/// bundles its own runtime, but the LLM weights are too large to ship — so this
/// is the one thing the user may need to set up. We detect it and guide them,
/// instead of surfacing a generic "couldn't reach Muse" error.
public enum OllamaStatus: Equatable, Sendable {
    case ok
    case notRunning          // nothing listening on the Ollama port
    case modelMissing(String) // Ollama is up but the chat model isn't pulled
}

public enum OllamaHealth {
    public static let requiredModel = "gemma4:12b"
    public static let baseURL = "http://localhost:11434"

    /// Live check: is Ollama up and does it have `model`? Localhost only (no
    /// egress); a short timeout so a launch check never hangs the UI.
    public static func check(model: String = requiredModel, baseURL: String = baseURL) async -> OllamaStatus {
        guard let url = URL(string: "\(baseURL)/api/tags") else { return .notRunning }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2.5
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return .notRunning }
            return parse(data, model: model)
        } catch {
            return .notRunning
        }
    }

    /// Pure: classify an `/api/tags` body. A model counts as present on an exact
    /// name match, a quant-suffixed variant (e.g. `qwen3:8b-q4_K_M`), or the same
    /// identity under Ollama's implicit `:latest` tag (a bare `gemma4` and
    /// `gemma4:latest` are one model — the same rule the CLI's findOllamaModelTag
    /// applies), but NOT a different size tag. Unparseable but 200 → assume ok.
    public static func parse(_ data: Data, model: String) -> OllamaStatus {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = object["models"] as? [[String: Any]] else { return .ok }
        let names = models.compactMap { $0["name"] as? String }
        let withLatest = { (s: String) in s.contains(":") ? s : s + ":latest" }
        let target = withLatest(model)
        let present = names.contains { withLatest($0) == target || $0.hasPrefix(model + "-") }
        return present ? .ok : .modelMissing(model)
    }
}
