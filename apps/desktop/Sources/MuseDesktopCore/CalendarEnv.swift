import Foundation

/// The calendar-connection fields the user enters in Settings.
public struct CalendarEnvInput: Equatable, Sendable {
    public var enableMacOS: Bool
    public var caldavURL: String
    public var caldavUsername: String
    public var caldavPassword: String
    public var gcalClientId: String
    public var gcalClientSecret: String
    public var gcalRefreshToken: String
    public var gcalCalendarId: String

    public init(
        enableMacOS: Bool = false,
        caldavURL: String = "", caldavUsername: String = "", caldavPassword: String = "",
        gcalClientId: String = "", gcalClientSecret: String = "", gcalRefreshToken: String = "",
        gcalCalendarId: String = ""
    ) {
        self.enableMacOS = enableMacOS
        self.caldavURL = caldavURL
        self.caldavUsername = caldavUsername
        self.caldavPassword = caldavPassword
        self.gcalClientId = gcalClientId
        self.gcalClientSecret = gcalClientSecret
        self.gcalRefreshToken = gcalRefreshToken
        self.gcalCalendarId = gcalCalendarId
    }
}

/// Map stored calendar credentials to the env vars the bundled server reads.
/// Pure + testable so the desktop's Keychain layer holds only storage. `local`
/// is always implicitly active; a provider is added ONLY when ALL its required
/// fields are present (a partially-filled CalDAV/Google config must not half-
/// enable), and MUSE_CALENDAR_PROVIDERS is set only when an extra provider beyond
/// `local` is configured.
public enum CalendarEnv {
    public static func build(_ input: CalendarEnvInput) -> [String: String] {
        func t(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
        var providers = ["local"]
        var e: [String: String] = [:]

        if input.enableMacOS { providers.append("macos") }

        let caldavURL = t(input.caldavURL)
        let caldavUser = t(input.caldavUsername)
        let caldavPass = t(input.caldavPassword)
        if !caldavURL.isEmpty && !caldavUser.isEmpty && !caldavPass.isEmpty {
            providers.append("caldav")
            e["MUSE_CALDAV_URL"] = caldavURL
            e["MUSE_CALDAV_USERNAME"] = caldavUser
            e["MUSE_CALDAV_APP_PASSWORD"] = caldavPass
        }

        let gClientId = t(input.gcalClientId)
        let gSecret = t(input.gcalClientSecret)
        let gRefresh = t(input.gcalRefreshToken)
        if !gClientId.isEmpty && !gSecret.isEmpty && !gRefresh.isEmpty {
            providers.append("gcal")
            e["MUSE_GCAL_CLIENT_ID"] = gClientId
            e["MUSE_GCAL_CLIENT_SECRET"] = gSecret
            e["MUSE_GCAL_REFRESH_TOKEN"] = gRefresh
            let calId = t(input.gcalCalendarId)
            if !calId.isEmpty { e["MUSE_GCAL_CALENDAR_ID"] = calId }
        }

        if providers.count > 1 { e["MUSE_CALENDAR_PROVIDERS"] = providers.joined(separator: ",") }
        return e
    }
}
