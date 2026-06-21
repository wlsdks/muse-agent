import Foundation
import MuseDesktopCore

/// Calendar provider connections the user sets in Settings, stored in the
/// Keychain. The desktop injects them as env when it spawns the bundled server,
/// so the existing env-driven calendar setup connects — macOS Calendar.app works
/// instantly (local AppleScript), CalDAV via an app-password, Google via OAuth
/// credentials (refresh token obtained out-of-band). Mirrors MessagingCredentials.
struct CalendarCredentials: Equatable {
    var enableMacOS = false
    var caldavURL = ""
    var caldavUsername = ""
    var caldavPassword = ""
    var gcalClientId = ""
    var gcalClientSecret = ""
    var gcalRefreshToken = ""
    var gcalCalendarId = ""

    private enum K {
        static let macos = "cal.enableMacOS"
        static let caldavURL = "cal.caldavURL"
        static let caldavUser = "cal.caldavUsername"
        static let caldavPass = "cal.caldavPassword"
        static let gClientId = "cal.gcalClientId"
        static let gClientSecret = "cal.gcalClientSecret"
        static let gRefresh = "cal.gcalRefreshToken"
        static let gCalId = "cal.gcalCalendarId"
    }

    static func load() -> CalendarCredentials {
        var c = CalendarCredentials()
        c.enableMacOS = KeychainStore.get(K.macos) == "1"
        c.caldavURL = KeychainStore.get(K.caldavURL) ?? ""
        c.caldavUsername = KeychainStore.get(K.caldavUser) ?? ""
        c.caldavPassword = KeychainStore.get(K.caldavPass) ?? ""
        c.gcalClientId = KeychainStore.get(K.gClientId) ?? ""
        c.gcalClientSecret = KeychainStore.get(K.gClientSecret) ?? ""
        c.gcalRefreshToken = KeychainStore.get(K.gRefresh) ?? ""
        c.gcalCalendarId = KeychainStore.get(K.gCalId) ?? ""
        return c
    }

    func save() {
        KeychainStore.set(enableMacOS ? "1" : "", for: K.macos)
        KeychainStore.set(caldavURL.trimmed, for: K.caldavURL)
        KeychainStore.set(caldavUsername.trimmed, for: K.caldavUser)
        KeychainStore.set(caldavPassword.trimmed, for: K.caldavPass)
        KeychainStore.set(gcalClientId.trimmed, for: K.gClientId)
        KeychainStore.set(gcalClientSecret.trimmed, for: K.gClientSecret)
        KeychainStore.set(gcalRefreshToken.trimmed, for: K.gRefresh)
        KeychainStore.set(gcalCalendarId.trimmed, for: K.gCalId)
    }

    /// Env for the bundled server: the active provider list + each provider's
    /// credentials. `local` is always on; extras add as configured.
    func serverEnv() -> [String: String] {
        CalendarEnv.build(CalendarEnvInput(
            enableMacOS: enableMacOS,
            caldavURL: caldavURL,
            caldavUsername: caldavUsername,
            caldavPassword: caldavPassword,
            gcalClientId: gcalClientId,
            gcalClientSecret: gcalClientSecret,
            gcalRefreshToken: gcalRefreshToken,
            gcalCalendarId: gcalCalendarId
        ))
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
