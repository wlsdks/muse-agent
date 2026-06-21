import Foundation

/// The token fields the user enters for each messenger in Settings.
public struct MessagingEnvInput: Equatable, Sendable {
    public var telegramToken: String
    public var discordToken: String
    public var discordChannels: String
    public var slackToken: String
    public var slackChannels: String
    public var lineAccessToken: String
    public var lineSecret: String

    public init(
        telegramToken: String = "", discordToken: String = "", discordChannels: String = "",
        slackToken: String = "", slackChannels: String = "", lineAccessToken: String = "", lineSecret: String = ""
    ) {
        self.telegramToken = telegramToken
        self.discordToken = discordToken
        self.discordChannels = discordChannels
        self.slackToken = slackToken
        self.slackChannels = slackChannels
        self.lineAccessToken = lineAccessToken
        self.lineSecret = lineSecret
    }
}

/// Map stored messenger tokens to the env vars the bundled server reads to
/// connect each provider. Pure + testable so the desktop's Keychain layer holds
/// only storage. A blank (or whitespace-only) token sets NO var for that provider
/// — a half-configured provider must not be partly enabled. Poll is enabled only
/// when a token (and, for Discord/Slack, channels) is present, and the inbound
/// reply flag is set iff at least one provider is configured.
public enum MessagingEnv {
    public static func build(_ input: MessagingEnvInput) -> [String: String] {
        func t(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
        var e: [String: String] = [:]

        let telegram = t(input.telegramToken)
        if !telegram.isEmpty {
            e["MUSE_TELEGRAM_BOT_TOKEN"] = telegram
            e["MUSE_TELEGRAM_POLL_ENABLED"] = "1"
        }

        let discord = t(input.discordToken)
        if !discord.isEmpty {
            e["MUSE_DISCORD_BOT_TOKEN"] = discord
            let channels = t(input.discordChannels)
            if !channels.isEmpty {
                e["MUSE_DISCORD_POLL_CHANNELS"] = channels
                e["MUSE_DISCORD_POLL_ENABLED"] = "1"
            }
        }

        let slack = t(input.slackToken)
        if !slack.isEmpty {
            e["MUSE_SLACK_BOT_TOKEN"] = slack
            let channels = t(input.slackChannels)
            if !channels.isEmpty {
                e["MUSE_SLACK_POLL_CHANNELS"] = channels
                e["MUSE_SLACK_POLL_ENABLED"] = "1"
            }
        }

        let lineToken = t(input.lineAccessToken)
        if !lineToken.isEmpty { e["MUSE_LINE_CHANNEL_ACCESS_TOKEN"] = lineToken }
        let lineSecret = t(input.lineSecret)
        if !lineSecret.isEmpty { e["MUSE_LINE_CHANNEL_SECRET"] = lineSecret }

        if !e.isEmpty { e["MUSE_INBOUND_REPLY_ENABLED"] = "1" }
        return e
    }
}
