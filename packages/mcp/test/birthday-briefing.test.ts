import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { formatBirthdayBriefLine, resolveUpcomingBirthdays, type Contact } from "../src/personal-contacts-store.js";
import { runDueSituationalBriefing } from "../src/situational-briefing-loop.js";
import { writeObjectives } from "../src/personal-objectives-store.js";

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
