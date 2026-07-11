import { MUSE_IDENTITY_CORE } from "@muse/prompts";
import { describe, expect, it, vi } from "vitest";

import { synthesizeNoticeText, type NoticeGroundingReverify } from "../src/proactive-notice-loop.js";

const baseItem = {
  factSheet: "Standup at 9:00 AM, Room A",
  id: "e1",
  kind: "calendar" as const,
  startsAt: new Date("2026-06-20T09:00:00.000Z"),
  text: "⏰ Standup in 15 min",
  title: "Standup"
};

const provider = (output: string) => ({ generate: async () => ({ output }) });

describe("synthesizeNoticeText — faithfulness gate on the proactive notice (unasked push = high-trust, fabrication=0)", () => {
  const opts = (reverify?: NoticeGroundingReverify) => ({
    agentModel: "m",
    modelProvider: provider("Standup in 15 min in Room B — want yesterday's notes?"),
    reverify
  });
  it("DROPS to the verbatim item.text when the judge says the synthesized prose is NOT grounded (a fabricated Room B never pushes)", async () => {
    const reverify = vi.fn().mockResolvedValue(false);
    expect(await synthesizeNoticeText(baseItem, opts(reverify))).toBe("⏰ Standup in 15 min");
    expect(reverify).toHaveBeenCalledTimes(1);
  });
  it("KEEPS the synthesized prose when the judge confirms it grounded in the factSheet", async () => {
    const out = await synthesizeNoticeText(baseItem, opts(vi.fn().mockResolvedValue(true)));
    expect(out).toContain("Room B");
  });
  it("fail-closes to item.text when the judge THROWS (an unverifiable push is never the unverified prose)", async () => {
    expect(await synthesizeNoticeText(baseItem, opts(vi.fn().mockRejectedValue(new Error("judge down"))))).toBe("⏰ Standup in 15 min");
  });
  it("fail-closes to item.text on EMPTY factSheet WITHOUT consulting the judge (nothing to verify against)", async () => {
    const reverify = vi.fn().mockResolvedValue(true);
    const out = await synthesizeNoticeText({ ...baseItem, factSheet: "   " }, { agentModel: "m", modelProvider: provider("x"), reverify });
    expect(out).toBe("⏰ Standup in 15 min");
    expect(reverify).not.toHaveBeenCalled();
  });
  it("back-compat: no reverify → delivers the synthesized prose unverified (existing behavior preserved)", async () => {
    const out = await synthesizeNoticeText(baseItem, { agentModel: "m", modelProvider: provider("Standup soon in Room B") });
    expect(out).toContain("Room B");
  });

  it("carries the shared identity core in the system message, plus its own heads-up task", async () => {
    const sink: { request?: { messages: { role: string; content: string }[] } } = {};
    await synthesizeNoticeText(baseItem, {
      agentModel: "m",
      modelProvider: { generate: async (request: typeof sink.request) => { sink.request = request; return { output: "x" }; } }
    });
    const system = sink.request?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain(MUSE_IDENTITY_CORE);
    expect(system).toContain("imminent calendar event or task");
  });
});
