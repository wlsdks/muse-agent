import { describe, expect, it } from "vitest";

import { buildReminderContextBlock } from "./present.js";

// Minimal PersistedReminder-shaped stub (only the fields the block builder reads).
function reminder(id: string, text: string, dueAt: string) {
  return { id, text, dueAt, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" } as never;
}

describe("buildReminderContextBlock — <<reminder N>> grounding block", () => {
  it("empty list → the no-reminders placeholder (no crash)", () => {
    expect(buildReminderContextBlock([])).toBe("(no pending reminders)");
  });

  it("wraps each reminder with its 1-based number, id, a due, the text, and the [reminder: <text>] citation", () => {
    const block = buildReminderContextBlock([
      reminder("r1", "call dentist", "2026-04-15T17:00:00.000Z"),
      reminder("r2", "pay rent", "2026-05-01T09:00:00.000Z")
    ]);
    expect(block).toContain("<<reminder 1 — r1 (due ");
    expect(block).toContain("\ncall dentist\n[reminder: call dentist]\n<<end>>");
    expect(block).toContain("<<reminder 2 — r2 (due ");
    expect(block).toContain("[reminder: pay rent]");
    // citation embeds the TEXT (what the gate matches), not the id
    expect(block).not.toContain("[reminder: r1]");
  });

  it("separates multiple reminders with a blank line", () => {
    const block = buildReminderContextBlock([
      reminder("r1", "a", "2026-04-15T17:00:00.000Z"),
      reminder("r2", "b", "2026-04-16T17:00:00.000Z")
    ]);
    expect(block).toContain("<<end>>\n\n<<reminder 2");
  });
});
