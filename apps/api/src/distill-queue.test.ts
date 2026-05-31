import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enqueueLearnEvent, queryPlaybook, readPendingLearnEvents, type LearnCorrectionEvent } from "@muse/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { distillQueuedCorrections } from "./distill-queue.js";

let dir: string;
let queueFile: string;
let playbookFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-distillq-"));
  queueFile = join(dir, "learn-queue.jsonl");
  playbookFile = join(dir, "playbook.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ev = (id: string, correction: string): LearnCorrectionEvent => ({
  correction, enqueuedAtMs: 1000, id, priorAnswer: "I'd reschedule to Saturday.", request: "reschedule the dentist", userId: "u1"
});

// Fake distiller — deterministic, no model. Echoes a strategy unless the
// correction is the sentinel "(no lesson)".
const fakeDistill = async (exchange: { correction: string }): Promise<{ text: string; tag?: string } | undefined> =>
  exchange.correction.includes("(no lesson)") ? undefined : { tag: "scheduling", text: `learned: ${exchange.correction}` };

const deps = (over = {}): Parameters<typeof distillQueuedCorrections>[0] => ({
  distill: fakeDistill,
  model: "test",
  modelProvider: { generate: async () => ({}) } as never,
  newId: () => `pb_${Math.random().toString(36).slice(2)}`,
  playbookFile,
  queueFile,
  ...over
});

describe("distillQueuedCorrections — idle distill-consumer", () => {
  it("distills ONE queued correction into a playbook strategy and marks it done", async () => {
    await enqueueLearnEvent(queueFile, ev("a", "no — default to the next business day"));
    const recorded = await distillQueuedCorrections(deps());
    expect(recorded).toBe(1);
    const pb = await queryPlaybook(playbookFile, "u1");
    expect(pb).toHaveLength(1);
    expect(pb[0]?.text).toContain("next business day");
    expect(pb[0]?.tag).toBe("scheduling");
    expect(await readPendingLearnEvents(queueFile)).toEqual([]); // consumed
  });

  it("processes at most ONE per tick (the LLM call is the cost)", async () => {
    await enqueueLearnEvent(queueFile, ev("a", "lesson one"));
    await enqueueLearnEvent(queueFile, ev("b", "lesson two"));
    const recorded = await distillQueuedCorrections(deps());
    expect(recorded).toBe(1);
    // the second event remains pending for the next tick
    expect((await readPendingLearnEvents(queueFile)).map((e) => e.id)).toEqual(["b"]);
  });

  it("GROUNDING FENCE: an empty correction writes NO strategy (but is consumed)", async () => {
    await enqueueLearnEvent(queueFile, ev("a", "   "));
    const recorded = await distillQueuedCorrections(deps());
    expect(recorded).toBe(0);
    expect(await queryPlaybook(playbookFile, "u1")).toEqual([]);
    expect(await readPendingLearnEvents(queueFile)).toEqual([]); // still drained, just no write
  });

  it("a distiller that returns nothing writes NO strategy", async () => {
    await enqueueLearnEvent(queueFile, ev("a", "this has (no lesson) to learn"));
    const recorded = await distillQueuedCorrections(deps());
    expect(recorded).toBe(0);
    expect(await queryPlaybook(playbookFile, "u1")).toEqual([]);
  });

  it("empty queue → no-op (zero)", async () => {
    expect(await distillQueuedCorrections(deps())).toBe(0);
  });
});
