import { describe, expect, it } from "vitest";
import { shapeDaemonFlags, type DaemonFlagView } from "./settings-routes.js";

// parseBoolean truthy set: "true", "1", "yes", "on" (case-insensitive, trimmed).
// All eight DAEMON_FLAGS have default false.

const ALL_KEYS = [
  "MUSE_EPISODIC_MEMORY_ENABLED",
  "MUSE_HOME_WATCH_ENABLED",
  "MUSE_CONFLICT_WATCH_ENABLED",
  "MUSE_PROACTIVE_AGENT_TURN",
  "MUSE_BACKGROUND_REVIEW_ENABLED",
  "MUSE_KNOWLEDGE_SEARCH_ENABLED",
  "MUSE_TELEGRAM_POLL_ENABLED",
  "MUSE_MATRIX_POLL_ENABLED",
  "MUSE_INBOUND_REPLY_ENABLED"
];

describe("shapeDaemonFlags", () => {
  it("empty env → all flags disabled, all 9 keys present in order", () => {
    const { flags } = shapeDaemonFlags({});
    expect(flags).toHaveLength(9);
    for (let i = 0; i < ALL_KEYS.length; i++) {
      const flag = flags[i] as DaemonFlagView;
      expect(flag.key).toBe(ALL_KEYS[i]);
      expect(flag.enabled).toBe(false);
    }
  });

  it("MUSE_EPISODIC_MEMORY_ENABLED=true and MUSE_HOME_WATCH_ENABLED=1 → those two enabled", () => {
    const env = {
      MUSE_EPISODIC_MEMORY_ENABLED: "true",
      MUSE_HOME_WATCH_ENABLED: "1"
    };
    const { flags } = shapeDaemonFlags(env);
    const byKey = Object.fromEntries(flags.map((f: DaemonFlagView) => [f.key, f.enabled]));
    // Both "true" and "1" are in parseBoolean's TRUTHY_ENV_VALUES set
    expect(byKey["MUSE_EPISODIC_MEMORY_ENABLED"]).toBe(true);
    expect(byKey["MUSE_HOME_WATCH_ENABLED"]).toBe(true);
    expect(byKey["MUSE_CONFLICT_WATCH_ENABLED"]).toBe(false);
    expect(byKey["MUSE_PROACTIVE_AGENT_TURN"]).toBe(false);
    expect(byKey["MUSE_BACKGROUND_REVIEW_ENABLED"]).toBe(false);
    expect(byKey["MUSE_KNOWLEDGE_SEARCH_ENABLED"]).toBe(false);
    expect(byKey["MUSE_TELEGRAM_POLL_ENABLED"]).toBe(false);
    expect(byKey["MUSE_INBOUND_REPLY_ENABLED"]).toBe(false);
  });

  it("MUSE_CONFLICT_WATCH_ENABLED=false → that flag disabled", () => {
    const env = { MUSE_CONFLICT_WATCH_ENABLED: "false" };
    const { flags } = shapeDaemonFlags(env);
    const conflict = flags.find((f: DaemonFlagView) => f.key === "MUSE_CONFLICT_WATCH_ENABLED");
    expect(conflict).toBeDefined();
    expect(conflict!.enabled).toBe(false);
  });

  it("every flag has a non-empty label and its key matches known keys", () => {
    const { flags } = shapeDaemonFlags({});
    for (const flag of flags) {
      expect(flag.label.length).toBeGreaterThan(0);
      expect(ALL_KEYS).toContain(flag.key);
    }
  });
});
