import { describe, expect, it } from "vitest";

import { messagingConfigCheck } from "./commands-doctor.js";

describe("messagingConfigCheck — which outbound messengers are wired", () => {
  it("ok when no provider token is set (messaging is opt-in)", () => {
    const v = messagingConfigCheck({});
    expect(v.status).toBe("ok");
    expect(v.detail).toMatch(/no messaging provider|opt-in|not configured/i);
  });

  it("lists the configured providers when their tokens are present", () => {
    const v = messagingConfigCheck({ MUSE_TELEGRAM_BOT_TOKEN: "t", MUSE_SLACK_BOT_TOKEN: "s" });
    expect(v.status).toBe("ok");
    expect(v.detail).toMatch(/telegram/i);
    expect(v.detail).toMatch(/slack/i);
  });

  it("treats a blank/whitespace token as not configured", () => {
    const v = messagingConfigCheck({ MUSE_TELEGRAM_BOT_TOKEN: "   " });
    expect(v.detail).toMatch(/no messaging provider|not configured/i);
  });

  it("recognises all four providers", () => {
    const v = messagingConfigCheck({
      MUSE_TELEGRAM_BOT_TOKEN: "t",
      MUSE_DISCORD_BOT_TOKEN: "d",
      MUSE_SLACK_BOT_TOKEN: "s",
      MUSE_LINE_CHANNEL_ACCESS_TOKEN: "l"
    });
    expect(v.detail).toMatch(/telegram.*discord.*slack.*line/i);
  });
});
