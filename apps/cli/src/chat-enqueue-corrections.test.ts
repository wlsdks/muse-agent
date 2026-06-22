import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPendingLearnEvents } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enqueueSessionCorrections } from "./chat-enqueue-corrections.js";

let dir: string;
let queueFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-enq-corr-"));
  queueFile = join(dir, "learn-queue.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A session boundary that opens at the first line, and turns with a correction.
const boundaries = async () => [{ tsIso: "2026-05-01T00:00:00.000Z", userId: "u1" }] as never;
const turnsWithCorrection = async () => [
  { role: "user", content: "summarise the meeting" },
  { role: "assistant", content: "Here's a long prose paragraph..." },
  { role: "user", content: "no, that's not what I meant — use bullet points, not prose" }
] as never;
const turnsNoCorrection = async () => [
  { role: "user", content: "what's the weather" },
  { role: "assistant", content: "I don't have weather data." }
] as never;

describe("enqueueSessionCorrections — chat producer for idle learning", () => {
  it("enqueues a detected correction onto the learn-queue", async () => {
    const res = await enqueueSessionCorrections({
      queueFile, userId: "u1", idFactory: () => "lq1", now: () => new Date(1000),
      readLines: turnsWithCorrection, readBoundaries: boundaries
    });
    expect(res.enqueued).toBe(1);
    const pending = await readPendingLearnEvents(queueFile);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.correction).toContain("bullet points");
    expect(pending[0]?.id).toBe("lq1");
    expect(pending[0]?.priorAnswer).toContain("prose paragraph");
    expect(pending[0]?.userId).toBe("u1");
  });

  it("enqueues nothing when the session has no correction", async () => {
    const res = await enqueueSessionCorrections({
      queueFile, userId: "u1", readLines: turnsNoCorrection, readBoundaries: boundaries
    });
    expect(res.enqueued).toBe(0);
    expect(await readPendingLearnEvents(queueFile)).toEqual([]);
  });

  it("fail-soft: a history-read error enqueues nothing (never throws at exit)", async () => {
    const res = await enqueueSessionCorrections({
      queueFile, userId: "u1",
      readLines: async () => { throw new Error("history gone"); }, readBoundaries: boundaries
    });
    expect(res.enqueued).toBe(0);
    expect(res.reason).toMatch(/history read failed/);
  });
});
