import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { resolveTasksDueLine, type PersistedTask } from "@muse/stores";
import { runDueSituationalBriefing } from "../src/situational-briefing-loop.js";
import { writeObjectives } from "@muse/stores";

const now = new Date(2026, 4, 20, 8, 0); // May 20 2026
function iso(y: number, m: number, d: number): string {
  return new Date(y, m, d, 12, 0).toISOString();
}
const TASKS: PersistedTask[] = [
  { createdAt: iso(2026, 4, 1), dueAt: iso(2026, 4, 18), id: "t1", status: "open", title: "Pay rent" },   // overdue
  { createdAt: iso(2026, 4, 1), dueAt: iso(2026, 4, 20), id: "t2", status: "open", title: "Buy milk" },    // today
  { createdAt: iso(2026, 4, 1), dueAt: iso(2026, 4, 21), id: "t3", status: "open", title: "Call mom" },    // tomorrow
  { createdAt: iso(2026, 4, 1), dueAt: iso(2026, 4, 28), id: "t4", status: "open", title: "Far off" },     // beyond window
  { createdAt: iso(2026, 4, 1), dueAt: iso(2026, 4, 20), id: "t5", status: "done", title: "Done one" },    // done → skipped
  { createdAt: iso(2026, 4, 1), id: "t6", status: "open", title: "No due date" }                            // no dueAt → skipped
];

describe("resolveTasksDueLine", () => {
  it("lists open tasks due within the window, overdue first, with relative timing", () => {
    expect(resolveTasksDueLine(TASKS, { now, withinDays: 1 })).toBe("Pay rent (overdue); Buy milk (today); Call mom (tomorrow)");
  });

  it("returns undefined when nothing is due in the window", () => {
    expect(resolveTasksDueLine([{ createdAt: iso(2026, 4, 1), dueAt: iso(2026, 4, 28), id: "x", status: "open", title: "Later" }], { now, withinDays: 1 })).toBeUndefined();
    expect(resolveTasksDueLine([], { now })).toBeUndefined();
  });

  it("a wider window pulls in farther tasks", () => {
    expect(resolveTasksDueLine(TASKS, { now, withinDays: 30 })).toContain("Far off");
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

describe("runDueSituationalBriefing — the due-tasks line rides a briefing end-to-end", () => {
  it("delivers a brief whose Due line flags today's + overdue tasks alongside an imminent item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tasksdue-brief-"));
    const objectivesFile = join(dir, "objectives.json");
    await writeObjectives(objectivesFile, []);
    const sent: OutboundMessage[] = [];

    const summary = await runDueSituationalBriefing({
      destination: "555",
      imminent: [{ startsAt: new Date(now.getTime() + 1_800_000), title: "Standup" }],
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => now,
      objectivesFile,
      providerId: "telegram",
      sidecarFile: join(dir, "sidecar.json"),
      tasksDueLine: () => resolveTasksDueLine(TASKS, { now, withinDays: 1 })
    });

    expect(summary.delivered).toBe(1);
    expect(sent[0]!.text).toContain("Due: Pay rent (overdue)");
    expect(sent[0]!.text).toContain("Standup");
  });
});
