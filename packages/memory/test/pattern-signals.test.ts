import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aggregateActivitySignals } from "../src/pattern-signals.js";

function seedFile(file: string, contents: string): void {
  writeFileSync(file, contents, "utf8");
}

function setMtime(file: string, ms: number): void {
  const seconds = ms / 1000;
  utimesSync(file, seconds, seconds);
}

describe("aggregateActivitySignals", () => {
  it("returns an empty envelope when every source is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sig-empty-"));
    const result = await aggregateActivitySignals({
      activityFile: join(root, "missing-activity.jsonl"),
      notesDir: join(root, "missing-notes"),
      now: () => 1_700_000_000_000,
      tasksFile: join(root, "missing-tasks.json")
    });
    expect(result.activityEvents).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.noteEdits).toEqual([]);
    expect(result.capturedAtMs).toBe(1_700_000_000_000);
  });

  it("parses activity.jsonl line by line, skipping malformed rows + dropping pre-sinceMs entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sig-activity-"));
    const file = join(root, "activity.jsonl");
    seedFile(file, [
      JSON.stringify({ kind: "repl-start", tsIso: "2026-05-12T08:00:00Z", userId: "stark" }),
      "not-json",
      JSON.stringify({ kind: "chat-turn", tsIso: "2026-05-10T08:00:00Z", userId: "stark" }), // before sinceMs
      JSON.stringify({ tsIso: "2026-05-12T09:00:00Z", userId: "stark" }), // missing kind
      JSON.stringify({ kind: "chat-turn", tsIso: "2026-05-13T08:00:00Z", userId: "stark" }),
      "",
      JSON.stringify({ kind: "chat-turn", tsIso: "totally-invalid-iso", userId: "stark" })
    ].join("\n"), "utf8");

    const result = await aggregateActivitySignals({
      activityFile: file,
      notesDir: join(root, "no-notes"),
      sinceMs: Date.parse("2026-05-11T00:00:00Z"),
      tasksFile: join(root, "no-tasks.json")
    });
    expect(result.activityEvents.map((e) => e.tsIso)).toEqual([
      "2026-05-12T08:00:00Z",
      "2026-05-13T08:00:00Z"
    ]);
    expect(result.activityEvents[0]).toMatchObject({ kind: "repl-start", userId: "stark" });
  });

  it("parses tasks.json into TaskSignals, tolerating bad rows and missing optional fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sig-tasks-"));
    const file = join(root, "tasks.json");
    seedFile(file, JSON.stringify({
      tasks: [
        { id: "t1", title: "Open task", status: "open", createdAt: "2026-05-12T08:00:00Z" },
        { id: "t2", title: "Done task", status: "done", createdAt: "2026-05-11T08:00:00Z", completedAt: "2026-05-11T09:30:00Z", dueAt: "2026-05-11T10:00:00Z" },
        { id: "tbad", title: "Bad status", status: "exotic", createdAt: "2026-05-11T08:00:00Z" },
        { title: "No id", status: "open", createdAt: "2026-05-11T08:00:00Z" },
        "not even an object"
      ]
    }));

    const result = await aggregateActivitySignals({
      activityFile: join(root, "no-activity.jsonl"),
      notesDir: join(root, "no-notes"),
      tasksFile: file
    });
    expect(result.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(result.tasks[1]).toMatchObject({
      completedAtMs: Date.parse("2026-05-11T09:30:00Z"),
      dueAtMs: Date.parse("2026-05-11T10:00:00Z"),
      id: "t2",
      status: "done",
      title: "Done task"
    });
    expect(result.tasks[0]).toMatchObject({ id: "t1", status: "open" });
    expect(result.tasks[0]).not.toHaveProperty("completedAtMs");
  });

  it("walks the notes dir, captures pathFamily, skips hidden dirs + non-md files", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sig-notes-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    mkdirSync(join(notesDir, "journal"));
    mkdirSync(join(notesDir, "meetings"));
    mkdirSync(join(notesDir, ".obsidian")); // hidden — must be skipped

    seedFile(join(notesDir, "journal", "2026-05-12.md"), "j1");
    setMtime(join(notesDir, "journal", "2026-05-12.md"), Date.parse("2026-05-12T21:30:00Z"));

    seedFile(join(notesDir, "journal", "2026-05-13.md"), "j2");
    setMtime(join(notesDir, "journal", "2026-05-13.md"), Date.parse("2026-05-13T21:35:00Z"));

    seedFile(join(notesDir, "meetings", "standup.md"), "m1");
    setMtime(join(notesDir, "meetings", "standup.md"), Date.parse("2026-05-12T09:00:00Z"));

    seedFile(join(notesDir, "rootless.md"), "r1");
    setMtime(join(notesDir, "rootless.md"), Date.parse("2026-05-12T07:00:00Z"));

    seedFile(join(notesDir, "image.png"), "binary");
    seedFile(join(notesDir, ".obsidian", "workspace.json"), "settings");

    const result = await aggregateActivitySignals({
      activityFile: join(root, "no-activity.jsonl"),
      notesDir,
      tasksFile: join(root, "no-tasks.json")
    });

    expect(result.noteEdits).toHaveLength(4);
    // Newest first.
    expect(result.noteEdits.map((n) => n.absPath.endsWith("2026-05-13.md")).slice(0, 1)).toEqual([true]);

    const families = result.noteEdits.map((n) => n.pathFamily).sort();
    expect(families).toEqual(["", "journal", "journal", "meetings"]);

    // Hidden dir contents never appear.
    expect(result.noteEdits.every((n) => !n.absPath.includes(".obsidian"))).toBe(true);
  });
});
