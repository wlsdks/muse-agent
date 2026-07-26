import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FollowupStoreUnavailableError,
  previewFollowupTriage
} from "../src/index.js";
import { writeFollowups, type PersistedFollowup } from "../src/personal-followups-store.js";

const BASE = new Date("2026-07-22T00:00:00.000Z");

function followup(id: string, overrides: Partial<PersistedFollowup> = {}): PersistedFollowup {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    scheduledFor: "2026-07-01T00:00:00.000Z",
    status: "scheduled",
    summary: `summary ${id}`,
    userId: "owner",
    ...overrides
  };
}

async function fixture(items: readonly PersistedFollowup[] = [followup("fu_a"), followup("fu_b")]) {
  const dir = await mkdtemp(join(tmpdir(), "muse-followup-triage-"));
  const file = join(dir, "followups.json");
  await writeFollowups(file, items);
  return { dir, file };
}

describe("follow-up backlog triage preview", () => {
  it("projects exact retain, dismiss, snooze, and draft-digest after-images without changing source bytes", async () => {
    const f = await fixture([
      followup("fu_b", { scheduledFor: "2026-07-02T00:00:00.000Z", summary: "line one\nline two" }),
      followup("fu_a")
    ]);
    const before = await readFile(f.file, "utf8");

    const retained = await previewFollowupTriage({
      action: "retain", followupsFile: f.file, ids: ["fu_b", "fu_a"], now: () => BASE
    });
    expect(retained.items.map((item) => item.id)).toEqual(["fu_a", "fu_b"]);
    expect(retained.changes).toEqual(retained.items.map((beforeItem) => ({ after: beforeItem, before: beforeItem })));

    const dismissed = await previewFollowupTriage({
      action: "dismiss", followupsFile: f.file, ids: ["fu_a"], now: () => BASE
    });
    expect(dismissed.changes[0]).toEqual({
      after: { ...dismissed.items[0], cancelReason: "backlog-triage-dismissed", status: "cancelled" },
      before: dismissed.items[0]
    });

    const snoozed = await previewFollowupTriage({
      action: "snooze",
      followupsFile: f.file,
      ids: ["fu_a"],
      now: () => BASE,
      snoozeAt: "2026-07-23T09:30:00+09:00"
    });
    expect(snoozed.changes[0]?.after.scheduledFor).toBe("2026-07-23T00:30:00.000Z");

    const drafted = await previewFollowupTriage({
      action: "draft-digest", followupsFile: f.file, ids: ["fu_b"], now: () => BASE
    });
    expect(drafted.changes[0]?.after).toEqual(drafted.changes[0]?.before);
    expect(drafted.digestDraft).toContain("line one line two");
    expect(await readFile(f.file, "utf8")).toBe(before);
  });

  it("binds the preview to the exact source bytes and accepts deterministic batches of 1 and 20", async () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      followup(`fu_${index.toString().padStart(2, "0")}`, {
        scheduledFor: new Date(Date.parse("2026-07-01T00:00:00.000Z") + (19 - index) * 1_000).toISOString()
      })
    );
    const f = await fixture(items);
    const raw = await readFile(f.file, "utf8");
    const one = await previewFollowupTriage({
      action: "retain", followupsFile: f.file, ids: ["fu_00"], now: () => BASE
    });
    expect(one.items).toHaveLength(1);
    expect(one).not.toHaveProperty("operationId");
    expect(one.sourceDigest).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));

    const twenty = await previewFollowupTriage({
      action: "retain", followupsFile: f.file, ids: items.map((item) => item.id), now: () => BASE
    });
    expect(twenty.items).toHaveLength(20);
    expect(twenty.items.map((item) => item.scheduledFor)).toEqual(
      [...items].sort((left, right) => Date.parse(left.scheduledFor) - Date.parse(right.scheduledFor))
        .map((item) => item.scheduledFor)
    );
  });

  it("fails the entire batch before any write for missing, future, fired, cancelled, duplicate, and oversized selections", async () => {
    const f = await fixture([
      followup("due"),
      followup("future", { scheduledFor: "2026-08-01T00:00:00.000Z" }),
      followup("fired", { firedAt: "2026-07-01T00:01:00.000Z", status: "fired" }),
      followup("cancelled", { cancelReason: "user-cancelled", status: "cancelled" }),
      ...Array.from({ length: 21 }, (_, index) => followup(`many_${index.toString()}`))
    ]);
    const before = await readFile(f.file, "utf8");
    const directoryBefore = await readdir(f.dir);
    const invalidIds = [["due", "missing"], ["due", "future"], ["due", "fired"], ["due", "cancelled"], ["due", "due"]];
    for (const ids of invalidIds) {
      await expect(previewFollowupTriage({
        action: "dismiss", followupsFile: f.file, ids, now: () => BASE
      })).rejects.toThrow();
    }
    await expect(previewFollowupTriage({
      action: "retain",
      followupsFile: f.file,
      ids: Array.from({ length: 21 }, (_, index) => `many_${index.toString()}`),
      now: () => BASE
    })).rejects.toThrow("1 to 20");
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect(await readdir(f.dir)).toEqual(directoryBefore);
  });

  it("requires an exact future snooze instant and rejects snooze input for every other action", async () => {
    const f = await fixture([followup("due")]);
    await expect(previewFollowupTriage({
      action: "snooze", followupsFile: f.file, ids: ["due"], now: () => BASE
    })).rejects.toThrow("required");
    await expect(previewFollowupTriage({
      action: "snooze", followupsFile: f.file, ids: ["due"], now: () => BASE, snoozeAt: BASE.toISOString()
    })).rejects.toThrow("future");
    await expect(previewFollowupTriage({
      action: "snooze", followupsFile: f.file, ids: ["due"], now: () => BASE, snoozeAt: "January 1, 2099"
    })).rejects.toThrow("ISO-8601");
    await expect(previewFollowupTriage({
      action: "snooze", followupsFile: f.file, ids: ["due"], now: () => BASE, snoozeAt: "2099-02-31T00:00:00Z"
    })).rejects.toThrow("ISO-8601");
    await expect(previewFollowupTriage({
      action: "retain", followupsFile: f.file, ids: ["due"], now: () => BASE, snoozeAt: "2026-07-23T00:00:00.000Z"
    })).rejects.toThrow("only valid");
    await expect(previewFollowupTriage({
      action: "bogus" as never, followupsFile: f.file, ids: ["due"], now: () => BASE
    })).rejects.toThrow("action must be");
  });

  it.each([
    ["bad JSON", "{"],
    ["bad root", JSON.stringify({ followups: "not-an-array" })],
    ["unknown root field", JSON.stringify({ followups: [], version: 1 })],
    ["unknown item field", JSON.stringify({ followups: [{ ...followup("due"), surprise: true }] })],
    ["bad timestamp", JSON.stringify({ followups: [followup("due", { scheduledFor: "not-a-date" })] })],
    ["non-canonical timestamp", JSON.stringify({ followups: [followup("due", { scheduledFor: "2026-07-01T00:00:00Z" })] })],
    ["scheduled with firedAt", JSON.stringify({ followups: [followup("due", { firedAt: "2026-07-01T00:01:00.000Z" })] })],
    ["scheduled with cancelReason", JSON.stringify({ followups: [followup("due", { cancelReason: "stale" })] })],
    ["fired without firedAt", JSON.stringify({ followups: [followup("due", { status: "fired" })] })],
    ["cancelled without reason", JSON.stringify({ followups: [followup("due", { status: "cancelled" })] })],
    ["duplicate stored id", JSON.stringify({ followups: [followup("due"), followup("due")] })]
  ])("fails closed on %s without quarantine, repair, or rewrite", async (_name, raw) => {
    const dir = await mkdtemp(join(tmpdir(), "muse-followup-triage-invalid-"));
    const file = join(dir, "followups.json");
    await writeFile(file, raw, "utf8");
    const directoryBefore = await readdir(dir);
    await expect(previewFollowupTriage({
      action: "retain", followupsFile: file, ids: ["due"], now: () => BASE
    })).rejects.toBeInstanceOf(FollowupStoreUnavailableError);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readdir(dir)).toEqual(directoryBefore);
  });
});
