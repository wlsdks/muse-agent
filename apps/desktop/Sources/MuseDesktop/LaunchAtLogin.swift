import ServiceManagement

/// Launch Muse automatically at login via the modern ServiceManagement API
/// (macOS 13+). The system is the source of truth — `isEnabled` reads the live
/// status (the user can also toggle it in System Settings → General → Login
/// Items), so the UI never drifts from reality. Registration only works for a
/// real signed .app bundle; in a bare `swift run` it throws and we report off.
enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    @discardableResult
    static func set(_ enabled: Bool) -> Bool {
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
            return true
        } catch {
            return false
        }
    }
}
