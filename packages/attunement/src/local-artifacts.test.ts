import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReminders, writeTasks, type PersistedReminder, type PersistedTask } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { createLocalArtifactValidator, createLocalExactArtifactResolver, type ArtifactLink } from "./index.js";

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-18T09:00:00.000Z",
  id: "task_local-parity",
  notes: "  Ask Jamie which flowers they prefer.\nThen send only the matching options.  ",
  status: "open",
  tags: ["birthday", "Jamie"],
  title: "Send the flower options"
};

const LINK: ArtifactLink = {
  artifactId: TASK.id,
  artifactType: "task",
  linkedAt: "2026-07-17T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "next-step",
  threadId: "thread_life"
};

const REMINDER: PersistedReminder = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-22T09:00:00.000Z",
  id: "reminder_dentist-visit",
  status: "pending",
  text: "  Bring the referral letter to the dentist  "
};

const REMINDER_LINK: ArtifactLink = {
  artifactId: REMINDER.id,
  artifactType: "reminder",
  linkedAt: "2026-07-17T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "context",
  threadId: "thread_life"
};

describe("createLocalExactArtifactResolver", () => {
  it("returns one canonical local task shape for every Continuity surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-local-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    await writeTasks(tasksFile, [TASK]);

    const resolve = createLocalExactArtifactResolver({ notesDir, tasksFile });

    await expect(resolve(LINK)).resolves.toEqual({
      artifactId: TASK.id,
      artifactType: "task",
      providerId: "local",
      role: "next-step",
      summary: "Ask Jamie which flowers they prefer. Then send only the matching options.",
      taskDueAt: TASK.dueAt,
      taskStatus: "open",
      taskTags: ["birthday", "Jamie"],
      title: TASK.title,
      updatedAt: TASK.createdAt
    });
  });

  it("resolves one exact reminder as bounded read-only context", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-reminder-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    const remindersFile = join(root, "reminders.json");
    await writeTasks(tasksFile, []);
    await writeReminders(remindersFile, [REMINDER]);
    const before = readFileSync(remindersFile);

    const resolve = createLocalExactArtifactResolver({ notesDir, remindersFile, tasksFile });
    await expect(resolve(REMINDER_LINK)).resolves.toEqual({
      artifactId: REMINDER.id,
      artifactType: "reminder",
      providerId: "local",
      reminderDueAt: REMINDER.dueAt,
      reminderStatus: "pending",
      role: "context",
      title: "Bring the referral letter to the dentist"
    });
    expect(readFileSync(remindersFile)).toEqual(before);
  });

  it("canonicalizes only an exact or unique reminder id prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-reminder-id-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    const remindersFile = join(root, "reminders.json");
    await writeTasks(tasksFile, []);
    await writeReminders(remindersFile, [REMINDER, { ...REMINDER, id: "reminder_departure" }]);
    const validate = createLocalArtifactValidator({ notesDir, remindersFile, tasksFile });

    await expect(validate({ artifactId: "reminder_dent", artifactType: "reminder", providerId: "local" }))
      .resolves.toEqual({ artifactId: REMINDER.id, artifactType: "reminder", providerId: "local" });
    await expect(validate({ artifactId: "reminder_d", artifactType: "reminder", providerId: "local" }))
      .rejects.toThrow("ambiguous");
    await expect(validate({ artifactId: "dentist", artifactType: "reminder", providerId: "local" }))
      .rejects.toThrow("no local reminder");
  });

  it("fails closed on malformed reminder bytes without quarantine or sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-reminder-corrupt-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    const remindersFile = join(root, "reminders.json");
    await writeTasks(tasksFile, []);
    writeFileSync(remindersFile, "{", "utf8");
    const before = readFileSync(remindersFile);
    const resolve = createLocalExactArtifactResolver({ notesDir, remindersFile, tasksFile });

    await expect(resolve(REMINDER_LINK)).rejects.toThrow("reminder store cannot be read or validated");
    expect(readFileSync(remindersFile)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(["notes", "reminders.json", "tasks.json"]);
  });

  it("fails closed on duplicate reminder ids instead of selecting the first row", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-reminder-duplicate-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    const remindersFile = join(root, "reminders.json");
    await writeTasks(tasksFile, []);
    writeFileSync(remindersFile, JSON.stringify({ reminders: [REMINDER, { ...REMINDER, text: "Conflicting duplicate" }] }), "utf8");
    const before = readFileSync(remindersFile);
    const validate = createLocalArtifactValidator({ notesDir, remindersFile, tasksFile });
    const resolve = createLocalExactArtifactResolver({ notesDir, remindersFile, tasksFile });

    await expect(validate({ artifactId: REMINDER.id, artifactType: "reminder", providerId: "local" }))
      .rejects.toThrow("reminder store cannot be read or validated");
    await expect(resolve(REMINDER_LINK)).rejects.toThrow("reminder store cannot be read or validated");
    expect(readFileSync(remindersFile)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(["notes", "reminders.json", "tasks.json"]);
  });

  it("distinguishes a missing exact reminder from an unavailable reminder store without writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-reminder-missing-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    const remindersFile = join(root, "reminders.json");
    await writeTasks(tasksFile, []);
    await writeReminders(remindersFile, [REMINDER]);
    const before = readFileSync(remindersFile);
    const resolve = createLocalExactArtifactResolver({ notesDir, remindersFile, tasksFile });

    await expect(resolve({ ...REMINDER_LINK, artifactId: "reminder_missing" })).resolves.toBeUndefined();
    expect(readFileSync(remindersFile)).toEqual(before);

    const unavailableFile = join(root, "unavailable-reminders.json");
    const unavailable = createLocalArtifactValidator({ notesDir, remindersFile: unavailableFile, tasksFile });
    await expect(unavailable({ artifactId: REMINDER.id, artifactType: "reminder", providerId: "local" }))
      .rejects.toThrow("reminder store cannot be read or validated");
    expect(existsSync(unavailableFile)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["notes", "reminders.json", "tasks.json"]);
  });
});
