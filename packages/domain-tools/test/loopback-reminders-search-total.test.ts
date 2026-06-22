import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRemindersMcpServer } from "../src/loopback-reminders.js";
import { writeReminders, type PersistedReminder } from "@muse/stores";

const rem = (id: string, text: string, dueAt: string): PersistedReminder => ({
  createdAt: dueAt,
  dueAt,
  id,
  status: "pending",
  text
});

function tool(file: string, name: string) {
  const found = createRemindersMcpServer({ file, maxListEntries: 2 }).tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-rem-")), "reminders.json");
}

describe("muse.reminders#search — total reflects the real match count, not the post-limit slice", () => {
  it("reports total = the full match count and shown = the returned (capped) count", async () => {
    const file = freshFile();
    await writeReminders(file, [
      rem("a", "buy milk one", "2026-06-01T00:00:00Z"),
      rem("b", "buy milk two", "2026-06-02T00:00:00Z"),
      rem("c", "buy milk three", "2026-06-03T00:00:00Z")
    ]);
    // all 3 match "milk", but maxListEntries is 2
    const out = (await tool(file, "search").execute({ query: "milk" })) as {
      reminders: unknown[];
      shown: number;
      total: number;
    };
    expect(out.reminders).toHaveLength(2); // the cap is honored
    expect(out.shown).toBe(2); // the post-slice (returned) count
    expect(out.total).toBe(3); // the REAL match count — was 2 (the slice length) before the fix
  });
});
