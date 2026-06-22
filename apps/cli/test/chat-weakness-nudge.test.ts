import { askTimeWeaknessNudge, renderAskTimeNudge, topicKeyFromMessage, type WeaknessEntry } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { chatRepeatWeaknessNudge } from "../src/chat-repl.js";

describe("chatRepeatWeaknessNudge — in-chat repeat nudge unified onto the shared ask helper", () => {
  const message = "what's my office vpn mtu?";
  const topic = topicKeyFromMessage(message);
  const e = (over: Partial<WeaknessEntry>): WeaknessEntry => ({
    axis: "grounding-gap", count: 2, firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-07T00:00:00.000Z", topic, ...over
  });
  const deps = (entries: readonly WeaknessEntry[]) => ({
    readWeaknesses: async () => entries,
    selectNudge: askTimeWeaknessNudge,
    render: renderAskTimeNudge,
    topicKey: topicKeyFromMessage,
    weaknessesFile: "unused"
  });

  it("surfaces a recurring SOURCE-CONFLICT as a reconcile hint (the old chat nudge could never show this)", async () => {
    const out = await chatRepeatWeaknessNudge(message, deps([e({ axis: "source-conflict", count: 3 })]));
    expect(out).toContain("disagree");
    expect(out).not.toContain("add one");
    expect(out?.startsWith("\n\n(")).toBe(true);
  });

  it("surfaces a recurring grounding-gap as the add-a-note hint", async () => {
    const out = await chatRepeatWeaknessNudge(message, deps([e({ axis: "grounding-gap", count: 2 })]));
    expect(out).toContain("add one");
  });

  it("no nudge for a single occurrence, a MASTERED topic, or a dev-fixable misgrounding", async () => {
    expect(await chatRepeatWeaknessNudge(message, deps([e({ count: 1 })]))).toBeUndefined();
    expect(await chatRepeatWeaknessNudge(message, deps([e({ count: 5, pKnown: 0.99 })]))).toBeUndefined();
    expect(await chatRepeatWeaknessNudge(message, deps([e({ axis: "misgrounding", count: 5 })]))).toBeUndefined();
  });

  it("no nudge when the ledger read throws (best-effort, never a chat error)", async () => {
    const out = await chatRepeatWeaknessNudge(message, {
      readWeaknesses: async () => { throw new Error("ledger down"); },
      selectNudge: askTimeWeaknessNudge,
      render: renderAskTimeNudge,
      topicKey: topicKeyFromMessage,
      weaknessesFile: "x"
    });
    expect(out).toBeUndefined();
  });
});
