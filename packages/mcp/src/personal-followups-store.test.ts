import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cancelFollowup,
  markFollowupFired,
  readFollowups,
  readFollowupStatusFilter,
  resolveFollowupRef,
  serializeFollowup,
  upsertFollowup,
  writeFollowups,
  type PersistedFollowup
} from "@muse/stores";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-followups-"));
  return join(dir, "followups.json");
}

function fixture(overrides: Partial<PersistedFollowup> = {}): PersistedFollowup {
  return {
    createdAt: "2026-05-13T10:00:00.000Z",
    id: "fu_test_1",
    scheduledFor: "2026-05-13T10:30:00.000Z",
    status: "scheduled",
    summary: "check Q3 budget memo",
    userId: "stark",
    ...overrides
  };
}

describe("readFollowups", () => {
  it("returns [] when the file is missing", async () => {
    expect(await readFollowups("/nonexistent/path/followups.json")).toEqual([]);
  });

  it("returns [] when the JSON is invalid", async () => {
    const file = tmpFile();
    writeFileSync(file, "{not json", "utf8");
    expect(await readFollowups(file)).toEqual([]);
  });

  it("returns [] when the shape is wrong (missing followups array)", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ wrong: "shape" }), "utf8");
    expect(await readFollowups(file)).toEqual([]);
  });

  it("filters out malformed entries while keeping valid ones", async () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({
      followups: [
        fixture({ id: "fu_ok" }),
        { id: "fu_no_user", scheduledFor: "x", createdAt: "x", summary: "x", status: "scheduled" }, // missing userId
        fixture({ id: "fu_bad_status", status: "garbage" as never })
      ]
    }), "utf8");
    const out = await readFollowups(file);
    expect(out.map((f) => f.id)).toEqual(["fu_ok"]);
  });
});

describe("writeFollowups", () => {
  it("round-trips an array of followups through the on-disk shape", async () => {
    const file = tmpFile();
    const original = [fixture({ id: "fu_a" }), fixture({ id: "fu_b", summary: "second" })];
    await writeFollowups(file, original);
    const reloaded = await readFollowups(file);
    expect(reloaded).toHaveLength(2);
    expect(reloaded.map((f) => f.id).sort()).toEqual(["fu_a", "fu_b"]);
  });
});

describe("upsertFollowup", () => {
  it("appends a new id", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_1" }));
    await upsertFollowup(file, fixture({ id: "fu_2", summary: "second" }));
    const all = await readFollowups(file);
    expect(all.map((f) => f.id).sort()).toEqual(["fu_1", "fu_2"]);
  });

  it("replaces an existing id in place rather than duplicating", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_1", summary: "v1" }));
    await upsertFollowup(file, fixture({ id: "fu_1", summary: "v2" }));
    const all = await readFollowups(file);
    expect(all).toHaveLength(1);
    expect(all[0]?.summary).toBe("v2");
  });
});

describe("markFollowupFired", () => {
  it("flips status scheduled → fired and stamps firedAt", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_fire" }));
    const result = await markFollowupFired(file, "fu_fire", "2026-05-13T10:30:01.000Z");
    expect(result?.status).toBe("fired");
    expect(result?.firedAt).toBe("2026-05-13T10:30:01.000Z");
    const all = await readFollowups(file);
    expect(all[0]?.status).toBe("fired");
  });

  it("returns undefined when the id is not found", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_x" }));
    expect(await markFollowupFired(file, "fu_missing", "2026-05-13T10:30:01.000Z")).toBeUndefined();
  });

  it("returns undefined when the followup is already fired", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_done", firedAt: "x", status: "fired" }));
    expect(await markFollowupFired(file, "fu_done", "2026-05-13T10:30:01.000Z")).toBeUndefined();
  });
});

describe("cancelFollowup", () => {
  it("flips status scheduled → cancelled with the supplied reason", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_cancel" }));
    const result = await cancelFollowup(file, "fu_cancel", "user-cancelled");
    expect(result?.status).toBe("cancelled");
    expect(result?.cancelReason).toBe("user-cancelled");
  });

  it("returns undefined when the followup is already fired", async () => {
    const file = tmpFile();
    await upsertFollowup(file, fixture({ id: "fu_old", firedAt: "x", status: "fired" }));
    expect(await cancelFollowup(file, "fu_old", "snooze-replaced")).toBeUndefined();
  });
});

describe("serializeFollowup", () => {
  it("omits optional fields that are undefined", () => {
    const out = serializeFollowup(fixture()) as Record<string, unknown>;
    expect("firedAt" in out).toBe(false);
    expect("cancelReason" in out).toBe(false);
    expect("originRunId" in out).toBe(false);
    expect("kind" in out).toBe(false);
  });

  it("includes optional fields that are set", () => {
    const out = serializeFollowup(fixture({
      firedAt: "2026-05-13T10:30:01.000Z",
      kind: "relative-minutes",
      originRunId: "run_abc",
      originTurnHash: "sha256:deadbeef"
    })) as Record<string, unknown>;
    expect(out.firedAt).toBe("2026-05-13T10:30:01.000Z");
    expect(out.kind).toBe("relative-minutes");
    expect(out.originRunId).toBe("run_abc");
    expect(out.originTurnHash).toBe("sha256:deadbeef");
  });
});

describe("readFollowupStatusFilter", () => {
  it("defaults to 'scheduled' for unknown / undefined input", () => {
    expect(readFollowupStatusFilter(undefined)).toBe("scheduled");
    expect(readFollowupStatusFilter("nonsense")).toBe("scheduled");
  });

  it("passes the canonical statuses through", () => {
    expect(readFollowupStatusFilter("fired")).toBe("fired");
    expect(readFollowupStatusFilter("cancelled")).toBe("cancelled");
    expect(readFollowupStatusFilter("all")).toBe("all");
  });
});

// Concurrency (shared atomic-file helper migration): upsert / markFired /
// cancel / snooze are read-modify-write. A lost followup is a proactive nudge
// the user never receives; before the per-file mutation queue, two concurrent
// detect passes each read the same snapshot and clobbered one another.
describe("concurrent followup mutation", () => {
  it("preserves EVERY distinct followup upserted concurrently (no last-writer-wins loss)", async () => {
    const file = tmpFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => upsertFollowup(file, fixture({ id: `fu${i.toString()}` }))));
    const all = await readFollowups(file);
    expect(all).toHaveLength(20);
    expect(new Set(all.map((f) => f.id)).size).toBe(20);
  });

  it("applies every concurrent markFired on distinct scheduled followups (no crash, none dropped)", async () => {
    const file = tmpFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => upsertFollowup(file, fixture({ id: `fu${i.toString()}` }))));
    const fired = await Promise.all((await readFollowups(file)).map((f) => markFollowupFired(file, f.id, "2026-05-13T11:00:00.000Z")));
    expect(fired.filter(Boolean)).toHaveLength(20);
    expect((await readFollowups(file)).every((f) => f.status === "fired")).toBe(true);
  });
});

describe("resolveFollowupRef — one-shot cancel/snooze by id OR a word from the summary", () => {
  it("resolves an exact id", () => {
    const fs = [fixture({ id: "fu_a", summary: "check budget" }), fixture({ id: "fu_b", summary: "email Sam" })];
    const r = resolveFollowupRef(fs, "fu_b");
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" ? r.followup.id : "").toBe("fu_b");
  });

  it("resolves a distinct word from the summary — no prior list needed", () => {
    const fs = [fixture({ id: "fu_a", summary: "check Q3 budget memo" }), fixture({ id: "fu_b", summary: "email Sam back" })];
    const r = resolveFollowupRef(fs, "budget");
    expect(r.status === "resolved" ? r.followup.id : "").toBe("fu_a");
  });

  it("an ambiguous word returns candidates, never a guess", () => {
    const fs = [fixture({ id: "fu_a", summary: "call the dentist" }), fixture({ id: "fu_b", summary: "the dentist invoice" })];
    const r = resolveFollowupRef(fs, "dentist");
    expect(r.status).toBe("ambiguous");
    expect(r.status === "ambiguous" ? r.candidates.length : 0).toBe(2);
  });

  it("prefers a SCHEDULED match over a fired/cancelled one with the same word", () => {
    const fs = [fixture({ id: "fu_done", status: "fired", summary: "budget review" }), fixture({ id: "fu_live", status: "scheduled", summary: "budget review" })];
    const r = resolveFollowupRef(fs, "budget");
    expect(r.status === "resolved" ? r.followup.id : "").toBe("fu_live");
  });

  it("an unknown word → not-found (no action)", () => {
    expect(resolveFollowupRef([fixture()], "nonexistent").status).toBe("not-found");
  });

  it("an empty/whitespace ref → not-found", () => {
    expect(resolveFollowupRef([fixture()], "   ").status).toBe("not-found");
  });
});

describe("resolveFollowupRef — matches a ref LITERALLY, not as a regex (a destructive ref can't match-all)", () => {
  it("a regex-metacharacter ref ('.*') is a literal substring → matches NOTHING, not every followup", () => {
    const fs = [fixture({ id: "fu_a", summary: "check budget" }), fixture({ id: "fu_b", summary: "email Sam" })];
    // If matching were regex, '.*' would match BOTH summaries → ambiguous/wrong cancel
    // on a careless ref. Literal `.includes`: no summary contains the literal ".*" → not-found.
    expect(resolveFollowupRef(fs, ".*").status).toBe("not-found");
  });

  it("a single '.' ref does not match an arbitrary followup (regex-injection guard on a destructive resolver)", () => {
    const fs = [fixture({ id: "fu_a", summary: "review report" })];
    expect(resolveFollowupRef(fs, ".").status).toBe("not-found");
  });

  it("a literal parenthesized token resolves the followup that literally contains it", () => {
    const fs = [fixture({ id: "fu_q3", summary: "review (Q3) report" }), fixture({ id: "fu_other", summary: "plan ahead" })];
    const r = resolveFollowupRef(fs, "(Q3)");
    expect(r.status === "resolved" ? r.followup.id : "").toBe("fu_q3");
  });

  it("an unmatched long ref → not-found (no accidental resolve)", () => {
    expect(resolveFollowupRef([fixture()], "z".repeat(200)).status).toBe("not-found");
  });
});
