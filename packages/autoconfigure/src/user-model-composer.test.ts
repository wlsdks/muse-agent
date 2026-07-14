import type { UserMemorySnapshot } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { buildUserModelComposer } from "./runtime-assembly.js";

const IDENTITY_MARKER = "Learns you, not the world.";

const memory = (over: Partial<UserMemorySnapshot> = {}): UserMemorySnapshot => ({
  userId: "u",
  facts: { name: "Jinan" },
  preferences: { "veto:no_coffee": "never suggest coffee — caffeine sensitivity" },
  ...over
});

describe("buildUserModelComposer — opt-in MUSE_RICH_USER_MODEL gate (default OFF)", () => {
  it("default OFF ⇒ no composer (byte-identical default section path); explicit true ⇒ a composer", () => {
    expect(buildUserModelComposer({})).toBeUndefined();
    expect(buildUserModelComposer({ MUSE_RICH_USER_MODEL: "false" })).toBeUndefined();
    expect(buildUserModelComposer({ MUSE_RICH_USER_MODEL: "true" })).toBeDefined();
  });

  it("MUSE_RICH_USER_MODEL=true ⇒ the recall learned block (facts + vetoes)", () => {
    const composer = buildUserModelComposer({ MUSE_RICH_USER_MODEL: "true" })!;
    const section = composer(memory(), "u", 40);
    expect(section).toContain("Vetoes"); // the recall learned block's veto header
    expect(section).toContain("no_coffee: never suggest coffee");
    expect(section).toContain("Facts the user has shared:");
    expect(section).toContain("name: Jinan");
  });

  it("the composed section carries NO identity preamble and NO context line (no double-inject)", () => {
    const composer = buildUserModelComposer({ MUSE_RICH_USER_MODEL: "true" })!;
    const section = composer(memory(), "u", 40) ?? "";
    expect(section).not.toContain(IDENTITY_MARKER);
    expect(section).not.toContain("You are Muse");
    expect(section).not.toContain("Current local context:");
  });

  it("empty memory ⇒ composer returns undefined (agent-core falls back to the default section)", () => {
    const composer = buildUserModelComposer({ MUSE_RICH_USER_MODEL: "true" })!;
    expect(composer({ userId: "u", facts: {}, preferences: {} }, "u", 40)).toBeUndefined();
  });

  it("fail-soft: a throwing snapshot returns undefined, never breaking the run", () => {
    const composer = buildUserModelComposer({ MUSE_RICH_USER_MODEL: "true" })!;
    const hostile = {
      userId: "u",
      facts: { name: "Jinan" },
      get preferences(): Record<string, string> {
        throw new Error("boom");
      }
    } as unknown as UserMemorySnapshot;
    expect(() => composer(hostile, "u", 40)).not.toThrow();
    expect(composer(hostile, "u", 40)).toBeUndefined();
  });
});
