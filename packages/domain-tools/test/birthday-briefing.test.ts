import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { formatBirthdayBriefLine, resolveUpcomingBirthdays, type Contact } from "@muse/stores";
import { runDueSituationalBriefing } from "../src/situational-briefing-loop.js";
import { writeObjectives } from "@muse/stores";

describe("formatBirthdayBriefLine", () => {
  const now = new Date(2026, 4, 20); // May 20
  const people: Contact[] = [
    { birthday: "05-20", id: "t", name: "Tom" },   // today
    { birthday: "05-21", id: "s", name: "Sarah" },  // tomorrow
    { birthday: "05-23", id: "a", name: "Ann" }     // in 3 days
  ];

  it("renders today / tomorrow / in N days, soonest first", () => {
    const line = formatBirthdayBriefLine(resolveUpcomingBirthdays(people, { now, withinDays: 7 }));
    expect(line).toBe("Tom today; Sarah tomorrow; Ann in 3 days");
  });

  it("returns undefined when there are no upcoming birthdays", () => {
    expect(formatBirthdayBriefLine(resolveUpcomingBirthdays([{ birthday: "12-25", id: "x", name: "X" }], { now, withinDays: 7 }))).toBeUndefined();
    expect(formatBirthdayBriefLine([])).toBeUndefined();
  });
});

describe("resolveUpcomingBirthdays — Feb-29 leap-day birthdays", () => {
  const leapLarry: Contact[] = [{ birthday: "02-29", id: "l", name: "Larry" }];

  it("in a NON-leap year, a 02-29 birthday celebrates on 02-28 — not a phantom non-existent '02-29' from a Date rollover to Mar 1", () => {
    // 2026 is not a leap year: new Date(2026, 1, 29) silently overflows to Mar 1,
    // which previously surfaced "Larry in 2 days" with the impossible date "02-29".
    const out = resolveUpcomingBirthdays(leapLarry, { now: new Date(2026, 1, 27), withinDays: 7 }); // Feb 27
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe("02-28"); // a real date in 2026, the common-year convention
    expect(out[0]!.daysUntil).toBe(1); // Feb 27 → Feb 28
    // the impossible date must never be reported in a non-leap year
    expect(out.some((b) => b.date === "02-29")).toBe(false);
  });

  it("in a LEAP year, a 02-29 birthday keeps its real 02-29 date", () => {
    const out = resolveUpcomingBirthdays(leapLarry, { now: new Date(2028, 1, 27), withinDays: 7 }); // 2028 is a leap year, Feb 27
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe("02-29");
    expect(out[0]!.daysUntil).toBe(2); // Feb 27 → Feb 29
  });

  it("does not phantom-surface a 02-29 birthday as imminent once Feb is past in a non-leap year", () => {
    // On Mar 5 2026 the next occurrence is ~Feb 2027 (also non-leap → 02-28), far outside a 7-day window.
    const out = resolveUpcomingBirthdays(leapLarry, { now: new Date(2026, 2, 5), withinDays: 7 }); // Mar 5
    expect(out).toHaveLength(0);
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

describe("runDueSituationalBriefing — the birthday line rides a briefing end-to-end", () => {
  it("delivers a brief whose Birthdays line names tomorrow's birthday alongside an imminent item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-bday-brief-"));
    const objectivesFile = join(dir, "objectives.json");
    await writeObjectives(objectivesFile, []);
    const now = new Date(2026, 4, 20, 8, 0);
    const people: Contact[] = [{ birthday: "05-21", id: "s", name: "Sarah" }];
    const sent: OutboundMessage[] = [];

    const summary = await runDueSituationalBriefing({
      birthdayLine: () => formatBirthdayBriefLine(resolveUpcomingBirthdays(people, { now, withinDays: 7 })),
      destination: "555",
      imminent: [{ startsAt: new Date(now.getTime() + 1_800_000), title: "Standup" }],
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => now,
      objectivesFile,
      providerId: "telegram",
      sidecarFile: join(dir, "sidecar.json")
    });

    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).toContain("Birthdays: Sarah tomorrow");
    expect(sent[0]!.text).toContain("Standup");
  });
});
