import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReminders } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildGreetings,
  gatherCompanionCandidates,
  phraseCandidate,
  selectCompanionLine,
  timeGreeting,
  type CompanionCandidate
} from "./companion-line.js";

const cand = (key: string, line = `line for ${key}`): CompanionCandidate => ({ key, line });

describe("selectCompanionLine — grounded-or-greeting opener selection", () => {
  const greetings = ["Good morning ☀️", "What's on your mind?", "I'm right here :)"];
  const noVeto = new Set<string>();

  it("prefers a fresh grounded candidate outside quiet hours (grounded:true)", () => {
    const s = selectCompanionLine({
      candidates: [cand("reminder:r1")],
      greetings,
      quiet: false,
      recent: [],
      rotation: 0,
      vetoed: noVeto
    });
    expect(s.grounded).toBe(true);
    expect(s.key).toBe("reminder:r1");
    expect(s.line).toBe("line for reminder:r1");
  });

  it("VARIES the grounded pick as rotation advances (no fixed line)", () => {
    const candidates = [cand("calendar:e1"), cand("reminder:r1"), cand("task:t1")];
    const keys = [0, 1, 2].map((rotation) =>
      selectCompanionLine({ candidates, greetings, quiet: false, recent: [], rotation, vetoed: noVeto }).key
    );
    expect(new Set(keys).size).toBe(3); // three consecutive calls, three different items
  });

  it("never immediately repeats: a recently-shown grounded key falls back to a greeting", () => {
    const s = selectCompanionLine({
      candidates: [cand("reminder:r1")],
      greetings,
      quiet: false,
      recent: ["reminder:r1"], // only candidate was just shown
      rotation: 0,
      vetoed: noVeto
    });
    expect(s.grounded).toBe(false);
    expect(greetings).toContain(s.line);
  });

  it("suppresses a VETOED grounded source and returns a greeting instead", () => {
    const s = selectCompanionLine({
      candidates: [cand("calendar:evt-42")],
      greetings,
      quiet: false,
      recent: [],
      rotation: 0,
      vetoed: new Set(["calendar:evt-42"])
    });
    expect(s.grounded).toBe(false);
    expect(greetings).toContain(s.line);
  });

  it("during QUIET HOURS suppresses grounded items entirely, greeting only", () => {
    const s = selectCompanionLine({
      candidates: [cand("reminder:r1"), cand("task:t1")],
      greetings,
      quiet: true,
      recent: [],
      rotation: 0,
      vetoed: noVeto
    });
    expect(s.grounded).toBe(false);
    expect(greetings).toContain(s.line);
  });

  it("rotates greetings and avoids immediately repeating the last greeting", () => {
    // greeting:0 just shown → next call must pick a different greeting slot.
    const s = selectCompanionLine({
      candidates: [],
      greetings,
      quiet: false,
      recent: ["greeting:0"],
      rotation: 0,
      vetoed: noVeto
    });
    expect(s.grounded).toBe(false);
    expect(s.key).not.toBe("greeting:0");
  });
});

describe("phraseCandidate — deterministic, honest phrasing from real fields", () => {
  it("interpolates the real event title + time (ko + en)", () => {
    expect(phraseCandidate("event", { time: "14:30", title: "Q3 sync" }, "en", 0)).toContain("Q3 sync");
    expect(phraseCandidate("event", { time: "14:30", title: "Q3 sync" }, "en", 0)).toContain("14:30");
    expect(phraseCandidate("event", { time: "14:30", title: "회의" }, "ko", 0)).toContain("회의");
  });

  it("varies the phrasing template as rotation advances", () => {
    const a = phraseCandidate("task", { overdue: 0, title: "Pay rent" }, "en", 0);
    const b = phraseCandidate("task", { overdue: 0, title: "Pay rent" }, "en", 1);
    expect(a).not.toBe(b);
    expect(a).toContain("Pay rent");
    expect(b).toContain("Pay rent");
  });

  it("distinguishes overdue from upcoming without inventing anything", () => {
    expect(phraseCandidate("reminder", { overdue: 1, text: "call mom" }, "en", 0).toLowerCase()).toContain("overdue");
    expect(phraseCandidate("reminder", { overdue: 0, text: "call mom" }, "en", 0).toLowerCase()).not.toContain("overdue");
  });

  it("phrases a birthday only from the given name + day count", () => {
    expect(phraseCandidate("birthday", { days: 0, name: "Sarah" }, "en", 0)).toContain("Sarah");
    expect(phraseCandidate("birthday", { days: 3, name: "Sarah" }, "en", 0)).toContain("3 days");
  });

  it("truncates an overlong field so the line fits the bubble", () => {
    const long = "x".repeat(200);
    const line = phraseCandidate("note", { title: long }, "en", 0);
    expect(line.length).toBeLessThan(80);
    expect(line).toContain("…");
  });
});

describe("timeGreeting / buildGreetings — content-free, asserts nothing", () => {
  it("buckets by hour and localizes", () => {
    expect(timeGreeting("en", 8)).toBe("Good morning ☀️");
    expect(timeGreeting("en", 14)).toContain("afternoon");
    expect(timeGreeting("en", 20)).toContain("evening");
    expect(timeGreeting("ko", 8)).toContain("아침");
  });

  it("greeting pool leads with the time greeting and never mentions a data fact", () => {
    const greetings = buildGreetings("en", 8);
    expect(greetings[0]).toBe("Good morning ☀️");
    expect(greetings.length).toBeGreaterThan(3);
    for (const g of greetings) {
      expect(g).not.toMatch(/\d/u); // no counts / times / dates in a content-free greeting
    }
  });
});

describe("gatherCompanionCandidates — grounded extraction + fabrication guard", () => {
  let dir: string;
  const now = new Date("2026-07-08T09:00:00Z");

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const seededEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv => ({
    MUSE_NOTES_DIR: join(dir, "empty-notes"),
    ...overrides
  });

  it("extracts a due reminder as a grounded candidate whose line comes from the store", async () => {
    dir = await mkdtemp(join(tmpdir(), "companion-"));
    const remindersFile = join(dir, "reminders.json");
    await writeReminders(remindersFile, [
      { createdAt: now.toISOString(), dueAt: new Date(now.getTime() + 3_600_000).toISOString(), id: "rem-1", status: "pending", text: "submit the Q3 memo" }
    ]);
    const candidates = await gatherCompanionCandidates(
      seededEnv({ MUSE_REMINDERS_FILE: remindersFile }),
      now,
      "en",
      0
    );
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const reminder = candidates.find((c) => c.key === "reminder:rem-1");
    expect(reminder).toBeDefined();
    expect(reminder!.line).toContain("submit the Q3 memo");
  });

  it("FABRICATION GUARD: empty stores yield ZERO candidates — nothing to invent", async () => {
    dir = await mkdtemp(join(tmpdir(), "companion-empty-"));
    const candidates = await gatherCompanionCandidates(
      seededEnv({
        MUSE_CALENDAR_FILE: join(dir, "no-calendar.json"),
        MUSE_CHECKINS_FILE: join(dir, "no-checkins.json"),
        MUSE_CONTACTS_FILE: join(dir, "no-contacts.json"),
        MUSE_FOLLOWUPS_FILE: join(dir, "no-followups.json"),
        MUSE_REMINDERS_FILE: join(dir, "no-reminders.json"),
        MUSE_TASKS_FILE: join(dir, "no-tasks.json")
      }),
      now,
      "en",
      0
    );
    expect(candidates).toEqual([]);

    // …and with no candidates, the opener is a content-free greeting (grounded:false),
    // never an invented event/count.
    const s = selectCompanionLine({
      candidates,
      greetings: buildGreetings("en", now.getHours()),
      quiet: false,
      recent: [],
      rotation: 0,
      vetoed: new Set<string>()
    });
    expect(s.grounded).toBe(false);
    expect(s.line).not.toMatch(/\d/u);
  });

  it("does not surface a task whose due date is far in the future", async () => {
    dir = await mkdtemp(join(tmpdir(), "companion-task-"));
    const tasksFile = join(dir, "tasks.json");
    const far = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    await writeFile(tasksFile, JSON.stringify({ tasks: [{ dueAt: far, id: "t-far", status: "open", title: "distant task" }] }), "utf8");
    const candidates = await gatherCompanionCandidates(
      seededEnv({ MUSE_TASKS_FILE: tasksFile }),
      now,
      "en",
      0
    );
    expect(candidates.find((c) => c.key === "task:t-far")).toBeUndefined();
  });
});
