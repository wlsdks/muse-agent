import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRemindersMcpServer, type ReminderMirror } from "../src/loopback-reminders.js";
import { readReminders } from "@muse/stores";

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-rem-mirror-")), "reminders.json");
}

function addTool(file: string, mirror?: ReminderMirror) {
  const found = createRemindersMcpServer({
    file,
    now: () => new Date("2026-06-10T00:00:00.000Z"),
    ...(mirror ? { mirror } : {})
  }).tools.find((t) => t.name === "add");
  if (!found) throw new Error("add tool not found");
  return found;
}

describe("muse.reminders#add — Apple Reminders mirror injection", () => {
  it("calls the injected mirror exactly once, with the created text + dueAt", async () => {
    const file = freshFile();
    const calls: Array<{ text: string; dueAt: string }> = [];
    const mirror: ReminderMirror = async (r) => { calls.push({ ...r }); return { mirrored: true }; };
    const out = await addTool(file, mirror).execute({ text: "call mom", dueAt: "2026-06-11T00:00:00.000Z" });
    expect((out as { reminder?: unknown }).reminder).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("call mom");
    expect(calls[0]!.dueAt).toBe("2026-06-11T00:00:00.000Z");
    // The Muse write is the source of truth and always persists.
    expect(await readReminders(file)).toHaveLength(1);
  });

  it("surfaces a mirror warning as `mirrorNote` in the tool result (fail-soft, write still succeeds)", async () => {
    const file = freshFile();
    const mirror: ReminderMirror = async () => ({ mirrored: false, warning: "Apple Reminders mirror failed: boom" });
    const out = await addTool(file, mirror).execute({ text: "call mom", dueAt: "2026-06-11T00:00:00.000Z" }) as {
      reminder?: unknown;
      mirrorNote?: string;
    };
    expect(out.reminder).toBeDefined();
    expect(out.mirrorNote).toBe("Apple Reminders mirror failed: boom");
    expect(await readReminders(file)).toHaveLength(1);
  });

  it("a THROWN mirror never fails the Muse write — it degrades to a mirrorNote", async () => {
    const file = freshFile();
    const mirror: ReminderMirror = async () => { throw new Error("osascript exploded"); };
    const out = await addTool(file, mirror).execute({ text: "call mom", dueAt: "2026-06-11T00:00:00.000Z" }) as {
      reminder?: unknown;
      mirrorNote?: string;
    };
    expect(out.reminder).toBeDefined();
    expect(out.mirrorNote).toContain("osascript exploded");
    expect(await readReminders(file)).toHaveLength(1);
  });

  it("omits mirrorNote (and does not call the mirror) when no mirror is injected", async () => {
    const file = freshFile();
    const out = await addTool(file).execute({ text: "call mom", dueAt: "2026-06-11T00:00:00.000Z" }) as {
      reminder?: unknown;
      mirrorNote?: string;
    };
    expect(out.reminder).toBeDefined();
    expect(out.mirrorNote).toBeUndefined();
  });

  it("does NOT mirror on a FAILED create (empty text) — the write never happened", async () => {
    const file = freshFile();
    let called = 0;
    const mirror: ReminderMirror = async () => { called += 1; return { mirrored: true }; };
    const out = await addTool(file, mirror).execute({ text: "   ", dueAt: "2026-06-11T00:00:00.000Z" });
    expect((out as { error?: string }).error).toBeDefined();
    expect(called).toBe(0);
    expect(await readReminders(file)).toHaveLength(0);
  });
});
