import { describe, expect, it } from "vitest";

import { episodeIndexHealth, messagingConfigCheck, notesIndexHealth } from "./commands-doctor-checks.js";

describe("messagingConfigCheck", () => {
  it("reports none configured (opt-in) and the wired providers", () => {
    expect(messagingConfigCheck({}).detail).toContain("no messaging provider");
    const wired = messagingConfigCheck({ MUSE_TELEGRAM_BOT_TOKEN: "t", MUSE_SLACK_BOT_TOKEN: "s" });
    expect(wired.detail).toContain("telegram");
    expect(wired.detail).toContain("slack");
    expect(wired.status).toBe("ok");
  });
});

describe("notesIndexHealth", () => {
  it("warns when absent or stale, ok when present+fresh", () => {
    expect(notesIndexHealth({ exists: false, stale: false }).status).toBe("warn");
    expect(notesIndexHealth({ exists: true, stale: true }).status).toBe("warn");
    expect(notesIndexHealth({ exists: true, stale: false }).status).toBe("ok");
  });
});

describe("episodeIndexHealth", () => {
  it("ok when none, warns when unindexed or lagging, ok when fully indexed", () => {
    expect(episodeIndexHealth({ episodeCount: 0, indexedCount: 0 }).status).toBe("ok");
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 0 }).status).toBe("warn");
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 3 }).status).toBe("warn");
    expect(episodeIndexHealth({ episodeCount: 5, indexedCount: 5 }).status).toBe("ok");
  });
});
