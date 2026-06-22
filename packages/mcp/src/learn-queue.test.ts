import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enqueueLearnEvent,
  markLearnEventsDone,
  readPendingLearnEvents,
  resolveLearnQueueFile,
  type LearnCorrectionEvent
} from "@muse/stores";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-learnq-"));
  file = join(dir, "learn-queue.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ev = (id: string, correction: string): LearnCorrectionEvent => ({
  correction, enqueuedAtMs: 1000, id, priorAnswer: "I'd reschedule to Saturday.", userId: "u1"
});

describe("resolveLearnQueueFile", () => {
  it("honors MUSE_LEARN_QUEUE_FILE, else ~/.muse/learn-queue.jsonl", () => {
    expect(resolveLearnQueueFile({ MUSE_LEARN_QUEUE_FILE: "/tmp/q.jsonl" })).toBe("/tmp/q.jsonl");
    expect(resolveLearnQueueFile({})).toMatch(/[\\/]\.muse[\\/]learn-queue\.jsonl$/u);
  });
});

describe("learn-queue — append-only signal substrate", () => {
  it("missing file reads as empty (never crashes the consumer)", async () => {
    expect(await readPendingLearnEvents(file)).toEqual([]);
  });

  it("enqueues events oldest-first and reads them back", async () => {
    await enqueueLearnEvent(file, ev("a", "no — default to the next business day"));
    await enqueueLearnEvent(file, ev("b", "use bullet points, not prose"));
    const pending = await readPendingLearnEvents(file);
    expect(pending.map((e) => e.id)).toEqual(["a", "b"]);
    expect(pending[0]?.correction).toContain("business day");
  });

  it("markLearnEventsDone removes only the distilled events", async () => {
    await enqueueLearnEvent(file, ev("a", "x"));
    await enqueueLearnEvent(file, ev("b", "y"));
    await enqueueLearnEvent(file, ev("c", "z"));
    await markLearnEventsDone(file, ["a", "c"]);
    expect((await readPendingLearnEvents(file)).map((e) => e.id)).toEqual(["b"]);
  });

  it("skips a corrupt line, keeps the valid ones (fail-safe)", async () => {
    await enqueueLearnEvent(file, ev("a", "x"));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "{ this is not valid json\n", "utf8");
    await enqueueLearnEvent(file, ev("b", "y"));
    expect((await readPendingLearnEvents(file)).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("learn-queue — concurrent enqueue-vs-drain (lost-update safety)", () => {
  // The drain (markLearnEventsDone) is a read-modify-write that rewrites the
  // whole file; an enqueue (append) landing between its read and write would be
  // clobbered — a real user correction silently lost on the unattended path.
  // Both must serialize on the same per-file mutation queue.
  it("does not drop an event enqueued while a drain is in flight", async () => {
    await enqueueLearnEvent(file, ev("a", "x"));
    await enqueueLearnEvent(file, ev("b", "y"));
    const drain = markLearnEventsDone(file, ["a"]); // start the drain (reads {a,b})
    await enqueueLearnEvent(file, ev("c", "z"));     // append races the drain
    await drain;
    const ids = (await readPendingLearnEvents(file)).map((e) => e.id);
    expect(ids).toContain("c"); // the racing append survives (serialized RMW)
    expect(ids).not.toContain("a"); // the drained id is still gone
    expect(ids).toContain("b");
  });
});
