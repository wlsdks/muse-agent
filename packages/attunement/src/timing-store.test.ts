import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AttunementStoreError } from "./attunement-store.js";
import {
  evaluateTimingSession,
  forgetTimingSession,
  pauseTimingSession,
  readTimingState,
  recordTimingFeedback,
  recordTimingObservation,
  startTimingSession
} from "./timing-store.js";

function fixture(): { readonly file: string; readonly options: { readonly idFactory: () => string; readonly now: () => Date } } {
  let sequence = 0;
  return {
    file: join(mkdtempSync(join(tmpdir(), "muse-timing-")), "timing.json"),
    options: {
      idFactory: () => `id-${(++sequence).toString()}`,
      now: () => new Date("2026-07-15T09:00:00.000Z")
    }
  };
}

const knownThread = async (): Promise<void> => undefined;

describe("thread-scoped continuity timing store", () => {
  it("permits only one explicit active thread and rejects observations while paused", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    await expect(startTimingSession(file, { consentVersion: 1, threadId: "thread_life" }, knownThread, options)).rejects.toThrow("already active");
    await pauseTimingSession(file, session.id, options);
    await expect(recordTimingObservation(file, session.id, {
      appCategory: "building",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:25:00.000Z",
      startedAt: "2026-07-15T09:00:00.000Z"
    }, options)).rejects.toThrow("paused");
  });

  it("offers only at a stable category boundary and digests during the learned cooldown", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "building",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:25:00.000Z",
      startedAt: "2026-07-15T09:00:00.000Z"
    }, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "planning",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:50:00.000Z",
      startedAt: "2026-07-15T09:25:00.000Z"
    }, options);
    const first = await evaluateTimingSession(file, session.id, options);
    expect(first.decision).toBe("offer");

    await recordTimingFeedback(file, first.id, "ignored", options);
    await recordTimingObservation(file, session.id, {
      appCategory: "research",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T10:15:00.000Z",
      startedAt: "2026-07-15T09:50:00.000Z"
    }, options);
    const second = await evaluateTimingSession(file, session.id, options);
    expect(second.decision).toBe("digest");
    expect(second.reason).toBe("offer-cooldown-active");
  });

  it("forgets every receipt for a session", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_life" }, knownThread, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "writing",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:25:00.000Z",
      startedAt: "2026-07-15T09:00:00.000Z"
    }, options);
    await evaluateTimingSession(file, session.id, options);
    const deleted = await forgetTimingSession(file, session.id);
    expect(deleted).toEqual({ deletedCandidates: 1, deletedFeedback: 0, deletedObservations: 1 });
    expect(await readTimingState(file)).toEqual({ candidates: [], feedback: [], observations: [], schemaVersion: 1, sessions: [] });
  });

  it("fails closed when persisted state contains a raw desktop field", async () => {
    const { file } = fixture();
    await writeFile(file, JSON.stringify({
      candidates: [],
      feedback: [],
      observations: [{
        appCategory: "building",
        durationMs: 1,
        endedAt: "2026-07-15T09:00:01.000Z",
        id: "observation_1",
        sessionId: "timing_1",
        startedAt: "2026-07-15T09:00:00.000Z",
        threadId: "thread_work",
        windowTitle: "secret document"
      }],
      schemaVersion: 1,
      sessions: []
    }));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);
  });
});
