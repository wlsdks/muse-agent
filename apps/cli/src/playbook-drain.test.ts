import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enqueueLearnEvent, queryPlaybook, readPendingLearnEvents, setLearningPaused, type LearnCorrectionEvent } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLearnQueueDrain, type RunLearnQueueDrainDeps } from "./playbook-drain.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-drain-"));
  env = {
    MUSE_LEARN_QUEUE_FILE: join(dir, "learn-queue.jsonl"),
    MUSE_PLAYBOOK_FILE: join(dir, "playbook.json"),
    MUSE_LEARNING_PAUSE_FILE: join(dir, "learning-paused.json"),
    MUSE_SUPPRESSED_LESSONS_FILE: join(dir, "suppressed.json")
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ev = (id: string, correction: string): LearnCorrectionEvent => ({
  correction, enqueuedAtMs: 1000, id, priorAnswer: "I'd reschedule to Saturday.", request: "reschedule the dentist", userId: "u1"
});

function baseDeps(over: Partial<RunLearnQueueDrainDeps> = {}): RunLearnQueueDrainDeps {
  return {
    env,
    model: "test-model",
    modelProvider: { generate: async () => ({}) } as never,
    stdout: () => undefined,
    ...over
  };
}

describe("runLearnQueueDrain — the manual catch-up for the daemon's one-per-tick idle learner", () => {
  it("drains ALL pending events in one call (maxPerTick = pending length), wired to the SAME files distillQueuedCorrections uses", async () => {
    await enqueueLearnEvent(env.MUSE_LEARN_QUEUE_FILE!, ev("a", "lesson one"));
    await enqueueLearnEvent(env.MUSE_LEARN_QUEUE_FILE!, ev("b", "lesson two"));
    await enqueueLearnEvent(env.MUSE_LEARN_QUEUE_FILE!, ev("c", "lesson three"));

    const seen: string[] = [];
    const distill: RunLearnQueueDrainDeps["distill"] = async (exchange) => {
      seen.push(exchange.correction);
      return { text: `learned: ${exchange.correction}` };
    };

    const result = await runLearnQueueDrain(baseDeps({ distill }));

    expect(result).toEqual({ learned: 3, pending: 3, status: "drained" });
    // all 3 were handed to the distiller in ONE call — proves maxPerTick was
    // set to the full pending count, not the daemon tick's default of 1.
    // (the self-consistency gate draws the distiller multiple times per
    // event, so dedupe before checking WHICH corrections were seen.)
    expect(new Set(seen)).toEqual(new Set(["lesson one", "lesson two", "lesson three"]));
    // queue drained (markLearnEventsDone ran against MUSE_LEARN_QUEUE_FILE)
    expect(await readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).toEqual([]);
    // strategies landed in MUSE_PLAYBOOK_FILE
    const bank = await queryPlaybook(env.MUSE_PLAYBOOK_FILE!, "u1");
    expect(bank).toHaveLength(3);
    expect(bank.map((s) => s.text)).toEqual(expect.arrayContaining([
      "learned: lesson one", "learned: lesson two", "learned: lesson three"
    ]));
  });

  it("an empty queue prints the empty message and makes ZERO model calls", async () => {
    let distillCalls = 0;
    const distill: RunLearnQueueDrainDeps["distill"] = async () => { distillCalls += 1; return undefined; };
    const lines: string[] = [];

    const result = await runLearnQueueDrain(baseDeps({ distill, stdout: (l) => lines.push(l) }));

    expect(result.status).toBe("empty");
    expect(distillCalls).toBe(0);
    expect(lines.join("")).toContain("learn queue empty — nothing to drain");
  });

  it("learning paused: prints a `muse playbook resume` hint, leaves the queue intact, no distill call", async () => {
    await enqueueLearnEvent(env.MUSE_LEARN_QUEUE_FILE!, ev("a", "lesson one"));
    await setLearningPaused(env.MUSE_LEARNING_PAUSE_FILE!, true, new Date().toISOString());
    let distillCalls = 0;
    const distill: RunLearnQueueDrainDeps["distill"] = async () => { distillCalls += 1; return undefined; };
    const lines: string[] = [];

    const result = await runLearnQueueDrain(baseDeps({ distill, stdout: (l) => lines.push(l) }));

    expect(result.status).toBe("paused");
    expect(distillCalls).toBe(0);
    expect(lines.join("")).toContain("muse playbook resume");
    expect(await readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).toHaveLength(1);
  });
});
