import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startPatternTick } from "../src/pattern-tick.js";

interface MessageSent { readonly providerId: string; readonly destination: string; readonly text: string }

function fakeRegistry(sent: MessageSent[]): MessagingProviderRegistry {
  return {
    send: async (providerId: string, message: { destination: string; text: string }) => {
      sent.push({ destination: message.destination, providerId, text: message.text });
      return { destination: message.destination, messageId: "stub", providerId };
    }
  } as unknown as MessagingProviderRegistry;
}

function seedThreeTuesdayJournals(notesDir: string): void {
  mkdirSync(notesDir);
  mkdirSync(join(notesDir, "journal"));
  const tuesdays = [
    new Date(2026, 3, 14, 21, 30),
    new Date(2026, 3, 21, 21, 30),
    new Date(2026, 3, 28, 21, 30)
  ];
  for (let i = 0; i < tuesdays.length; i++) {
    const file = join(notesDir, "journal", `entry-${i.toString()}.md`);
    writeFileSync(file, "x", "utf8");
    const secs = tuesdays[i]!.getTime() / 1000;
    utimesSync(file, secs, secs);
  }
}

describe("startPatternTick", () => {
  it("tickOnce fires the in-slot strong pattern and records the cooldown", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-tick-"));
    const notesDir = join(root, "notes");
    seedThreeTuesdayJournals(notesDir);
    const sent: MessageSent[] = [];
    const handle = startPatternTick({
      destination: "@me",
      notesDir,
      now: () => new Date(2026, 4, 12, 21, 30), // Tuesday May 12
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      registry: fakeRegistry(sent),
      tasksFile: join(root, "no-tasks.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.providerId).toBe("telegram");
      expect(sent[0]!.text).toContain("journal notes");

      // Second tick within the cooldown window → no re-fire.
      await handle.tickOnce();
      expect(sent).toHaveLength(1);

      const persisted = JSON.parse(readFileSync(join(root, "patterns-fired.json"), "utf8")) as {
        fired: Array<{ patternId: string }>;
      };
      expect(persisted.fired).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("skips firing during the quiet-hour window", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-tick-quiet-"));
    const notesDir = join(root, "notes");
    seedThreeTuesdayJournals(notesDir);
    const sent: MessageSent[] = [];
    const handle = startPatternTick({
      destination: "@me",
      notesDir,
      // Tuesday 02:00 falls inside the 23-7 quiet window.
      now: () => new Date(2026, 4, 12, 2, 0),
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      quietHours: { endHour: 7, startHour: 23 },
      registry: fakeRegistry(sent),
      tasksFile: join(root, "no-tasks.json")
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([]);
      // No cooldown record either — quiet-hour skip should leave state untouched.
      expect(() => readFileSync(join(root, "patterns-fired.json"), "utf8")).toThrow();
    } finally {
      handle.stop();
    }
  });

  it("logger surfaces the summary on a successful fire", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-tick-log-"));
    const notesDir = join(root, "notes");
    seedThreeTuesdayJournals(notesDir);
    const lines: string[] = [];
    const handle = startPatternTick({
      destination: "@me",
      logger: (m) => lines.push(m),
      notesDir,
      now: () => new Date(2026, 4, 12, 21, 30),
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      registry: fakeRegistry([]),
      tasksFile: join(root, "no-tasks.json")
    });
    try {
      await handle.tickOnce();
      expect(lines.some((l) => l.includes("pattern-tick: fired 1 of 1"))).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
