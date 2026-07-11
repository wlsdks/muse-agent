import { describe, expect, it } from "vitest";

import { shapeDaemonFlags } from "../src/settings-routes.js";

// Truthful daemon status: the flags surface must report whether a daemon is
// ACTUALLY running (live handle via the supervisor), not just whether its
// env flag is set — a flag-on/daemon-dead badge was the UX audit's top lie.

describe("shapeDaemonFlags running state", () => {
  it("reports running for channel daemons from the live status snapshot", () => {
    const shaped = shapeDaemonFlags(
      { MUSE_INBOUND_REPLY_ENABLED: "1", MUSE_TELEGRAM_POLL_ENABLED: "1" },
      () => ({
        "inbound-reply": { running: true },
        "telegram-poll": { running: false }
      })
    );
    const telegram = shaped.flags.find((flag) => flag.key === "MUSE_TELEGRAM_POLL_ENABLED");
    const reply = shaped.flags.find((flag) => flag.key === "MUSE_INBOUND_REPLY_ENABLED");
    expect(telegram).toMatchObject({ enabled: true, running: false });
    expect(reply).toMatchObject({ enabled: true, running: true });
  });

  it("omits running when no status source is wired (non-channel daemons keep the old shape)", () => {
    const shaped = shapeDaemonFlags({ MUSE_TELEGRAM_POLL_ENABLED: "1" });
    const telegram = shaped.flags.find((flag) => flag.key === "MUSE_TELEGRAM_POLL_ENABLED");
    expect(telegram?.enabled).toBe(true);
    expect(telegram && "running" in telegram ? telegram.running : undefined).toBeUndefined();
  });

  it("lists the matrix sync daemon flag", () => {
    const shaped = shapeDaemonFlags({});
    expect(shaped.flags.some((flag) => flag.key === "MUSE_MATRIX_POLL_ENABLED")).toBe(true);
  });
});

describe("shapeDaemonFlags status detail passthrough", () => {
  it("carries lastIngestAtIso and lastError for channel daemons", () => {
    const shaped = shapeDaemonFlags(
      { MUSE_TELEGRAM_POLL_ENABLED: "1" },
      () => ({
        "telegram-poll": { lastError: "getUpdates failed", lastIngestAtIso: "2026-07-11T10:00:00.000Z", running: true }
      })
    );
    const telegram = shaped.flags.find((flag) => flag.key === "MUSE_TELEGRAM_POLL_ENABLED");
    expect(telegram).toMatchObject({
      lastError: "getUpdates failed",
      lastIngestAtIso: "2026-07-11T10:00:00.000Z",
      running: true
    });
  });
});
