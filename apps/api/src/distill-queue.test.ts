import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enqueueLearnEvent, queryPlaybook, readPendingLearnEvents, readSuppressedLessons, recordSuppressedLesson, setLearningPaused, type LearnCorrectionEvent } from "@muse/stores";
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
    expect(pb[0]?.probation).toBe(true); // unattended write enters probation (not injected until reinforced)
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

  describe("undo that teaches (B1 §5) — a suppressed correction is NOT re-learned", () => {
    it("skips (before distilling) a correction matching an undone lesson's source, bumps its blocked count; a different correction still distills", async () => {
      const suppressedLessonsFile = join(dir, "suppressed.json");
      // the user undid a lesson distilled FROM this correction (source = the signal)
      await recordSuppressedLesson(suppressedLessonsFile, {
        createdAt: "2026-06-01T00:00:00Z", id: "x1", text: "don't reschedule onto weekends",
        source: "stop rescheduling things to weekends", userId: "u1"
      });
      // re-enqueue the same SIGNAL (correction) → matched on source → blocked before the LLM call
      await enqueueLearnEvent(queueFile, ev("a", "stop rescheduling things to weekends"));
      const recorded = await distillQueuedCorrections(deps({ suppressedLessonsFile }));
      expect(recorded).toBe(0); // suppressed → not re-learned
      expect(await queryPlaybook(playbookFile, "u1")).toEqual([]);
      expect((await readSuppressedLessons(suppressedLessonsFile))[0]?.blockedCount).toBe(1); // veto counted the block

      // a DIFFERENT, unrelated correction is NOT blocked
      await enqueueLearnEvent(queueFile, ev("b", "always include a budget summary in expense reports"));
      const recorded2 = await distillQueuedCorrections(deps({ suppressedLessonsFile }));
      expect(recorded2).toBe(1);
      expect((await queryPlaybook(playbookFile, "u1")).map((s) => s.text)).toEqual(["learned: always include a budget summary in expense reports"]);
    });

    it("PAUSED ⇒ zero writes and the queue is left intact (resume catches up)", async () => {
      const pauseFile = join(dir, "paused.json");
      await setLearningPaused(pauseFile, true, "2026-06-01T00:00:00Z");
      await enqueueLearnEvent(queueFile, ev("a", "always answer in bullets"));
      expect(await distillQueuedCorrections(deps({ pauseFile }))).toBe(0); // no distill
      expect(await queryPlaybook(playbookFile, "u1")).toEqual([]); // zero playbook writes
      expect(await readPendingLearnEvents(queueFile)).toHaveLength(1); // queue intact, NOT drained

      // resume → the queued correction now distills
      await setLearningPaused(pauseFile, false);
      expect(await distillQueuedCorrections(deps({ pauseFile }))).toBe(1);
    });

    it("a suppression with no source can't block (best-effort) — the correction still distills", async () => {
      const suppressedLessonsFile = join(dir, "suppressed2.json");
      await recordSuppressedLesson(suppressedLessonsFile, {
        createdAt: "2026-06-01T00:00:00Z", id: "x2", text: "some old undone lesson", userId: "u1"
      });
      await enqueueLearnEvent(queueFile, ev("a", "stop rescheduling things to weekends"));
      expect(await distillQueuedCorrections(deps({ suppressedLessonsFile }))).toBe(1);
    });

    it("with no suppressedLessonsFile wired, behaves exactly as before (back-compat)", async () => {
      await enqueueLearnEvent(queueFile, ev("a", "anything goes"));
      expect(await distillQueuedCorrections(deps())).toBe(1);
    });
  });
});
