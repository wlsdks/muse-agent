import XCTest
@testable import MuseDesktopCore

final class MessagingEnvTests: XCTestCase {
    func testEmptyInputYieldsNoEnvAndNoInboundFlag() {
        XCTAssertEqual(MessagingEnv.build(MessagingEnvInput()), [:])
    }

    func testTelegramTokenEnablesPollAndInboundReply() {
        let e = MessagingEnv.build(MessagingEnvInput(telegramToken: "  abc123  ")) // trimmed
        XCTAssertEqual(e["MUSE_TELEGRAM_BOT_TOKEN"], "abc123")
        XCTAssertEqual(e["MUSE_TELEGRAM_POLL_ENABLED"], "1")
        XCTAssertEqual(e["MUSE_INBOUND_REPLY_ENABLED"], "1")
    }

    func testWhitespaceOnlyTokenSetsNothing() {
        XCTAssertEqual(MessagingEnv.build(MessagingEnvInput(telegramToken: "   ")), [:])
    }

    func testDiscordWithoutChannelsSetsTokenButNotPoll() {
        let e = MessagingEnv.build(MessagingEnvInput(discordToken: "dt"))
        XCTAssertEqual(e["MUSE_DISCORD_BOT_TOKEN"], "dt")
        XCTAssertNil(e["MUSE_DISCORD_POLL_CHANNELS"])
        XCTAssertNil(e["MUSE_DISCORD_POLL_ENABLED"])
    }

    func testDiscordWithChannelsEnablesPoll() {
        let e = MessagingEnv.build(MessagingEnvInput(discordToken: "dt", discordChannels: "c1,c2"))
        XCTAssertEqual(e["MUSE_DISCORD_POLL_CHANNELS"], "c1,c2")
        XCTAssertEqual(e["MUSE_DISCORD_POLL_ENABLED"], "1")
    }

    func testSlackWithChannelsEnablesPoll() {
        let e = MessagingEnv.build(MessagingEnvInput(slackToken: "st", slackChannels: "#general"))
        XCTAssertEqual(e["MUSE_SLACK_BOT_TOKEN"], "st")
        XCTAssertEqual(e["MUSE_SLACK_POLL_CHANNELS"], "#general")
        XCTAssertEqual(e["MUSE_SLACK_POLL_ENABLED"], "1")
    }

    func testLineTokensAndInboundFlagWhenAnyConfigured() {
        let e = MessagingEnv.build(MessagingEnvInput(lineAccessToken: "la", lineSecret: "ls"))
        XCTAssertEqual(e["MUSE_LINE_CHANNEL_ACCESS_TOKEN"], "la")
        XCTAssertEqual(e["MUSE_LINE_CHANNEL_SECRET"], "ls")
        XCTAssertEqual(e["MUSE_INBOUND_REPLY_ENABLED"], "1")
    }

    func testTokensDoNotCrossWires() {
        // a telegram token must never land in a discord/slack/line var
        let e = MessagingEnv.build(MessagingEnvInput(telegramToken: "tg"))
        XCTAssertNil(e["MUSE_DISCORD_BOT_TOKEN"])
        XCTAssertNil(e["MUSE_SLACK_BOT_TOKEN"])
        XCTAssertNil(e["MUSE_LINE_CHANNEL_ACCESS_TOKEN"])
    }
}
