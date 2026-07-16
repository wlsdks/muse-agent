import { describe, expect, it } from "vitest";
import {
  InMemoryDebugReplayCaptureStore,
  createDebugReplayCaptureInsert,
  mapDebugReplayCaptureRow
} from "../src/debug-replay.js";

describe("InMemoryDebugReplayCaptureStore", () => {
  it("saves and retrieves a capture by id", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    const saved = await store.saveDebugReplayCapture({
      capturedAt: "2026-05-09T00:00:00.000Z",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      id: "capture-1",
      modelId: "provider/model",
      userPrompt: "fail this run"
    });

    expect(saved.id).toBe("capture-1");
    expect(await store.getDebugReplayCapture("capture-1")).toMatchObject({ id: "capture-1" });
  });

  it("lists captures up to the limit", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    await store.saveDebugReplayCapture({ id: "first", userPrompt: "a" });
    await store.saveDebugReplayCapture({ id: "second", userPrompt: "b" });

    const all = await store.listDebugReplayCaptures(10);
    expect(all).toHaveLength(2);

    const clamped = await store.listDebugReplayCaptures(1);
    expect(clamped).toHaveLength(1);
  });

  it("lists newest-first (DESC by capturedAt) to match the Kysely path's `ORDER BY captured_at DESC`", async () => {
    // Pre-fix in-memory returned Map insertion order (oldest first),
    // diverging from production Kysely. Tests relying on the in-memory
    // store therefore saw the wrong ordering vs `/api/admin/debug/replay`.
    const store = new InMemoryDebugReplayCaptureStore();
    // Insert in chronological order so insertion-order ≠ DESC order.
    await store.saveDebugReplayCapture({
      capturedAt: "2026-05-19T08:00:00.000Z",
      id: "oldest",
      userPrompt: "a"
    });
    await store.saveDebugReplayCapture({
      capturedAt: "2026-05-20T12:00:00.000Z",
      id: "middle",
      userPrompt: "b"
    });
    await store.saveDebugReplayCapture({
      capturedAt: "2026-05-21T09:00:00.000Z",
      id: "newest",
      userPrompt: "c"
    });

    const all = await store.listDebugReplayCaptures(10);
    expect(all.map((entry) => entry.id), "newest first across the full window").toEqual([
      "newest",
      "middle",
      "oldest"
    ]);

    // Limit honours the DESC order — clamped result is the newest N,
    // NOT the oldest N (the pre-fix Map-iteration bug).
    const top1 = await store.listDebugReplayCaptures(1);
    expect(top1.map((entry) => entry.id), "limit=1 must return the NEWEST capture, not the oldest").toEqual(["newest"]);
  });

  it("two captures with the same capturedAt sort by id ASC (deterministic, stable across runs)", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    const sameInstant = "2026-05-21T09:00:00.000Z";
    // Insert in REVERSE id order so the result can prove the comparator
    // is sorting (not just preserving insertion order).
    await store.saveDebugReplayCapture({ capturedAt: sameInstant, id: "z-second", userPrompt: "z" });
    await store.saveDebugReplayCapture({ capturedAt: sameInstant, id: "a-first", userPrompt: "a" });

    const all = await store.listDebugReplayCaptures(10);
    expect(all.map((entry) => entry.id)).toEqual(["a-first", "z-second"]);
  });

  it("captures with no capturedAt sink below those with a valid timestamp; same-no-timestamp ties fall to id ASC", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    // The pre-fix in-memory store accepted records without `capturedAt`
    // (existing tests in this file do exactly that — line 25-26 just
    // save `{ id, userPrompt }`). The new comparator must keep them
    // listable, but rank them below any capture that has a real time.
    await store.saveDebugReplayCapture({ id: "z-no-time", userPrompt: "x" });
    await store.saveDebugReplayCapture({
      capturedAt: "2026-05-19T08:00:00.000Z",
      id: "real-time",
      userPrompt: "y"
    });
    await store.saveDebugReplayCapture({ id: "a-no-time", userPrompt: "x" });

    const all = await store.listDebugReplayCaptures(10);
    expect(all.map((entry) => entry.id)).toEqual(["real-time", "a-no-time", "z-no-time"]);
  });

  it("purgeExpired is inclusive at the boundary and never purges a capture without an expiry", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    const ref = new Date("2026-05-09T00:00:00.000Z");
    await store.saveDebugReplayCapture({ expiresAt: ref.toISOString(), id: "exactly-now", userPrompt: "x" }); // expiresAt == ref
    await store.saveDebugReplayCapture({ expiresAt: new Date(ref.getTime() + 1).toISOString(), id: "one-ms-later", userPrompt: "x" });
    await store.saveDebugReplayCapture({ id: "no-ttl", userPrompt: "x" }); // no expiresAt at all

    const purged = await store.purgeExpired(ref);
    expect(purged).toBe(1); // only the boundary record — the comparison is <=, not <
    expect(await store.getDebugReplayCapture("exactly-now")).toBeUndefined();
    expect(await store.getDebugReplayCapture("one-ms-later")).toMatchObject({ id: "one-ms-later" });
    expect(await store.getDebugReplayCapture("no-ttl")).toMatchObject({ id: "no-ttl" }); // a TTL-less capture is never reaped
  });

  it("listDebugReplayCaptures clamps a zero / negative limit to an empty result (Math.max(0, limit))", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    await store.saveDebugReplayCapture({ id: "a", userPrompt: "a" });
    expect(await store.listDebugReplayCaptures(0)).toEqual([]);
    expect(await store.listDebugReplayCaptures(-3)).toEqual([]);
  });

  it("purges expired captures and reports the count", async () => {
    const store = new InMemoryDebugReplayCaptureStore();
    await store.saveDebugReplayCapture({
      expiresAt: "2025-01-01T00:00:00.000Z",
      id: "stale",
      userPrompt: "expired"
    });
    await store.saveDebugReplayCapture({
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      id: "fresh",
      userPrompt: "fresh"
    });

    const purged = await store.purgeExpired(new Date("2026-05-09T00:00:00.000Z"));

    expect(purged).toBe(1);
    expect(await store.getDebugReplayCapture("stale")).toBeUndefined();
    expect(await store.getDebugReplayCapture("fresh")).toMatchObject({ id: "fresh" });
  });
});

describe("createDebugReplayCaptureInsert + mapDebugReplayCaptureRow", () => {
  it("round-trips a capture record through the insert + row mapper", () => {
    const insert = createDebugReplayCaptureInsert({
      capturedAt: "2026-05-09T00:00:00.000Z",
      errorCode: "RUN_FAILED",
      errorMessage: "boom",
      expiresAt: "2026-06-08T00:00:00.000Z",
      id: "capture-99",
      metadata: { hint: "synthetic" },
      modelId: "provider/model",
      toolsAttempted: ["read_file"],
      userHash: "user-hash",
      userPrompt: "say hi"
    });

    expect(insert).toMatchObject({
      error_code: "RUN_FAILED",
      error_message: "boom",
      id: "capture-99",
      model_id: "provider/model",
      tools_attempted: ["read_file"],
      user_hash: "user-hash",
      user_prompt: "say hi"
    });

    expect(mapDebugReplayCaptureRow(insert)).toMatchObject({
      capturedAt: "2026-05-09T00:00:00.000Z",
      errorCode: "RUN_FAILED",
      errorMessage: "boom",
      expiresAt: "2026-06-08T00:00:00.000Z",
      id: "capture-99",
      metadata: { hint: "synthetic" },
      modelId: "provider/model",
      toolsAttempted: ["read_file"],
      userHash: "user-hash",
      userPrompt: "say hi"
    });
  });

  it("drops non-finite values rather than serializing them as JSON null", () => {
    const insert = createDebugReplayCaptureInsert({
      capturedAt: "2026-05-09T00:00:00.000Z",
      metadata: { nested: { invalid: Number.POSITIVE_INFINITY } },
      toolsAttempted: ["read_file", Number.NaN, { invalid: Number.NEGATIVE_INFINITY }],
      userPrompt: "say hi"
    });

    expect(insert.metadata_json).toEqual({});
    expect(insert.tools_attempted).toEqual(["read_file"]);
  });

  it("a corrupt persisted timestamp degrades to a valid ISO, not a RangeError that 500s the list", () => {
    // One hand-edited / partially-written row must not throw out of
    // the mapper — that would crash GET /api/admin/debug/replay for
    // every capture, not just the bad one.
    const row = {
      captured_at: "not-a-date",
      error_code: "RUN_FAILED",
      error_message: "boom",
      expires_at: "",
      id: "capture-bad",
      metadata_json: "{}",
      model_id: "provider/model",
      tools_attempted: "[]",
      user_hash: "u",
      user_prompt: "hi"
    } as unknown as Parameters<typeof mapDebugReplayCaptureRow>[0];

    const mapped = mapDebugReplayCaptureRow(row) as { capturedAt: string; expiresAt: string; id: string };
    expect(mapped.id).toBe("capture-bad");
    // Both timestamps are now parseable ISO strings (not NaN / throw).
    expect(Number.isNaN(Date.parse(mapped.capturedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(mapped.expiresAt))).toBe(false);

    // A well-formed timestamp is still passed through unchanged.
    const ok = mapDebugReplayCaptureRow({
      ...row,
      captured_at: "2026-05-09T00:00:00.000Z"
    } as unknown as Parameters<typeof mapDebugReplayCaptureRow>[0]) as { capturedAt: string };
    expect(ok.capturedAt).toBe("2026-05-09T00:00:00.000Z");
  });
});
