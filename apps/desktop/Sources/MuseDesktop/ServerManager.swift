import Foundation
import MuseDesktopCore

/// Runs the bundled self-contained Muse API server (`muse-api-bin`), which serves
/// BOTH the API and the built web UI from one origin — so the desktop app
/// delivers the full Muse experience with no external node/repo/dev-servers.
///
/// Supervision: reuses an already-healthy server (e.g. a dev instance), picks a
/// free port otherwise, passes its own PID so the child self-exits if this app
/// crashes (no orphans), restarts the child on an unexpected exit with backoff
/// (circuit-broken), and stops it on quit. The binary + web dir resolve relative
/// to the .app bundle. On a plain `swift run` (no bundle) it no-ops.
final class ServerManager {
    static let shared = ServerManager()
    private init() {}

    private let candidatePorts = [3030, 3041, 3052]
    private(set) var port = 3030
    var baseURL: String { "http://127.0.0.1:\(port)" }

    private var process: Process?
    private var restarts = 0
    private var intentionalStop = false
    private let restartPolicy = RestartPolicy()

    /// Cheap, non-blocking hint for the menu-bar status line (we spawned a server
    /// that hasn't intentionally stopped). Not a health check.
    var isLikelyRunning: Bool { process != nil }

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

    /// The build id baked into this bundle (Info.plist MuseBuildId, written by
    /// make-app.sh) — nil on a bare `swift run`.
    private var bundledBuildId: String? {
        Bundle.main.object(forInfoDictionaryKey: "MuseBuildId") as? String
    }

    /// Ensure a Muse server answers `/api/health`, reusing or spawning as needed.
    /// A healthy server is reused ONLY when its reported build id matches this
    /// bundle (or it's an explicit dev server) — a stale instance holding the
    /// port is asked to shut down and replaced, so an app update can never be
    /// silently masked by last week's server. Fully async; the callback fires on
    /// the main queue. `false` → no bundled binary or start timed out.
    func ensureRunning(timeout: TimeInterval = 30, _ done: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            for candidate in self.candidatePorts {
                guard let health = self.healthInfo(port: candidate) else { continue }
                if ServerReusePolicy.shouldReuse(bundledBuildId: self.bundledBuildId, reportedVersion: health.version) {
                    self.port = candidate
                    DispatchQueue.main.async { done(true) }
                    return
                }
                self.replaceStaleServer(port: candidate)
            }
            guard self.binPath != nil else { DispatchQueue.main.async { done(false) }; return }
            self.port = self.candidatePorts.first(where: { self.isFree(port: $0) }) ?? self.candidatePorts[0]
            self.restarts = 0
            self.start()
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                if self.isHealthy(port: self.port) { DispatchQueue.main.async { done(true) }; return }
                Thread.sleep(forTimeInterval: 0.5)
            }
            DispatchQueue.main.async { done(false) }
        }
    }

    private func start() {
        guard let bin = binPath, process == nil else { return }
        intentionalStop = false
        var env = MuseBridge.companionEnvironment()
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        env["MUSE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        if let web = webDir { env["MUSE_WEB_DIR"] = web }
        if (env["MUSE_LOCAL_ONLY"] ?? "").isEmpty { env["MUSE_LOCAL_ONLY"] = "true" }
        // Messenger tokens (Keychain) → the server connects Telegram/Discord/Slack/LINE.
        for (key, value) in MessagingCredentials.load().serverEnv() { env[key] = value }
        // Calendar connections (Keychain) → macOS / CalDAV / Google providers.
        for (key, value) in CalendarCredentials.load().serverEnv() { env[key] = value }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in self?.handleExit() }
        do { try proc.run(); process = proc } catch { process = nil }
    }

    /// Restart on an unexpected child exit, with backoff and a circuit breaker so
    /// a crash-looping binary doesn't hot-spin.
    private func handleExit() {
        process = nil
        guard !intentionalStop else { return }
        switch restartPolicy.decide(restartsSoFar: restarts) {
        case .giveUp:
            return
        case .restart(let afterSeconds):
            restarts += 1
            DispatchQueue.global().asyncAfter(deadline: .now() + afterSeconds) { [weak self] in self?.start() }
        }
    }

    /// Stop the spawned server (on app quit) — intentional, so no restart fires.
    func stop() {
        intentionalStop = true
        process?.terminate()
        process = nil
    }

    /// Restart the bundled server so new env (e.g. just-saved messenger tokens)
    /// takes effect. No-op-safe if nothing was running.
    func restart() {
        stop()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.ensureRunning { _ in }
        }
    }

    private func isHealthy(port: Int) -> Bool {
        healthInfo(port: port) != nil
    }

    private struct HealthInfo { let version: String? }

    /// nil = nothing healthy on the port; otherwise the parsed /api/health
    /// (version absent on pre-version servers — the reuse policy treats
    /// that as stale).
    private func healthInfo(port: Int) -> HealthInfo? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        let semaphore = DispatchSemaphore(value: 0)
        var info: HealthInfo?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let version = data
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                .flatMap { $0["version"] as? String }
            info = HealthInfo(version: version)
        }.resume()
        _ = semaphore.wait(timeout: .now() + 2)
        return info
    }

    /// Replace a healthy-but-stale Muse server: ask it to exit via
    /// POST /api/admin/shutdown (graceful drain), and if it predates that
    /// route, SIGTERM the muse-api process owning the port. Foreign
    /// (non-Muse) listeners are left alone. Blocks (bounded) until the
    /// port frees or the wait times out.
    private func replaceStaleServer(port: Int) {
        if let url = URL(string: "http://127.0.0.1:\(port)/api/admin/shutdown") {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 2
            let semaphore = DispatchSemaphore(value: 0)
            var accepted = false
            URLSession.shared.dataTask(with: request) { _, response, _ in
                accepted = (response as? HTTPURLResponse)?.statusCode == 200
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 2.5)
            if !accepted { terminateMuseApiProcess(onPort: port) }
        }
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if isFree(port: port) { return }
            Thread.sleep(forTimeInterval: 0.3)
        }
    }

    /// SIGTERM the process listening on the port, but ONLY when its command
    /// name identifies it as a Muse API server — never a foreign process.
    private func terminateMuseApiProcess(onPort port: Int) {
        guard let out = runCommand("/usr/sbin/lsof", ["-ti", "tcp:\(port)", "-sTCP:LISTEN"]) else { return }
        for line in out.split(separator: "\n") {
            guard let pid = Int32(line.trimmingCharacters(in: .whitespaces)) else { continue }
            guard let command = runCommand("/bin/ps", ["-p", "\(pid)", "-o", "command="]),
                  MuseApiProcessIdentity.isMuseApiCommand(command) else { continue }
            kill(pid, SIGTERM)
        }
    }

    private func runCommand(_ path: String, _ arguments: [String]) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = arguments
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    /// A port is free if a connection is refused (nothing listening). If anything
    /// responds, treat it as occupied so we don't fight a foreign server.
    private func isFree(port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0
        let semaphore = DispatchSemaphore(value: 0)
        var free = false
        URLSession.shared.dataTask(with: request) { _, _, error in
            let code = (error as NSError?)?.code
            free = code == NSURLErrorCannotConnectToHost || code == NSURLErrorCannotFindHost
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.5)
        return free
    }
}
