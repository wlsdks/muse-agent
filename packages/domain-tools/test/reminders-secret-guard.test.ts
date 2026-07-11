import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRemindersMcpServer } from "../src/loopback-reminders.js";
import { readReminders } from "@muse/stores";

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-rem-secret-guard-")), "reminders.json");
}

function addTool(file: string) {
  const found = createRemindersMcpServer({ file, now: () => new Date("2026-06-10T00:00:00.000Z") }).tools.find((t) => t.name === "add");
  if (!found) throw new Error("add tool not found");
  return found;
}

describe("muse.reminders#add — fail-close secret-persistence guard", () => {
  it("refuses a reminder text carrying a password and performs NO write", async () => {
    const file = freshFile();
    const out = await addTool(file).execute({ text: "내 비밀번호 hunter2를 기억해", dueAt: "2026-06-11T00:00:00.000Z" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(out.kinds).toContain("credential-label");
    expect(await readReminders(file)).toEqual([]);
  });

  it("an ordinary reminder still writes normally (no over-block regression)", async () => {
    const file = freshFile();
    const out = await addTool(file).execute({ text: "call mom", dueAt: "2026-06-11T00:00:00.000Z" }) as { reminder?: { text: string } };
    expect(out.reminder?.text).toBe("call mom");
    expect(await readReminders(file)).toHaveLength(1);
  });
});
