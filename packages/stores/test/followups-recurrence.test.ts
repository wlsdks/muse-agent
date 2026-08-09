import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  advanceFollowupOccurrence,
  cancelFollowup,
  parseFollowupsStrict,
  readFollowups,
  readFollowupsStrict,
  snoozeFollowup,
  upsertFollowup,
  type PersistedFollowup
} from "../src/personal-followups-store.js";

const local = (year: number, month: number, day: number, hour: number, minute = 0, second = 0): string =>
  new Date(year, month - 1, day, hour, minute, second, 0).toISOString();

const recurrence = { kind: "daily" as const, hour: 8, minute: 0 };

function entry(id: string, overrides: Partial<PersistedFollowup> = {}): PersistedFollowup {
  return {
    createdAt: "2026-05-01T00:00:00.000Z",
    id,
    scheduledFor: local(2026, 5, 1, 8),
    status: "scheduled",
    summary: "Check Q3 memo",
    userId: "u",
    ...overrides
  };
}

function file(): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(join(tmpdir(), "muse-followup-recurrence-"));
  return { dir, path: join(dir, "followups.json") };
}

describe("followup recurrence store identity and lifecycle", () => {
  it("returns created/already-present/upgraded and keeps different summaries separate", async () => {
    const target = file();
    try {
      const oneShot = await upsertFollowup(target.path, entry("one", {
        scheduledFor: local(2026, 5, 1, 8, 0, 59)
      }));
      expect(oneShot.operation).toBe("created");

      const upgraded = await upsertFollowup(target.path, entry("recurring", {
        recurrence,
        scheduledFor: local(2026, 5, 1, 8)
      }));
      expect(upgraded.operation).toBe("upgraded");
      expect(upgraded.followup).toMatchObject({ id: "one", recurrence });

      const reused = await upsertFollowup(target.path, entry("another-id", {
        recurrence,
        summary: " check q3 memo! "
      }));
      expect(reused.operation).toBe("already-present");
      expect(reused.followup?.id).toBe("one");

      const separate = await upsertFollowup(target.path, entry("different", {
        recurrence,
        summary: "Check Q4 memo"
      }));
      expect(separate.operation).toBe("created");
      expect((await readFollowups(target.path)).map((followup) => followup.id).sort()).toEqual(["different", "one"]);
    } finally {
      rmSync(target.dir, { force: true, recursive: true });
    }
  });

  it("advances recurring occurrences with a locked expected-time CAS and fires one-shots", async () => {
    const target = file();
    try {
      const scheduledFor = local(2026, 5, 4, 8);
      await upsertFollowup(target.path, entry("recurring", { recurrence, scheduledFor }));
      const advanced = await advanceFollowupOccurrence(target.path, "recurring", scheduledFor, local(2026, 5, 4, 8, 1));
      expect(advanced.operation).toBe("advanced");
      expect(advanced.followup).toMatchObject({
        lastFiredAt: local(2026, 5, 4, 8, 1),
        scheduledFor: local(2026, 5, 5, 8),
        status: "scheduled"
      });

      const stale = await advanceFollowupOccurrence(target.path, "recurring", scheduledFor, local(2026, 5, 4, 8, 2));
      expect(stale.operation).toBe("preserved");
      expect((await readFollowups(target.path))[0]?.scheduledFor).toBe(local(2026, 5, 5, 8));

      await upsertFollowup(target.path, entry("one-shot", { scheduledFor: local(2026, 5, 4, 9) }));
      const fired = await advanceFollowupOccurrence(target.path, "one-shot", local(2026, 5, 4, 9), local(2026, 5, 4, 9, 1));
      expect(fired.operation).toBe("fired");
      expect(fired.followup).toMatchObject({ firedAt: local(2026, 5, 4, 9, 1), status: "fired" });
    } finally {
      rmSync(target.dir, { force: true, recursive: true });
    }
  });

  it("preserves recurrence through snooze and cancellation, including a stale advance", async () => {
    const target = file();
    try {
      const scheduledFor = local(2026, 5, 4, 8);
      await upsertFollowup(target.path, entry("recurring", { recurrence, scheduledFor }));
      const snoozedFor = local(2026, 5, 6, 8);
      const snoozed = await snoozeFollowup(target.path, "recurring", snoozedFor);
      expect(snoozed).toMatchObject({ recurrence, scheduledFor: snoozedFor, status: "scheduled" });
      const cancelled = await cancelFollowup(target.path, "recurring", "user-cancelled");
      expect(cancelled).toMatchObject({ cancelReason: "user-cancelled", recurrence, status: "cancelled" });
      const stale = await advanceFollowupOccurrence(target.path, "recurring", snoozedFor, local(2026, 5, 6, 8, 1));
      expect(stale.operation).toBe("preserved");
      expect((await readFollowups(target.path))[0]).toMatchObject({ recurrence, status: "cancelled" });
    } finally {
      rmSync(target.dir, { force: true, recursive: true });
    }
  });

  it("fails closed on invalid new records and strict persisted recurrence/key data", async () => {
    const target = file();
    try {
      await expect(upsertFollowup(target.path, entry("bad-rule", {
        recurrence: { kind: "monthly", dayOfMonth: 32, hour: 8, minute: 0 } as never
      }))).rejects.toThrow("recurrence");
      await expect(upsertFollowup(target.path, entry("bad-time", { scheduledFor: "not-a-time" }))).rejects.toThrow("timestamp");
      await expect(upsertFollowup(target.path, entry("bad-key", { commitmentKey: "0".repeat(64) }))).rejects.toThrow("commitment key");
      expect(await readFollowups(target.path)).toEqual([]);

      const valid = await upsertFollowup(target.path, entry("valid", { recurrence }));
      expect(valid.operation).toBe("created");
      expect((await readFollowupsStrict(target.path))[0]).toMatchObject({ commitmentKey: expect.stringMatching(/^[0-9a-f]{64}$/u), recurrence });
      const malformed = JSON.stringify({ followups: [{ ...entry("malformed", { recurrence }), commitmentKey: "0".repeat(64) }] });
      expect(() => parseFollowupsStrict(malformed)).toThrow();
    } finally {
      rmSync(target.dir, { force: true, recursive: true });
    }
  });
});
