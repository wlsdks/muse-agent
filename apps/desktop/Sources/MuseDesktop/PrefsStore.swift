import Foundation
import MuseDesktopCore

/// Persists `CompanionPrefs` in UserDefaults under the app's domain, so the
/// chosen look + window position survive a relaunch.
enum PrefsStore {
    private static let key = "companionPrefs"
    private static let defaults = UserDefaults(suiteName: "com.muse.desktop") ?? .standard

    static func load() -> CompanionPrefs {
        defaults.string(forKey: key).flatMap(CompanionPrefs.decode) ?? CompanionPrefs()
    }

    static func update(_ mutate: (inout CompanionPrefs) -> Void) {
        var prefs = load()
        mutate(&prefs)
        defaults.set(prefs.encoded(), forKey: key)
    }
}
