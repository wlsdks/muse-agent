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
});
