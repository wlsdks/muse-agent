import Foundation

public enum WebNavDecision: Equatable, Sendable {
    case allow            // load in the app's WebView
    case openExternally   // hand off to the user's browser, don't navigate the app
    case cancel           // block entirely
}

/// The navigation gate for the app's embedded WebView: keep it pinned to the
/// local Muse server. Loopback hosts + inert schemes (about/data/blob) load
/// in-app; any other http(s) opens in the user's browser instead of navigating
/// the app away; everything else is blocked. Pure so this security decision is
/// unit-tested, not buried in the WKNavigationDelegate. Host match is EXACT —
/// "localhost.evil.com" is NOT local and must not load in-app.
public enum WebNavPolicy {
    public static func decide(scheme: String, host: String) -> WebNavDecision {
        let s = scheme.lowercased()
        let isLocal = host == "127.0.0.1" || host == "localhost"
        if isLocal || ["about", "data", "blob"].contains(s) { return .allow }
        if s == "http" || s == "https" { return .openExternally }
        return .cancel
    }
}
