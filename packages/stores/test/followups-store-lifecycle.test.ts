import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cancelFollowup,
  markFollowupFired,
  readFollowupStatusFilter,
  readFollowups,
  serializeFollowup,
  upsertFollowup,
  writeFollowups,
  type PersistedFollowup
} from "../src/personal-followups-store.js";

const base = (id: string, status: PersistedFollowup["status"] = "scheduled"): PersistedFollowup => ({
  createdAt: "2026-06-01T00:00:00Z",
  id,
  scheduledFor: "2026-06-10T09:00:00Z",
  status,
  summary: `s-${id}`,
  userId: "u"
});

describe("personal-followups-store lifecycle (markFired / cancel / upsert)", () => {
  let file: string;
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "muse-fu-")); file = join(dir, "followups.json"); });
  afterEach(() => { rmSync(dir, { force: true, recursive: true }); });

  it("markFollowupFired flips a scheduled entry to fired with the firedAt stamp", async () => {
    await writeFollowups(file, [base("a")]);
    const patched = await markFollowupFired(file, "a", "2026-06-10T09:00:01Z");
    expect(patched).toMatchObject({ firedAt: "2026-06-10T09:00:01Z", id: "a", status: "fired" });
    expect((await readFollowups(file))[0]?.status).toBe("fired"); // persisted
  });

  it("markFollowupFired is a guarded no-op for a missing id OR an already-fired entry (never re-fires)", async () => {
    await writeFollowups(file, [base("b", "fired")]);
    expect(await markFollowupFired(file, "missing", "t")).toBeUndefined();
    expect(await markFollowupFired(file, "b", "t")).toBeUndefined(); // status !== scheduled
  });

  it("cancelFollowup flips a scheduled entry to cancelled, but not a fired one", async () => {
    await writeFollowups(file, [base("c"), base("d", "fired")]);
    const cancelled = await cancelFollowup(file, "c", "user-cancelled");
    expect(cancelled).toMatchObject({ cancelReason: "user-cancelled", status: "cancelled" });
    expect(await cancelFollowup(file, "d", "x")).toBeUndefined(); // already fired → no resurrection
  });

  it("upsertFollowup appends a new id and REPLACES an existing one (idempotent, no duplicate)", async () => {
    await upsertFollowup(file, base("e"));
    await upsertFollowup(file, { ...base("e"), summary: "updated" });
    await upsertFollowup(file, base("f"));
    const all = await readFollowups(file);
    expect(all.map((x) => x.id).sort()).toEqual(["e", "f"]);
    expect(all.find((x) => x.id === "e")?.summary).toBe("updated");
  });

  it("drops entries with malformed optional fields at the persisted boundary", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify({
      followups: [
        base("valid"),
        { ...base("bad-kind"), kind: 7 },
        { ...base("bad-reason"), cancelReason: false }
      ]
    }));
    expect((await readFollowups(file)).map((entry) => entry.id)).toEqual(["valid"]);
  });
});

describe("readFollowupStatusFilter", () => {
  it("passes through the valid filters and defaults everything else to 'scheduled'", () => {
    expect(readFollowupStatusFilter("fired")).toBe("fired");
    expect(readFollowupStatusFilter("cancelled")).toBe("cancelled");
    expect(readFollowupStatusFilter("all")).toBe("all");
    // "scheduled" is the default, and so is any unknown / undefined value.
    expect(readFollowupStatusFilter("scheduled")).toBe("scheduled");
    expect(readFollowupStatusFilter("bogus")).toBe("scheduled");
    expect(readFollowupStatusFilter(undefined)).toBe("scheduled");
  });
});

describe("serializeFollowup", () => {
  it("emits the six required fields and omits absent optionals", () => {
    expect(Object.keys(serializeFollowup(base("m"))).sort()).toEqual([
      "createdAt", "id", "scheduledFor", "status", "summary", "userId"
    ]);
  });

  it("includes each optional only when set", () => {
    const out = serializeFollowup({ ...base("n"), cancelReason: "x", firedAt: "t", kind: "relative-minutes", originRunId: "r", originTurnHash: "h" });
    expect(out).toMatchObject({ cancelReason: "x", firedAt: "t", kind: "relative-minutes", originRunId: "r", originTurnHash: "h" });
  });
});
