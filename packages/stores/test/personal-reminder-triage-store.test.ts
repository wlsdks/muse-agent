import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  confirmReminderTriage,
  previewReminderTriage,
  readReminderTriageLedgerStrict,
  ReminderTriageStoreError
} from "../src/personal-reminder-triage-store.js";
import { readRemindersStrict, writeReminders, type PersistedReminder } from "../src/personal-reminders-store.js";

const BASE = new Date("2026-07-22T00:00:00.000Z");

function reminder(id: string, overrides: Partial<PersistedReminder> = {}): PersistedReminder {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    dueAt: "2026-07-01T00:00:00.000Z",
    id,
    status: "pending",
    text: `text ${id}`,
    ...overrides
  };
}

async function fixture(items: readonly PersistedReminder[] = [reminder("rem_a"), reminder("rem_b")]) {
  const dir = await mkdtemp(join(tmpdir(), "muse-rem-triage-"));
  const remindersFile = join(dir, "reminders.json");
  const ledgerFile = join(dir, "reminder-triage.json");
  await writeReminders(remindersFile, items);
  return { dir, ledgerFile, remindersFile };
}

describe("reminder backlog triage transaction", () => {
  it("persists an owner-only preview authorization without changing reminders or leaking the bearer secret", async () => {
    const f = await fixture();
    const before = await readFile(f.remindersFile, "utf8");
    const preview = await previewReminderTriage({
      action: "dismiss", ids: ["rem_b", "rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE
    });

    expect(preview.items.map((item) => item.id)).toEqual(["rem_a", "rem_b"]);
    expect(await readFile(f.remindersFile, "utf8")).toBe(before);
    const ledgerRaw = await readFile(f.ledgerFile, "utf8");
    expect(ledgerRaw).not.toContain(preview.confirmToken);
    expect(ledgerRaw).not.toContain(preview.confirmToken.split("_").at(-1));
    expect((await stat(f.ledgerFile)).mode & 0o777).toBe(0o600);
    expect((await readReminderTriageLedgerStrict(f.ledgerFile)).events).toHaveLength(1);
  });

  it("applies a bounded dismiss atomically and replays the same terminal result without writes", async () => {
    const f = await fixture();
    const preview = await previewReminderTriage({ action: "dismiss", ids: ["rem_a", "rem_b"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE });
    const result = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => BASE });
    const ledgerAfter = await readFile(f.ledgerFile, "utf8");
    const remindersAfter = await readFile(f.remindersFile, "utf8");

    expect(result).toMatchObject({ action: "dismiss", outcome: "applied", status: "applied" });
    expect(await readRemindersStrict(f.remindersFile)).toEqual([]);
    expect(await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => new Date("2026-07-23T00:00:00Z") })).toEqual(result);
    expect(await readFile(f.ledgerFile, "utf8")).toBe(ledgerAfter);
    expect(await readFile(f.remindersFile, "utf8")).toBe(remindersAfter);
    expect((await readReminderTriageLedgerStrict(f.ledgerFile)).events.map((event) => event.type)).toEqual(["previewed", "prepared", "terminal"]);
  });

  it("recovers after reminder rename but before terminal append, even after token expiry", async () => {
    const f = await fixture([reminder("rem_a")]);
    const preview = await previewReminderTriage({ action: "dismiss", ids: ["rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE });
    await expect(confirmReminderTriage({
      failpoint: (point) => { if (point === "after-reminders") throw new Error("crash"); },
      ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => BASE
    })).rejects.toThrow("crash");

    const recovered = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => new Date("2026-07-23T00:00:00Z") });
    expect(recovered).toMatchObject({ outcome: "recovered-post-image", status: "applied" });
    expect((await readReminderTriageLedgerStrict(f.ledgerFile)).events.map((event) => event.type)).toEqual(["previewed", "prepared", "terminal"]);
  });

  it("consumes a now-past snooze as a non-mutating terminal conflict", async () => {
    const f = await fixture([reminder("rem_a")]);
    const before = await readFile(f.remindersFile, "utf8");
    const preview = await previewReminderTriage({
      action: "snooze", ids: ["rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile,
      now: () => BASE, snoozeAt: "2026-07-22T00:10:00.000Z"
    });
    const result = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => new Date("2026-07-22T00:10:00.000Z") });
    expect(result).toMatchObject({ outcome: "snooze-time-elapsed", status: "conflict" });
    expect(await readFile(f.remindersFile, "utf8")).toBe(before);
    expect((await readReminderTriageLedgerStrict(f.ledgerFile)).events.map((event) => event.type)).toEqual(["previewed", "terminal"]);
  });

  it("records snapshot drift without applying any part of the batch", async () => {
    const f = await fixture();
    const preview = await previewReminderTriage({ action: "dismiss", ids: ["rem_a", "rem_b"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE });
    await writeReminders(f.remindersFile, [reminder("rem_a"), reminder("rem_b", { text: "changed elsewhere" })]);
    const drifted = await readFile(f.remindersFile, "utf8");
    const result = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => BASE });
    expect(result).toMatchObject({ outcome: "snapshot-drift", status: "conflict" });
    expect(await readFile(f.remindersFile, "utf8")).toBe(drifted);
  });

  it("snoozes a plain batch to the exact supplied instant and retain leaves reminder bytes unchanged", async () => {
    const f = await fixture();
    const snooze = await previewReminderTriage({
      action: "snooze", ids: ["rem_b", "rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile,
      now: () => BASE, snoozeAt: "2026-07-23T09:30:00+09:00"
    });
    const snoozed = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: snooze.confirmToken, now: () => BASE });
    expect(snoozed).toMatchObject({ action: "snooze", outcome: "applied", status: "applied" });
    expect((await readRemindersStrict(f.remindersFile)).map((item) => item.dueAt)).toEqual(["2026-07-23T00:30:00.000Z", "2026-07-23T00:30:00.000Z"]);

    const retainBefore = await readFile(f.remindersFile, "utf8");
    const retain = await previewReminderTriage({ action: "retain", ids: ["rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => new Date("2026-07-24T00:00:00Z") });
    const retained = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: retain.confirmToken, now: () => new Date("2026-07-24T00:00:00Z") });
    expect(retained).toMatchObject({ action: "retain", outcome: "applied" });
    expect(await readFile(f.remindersFile, "utf8")).toBe(retainBefore);
  });

  it("records indeterminate recovery if a prepared transaction is superseded before retry", async () => {
    const f = await fixture([reminder("rem_a")]);
    const preview = await previewReminderTriage({ action: "dismiss", ids: ["rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE });
    await expect(confirmReminderTriage({
      failpoint: (point) => { if (point === "after-prepared") throw new Error("crash-after-prepare"); },
      ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => BASE
    })).rejects.toThrow("crash-after-prepare");
    await writeReminders(f.remindersFile, [reminder("rem_a", { text: "changed after prepare" })]);

    const result = await confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => new Date("2026-07-23T00:00:00Z") });
    expect(result).toMatchObject({ outcome: "indeterminate-after-preparation", status: "conflict" });
    expect((await readRemindersStrict(f.remindersFile))[0]!.text).toBe("changed after prepare");
  });

  it("rejects expired unused tokens, forged tokens, and malformed ledgers without reminder mutation", async () => {
    const f = await fixture([reminder("rem_a")]);
    const preview = await previewReminderTriage({ action: "retain", ids: ["rem_a"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE });
    const before = await readFile(f.remindersFile, "utf8");
    await expect(confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: `${preview.confirmToken.slice(0, -1)}A`, now: () => BASE })).rejects.toThrow("invalid reminder triage token");
    await expect(confirmReminderTriage({ ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, token: preview.confirmToken, now: () => new Date("2026-07-22T00:15:00.001Z") })).rejects.toThrow("expired");
    expect(await readFile(f.remindersFile, "utf8")).toBe(before);

    const tampered = JSON.parse(await readFile(f.ledgerFile, "utf8")) as { events: Array<{ items: Array<{ text: string }> }> };
    tampered.events[0]!.items[0]!.text = "tampered";
    await writeFile(f.ledgerFile, JSON.stringify(tampered), { mode: 0o600 });
    await expect(readReminderTriageLedgerStrict(f.ledgerFile)).rejects.toThrow("hash chain");

    await writeFile(f.ledgerFile, "{bad", { mode: 0o600 });
    await expect(readReminderTriageLedgerStrict(f.ledgerFile)).rejects.toBeInstanceOf(ReminderTriageStoreError);
    expect(await readFile(f.remindersFile, "utf8")).toBe(before);
  });

  it("fails preview before ledger creation for future/fired/linked batch and size violations", async () => {
    const f = await fixture([
      reminder("rem_linked", { eventId: "event_1" }),
      reminder("rem_plain"),
      reminder("rem_future", { dueAt: "2026-07-23T00:00:00.000Z" }),
      reminder("rem_fired", { status: "fired" })
    ]);
    await expect(previewReminderTriage({ action: "dismiss", ids: ["rem_linked", "rem_plain"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE })).rejects.toThrow("single-item");
    await expect(previewReminderTriage({ action: "retain", ids: ["rem_future"], ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE })).rejects.toThrow("not pending and due");
    await expect(previewReminderTriage({ action: "retain", ids: Array.from({ length: 21 }, (_, i) => `rem_${i.toString()}`), ledgerFile: f.ledgerFile, remindersFile: f.remindersFile, now: () => BASE })).rejects.toThrow("1 to 20");
    await expect(readFile(f.ledgerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
