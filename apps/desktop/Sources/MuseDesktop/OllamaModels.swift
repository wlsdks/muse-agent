import Foundation
import MuseDesktopCore

/// Point-and-click model management against the local Ollama HTTP API, so a
/// non-developer never needs the terminal to install or remove a model.
struct OllamaModel: Identifiable, Equatable {
    let name: String
    let sizeBytes: Int64
    var id: String { name }
    var sizeText: String {
        let gb = Double(sizeBytes) / 1_000_000_000
        if gb >= 1 { return String(format: "%.1f GB", gb) }
        return String(format: "%.0f MB", Double(sizeBytes) / 1_000_000)
    }
}

enum OllamaModels {
    static var baseURL: String { OllamaHealth.baseURL }

    /// Installed models (GET /api/tags), largest first.
    static func list() async -> [OllamaModel] {
        guard let url = URL(string: "\(baseURL)/api/tags"),
              let (data, _) = try? await URLSession.shared.data(from: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = obj["models"] as? [[String: Any]] else { return [] }
        return models.compactMap { m in
            guard let name = m["name"] as? String else { return nil }
            let size = (m["size"] as? NSNumber)?.int64Value ?? 0
            return OllamaModel(name: name, sizeBytes: size)
        }.sorted { $0.sizeBytes > $1.sizeBytes }
    }

    /// Remove a model (DELETE /api/delete). Returns success.
    @discardableResult
    static func delete(_ name: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/api/delete") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    /// Download a model (POST /api/pull, stream:false → resolves when complete).
    /// Long-running; the caller shows a "pulling…" state. Returns success.
    @discardableResult
    static func pull(_ name: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/api/pull") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 3600
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name, "stream": false])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        // Ollama returns {"status":"success"} on completion.
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (obj?["status"] as? String) == "success"
    }
}
