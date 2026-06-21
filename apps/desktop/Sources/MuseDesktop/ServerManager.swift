import Foundation
import MuseDesktopCore

/// Runs the bundled self-contained Muse API server (`muse-api-bin`), which
/// serves BOTH the API and the built web UI from one origin — so the desktop
/// app delivers the full Muse experience with no external node, repo, or dev
/// servers. The binary + web directory are resolved relative to the .app bundle
/// (a moved/distributed app still finds them). On a plain `swift run` (no
/// bundle) it no-ops, so `ensureRunning` reports false and the window shows the
/// manual-start card.
final class ServerManager {
    static let shared = ServerManager()
    private init() {}

    let port = 3030
    var baseURL: String { "http://127.0.0.1:\(port)" }

    private var process: Process?

    private var binPath: String? {
        guard let p = Bundle.main.resourceURL?.appendingPathComponent("muse-api-bin").path,
              FileManager.default.isExecutableFile(atPath: p) else { return nil }
        return p
    }

    private var webDir: String? {
        guard let p = Bundle.main.resourceURL?.appendingPathComponent("web").path,
              FileManager.default.fileExists(atPath: p) else { return nil }
        return p
    }

    /// Ensure the server answers `/api/health`, spawning the bundled binary if
    /// needed. Fully async (never blocks the main thread); the callback fires on
    /// the main queue. `false` → no bundled binary or start timed out.
    func ensureRunning(timeout: TimeInterval = 30, _ done: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            if self.isHealthy() { DispatchQueue.main.async { done(true) }; return }
            guard let bin = self.binPath else { DispatchQueue.main.async { done(false) }; return }
            self.spawn(bin)
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                if self.isHealthy() { DispatchQueue.main.async { done(true) }; return }
                Thread.sleep(forTimeInterval: 0.5)
            }
            DispatchQueue.main.async { done(false) }
        }
    }

    private func spawn(_ bin: String) {
        guard process == nil else { return }
        var env = MuseBridge.companionEnvironment()
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        if let web = webDir { env["MUSE_WEB_DIR"] = web }
        if (env["MUSE_LOCAL_ONLY"] ?? "").isEmpty { env["MUSE_LOCAL_ONLY"] = "true" }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do { try proc.run(); process = proc } catch { process = nil }
    }

    private func isHealthy() -> Bool {
        guard let url = URL(string: "\(baseURL)/api/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            ok = (response as? HTTPURLResponse)?.statusCode == 200
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 2)
        return ok
    }

    /// Terminate the spawned server (called on app quit so it doesn't linger).
    func stop() {
        process?.terminate()
        process = nil
    }
}
