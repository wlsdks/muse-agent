import Foundation
import MuseDesktopCore

/// Messenger tokens the user enters in Settings, stored in the Keychain. The
/// desktop injects them as env when it spawns the bundled server, so the
/// existing env-driven provider setup connects Telegram / Discord / Slack / LINE
/// — no API changes, tokens never touch a plaintext file.
struct MessagingCredentials: Equatable {
    var telegramToken = ""
    var discordToken = ""
    var discordChannels = ""   // comma-separated channel ids
    var slackToken = ""
    var slackChannels = ""
    var lineAccessToken = ""
    var lineSecret = ""

    private enum K {
        static let telegram = "msg.telegramToken"
        static let discord = "msg.discordToken"
        static let discordCh = "msg.discordChannels"
        static let slack = "msg.slackToken"
        static let slackCh = "msg.slackChannels"
        static let lineToken = "msg.lineAccessToken"
        static let lineSecret = "msg.lineSecret"
    }

    static func load() -> MessagingCredentials {
        var c = MessagingCredentials()
        c.telegramToken = KeychainStore.get(K.telegram) ?? ""
        c.discordToken = KeychainStore.get(K.discord) ?? ""
        c.discordChannels = KeychainStore.get(K.discordCh) ?? ""
        c.slackToken = KeychainStore.get(K.slack) ?? ""
        c.slackChannels = KeychainStore.get(K.slackCh) ?? ""
        c.lineAccessToken = KeychainStore.get(K.lineToken) ?? ""
        c.lineSecret = KeychainStore.get(K.lineSecret) ?? ""
        return c
    }

    func save() {
        KeychainStore.set(telegramToken.trimmed, for: K.telegram)
        KeychainStore.set(discordToken.trimmed, for: K.discord)
        KeychainStore.set(discordChannels.trimmed, for: K.discordCh)
        KeychainStore.set(slackToken.trimmed, for: K.slack)
        KeychainStore.set(slackChannels.trimmed, for: K.slackCh)
        KeychainStore.set(lineAccessToken.trimmed, for: K.lineToken)
        KeychainStore.set(lineSecret.trimmed, for: K.lineSecret)
    }

    /// Env vars to hand the bundled server so it connects these providers and
    /// polls for inbound messages (then auto-replies via Muse).
    func serverEnv() -> [String: String] {
        MessagingEnv.build(MessagingEnvInput(
            telegramToken: telegramToken,
            discordToken: discordToken,
            discordChannels: discordChannels,
            slackToken: slackToken,
            slackChannels: slackChannels,
            lineAccessToken: lineAccessToken,
            lineSecret: lineSecret
        ))
    }

    var hasAny: Bool { !serverEnv().isEmpty }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
