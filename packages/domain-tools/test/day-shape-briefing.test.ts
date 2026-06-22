import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { type AvailabilityEventLike } from "@muse/mcp-shared";
import { resolveDayShapeLine } from "@muse/proactivity";
import { writeObjectives } from "@muse/stores";
import { runDueSituationalBriefing } from "@muse/domain-tools";

const NOW = new Date(2026, 4, 20, 9, 0); // May 20 2026, 09:00 local
function ev(title: string, sh: number, eh: number): AvailabilityEventLike {
  return { allDay: false, endsAt: new Date(2026, 4, 20, eh, 0), startsAt: new Date(2026, 4, 20, sh, 0), title };
}

describe("resolveDayShapeLine — the rest of today's free/busy", () => {
  it("summarises free gaps; a gap to day-end renders 'after HH:MM'", () => {
    const line = resolveDayShapeLine([ev("Standup", 10, 11), ev("Review", 14, 15)], { now: NOW });
    expect(line).toBe("free 09:00–10:00, 11:00–14:00, after 15:00");
  });

  it("'booked solid the rest of today' when no gap remains", () => {
    expect(resolveDayShapeLine([ev("All day", 9, 22)], { now: NOW })).toBe("booked solid the rest of today");
  });

  it("returns undefined with no commitments left today (rides nothing)", () => {
    expect(resolveDayShapeLine([], { now: NOW })).toBeUndefined();
  });

  it("returns undefined once now is past the day's end-hour", () => {
    expect(resolveDayShapeLine([ev("Late", 23, 24)], { now: new Date(2026, 4, 20, 23, 30) })).toBeUndefined();
  });
});

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

describe("runDueSituationalBriefing — the day-shape line rides a briefing end-to-end", () => {
  async function run(opts: { imminent: boolean }): Promise<OutboundMessage[]> {
    const dir = mkdtempSync(join(tmpdir(), "muse-dayshape-brief-"));
    await writeObjectives(join(dir, "objectives.json"), []);
    const sent: OutboundMessage[] = [];
    await runDueSituationalBriefing({
      availabilityLine: () => resolveDayShapeLine([ev("Standup", 10, 11)], { now: NOW }),
      destination: "555",
      imminent: opts.imminent ? [{ startsAt: new Date(NOW.getTime() + 1_800_000), title: "Standup" }] : [],
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => NOW,
      objectivesFile: join(dir, "objectives.json"),
      providerId: "telegram",
      sidecarFile: join(dir, "sidecar.json")
    });
    return sent;
  }

  it("a non-empty brief gains a 'Schedule:' line for the rest of today", async () => {
    const sent = await run({ imminent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Schedule: free 09:00–10:00");
  });

  it("the day-shape line never TRIGGERS a brief on its own (rides, doesn't fire)", async () => {
    const sent = await run({ imminent: false });
    expect(sent).toHaveLength(0);
  });
});
