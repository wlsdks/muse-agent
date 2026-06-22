import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CorrectionExchange, DistilledStrategy } from "@muse/agent-core";
import { enqueueLearnEvent, readPendingLearnEvents, readPlaybook, recordPlaybookStrategy } from "@muse/stores";
import type { ModelProvider } from "@muse/model";
import { afterEach, describe, expect, it } from "vitest";

import { distillQueuedCorrections } from "../src/distill-queue.js";

let files: string[] = [];
const freshFile = (label: string) => {
  const file = join(tmpdir(), `muse-${label}-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

// `distill` is injected, so the model is never called — generate must not run.
const modelProvider: Pick<ModelProvider, "generate"> = {
  generate: async () => { throw new Error("model should not be called — distill is injected"); }
};
const distillReturning = (text: string) =>
  async (_exchange: CorrectionExchange): Promise<DistilledStrategy | undefined> => ({ text });

const seedCorrection = (queueFile: string, correction: string) =>
  enqueueLearnEvent(queueFile, { correction, enqueuedAtMs: 1, id: `ev_${randomUUID()}`, priorAnswer: "old answer", userId: "u1" });

describe("distillQueuedCorrections — bank dedup consolidates a repeated correction (sign-safe)", () => {
  it("a re-derived near-duplicate bumps the existing entry's timesObserved instead of writing a 2nd entry, and does NOT graduate it", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    // The bank already holds this lesson, on probation, from an earlier distill.
    await recordPlaybookStrategy(playbookFile, {
      createdAt: "2026-01-01T00:00:00Z", id: "existing", probation: true, reward: -1,
      text: "when rescheduling, default to the next business day", userId: "u1"
    });
    await seedCorrection(queueFile, "you keep rescheduling onto weekends — use a business day");

    const recorded = await distillQueuedCorrections({
      distill: distillReturning("when rescheduling, default to the next business day"),
      model: "m", modelProvider, playbookFile, queueFile
    });

    expect(recorded).toBe(0); // consolidated — nothing newly recorded
    const bank = await readPlaybook(playbookFile);
    expect(bank).toHaveLength(1); // no paraphrase duplicate
    expect(bank[0]?.timesObserved).toBe(2); // raised again → observed twice
    expect(bank[0]?.probation).toBe(true); // STILL on probation — a repeat never graduates
    expect(bank[0]?.reward).toBe(-1); // reward untouched — no positive signal manufactured
  });

  it("a genuinely-distinct lesson IS recorded as a new probation entry (dedup doesn't swallow real new learning)", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    await recordPlaybookStrategy(playbookFile, {
      createdAt: "2026-01-01T00:00:00Z", id: "existing", probation: true,
      text: "when rescheduling, default to the next business day", userId: "u1"
    });
    await seedCorrection(queueFile, "always CC the project lead on status updates");

    const recorded = await distillQueuedCorrections({
      distill: distillReturning("CC the project lead on every status email"),
      model: "m", modelProvider, playbookFile, queueFile
    });

    expect(recorded).toBe(1);
    const bank = await readPlaybook(playbookFile);
    expect(bank).toHaveLength(2); // the distinct lesson was added
    expect(bank.some((e) => e.text.includes("CC the project lead"))).toBe(true);
  });
});

describe("distillQueuedCorrections — drain-idempotency + grounding fence (the unattended-consumer safety invariants)", () => {
  // A dud event (no real correction) must be DRAINED, not jammed: the consumer
  // runs every idle tick, so a dud left pending would be re-processed forever.
  // It must also write ZERO strategies — a non-corrective signal never fabricates
  // a "lesson". `distill` is injected to throw, proving the empty event is fenced
  // out BEFORE any (costly) distill call.
  it("an empty-correction event is drained from the queue and writes no strategy (no jam, no fabrication)", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    await seedCorrection(queueFile, "   ");

    const recorded = await distillQueuedCorrections({
      distill: async () => { throw new Error("distill must not run for an empty correction"); },
      model: "m", modelProvider, playbookFile, queueFile
    });

    expect(recorded).toBe(0);
    expect(await readPlaybook(playbookFile)).toHaveLength(0); // nothing fabricated
    expect(await readPendingLearnEvents(queueFile)).toHaveLength(0); // drained, not re-queued
  });

  // A real correction whose distiller fail-soft returns nothing (NONE) must ALSO
  // drain the event and write nothing — the fail-soft path is the other way a
  // tick can produce no lesson, and it must not jam the queue either.
  it("a fail-soft distiller (returns undefined) drains the event and writes no strategy", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    await seedCorrection(queueFile, "you keep emailing before 9am — wait until business hours");

    const recorded = await distillQueuedCorrections({
      distill: async () => undefined,
      model: "m", modelProvider, playbookFile, queueFile
    });

    expect(recorded).toBe(0);
    expect(await readPlaybook(playbookFile)).toHaveLength(0);
    expect(await readPendingLearnEvents(queueFile)).toHaveLength(0); // drained despite no lesson
  });
});

// A distiller whose draft VARIES per call — the self-consistency gate draws k times.
const distillCycling = (texts: readonly string[]) => {
  let i = 0;
  return async (_exchange: CorrectionExchange): Promise<DistilledStrategy | undefined> => ({ text: texts[i++ % texts.length]! });
};

describe("distillQueuedCorrections — self-consistency write gate (sibling parity with the sync distiller)", () => {
  it("DISAGREEING drafts (k draws don't agree ⇒ likely confabulated) write ZERO strategies", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    await seedCorrection(queueFile, "you keep getting my preferences wrong");

    const recorded = await distillQueuedCorrections({
      distill: distillCycling([
        "always cc the project lead on status updates",
        "schedule meetings only in the morning slots",
        "prefer terse bullet points over long prose"
      ]),
      model: "m", modelProvider, playbookFile, queueFile, strategyConsistencySamples: 3
    });

    expect(recorded).toBe(0);                                   // inconsistent ⇒ no auto-write
    expect((await readPlaybook(playbookFile)).length).toBe(0);  // bank untouched
    expect((await readPendingLearnEvents(queueFile)).length).toBe(0); // event still drained (no queue jam)
  });

  it("CONSISTENT drafts (k draws agree) DO write a probation strategy", async () => {
    const queueFile = freshFile("learnq");
    const playbookFile = freshFile("playbook");
    await seedCorrection(queueFile, "always cc the project lead on status updates");

    const recorded = await distillQueuedCorrections({
      distill: distillReturning("cc the project lead on every status email"),
      model: "m", modelProvider, playbookFile, queueFile, strategyConsistencySamples: 3
    });

    expect(recorded).toBe(1);                                   // agreement ⇒ recorded
    expect((await readPlaybook(playbookFile))[0]?.probation).toBe(true);
  });
});
